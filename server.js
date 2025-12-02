// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ========= ENV =========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
const LANGUAGES =
  (process.env.MB_LANGUAGES || 'he,en,ru')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// מהירות "לוגית" (נשתמש בהוראה בפרומפט, לא פרמטר טכני במודל)
const SPEECH_SPEED = parseFloat(process.env.MB_SPEECH_SPEED || '1.15'); // 1.0 = רגיל

// שליטה ב-Voice וב-VAD (מהירות תגובה/רגישות)
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

const TURN_THRESHOLD = parseFloat(
  process.env.MB_VAD_THRESHOLD ||
    process.env.TURN_THRESHOLD ||
    '0.5'
);

const TURN_SILENCE_MS = parseInt(
  process.env.MB_VAD_SILENCE_MS ||
    process.env.TURN_SILENCE_MS ||
    '600',
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

// הגדרות "חוק ברזל" לניתוק (לעתיד – כרגע לא קוראים ל-Twilio REST)
const HANGUP_AFTER_GOODBYE =
  (process.env.MB_HANGUP_AFTER_GOODBYE || 'false')
    .toLowerCase() === 'true';

const HANGUP_GRACE_MS = parseInt(
  process.env.MB_HANGUP_GRACE_MS || '2000',
  10
);

// זמנים לשקט לפני אזהרה / ניתוק אוטומטי
const IDLE_WARNING_MS = parseInt(
  process.env.MB_IDLE_WARNING_MS || '20000',
  10
); // אחרי 20 שניות שקט – "אתם עדיין על הקו?"
const IDLE_HANGUP_MS = parseInt(
  process.env.MB_IDLE_HANGUP_MS || '35000',
  10
); // אחרי 35 שניות שקט – סיום שיחה וניתוק

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

// ========= חיבורי WS =========
wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // לוג טקסטואלי של השיחה
  const conversationLog = [];

  // ניטור שקט
  let lastUserMediaTs = Date.now();
  let idleWarningSent = false;
  let idleInterval = null;
  let callEnded = false;

  // פונקציה מרכזית לסיום שיחה (גם ל-stop וגם לניתוק אוטומטי)
  function endCall(reason = 'unknown') {
    if (callEnded) return;
    callEnded = true;

    console.log(`⏹️ Ending call, reason: ${reason}`);

    // לעצור בדיקות שקט
    if (idleInterval) {
      clearInterval(idleInterval);
      idleInterval = null;
    }

    // אם יש Webhook ואיסוף לידים פעיל – נשלח אליו את לוג השיחה
    if (LEAD_WEBHOOK_URL && ENABLE_LEAD_CAPTURE) {
      const payload = {
        streamSid,
        businessName: BUSINESS_NAME,
        botName: BOT_NAME,
        timestamp: new Date().toISOString(),
        closingMessage: CLOSING_SCRIPT,
        reason,
        conversationLog,
      };
      postToWebhook(LEAD_WEBHOOK_URL, payload);
    }

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
    if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
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

זמן שקט:
- אם יש שקט ארוך ואתם מקבלים בקשה מהמערכת לבדוק אם הלקוח עדיין על הקו,
  שאלו בקצרה: "אני עדיין כאן, אתם איתי על הקו? אם אתם צריכים עוד משהו תגידו לי בבקשה."
- אם אחרי ההודעה הזו עדיין יש שקט והמערכת מבקשת מכם לסיים,
  סיימו את השיחה במשפט סיום נעים וקצר בעברית, בסגנון:
  "${CLOSING_SCRIPT}"

ידע עסקי:
${BUSINESS_PROMPT || '(אין כרגע מידע עסקי נוסף)'}

${ENABLE_LEAD_CAPTURE ? `
איסוף פרטי פנייה:
- במהלך השיחה נסו להבין אם מדובר בלקוח חדש או בלקוח קיים.
- אם זה לקוח חדש: ${NEW_LEAD_PROMPT}
- אם זה לקוח קיים: ${EXISTING_LEAD_PROMPT}
- בסיום שיחה שבה נאספו פרטים, סיימו במשפט קצר שמסכם את הפרטים (שם, טלפון, סוג הפנייה).
` : ''}
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

      // הפעלת טיימר שקט
      lastUserMediaTs = Date.now();
      idleWarningSent = false;

      idleInterval = setInterval(() => {
        if (!openaiReady || callEnded) return;
        const now = Date.now();
        const silenceMs = now - lastUserMediaTs;

        // אזהרה ראשונה – "אתם עדיין על הקו?"
        if (!idleWarningSent && silenceMs >= IDLE_WARNING_MS) {
          idleWarningSent = true;
          console.log('⏰ Idle warning – sending "are you still there" message');

          const stillThere = {
            type: 'response.create',
            response: {
              instructions: `
שאלי בנימוס אם הלקוח עדיין על הקו, בסגנון:
"אני עדיין כאן, אתם איתי על הקו? אם אתם צריכים עוד משהו תגידו לי בבקשה. אם לא, אסיים את השיחה עוד רגע."
              `.trim(),
            },
          };
          openaiWs.send(JSON.stringify(stillThere));
        }

        // ניתוק אוטומטי אחרי אזהרה ושקט מתמשך
        if (idleWarningSent && silenceMs >= IDLE_HANGUP_MS) {
          console.log('⏰ Idle timeout reached – sending goodbye and ending call');

          const goodbye = {
            type: 'response.create',
            response: {
              instructions: `
סיימי את השיחה במשפט סיום נעים וקצר בעברית בסגנון:
"${CLOSING_SCRIPT}"
              `.trim(),
            },
          };
          openaiWs.send(JSON.stringify(goodbye));

          // נותנים לזמן הדיבור לצאת החוצה ואז מסיימים את השיחה
          setTimeout(() => {
            endCall('idle-timeout');
          }, HANGUP_GRACE_MS);
        }
      }, 2000);
    });

    openaiWs.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.error('⚠️ Failed to parse OpenAI message', e);
        return;
      }

      // אודיו מהבוט → טוויליו
      if (
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
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
          conversationLog.push({ from: 'user', text: transcript });
        }
      }

      // טקסט תשובת הבוט – לוג
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
      console.log('▶️ Stream started, streamSid:', streamSid);
      lastUserMediaTs = Date.now();
    }

    if (event === 'media') {
      // אודיו מהלקוח (base64 g711_ulaw)
      const payload = data.media && data.media.payload;
      if (!payload) return;

      // עדכון זמן פעילות אחרון – יש דיבור
      lastUserMediaTs = Date.now();

      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        const openaiAudioMsg = {
          // חשוב: הפורמט התקין
          type: 'input_audio_buffer.append',
          audio: payload,
        };
        openaiWs.send(JSON.stringify(openaiAudioMsg));
      }
    }

    if (event === 'stop') {
      console.log('⏹️ Stream stopped (Twilio stop event)');
      endCall('twilio-stop');
    }
  });

  twilioWs.on('close', () => {
    console.log('☎️ Twilio WebSocket closed');
    endCall('twilio-ws-close');
  });

  twilioWs.on('error', (err) => {
    console.error('❌ Twilio WebSocket error:', err);
    endCall('twilio-ws-error');
  });
});

// ========= RUN SERVER =========
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Realtime server listening on port ${PORT}`);
});
