// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ====== ENV VARS – מגיעים מ-Render ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// אפשרי לעתיד (כרגע לא בשימוש)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// פרומפט כללי על הבוט – אם לא הגדרת ב-ENV יהיה טקסט ברירת מחדל
const BOT_SYSTEM_PROMPT =
  process.env.BOT_SYSTEM_PROMPT ||
  `
אתם עוזר קולי בשם "נטע" עבור שירות האוטומציה לעסקים "MisterBot".
תמיד דברו בעברית (אם הלקוח לא ביקש שפה אחרת), בפנייה בלשון רבים (אתכם),
בטון נעים, אנושי, קצר וענייני.
ענו על שאלות לגבי בוטים קוליים, תזכורות, קביעת תורים, מענה לשיחות ועוד.
אל תתנו מידע או המלצות על חברות מתחרות בתחום האוטומציה הקולית.
אם שואלים ישירות על מתחרים – אמרו בעדינות שאינכם יכולים לענות על זה
ותחזרו להדגיש את היתרונות של MisterBot.
`.trim();

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing! Make sure it is set in Render env.');
}

// ====== EXPRESS בסיסי ======
const app = express();
app.get('/', (req, res) => {
  res.send('MisterBot realtime server is running.');
});

const server = http.createServer(app);

// ====== WebSocket ל-Twilio Media Streams ======
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

console.log('✅ MisterBot Realtime bridge starting up...');

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

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

      // שים לב: g711_ulaw (עם קו תחתון!) כדי להתאים ל־Twilio
      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: BOT_SYSTEM_PROMPT,
          voice: 'alloy',
          modalities: ['audio', 'text'],
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: 600,
            prefix_padding_ms: 300,
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

      // אם תרצה – פתח את זה לדיבוג:
      // console.log('🔁 OpenAI event:', msg.type);

      // אודיו מהבוט → החוצה לטלפוניה
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
            // OpenAI מחזיר base64 של g711_ulaw – בדיוק מה שטוויליו מחפש
            payload: msg.delta,
          },
        };
        twilioWs.send(JSON.stringify(twilioMediaMsg));
      }

      if (msg.type === 'response.completed') {
        console.log('✅ OpenAI response completed');
      }

      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
        }
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

  // מתחברים ל-OpenAI כש-Twilio נפתח
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
      // אודיו מהלקוח אלינו
      const payload = data.media.payload;
      // דיבוג – לראות שיש תנועה:
      // console.log('🎧 Twilio media frame received (len)', payload.length);

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

// ====== RUN SERVER ======
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Realtime server listening on port ${PORT}`);
});
