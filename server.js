// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

// ===================== SETUP בסיסי =====================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ===== משתני סביבה =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// אופציונלי – לעתיד עם ElevenLabs
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing! Make sure it is set in Render env.');
}

// ===== קריאה נוחה מה-ENV עם ברירת מחדל =====
function envOrDefault(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  return v;
}

function parseQuestions(envValue, fallbackArray) {
  const raw = envOrDefault(envValue, null);
  if (!raw) return fallbackArray;
  return raw
    .split('|')
    .map(q => q.trim())
    .filter(q => q.length > 0);
}

// ===== קונפיגורציה דרך ENV =====
const CONFIG = {
  MODEL: envOrDefault('MB_OPENAI_MODEL', 'gpt-4o-realtime-preview-2024-12-17'),

  BOT_NAME: envOrDefault('MB_BOT_NAME', 'נטע'),
  BUSINESS_NAME: envOrDefault('MB_BUSINESS_NAME', 'MisterBot'),

  OPENING_SCRIPT: envOrDefault(
    'MB_OPENING_SCRIPT',
    'שלום, הגעתם למיסטר בוט – מערכת אוטומציה חכמה לעסקים. שמי נטע, איך אפשר לעזור לכם היום?'
  ),

  CLOSING_SCRIPT: envOrDefault(
    'MB_CLOSING_SCRIPT',
    'תודה שפניתם למיסטר בוט. שיהיה לכם המשך יום נעים, ולהתראות.'
  ),

  BUSINESS_KB_PROMPT: envOrDefault(
    'MB_BUSINESS_PROMPT',
    'את מבוססת על שירות אוטומציה לעסקים בשם MisterBot, שמספק בוטים קוליים וצ׳אט חכמים, קביעת תורים, מענה לשיחות, ותהליכי אוטומציה עסקיים.'
  ),

  GENERAL_BEHAVIOR_PROMPT: envOrDefault(
    'MB_GENERAL_PROMPT',
    `
את עוזרת קולית אנושית, חמה ועניינית.
את תמיד:
• מדברת בטון נעים, לא רובוטי.
• שומרת על תשובות קצרות וברורות.
• פונה בלשון רבים (אתם).
• אם יש צורך, שואלת שאלה אחת בכל פעם.
• לעולם אינך נותנת מידע על חברות מתחרות בתחום הבוטים, מענה טלפוני או אוטומציה.
`.trim()
  ),

  LANGUAGES: envOrDefault('MB_LANGUAGES', 'he,en,ru'),
  SPEECH_SPEED: envOrDefault('MB_SPEECH_SPEED', 'רגילה'), // טקסט חופשי שנכנס לפרומפט

  NEW_LEAD_QUESTIONS: parseQuestions('MB_NEW_LEAD_QUESTIONS', [
    'מה שמך המלא?',
    'מה מספר הטלפון שלך?',
    'מה שם העסק שלך?',
    'באיזה שירות אתם מעוניינים?',
    'מאיפה הגעתם אלינו?'
  ]),

  EXISTING_CLIENT_QUESTIONS: parseQuestions('MB_EXISTING_CLIENT_QUESTIONS', [
    'מה שמך המלא?',
    'מה מספר הטלפון שלך?',
    'איך אפשר לעזור לכם היום?',
    'האם יש מספר הזמנה או תור שתרצו להתייחס אליו?'
  ]),

  WEBHOOK_URL: envOrDefault('MB_WEBHOOK_URL', ''),

  // הגדרות זיהוי "סוף דיבור"
  VAD_THRESHOLD: parseFloat(envOrDefault('MB_VAD_THRESHOLD', '0.5')),
  VAD_SILENCE_MS: parseInt(envOrDefault('MB_VAD_SILENCE_MS', '600'), 10),
  VAD_PREFIX_MS: parseInt(envOrDefault('MB_VAD_PREFIX_MS', '300'), 10),
};

// ===== פרומפט הוראות מרכזי שנבנה מה-ENV =====
function buildInstructions() {
  return `
את עוזרת קולית בשם "${CONFIG.BOT_NAME}" עבור שירות אוטומציה לעסקים "${CONFIG.BUSINESS_NAME}".
${CONFIG.BUSINESS_KB_PROMPT}

${CONFIG.GENERAL_BEHAVIOR_PROMPT}

שפות:
• השפה הראשית היא עברית.
• את יכולה לדבר גם באנגלית וברוסית בהתאם לשפה שבה הלקוח מדבר.
(${CONFIG.LANGUAGES})

מהירות דיבור:
• מהירות הדיבור שלך היא: ${CONFIG.SPEECH_SPEED}.
אם הלקוח נשמע מבולבל, את יכולה להאט מעט ולחזור במשפט פשוט יותר.

פתיח:
• בתחילת השיחה השתמשי בניסוח הבא (אפשר לשנות מעט לפי ההקשר):
"${CONFIG.OPENING_SCRIPT}"

סגירת שיחה:
• כאשר הלקוח מסיים, או מבקש לסיים, השתמשי בניסוח הסגירה:
"${CONFIG.CLOSING_SCRIPT}"

איסוף פרטי לקוח חדש:
• אם הלקוח אומר שהוא פונה בפעם הראשונה, שאלי את השאלות הבאות, אחת אחת, וודאי שקיבלת תשובה ברורה:
${CONFIG.NEW_LEAD_QUESTIONS.map(q => `- ${q}`).join('\n')}

איסוף פרטי לקוח קיים:
• אם הלקוח אומר שהוא כבר לקוח קיים, שאלי את השאלות הבאות, אחת אחת:
${CONFIG.EXISTING_CLIENT_QUESTIONS.map(q => `- ${q}`).join('\n')}

תמיד:
• אל תתני מידע על חברות מתחרות בתחום שלך.
• שמרי על שיחה זורמת וטבעית.
• אל תתנצלי יותר מדי – פעם אחת מספיקה.
`.trim();
}

// ===== אפליקציית Express בסיסית =====
const app = express();
app.get('/', (req, res) => {
  res.send('MisterBot realtime server is running.');
});

const server = http.createServer(app);

// ===================== WebSocket לטוויליו =====================

// Twilio יחובר לנתיב הזה כ-Media Stream WebSocket
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

console.log('✅ MisterBot Realtime bridge starting up...');

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;
  let isBotSpeaking = false; // כדי לא לאפשר "קטיעה" – מתעלמים מדיבור של הלקוח בזמן שהבוט מדבר

  // ---------- פותחים חיבור ל-OpenAI Realtime ----------
  function connectToOpenAI() {
    console.log('🔌 Connecting to OpenAI Realtime...');

    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      CONFIG.MODEL
    )}`;

    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openaiWs.on('open', () => {
      console.log('✅ OpenAI Realtime connected');
      openaiReady = true;

      const instructions = buildInstructions();

      // מגדירים את הסשן: אודיו g711-ulaw (תואם Twilio), ו-VAD בצד השרת
      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions,
          voice: 'alloy', // קול ברירת מחדל של OpenAI – כרגע לא משתמשים ב-ElevenLabs
          modalities: ['audio', 'text'],
          input_audio_format: 'g711-ulaw',
          output_audio_format: 'g711-ulaw',
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: CONFIG.VAD_THRESHOLD,
            silence_duration_ms: CONFIG.VAD_SILENCE_MS,
            prefix_padding_ms: CONFIG.VAD_PREFIX_MS,
          },
          max_response_output_tokens: 'inf',
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      console.log('🧠 OpenAI session.update sent');
    });

    openaiWs.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.error('⚠️ Failed to parse OpenAI message', e);
        return;
      }

      // console.log('🔁 OpenAI event:', msg.type);

      // התחלת אודיו מהבוט – מסמנים שהוא מדבר, כדי לא לשלוח אודיו של הלקוח במקביל
      if (msg.type === 'response.output_audio_started') {
        isBotSpeaking = true;
      }

      // שולחים אודיו החוצה לטוויליו
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
            // OpenAI מחזיר base64 של g711-ulaw – מתאים בדיוק למה שטוויליו רוצה
            payload: msg.delta,
          },
        };
        twilioWs.send(JSON.stringify(twilioMediaMsg));
      }

      if (msg.type === 'response.completed') {
        console.log('✅ OpenAI response completed');
        // סיום דיבור הבוט – אפשר שוב להקשיב ללקוח
        isBotSpeaking = false;
      }

      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        // תמלול מלא של מה שהלקוח אמר
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
        }
      }

      if (msg.type === 'response.output_text.delta' && msg.delta) {
        // חלקי טקסט של תשובת הבוט – ללוג בלבד אם תרצה
        // console.log('🧾 Bot partial:', msg.delta);
      }
    });

    openaiWs.on('close', () => {
      console.log('🔌 OpenAI Realtime connection closed');
      openaiReady = false;
      isBotSpeaking = false;
    });

    openaiWs.on('error', (err) => {
      console.error('❌ OpenAI Realtime error:', err);
      openaiReady = false;
      isBotSpeaking = false;
    });
  }

  // מחברים לאופן-איי מיד כשהחיבור של טוויליו נפתח
  connectToOpenAI();

  // ---------- הודעות נכנסות מטוויליו ----------
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
      // פה מגיע אודיו מהלקוח (base64 של g711-ulaw)
      const payload = data.media.payload;

      // אם הבוט מדבר כרגע – מתעלמים מהקלט, כדי שלא תהיה "קטיעה"
      if (isBotSpeaking) {
        return;
      }

      if (
        openaiWs &&
        openaiReady &&
        openaiWs.readyState === WebSocket.OPEN
      ) {
        const openaiAudioMsg = {
          type: 'input.audio_buffer.append',
          audio: payload,
        };
        openaiWs.send(JSON.stringify(openaiAudioMsg));
      }
    }

    if (event === 'mark') {
      console.log('📍 Twilio mark:', data.mark.name);
    }

    if (event === 'stop') {
      console.log('⏹️ Stream stopped');

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

// ===================== RUN SERVER =====================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Realtime server listening on port ${PORT}`);
});
