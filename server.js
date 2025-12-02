// server.js
//
// MisterBot Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (gpt-4o-realtime-preview-2024-12-17)
//
// חוקים עיקריים לפי ה-MASTER PROMPT:
// - שיחה בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
// - שליטה מלאה דרך ENV (פתיח, סגיר, פרומפט כללי, KB עסקי, טיימרים, לידים, VAD).
// - טיימר שקט + ניתוק אוטומטי + מקסימום זמן שיחה.
// - לוג שיחה + וובהוק לידים (אם מופעל).
//
// דרישות:
//   npm install express ws dotenv
//
// להרצה (למשל):
//   PORT=3000 node server.js
//
// Twilio Voice Webhook -> /twilio-voice  (TwiML)
// Twilio Media Streams -> wss://<domain>/twilio-media-stream
//

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// -----------------------------
// ENV Helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in ENV.');
}

const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'MisterBot';

const MB_OPENING_SCRIPT =
  process.env.MB_OPENING_SCRIPT ||
  'שלום, הגעתם למיסטר בוט – פתרונות בינה מלאכותית ובוטים קוליים לעסקים. שמי נטע, איך אפשר לעזור לכם היום?';

const MB_CLOSING_SCRIPT =
  process.env.MB_CLOSING_SCRIPT ||
  'תודה שדיברתם עם מיסטר בוט. המשך יום נעים, ולהתראות.';

const MB_GENERAL_PROMPT = process.env.MB_GENERAL_PROMPT || '';
const MB_BUSINESS_PROMPT = process.env.MB_BUSINESS_PROMPT || '';

const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 1.15);

const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';
const MAX_OUTPUT_TOKENS = process.env.MAX_OUTPUT_TOKENS || 'inf';

// VAD
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.5);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 600);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 300);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000); // 40 שניות
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);  // 90 שניות
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000); // ברירת מחדל 5 דקות
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000); // 45 שניות לפני הסוף

// לידים / וובהוק
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL || '';

// Debug
const MB_DEBUG = envBool('MB_DEBUG', false);

// -----------------------------
// Helpers – logging
// -----------------------------
function logDebug(tag, msg, extra) {
  if (!MB_DEBUG) return;
  if (extra !== undefined) {
    console.log(`[DEBUG][${tag}] ${msg}`, extra);
  } else {
    console.log(`[DEBUG][${tag}] ${msg}`);
  }
}

function logInfo(tag, msg, extra) {
  if (extra !== undefined) {
    console.log(`[INFO][${tag}] ${msg}`, extra);
  } else {
    console.log(`[INFO][${tag}] ${msg}`);
  }
}

function logError(tag, msg, extra) {
  if (extra !== undefined) {
    console.error(`[ERROR][${tag}] ${msg}`, extra);
  } else {
    console.error(`[ERROR][${tag}] ${msg}`);
  }
}

// -----------------------------
// System instructions builder
// -----------------------------
function buildSystemInstructions() {
  if (MB_GENERAL_PROMPT && MB_GENERAL_PROMPT.trim().length > 0) {
    // אם המשתמש הגדיר פרומפט כללי – משתמשים בו כמו שהוא.
    return MB_GENERAL_PROMPT;
  }

  const langsTxt =
    MB_LANGUAGES.length > 0
      ? `שפות נתמכות: ${MB_LANGUAGES.join(', ')}. ברירת מחדל: עברית. אם הלקוח מדבר באנגלית או רוסית – עוברים לשפה שלו.`
      : 'ברירת מחדל: עברית.';

  const businessKb =
    MB_BUSINESS_PROMPT && MB_BUSINESS_PROMPT.trim().length > 0
      ? `\n\nמידע עסקי על "${BUSINESS_NAME}":\n${MB_BUSINESS_PROMPT}\n`
      : '\n\nאם אין מידע עסקי רלוונטי, להישאר כללית ולהודות בחוסר הוודאות.\n';

  return `
אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור שירות "${BUSINESS_NAME}".

${langsTxt}

טון דיבור:
- חם, נעים, מקצועי ולא רובוטי.
- תמיד פנייה בלשון רבים ("אתם", "בשבילכם").
- משפטים קצרים וברורים (1–3 משפטים לכל תשובה).
- קצב דיבור מעט מהיר מהרגיל (בערך ${MB_SPEECH_SPEED}).

חוקי שיחה:
- ברירת מחדל בעברית.
- לא להחליף שפה ללא סיבה ברורה (הלקוח מדבר בשפה אחרת).
- לא להתנצל כל הזמן, לא לחפור, לא לחזור על עצמך.
- לנהל שיחה זורמת, לשאול שאלות המשך קצרות כשצריך.

טלפונים:
- כאשר מבקשים מספר טלפון – לבקש ספרה-ספרה בקול.
- להתייחס למספר כרצף ספרות בלבד.
- לא להוסיף +972 ולא להוריד 0 בהתחלה.
- לחזור על המספר ללקוח לאישור.

מתחרים:
- מותר להסביר באופן כללי על עולם הבוטים והאוטומציה.
- אסור לתת מידע שיווקי מפורט, המלצות או השוואות ישירות על חברות מתחרות.
- אם שואלים על מתחרה ספציפי – להסביר בעדינות שאינכם נותנים מידע שיווקי מפורט על מתחרים, ולהחזיר את הפוקוס לשירותי MisterBot.

איסוף פרטים (לידים):
- אם נראה שהשיחה מתאימה לאיסוף פרטי לקוח – לשאול בעדינות:
  - שם מלא.
  - שם העסק.
  - תחום פעילות.
  - מספר טלפון.
  - סיבת הפנייה.
- לחזור בסוף בקצרה על הפרטים כדי לוודא שהכול נכון.

סיום שיחה:
- אם הלקוח אומר "זהו", "זה הכול", "סיימנו", "מספיק לעכשיו", "תודה", "ביי", "להתראות" וכדומה – להבין שזאת סיום שיחה.
- במקרה כזה – לתת משפט סיכום קצר וחיובי, ולהיפרד בעדינות.

${businessKb}

זכרו:
- תמיד לדבר בנימוס, ברוגע, ובקצב מעט מהיר.
- לתת עדיפות למידע העסקי שניתן בפרומפט העסק.
- אם אין מידע, להודות בזה ולענות כללי, בלי להמציא עובדות.
`.trim();
}

// -----------------------------
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio Voice webhook – מחזיר TwiML שמחבר את השיחה ל־Media Streams
app.post('/twilio-voice', (req, res) => {
  const host = process.env.DOMAIN || req.headers.host;
  const wsUrl =
    process.env.MB_TWILIO_STREAM_URL ||
    `wss://${host.replace(/^https?:\/\//, '')}/twilio-media-stream`;

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`.trim();

  logInfo('Twilio-Voice', `Returning TwiML with Stream URL: ${wsUrl}`);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);

// -----------------------------
// WebSocket Server for Twilio Media Streams
// -----------------------------
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Per-call handler
// -----------------------------
wss.on('connection', (connection, req) => {
  const tag = 'Call';
  logInfo(tag, 'New Twilio Media Stream connection established.');

  if (!OPENAI_API_KEY) {
    logError(tag, 'OPENAI_API_KEY missing – closing connection.');
    connection.close();
    return;
  }

  const instructions = buildSystemInstructions();
  let streamSid = null;
  let callSid = null;

  // Realtime WS to OpenAI
  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  // שדות לניהול שיחה / טיימרים / לוג
  let conversationLog = []; // [{ from: 'user'|'bot', text }]
  let currentBotText = '';
  let callStartTs = Date.now();
  let lastMediaTs = Date.now();
  let idleCheckInterval = null;
  let maxCallTimeout = null;
  let pendingHangup = null; // { reason, closingMessage }
  let idleWarningSent = false;
  let openAiReady = false;
  let twilioClosed = false;
  let openAiClosed = false;

  // -----------------------------
  // Helper: שליחת וובהוק לידים / לוג
  // -----------------------------
  async function sendLeadWebhook(reason, closingMessage) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) {
      logDebug(tag, 'Lead webhook disabled or URL missing – skipping.');
      return;
    }
    try {
      const payload = {
        streamSid,
        callSid,
        botName: BOT_NAME,
        businessName: BUSINESS_NAME,
        startedAt: new Date(callStartTs).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - callStartTs,
        reason,
        closingMessage,
        conversationLog
      };

      logInfo(tag, `Sending lead webhook to ${MB_WEBHOOK_URL}`);
      const res = await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        logError(tag, `Lead webhook HTTP ${res.status}`, await res.text());
      }
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err);
    }
  }

  // -----------------------------
  // Helper: סיום שיחה מרוכז
  // -----------------------------
  async function endCall(reason, closingMessage) {
    logInfo(tag, `endCall called with reason="${reason}"`);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);

    await sendLeadWebhook(reason, closingMessage || MB_CLOSING_SCRIPT);

    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiClosed = true;
      openAiWs.close();
    }

    if (!twilioClosed && connection.readyState === WebSocket.OPEN) {
      twilioClosed = true;
      connection.close();
    }
  }

  // -----------------------------
  // Helper: תזמון סיום שיחה אחרי שהבוט יגיד משפט סיום
  // -----------------------------
  function scheduleEndCall(reason, closingMessage) {
    if (pendingHangup) {
      logDebug(tag, 'Hangup already scheduled, skipping duplicate.');
      return;
    }
    pendingHangup = { reason, closingMessage: closingMessage || MB_CLOSING_SCRIPT };

    // מבקשים מהמודל להגיד את משפט הסיום
    if (openAiWs.readyState === WebSocket.OPEN) {
      const text = pendingHangup.closingMessage || MB_CLOSING_SCRIPT;
      const item = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף משפטים נוספים: "${text}"`
            }
          ]
        }
      };
      openAiWs.send(JSON.stringify(item));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      logInfo(tag, `Scheduled hangup with closing message: ${text}`);
    } else {
      // אם אין חיבור למודל – מנתקים מיד
      endCall(reason, closingMessage);
    }
  }

  // -----------------------------
  // Helper: בדיקת מילות פרידה של המשתמש
  // -----------------------------
  function checkUserGoodbye(transcript) {
    if (!transcript) return;
    const t = transcript.toLowerCase();

    const goodbyePatterns = [
      'זהו',
      'זהו זה',
      'זה הכל',
      'זה הכול',
      'סיימנו',
      'מספיק לעכשיו',
      'להתראות',
      'ביי',
      'ביי ביי',
      'תודה רבה',
      'תודה, זהו',
      'תודה, זה הכל',
      'תודה זה הכל',
      'תודה זהו'
    ];

    if (goodbyePatterns.some((p) => t.includes(p))) {
      logInfo(tag, `Detected user goodbye phrase in transcript: "${transcript}"`);
      scheduleEndCall('user_goodbye', MB_CLOSING_SCRIPT);
    }
  }

  // -----------------------------
  // Helper: הודעת "אתם עדיין איתי?"
  // -----------------------------
  function sendIdleWarningIfNeeded() {
    if (idleWarningSent) return;
    idleWarningSent = true;

    if (openAiWs.readyState === WebSocket.OPEN) {
      const text = 'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
      const item = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `תגיבי ללקוח במשפט קצר בסגנון הבא (אפשר לשנות קצת): "${text}"`
            }
          ]
        }
      };
      openAiWs.send(JSON.stringify(item));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      logInfo(tag, 'Idle warning sent via model.');
    }
  }

  // -----------------------------
  // OpenAI WS handlers
  // -----------------------------
  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, 'Connected to OpenAI Realtime API.');

    const sessionUpdate = {
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['audio', 'text'],
        voice: OPENAI_VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        max_response_output_tokens: MAX_OUTPUT_TOKENS,
        instructions
      }
    };

    logDebug(tag, 'Sending session.update to OpenAI.', sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));

    // פתיח – הבוט מדבר ראשון
    const greetingText = MB_OPENING_SCRIPT;
    const initialItem = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `פתחי את השיחה עם הלקוח בעברית במשפטים קצרים בסגנון הבא (אפשר טיפה לשנות, אבל לא יותר מדי): "${greetingText}"`
          }
        ]
      }
    };

    openAiWs.send(JSON.stringify(initialItem));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  });

  openAiWs.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      logError(tag, 'Failed to parse OpenAI WS message', err);
      return;
    }

    if (MB_DEBUG) {
      logDebug(tag, `OpenAI event type: ${event.type}`, event);
    }

    switch (event.type) {
      case 'session.updated':
        logDebug(tag, 'Session updated', event);
        break;

      // אודיו החוצה – לבוט
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (!event.delta) return;
        if (connection.readyState !== WebSocket.OPEN) return;

        const audioDelta = {
          event: 'media',
          streamSid,
          media: { payload: event.delta }
        };
        connection.send(JSON.stringify(audioDelta));
        break;
      }

      // טקסט של הבוט (ללוג)
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') {
          currentBotText += event.delta;
        }
        break;

      case 'response.output_text.done':
      case 'response.completed':
      case 'response.done':
        if (currentBotText.trim().length > 0) {
          conversationLog.push({ from: 'bot', text: currentBotText.trim() });
          currentBotText = '';
        }

        // אם מחכה ניתוק אחרי סיום – זה הזמן
        if (pendingHangup) {
          const { reason, closingMessage } = pendingHangup;
          pendingHangup = null;
          endCall(reason, closingMessage);
        }
        break;

      // תמלול אודיו נכנס (הלקוח)
      case 'conversation.item.input_audio_transcription.completed':
      case 'response.audio_transcript.done': {
        const transcript =
          event.transcript ||
          (event.output && event.output[0] && event.output[0].content) ||
          '';

        if (typeof transcript === 'string' && transcript.trim().length > 0) {
          conversationLog.push({ from: 'user', text: transcript.trim() });
          checkUserGoodbye(transcript.trim());
        }
        break;
      }

      case 'error':
        logError(tag, 'OpenAI error event', event);
        break;

      default:
        // שאר האירועים – רק לוג בדיבאג
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    logInfo(tag, 'OpenAI WS connection closed.');
  });

  openAiWs.on('error', (err) => {
    logError(tag, 'OpenAI WS error', err);
  });

  // -----------------------------
  // Twilio WS handlers
  // -----------------------------
  connection.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      logError(tag, 'Failed to parse Twilio WS message', err);
      return;
    }

    if (MB_DEBUG) {
      logDebug(tag, `Twilio event: ${data.event}`, data);
    }

    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        callSid = data.start.callSid || null;
        callStartTs = Date.now();
        lastMediaTs = Date.now();
        logInfo(tag, `Incoming stream started. streamSid=${streamSid}, callSid=${callSid}`);

        // טיימר idle
        idleCheckInterval = setInterval(() => {
          const now = Date.now();
          const idleMs = now - lastMediaTs;
          const callMs = now - callStartTs;

          if (!idleWarningSent && idleMs >= MB_IDLE_WARNING_MS) {
            sendIdleWarningIfNeeded();
          }

          if (idleMs >= MB_IDLE_HANGUP_MS) {
            logInfo(tag, `Idle timeout reached (${idleMs} ms), scheduling hangup.`);
            scheduleEndCall('idle_timeout', MB_CLOSING_SCRIPT);
          }

          if (MB_MAX_CALL_MS > 0 && callMs >= MB_MAX_CALL_MS) {
            logInfo(tag, `Max call duration reached (${callMs} ms), scheduling hangup.`);
            scheduleEndCall('max_duration', MB_CLOSING_SCRIPT);
          }
        }, 1000);

        // טיימר אזהרה לפני סיום שיחה (למשל 45 שניות לפני סוף 5 דקות)
        if (MB_MAX_CALL_MS > 0 && MB_MAX_WARN_BEFORE_MS > 0) {
          const warnAt = MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS;
          if (warnAt > 0) {
            maxCallTimeout = setTimeout(() => {
              if (openAiWs.readyState === WebSocket.OPEN) {
                const warnText =
                  'אנחנו מתקרבים לסיום הזמן לשיחה. אם תרצו להתקדם ולהשאיר פרטים, זה זמן טוב לעשות זאת עכשיו.';
                const item = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'message',
                    role: 'user',
                    content: [
                      {
                        type: 'input_text',
                        text: `תני ללקוח אזהרה קצרה בסגנון הבא (אפשר לשנות מעט): "${warnText}"`
                      }
                    ]
                  }
                };
                openAiWs.send(JSON.stringify(item));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
                logInfo(tag, 'Max duration warning sent.');
              }
            }, warnAt);
          }
        }

        break;

      case 'media':
        lastMediaTs = Date.now();
        if (openAiReady && openAiWs.readyState === WebSocket.OPEN) {
          const audioAppend = {
            type: 'input_audio_buffer.append',
            audio: data.media.payload // Twilio שולח כבר כ-base64 של PCMU / G.711 μ-law
          };
          openAiWs.send(JSON.stringify(audioAppend));
        }
        break;

      case 'mark':
        // אפשר להשתמש בזה בעתיד לקומיטים אם תבטל server_vad
        break;

      case 'stop':
        logInfo(tag, 'Twilio sent stop event – ending call.');
        endCall('twilio_stop', MB_CLOSING_SCRIPT);
        break;

      default:
        logDebug(tag, `Unhandled Twilio event: ${data.event}`);
        break;
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logInfo(tag, 'Twilio Media Stream WS closed.');
    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
  });

  connection.on('error', (err) => {
    logError(tag, 'Twilio WS error', err);
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ MisterBot Realtime server listening on port ${PORT}`);
  console.log(`   /twilio-voice (TwiML)`);
  console.log(`   /twilio-media-stream (WebSocket for Twilio Media Streams)`);
});
