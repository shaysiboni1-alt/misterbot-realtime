// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ========= ENV =========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Twilio (אופציונלי, לצורך ניתוק יזום של השיחה מהשרת)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// ספק ה-TTS: openai (כמו היום) או eleven (ElevenLabs)
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'openai').toLowerCase();

// ElevenLabs TTS – שמות תואמים ל-ENV שלך
const ELEVEN_API_KEY =
  process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_VOICE_ID || '';
const ELEVEN_MODEL_ID =
  process.env.ELEVEN_MODEL_ID || 'eleven_multilingual_v2';
const ELEVEN_OPTIMIZE_STREAMING = parseInt(
  process.env.ELEVEN_OPTIMIZE_STREAMING || '2',
  10
);
const ELEVEN_OUTPUT_FORMAT =
  process.env.ELEVEN_OUTPUT_FORMAT || 'ulaw_8000';

// --- שמות הבוט / העסק (עם תאימות לשמות ישנים) ---
const BOT_NAME =
  process.env.MB_BOT_NAME ||
  process.env.BOT_NAME ||
  'נטע';

const BUSINESS_NAME =
  process.env.MB_BUSINESS_NAME ||
  process.env.BUSINESS_NAME ||
  'MisterBot';

// פתיח / סגיר – אם יש סקריפטים מלאים נשתמש בהם, אחרת נוסחה גנרית
const OPENING_SCRIPT =
  process.env.MB_OPENING_SCRIPT || process.env.OPENING_SCRIPT || '';

const CLOSING_SCRIPT =
  process.env.MB_CLOSING_SCRIPT ||
  process.env.ENDING_MESSAGE ||
  'תודה שפניתם למיסטר בוט, שיהיה לכם המשך יום נעים. להתראות.';

// פרומפטים כלליים / עסקיים
const GENERAL_PROMPT =
  process.env.MB_GENERAL_PROMPT || process.env.SYSTEM_PROMPT || '';
const BUSINESS_PROMPT =
  process.env.MB_BUSINESS_PROMPT || process.env.BUSINESS_KB || '';

// שפות (ברירת מחדל: עברית, אנגלית, רוסית)
const LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// מהירות "לוגית" (נשתמש בהוראה בפרומפט, לא פרמטר טכני במודל)
const SPEECH_SPEED = parseFloat(process.env.MB_SPEECH_SPEED || '1.15'); // 1.0 = רגיל

// שליטה ב-Voice וב-VAD (מהירות תגובה/רגישות)
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

// ברירת מחדל עדינה יותר לרעש רקע: threshold 0.4, silence 800ms
const TURN_THRESHOLD = parseFloat(
  process.env.MB_VAD_THRESHOLD ||
    process.env.TURN_THRESHOLD ||
    '0.4'
);

const TURN_SILENCE_MS = parseInt(
  process.env.MB_VAD_SILENCE_MS ||
    process.env.TURN_SILENCE_MS ||
    '800',
  10
);

const TURN_PREFIX_MS = parseInt(
  process.env.MB_VAD_PREFIX_MS ||
    process.env.TURN_PREFIX_MS ||
    '300',
  10
);

const MAX_OUTPUT_TOKENS =
  process.env.MAX_OUTPUT_TOKENS || 'inf';

// איסוף פרטים / לידים
const ENABLE_LEAD_CAPTURE =
  (process.env.MB_ENABLE_LEAD_CAPTURE ||
    process.env.ENABLE_LEAD_CAPTURE ||
    'true')
    .toLowerCase() === 'true';

// שאלות ללקוח חדש / קיים – טקסט חופשי שאתה מגדיר ב-ENV
const NEW_LEAD_PROMPT =
  process.env.MB_NEW_LEAD_QUESTIONS ||
  process.env.NEW_LEAD_PROMPT ||
  'אם מדובר בלקוח חדש, בקשי שם מלא, שם העסק, תחום הפעילות, מספר טלפון וסיבת הפנייה בצורה קצרה ונינוחה.';

const EXISTING_LEAD_PROMPT =
  process.env.MB_EXISTING_CLIENT_QUESTIONS ||
  process.env.EXISTING_LEAD_PROMPT ||
  'אם מדובר בלקוח קיים, בקשי שם מלא או שם עסק, מספר טלפון, וסוג הפנייה (תמיכה, חיוב, שינוי הגדרות, שאלה כללית).';

// אל איזה Webhook שולחים את הלוג (למשל Make)
const LEAD_WEBHOOK_URL =
  process.env.MB_WEBHOOK_URL ||
  process.env.LEAD_WEBHOOK_URL ||
  process.env.MAKE_WEBHOOK_URL ||
  '';

// ניתוק אחרי פרידה (משמש יחד עם טיימאאוט קצר)
const HANGUP_AFTER_GOODBYE =
  (process.env.MB_HANGUP_AFTER_GOODBYE || 'true')
    .toLowerCase() === 'true';

const HANGUP_GRACE_MS = parseInt(
  process.env.MB_HANGUP_GRACE_MS || '2000',
  10
);

// טיימרים לשקט
const IDLE_WARNING_MS = parseInt(
  process.env.MB_IDLE_WARNING_MS || '20000', // אחרי 20 שניות שקט – "אתם עדיין שם?"
  10
);
const IDLE_HANGUP_MS = parseInt(
  process.env.MB_IDLE_HANGUP_MS || '35000', // אחרי 35 שניות שקט – פרידה וניתוק
  10
);

// מגבלת שיחה (ברירת מחדל: 5 דקות = 300000ms)
const MAX_CALL_MS = parseInt(
  process.env.MB_MAX_CALL_MS || '300000',
  10
);
// כמה לפני הסוף להזהיר (ברירת מחדל: 45 שניות לפני 5 דקות)
const MAX_WARN_BEFORE_MS = parseInt(
  process.env.MB_MAX_WARN_BEFORE_MS || '45000',
  10
);

// =============== בדיקת מפתח ===============
if (!OPENAI_API_KEY) {
  console.error(
    '❌ OPENAI_API_KEY is missing! Make sure it is set in Render env.'
  );
}

// ========= EXPRESS =========
const app = express();
app.get('/', (req, res) => {
  res.send('MisterBot realtime server is running.');
});

const server = http.createServer(app);

// ========= WebSocket של טוויליו =========
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

console.log('✅ MisterBot Realtime bridge starting up...');

// פונקציה קטנה לשליחת POST ל-Webhook (ללא תלות בספריות חיצוניות)
async function postToWebhook(url, body) {
  if (!url) return;
  try {
    // ב-Node 18+ יש fetch גלובלי
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('📤 Webhook sent to:', url);
  } catch (err) {
    console.error('❌ Failed to send webhook:', err.message || err);
  }
}

// שליחת אודיו (base64 g711_ulaw) לטוויליו
function sendAudioToTwilio(streamSid, twilioWs, base64Audio) {
  if (!streamSid) return;
  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;
  if (!base64Audio) return;

  const twilioMediaMsg = {
    event: 'media',
    streamSid,
    media: {
      payload: base64Audio,
    },
  };
  twilioWs.send(JSON.stringify(twilioMediaMsg));
}

// קריאה ל-ElevenLabs כדי להמיר טקסט לאודיו בפורמט שמתאים לטוויליו
async function ttsWithEleven(text) {
  if (!text) return null;
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    console.error('❌ ELEVEN_API_KEY or ELEVEN_VOICE_ID missing');
    return null;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=${encodeURIComponent(
    ELEVEN_OUTPUT_FORMAT
  )}&optimize_streaming_latency=${ELEVEN_OPTIMIZE_STREAMING}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL_ID,
      }),
    });

    if (!res.ok) {
      console.error('❌ Eleven TTS HTTP error:', res.status, await res.text());
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Audio = buffer.toString('base64');
    return base64Audio;
  } catch (err) {
    console.error('❌ Eleven TTS fetch failed:', err.message || err);
    return null;
  }
}

// זיהוי "פרידה" מהלקוח לפי הטקסט
function isGoodbye(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  const patterns = [
    /תודה רבה/,
    /תודה,? זהו/,
    /זהו,? תודה/,
    /זה הכל/,
    /זהו הכל/,
    /אין לי.*שאלות/,
    /סיימנו/,
    /מספיק לעכשיו/,
    /יאללה תודה/,
    /טוב תודה/,
    /סבבה תודה/,
    /להתראות/,
    /ביי/,
    /יאללה ביי/,
    /יום טוב/,
    /ערב טוב/,
    /לילה טוב/,
    /that's all/,
    /that is all/,
    /i'm done/,
    /no more questions/,
    /thank you,? that's all/,
    /ok thanks/
  ];
  return patterns.some((re) => re.test(t));
}

// חילוץ שדות ליד בסיסיים מתוך לוג השיחה (הערכה חכמה, לא מושלם)
function extractLeadFields(conversationLog) {
  const userTexts = conversationLog
    .filter((m) => m.from === 'user' && typeof m.text === 'string')
    .map((m) => m.text.trim())
    .filter(Boolean);

  if (!userTexts.length) {
    return {
      contactName: '',
      businessName: '',
      phone: '',
      leadType: '',
      notes: ''
    };
  }

  // מחפש טלפון (רצף ספרות אחרון באחד המשפטים האחרונים)
  let phone = '';
  for (let i = userTexts.length - 1; i >= 0 && !phone; i--) {
    const digits = userTexts[i].replace(/[^\d]/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      phone = digits;
    }
  }

  // מחפש שם (שמי ..., קוראים לי ...)
  let contactName = '';
  for (let i = userTexts.length - 1; i >= 0 && !contactName; i--) {
    const txt = userTexts[i];
    let m =
      txt.match(/שמי\s+([^\s,]+(?:\s+[^\s,]+)?)/) ||
      txt.match(/קוראים לי\s+([^\s,]+(?:\s+[^\s,]+)?)/) ||
      txt.match(/אני\s+([^\s,]+(?:\s+[^\s,]+)?)/);
    if (m && m[1]) {
      contactName = m[1].trim();
    }
  }

  // מחפש שם עסק (שם העסק..., העסק שלי...)
  let businessName = '';
  for (let i = userTexts.length - 1; i >= 0 && !businessName; i--) {
    const txt = userTexts[i];
    let m =
      txt.match(/שם העסק[:\-]?\s*(.+)$/) ||
      txt.match(/העסק שלי\s+(.+)$/);
    if (m && m[1]) {
      businessName = m[1].trim();
    }
  }

  // הערכת סוג ליד (חדש / קיים) על בסיס מילים אופייניות
  const joined = userTexts.join(' ').toLowerCase();
  let leadType = '';
  if (/לקוח קיים|כבר עובד/.test(joined)) {
    leadType = 'existing';
  } else if (/לקוח חדש|מתעניין חדש|רוצה להצטרף/.test(joined)) {
    leadType = 'new';
  }

  // הערות – לוקח את 1–2 המשפטים האחרונים של הלקוח
  const lastTwo = userTexts.slice(-2).join(' | ');

  return {
    contactName,
    businessName,
    phone,
    leadType,
    notes: lastTwo
  };
}

// ניתוק יזום של שיחה בטוויליו דרך REST (אופציונלי)
async function hangupTwilioCall(callSid) {
  if (!callSid || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  const auth = Buffer.from(
    `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
  ).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'Status=completed'
    });
    console.log('☎️ Requested Twilio hangup for callSid:', callSid);
  } catch (err) {
    console.error('❌ Failed to hang up Twilio call via REST:', err.message || err);
  }
}

// ========= חיבורי WS =========
wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // ניהול זמן שיחה / שקט
  const callStartTs = Date.now();
  let lastMediaTs = Date.now();
  let idleWarningSent = false;
  let maxTimeWarningSent = false;
  let idleInterval = null;

  // דגלים כדי לא לסיים שיחה פעמיים
  let callEnded = false;
  let closingStarted = false;
  let goodbyeHandled = false;

  // נשמור לוג טקסטואלי של השיחה
  const conversationLog = [];

  // פונקציה מרכזית לסיום שיחה (גם stop, גם ניתוקים אוטומטיים)
  function endCall(reason) {
    if (callEnded) return;
    callEnded = true;
    console.log('🔚 Ending call, reason:', reason);

    if (idleInterval) {
      clearInterval(idleInterval);
      idleInterval = null;
    }

    // חילוץ שדות ליד מהשיחה
    const lead = extractLeadFields(conversationLog);

    // שליחת לוג / ליד ל-Webhook אם רלוונטי
    if (LEAD_WEBHOOK_URL && ENABLE_LEAD_CAPTURE) {
      const payload = {
        reason,
        streamSid,
        callSid,
        businessName: BUSINESS_NAME,
        botName: BOT_NAME,
        timestamp: new Date().toISOString(),
        closingMessage: CLOSING_SCRIPT,
        lead,
        conversationLog
      };
      postToWebhook(LEAD_WEBHOOK_URL, payload);
    }

    // ניתוק יזום של השיחה בטוויליו (אם יש אישורים מתאימים)
    if (callSid) {
      hangupTwilioCall(callSid);
    }

    // סגירת החיבורים – Twilio יסיים את השיחה ברגע שה-Stream נסגר (ובנוסף REST למעלה)
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  }

  // ---------- חיבור ל-OpenAI Realtime ----------
  function connectToOpenAI() {
    console.log('🔌 Connecting to OpenAI Realtime...');

    const openaiUrl =
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openaiWs.on('open', () => {
      console.log('✅ OpenAI Realtime connected');
      openaiReady = true;

      // שפות לקריאה בפרומפט
      const langsText = LANGUAGES.join(', ');

      // פרומפט ברירת מחדל אם לא הוגדר MB_GENERAL_PROMPT ב-ENV
      const defaultSystemPrompt = `
אתם עוזר קולי בשם "${BOT_NAME}" עבור שירות "${BUSINESS_NAME}".

שפות:
- ברירת המחדל היא עברית.
- אם הלקוח מדבר באנגלית או ברוסית, עברו לשפה שלו באופן טבעי.
- שפות זמינות: ${langsText}.

טון ודיבור:
- דיברו בטון חם, נעים, מקצועי ולא רובוטי.
- דברו בפנייה בלשון רבים ("אתכם").
- משפטים קצרים וברורים, בלי נאומים ארוכים.
- קצב הדיבור מעט מהיר מהרגיל (בערך פי ${SPEECH_SPEED} מקצב סטנדרטי), אבל עדיין ברור ונעים.
- אל תפסיקו באמצע תשובה גם אם הלקוח מדבר עליכם; סיימו משפט אחד ואז הגיבו.

טלפונים:
- כשמבקשים מספר טלפון, בקשו מהלקוח להגיד את המספר ספרה-ספרה.
- התייחסו למספר כאל רצף ספרות בלבד (ללא מילים).
- לעולם אל תוסיפו קידומת בינלאומית +972. השאירו את האפס בתחילת המספר (למשל 054...).
- חזרו על המספר ללקוח לווידוא.

מתחרים:
- מותר להסביר באופן כללי על עולם הבוטים הקוליים והאוטומציה לעסקים.
- אסור לתת מידע מפורט או להמליץ על חברות / שירותים מתחרים ספציפיים.
- אם שואלים על חברה מתחרה, אמרו בעדינות שאתם לא נותנים מידע שיווקי על ספקים אחרים ותמקדו את השיחה במה שמיסטר בוט מציעה.

ידע עסקי:
${BUSINESS_PROMPT || '(אין כרגע מידע עסקי נוסף)'}

${ENABLE_LEAD_CAPTURE ? `
איסוף פרטי פנייה:
- במהלך השיחה נסו להבין אם מדובר בלקוח חדש או בלקוח קיים.
- אם זה לקוח חדש: ${NEW_LEAD_PROMPT}
- אם זה לקוח קיים: ${EXISTING_LEAD_PROMPT}
- בסיום שיחה שבה נאספו פרטים, סיימו במשפט קצר שמסכם את הפרטים (שם, טלפון, סוג הפנייה).
` : ''}

שקט:
- אם יש שקט ארוך מצד הלקוח, אפשר להגיד בנימוס משהו כמו:
"אני עדיין כאן על הקו, אתם איתי?".
- אם אחרי זה עדיין אין תגובה, אפשר לסיים את השיחה במשפט פרידה קצר.
      `.trim();

      const finalSystemPrompt =
        (GENERAL_PROMPT && GENERAL_PROMPT.trim()) ||
        defaultSystemPrompt;

      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: finalSystemPrompt,
          voice: OPENAI_VOICE,
          modalities: ['audio', 'text'],

          // חשוב: פורמט שתואם לטוויליו (מה שעבד לנו)
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',

          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: TURN_THRESHOLD,
            silence_duration_ms: TURN_SILENCE_MS,
            prefix_padding_ms: TURN_PREFIX_MS,
          },
          max_response_output_tokens: MAX_OUTPUT_TOKENS,
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      console.log('🧠 OpenAI session.update sent');

      // ברכת פתיחה – אם יש סקריפט פתיחה ב-ENV, נשתמש בו כמו שהוא
      let greetingInstructions;
      if (OPENING_SCRIPT) {
        greetingInstructions = `
אמרי את משפט הפתיחה הבא כמעט מילה במילה, בטון טבעי ונעים:
"${OPENING_SCRIPT}"
        `.trim();
      } else {
        greetingInstructions = `
פתחי את השיחה בעברית, במשפט אחד קצר:
ברכי את הלקוח, הציגי את עצמך כ"${BOT_NAME}" מ"${BUSINESS_NAME}",
הסבירי בקצרה שמדובר בשירות בוטים קוליים ואוטומציה לעסקים,
ושאלי איך אפשר לעזור.
        `.trim();
      }

      const greeting = {
        type: 'response.create',
        response: {
          instructions: greetingInstructions,
        },
      };

      openaiWs.send(JSON.stringify(greeting));
      console.log('📢 Greeting response.create sent');

      // טיימר לבדיקת שקט + מגבלת זמן שיחה
      idleInterval = setInterval(() => {
        const now = Date.now();
        const idleMs = now - lastMediaTs;
        const callMs = now - callStartTs;

        // אזהרת שקט
        if (!idleWarningSent && idleMs >= IDLE_WARNING_MS && !closingStarted) {
          idleWarningSent = true;
          console.log('⏳ Idle warning triggered');
          if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            const warn = {
              type: 'response.create',
              response: {
                instructions: `
לא שמעתי אתכם כמה רגעים. 
תגידו לי אם אתם עדיין על הקו, ואם יש משהו נוסף שתרצו שאעזור בו.
                `.trim(),
              },
            };
            openaiWs.send(JSON.stringify(warn));
          }
        }

        // ניתוק אחרי שקט ממושך
        if (
          idleMs >= IDLE_HANGUP_MS &&
          !closingStarted &&
          HANGUP_AFTER_GOODBYE
        ) {
          closingStarted = true;
          console.log('🛑 Idle hangup triggered');
          if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            const bye = {
              type: 'response.create',
              response: {
                instructions: `
לא נשמע שיש עוד מישהו על הקו, אז אסיים את השיחה.
${CLOSING_SCRIPT}
                `.trim(),
              },
            };
            openaiWs.send(JSON.stringify(bye));
          }
          setTimeout(() => endCall('idle_timeout'), HANGUP_GRACE_MS);
        }

        // אזהרה לפני סוף 5 דקות
        if (
          !maxTimeWarningSent &&
          callMs >= (MAX_CALL_MS - MAX_WARN_BEFORE_MS) &&
          callMs < MAX_CALL_MS &&
          !closingStarted
        ) {
          maxTimeWarningSent = true;
          console.log('⏳ Max-call warning triggered');
          if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            const warnTime = {
              type: 'response.create',
              response: {
                instructions: `
אנחנו מתקרבים לסיום חמש הדקות של השיחה.
אם תרצו להתקדם, תוכלו עכשיו לסכם איתי בקצרה שם, עסק ומספר טלפון ואדאג שיעברו אליכם להמשך.
                `.trim(),
              },
            };
            openaiWs.send(JSON.stringify(warnTime));
          }
        }

        // ניתוק אחרי מקסימום זמן
        if (callMs >= MAX_CALL_MS && !closingStarted) {
          closingStarted = true;
          console.log('🛑 Max-call hangup triggered');
          if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            const byeTime = {
              type: 'response.create',
              response: {
                instructions: `
אני צריכה לסיים את השיחה בגלל מגבלת הזמן.
${CLOSING_SCRIPT}
                `.trim(),
              },
            };
            openaiWs.send(JSON.stringify(byeTime));
          }
          setTimeout(() => endCall('max_call_time'), HANGUP_GRACE_MS);
        }
      }, 1000);
    });

    openaiWs.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.error('⚠️ Failed to parse OpenAI message', e);
        return;
      }

      // אודיו מהבוט → טוויליו (רק אם ספק ה-TTS הוא OpenAI)
      if (
        TTS_PROVIDER === 'openai' &&
        msg.type === 'response.audio.delta' &&
        msg.delta &&
        streamSid &&
        twilioWs.readyState === WebSocket.OPEN
      ) {
        const twilioMediaMsg = {
          event: 'media',
          streamSid,
          media: {
            payload: msg.delta, // base64 g711_ulaw
          },
        };
        twilioWs.send(JSON.stringify(twilioMediaMsg));
      }

      // תמלול מלא של מה שהלקוח אמר
      if (
        msg.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
          conversationLog.push({ from: 'user', text: transcript });

          // זיהוי פרידה → פרידה + ניתוק
          if (!goodbyeHandled && isGoodbye(transcript) && HANGUP_AFTER_GOODBYE) {
            goodbyeHandled = true;
            closingStarted = true;
            console.log('👋 User goodbye detected – closing call');
            if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
              const bye = {
                type: 'response.create',
                response: {
                  instructions: CLOSING_SCRIPT.trim(),
                },
              };
              openaiWs.send(JSON.stringify(bye));
            }
            setTimeout(() => endCall('user_goodbye'), HANGUP_GRACE_MS);
          }
        }
      }

      // טקסט תשובת הבוט – לוג + TTS חיצוני (Eleven)
      if (
        (msg.type === 'response.output_text.done' ||
          msg.type === 'response.output_text.delta') &&
        msg.output &&
        msg.output[0]?.content
      ) {
        const parts = msg.output[0].content;
        const textParts = parts
          .filter((p) => p.type === 'output_text' || p.type === 'text')
          .map((p) => p.text || p.output_text)
          .filter(Boolean);
        if (textParts.length) {
          const botText = textParts.join(' ');
          console.log('🤖 Bot said:', botText);
          conversationLog.push({ from: 'bot', text: botText });

          // במצב Eleven – כשהטקסט הושלם, מייצרים אודיו דרך Eleven ושולחים לטוויליו
          if (TTS_PROVIDER === 'eleven' && msg.type === 'response.output_text.done') {
            ttsWithEleven(botText)
              .then((base64Audio) => {
                if (!base64Audio) return;
                sendAudioToTwilio(streamSid, twilioWs, base64Audio);
              })
              .catch((err) => {
                console.error('❌ Eleven TTS error:', err.message || err);
              });
          }
        }
      }

      if (msg.type === 'response.completed') {
        console.log('✅ OpenAI response completed');
      }

      if (msg.type === 'error') {
        console.error('❌ OpenAI error event:', msg);
      }
    });

    openaiWs.on('close', () => {
      console.log('🔌 OpenAI Realtime connection closed');
      openaiReady = false;
    });

    openaiWs.on('error', (err) => {
      console.error('❌ OpenAI Realtime error:', err);
      openaiReady = false;
    });
  }

  // מחברים לאופן-איי כשחיבור טוויליו נפתח
  connectToOpenAI();

  // ---------- הודעות מטוויליו ----------
  twilioWs.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.error('⚠️ Failed to parse Twilio message', e);
      return;
    }

    const event = data.event;

    if (event === 'start') {
      streamSid = data.start.streamSid;
      callSid = data.start.callSid || null;
      console.log('▶️ Stream started, streamSid:', streamSid, 'callSid:', callSid || 'N/A');
      lastMediaTs = Date.now();
    }

    if (event === 'media') {
      // אודיו מהלקוח (base64 g711_ulaw)
      const payload = data.media && data.media.payload;
      if (!payload) return;

      // מרענן טיימר שקט
      lastMediaTs = Date.now();

      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        const openaiAudioMsg = {
          type: 'input_audio_buffer.append', // חשוב – מה שעבד לנו
          audio: payload,
        };
        openaiWs.send(JSON.stringify(openaiAudioMsg));
      }
    }

    if (event === 'stop') {
      console.log('⏹️ Stream stopped (Twilio)');
      endCall('twilio_stop');
    }
  });

  twilioWs.on('close', () => {
    console.log('☎️ Twilio WebSocket closed');
    endCall('twilio_ws_close');
  });

  twilioWs.on('error', (err) => {
    console.error('❌ Twilio WebSocket error:', err);
    endCall('twilio_ws_error');
  });
});

// ========= RUN SERVER =========
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Realtime server listening on port ${PORT}`);
});
