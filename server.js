// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ========= ENV =========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// שם הבוט / העסק / טקסט פתיח וסגירה
const BOT_NAME = process.env.BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'MisterBot';
const OPENING_SUFFIX =
  process.env.OPENING_SUFFIX ||
  'שירות האוטומציה לעסקים. אני כאן כדי לעזור לכם בכל שאלה על בוטים קוליים ומערכת מיסטר בוט.';
const ENDING_MESSAGE =
  process.env.ENDING_MESSAGE ||
  'תודה שפניתם למיסטר בוט, שיהיה לכם המשך יום נעים. להתראות.';

// פרומפט כללי (טון, שפות, איסור על מתחרים וכו׳)
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

// פרומפט ידע עסקי – מידע על העסק הספציפי
const BUSINESS_KB = process.env.BUSINESS_KB || '';

// שליטה ב-Voice וב-VAD (מהירות תגובה/רגישות)
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';
const TURN_THRESHOLD = parseFloat(process.env.TURN_THRESHOLD || '0.5');
const TURN_SILENCE_MS = parseInt(process.env.TURN_SILENCE_MS || '600', 10);
const TURN_PREFIX_MS = parseInt(process.env.TURN_PREFIX_MS || '300', 10);
const MAX_OUTPUT_TOKENS = process.env.MAX_OUTPUT_TOKENS || 'inf';

// איסוף פרטים / לידים
const ENABLE_LEAD_CAPTURE =
  (process.env.ENABLE_LEAD_CAPTURE || 'false').toLowerCase() === 'true';

// שדות לליד מלקוח חדש / לקוח קיים – טקסט חופשי שאתה מגדיר
const NEW_LEAD_PROMPT =
  process.env.NEW_LEAD_PROMPT ||
  'אם מדובר בלקוח חדש, בקשי שם מלא, מספר טלפון וסיבת הפנייה בצורה נינוחה וקצרה.';
const EXISTING_LEAD_PROMPT =
  process.env.EXISTING_LEAD_PROMPT ||
  'אם מדובר בלקוח קיים, בקשי שם מלא, מספר טלפון, ואם יש – מספר לקוח או מזהה, וסיבת הפנייה.';

// לאן נשלח את הנתונים בסיום השיחה
const LEAD_WEBHOOK_URL =
  process.env.LEAD_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL || '';

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

  // נשמור לוג טקסטואלי של השיחה
  const conversationLog = [];

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

      // פרומפט ברירת מחדל אם לא הוגדר SYSTEM_PROMPT ב-ENV
      const defaultSystemPrompt = `
אתם עוזר קולי בשם "${BOT_NAME}" עבור שירות "${BUSINESS_NAME}".
דברו תמיד בעברית כברירת מחדל, בלשון רבים (אתכם), בטון נעים, טבעי, חמים וקצר.
אם הלקוח מדבר באנגלית או ברוסית, אפשר לעבור לשפה שלו, אבל אל תעברו שפה בלי סיבה.
ענו במהירות, במשפטים קצרים יחסית, בלי נאומים ארוכים.
מותר לענות על כל שאלה כללית, אבל:
- אל תמליצו על חברות או שירותים מתחרים למיסטר בוט.
- אם שואלים במפורש על מתחרים, תגידו בעדינות שאתם לא נותנים מידע שיווקי על מתחרים.
שלבו בשיחה את הידע העסקי הבא (אם רלוונטי): 
${BUSINESS_KB || '(אין כרגע מידע עסקי נוסף)'}

${ENABLE_LEAD_CAPTURE ? `
במהלך השיחה נסו להבין האם מדובר בלקוח חדש או לקוח קיים.
- אם זה לקוח חדש: ${NEW_LEAD_PROMPT}
- אם זה לקוח קיים: ${EXISTING_LEAD_PROMPT}
בסיום השיחה, אם נאספו פרטים, תסכמו אותם במשפט קצר וברור (שם, טלפון, סיבת פנייה).
` : ''}
`.trim();

      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: (SYSTEM_PROMPT || defaultSystemPrompt).trim(),
          voice: OPENAI_VOICE,
          modalities: ['audio', 'text'],

          // חשוב: הפורמט שתואם לטוויליו
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

      // ברכת פתיחה – ניתנת לשליטה דרך ENV (שם + OPENING_SUFFIX)
      const greeting = {
        type: 'response.create',
        response: {
          instructions: `
את ${BOT_NAME} מ"${BUSINESS_NAME}".
פתחי את השיחה בעברית, במשפט אחד קצר:
היי או שלום, הציגי את עצמך כ"${BOT_NAME}" ממיסטר בוט, הוסיפי בקצרה: "${OPENING_SUFFIX}",
ושאלי בנימוס איך אפשר לעזור. 
          `.trim(),
        },
      };
      openaiWs.send(JSON.stringify(greeting));
      console.log('📢 Greeting response.create sent');
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

      // טקסט של תשובת הבוט – אם תרצה לוג טקסטואלי
      if (msg.type === 'response.output_text.done' && msg.output && msg.output[0]?.content) {
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
    }

    if (event === 'media') {
      // אודיו מהלקוח (base64 g711_ulaw)
      const payload = data.media && data.media.payload;
      if (!payload) return;

      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        const openaiAudioMsg = {
          type: 'input_audio_buffer.append',
          audio: payload,
        };
        openaiWs.send(JSON.stringify(openaiAudioMsg));
      }
    }

    if (event === 'stop') {
      console.log('⏹️ Stream stopped');

      // שליחת הודעת סגירה (ברמת הטון – הבוט כבר יודע מה להגיד מהפרומפט)
      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        const closing = {
          type: 'response.create',
          response: {
            instructions: `
סיימי את השיחה במשפט סיום נעים וקצר בעברית, בסגנון:
"${ENDING_MESSAGE}"
            `.trim(),
          },
        };
        openaiWs.send(JSON.stringify(closing));
      }

      // אם מוגדר webhook – נשלח אליו את לוג השיחה
      if (LEAD_WEBHOOK_URL && ENABLE_LEAD_CAPTURE) {
        const payload = {
          streamSid,
          businessName: BUSINESS_NAME,
          botName: BOT_NAME,
          timestamp: new Date().toISOString(),
          conversationLog,
        };
        postToWebhook(LEAD_WEBHOOK_URL, payload);
      }

      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
      twilioWs.close();
    }
  });

  twilioWs.on('close', () => {
    console.log('☎️ Twilio WebSocket closed');
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('❌ Twilio WebSocket error:', err);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

// ========= RUN SERVER =========
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Realtime server listening on port ${PORT}`);
});
