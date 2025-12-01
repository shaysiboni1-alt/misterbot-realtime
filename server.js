// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

// ===================== SETUP בסיסי =====================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// משתני סביבה – מגיעים מ-Render Environment Group שיצרנו
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// שומרים גם את ElevenLabs, אבל עדיין לא משתמשים בהם בשלב הזה
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing! Make sure it is set in Render env.');
}

// אפליקציית Express בסיסית
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

  // ---------- פותחים חיבור ל-OpenAI Realtime ----------
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

      // מגדירים את הסשן: אודיו g711_ulaw (תואם Twilio), ו-VAD בצד השרת
      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: `
אתם עוזר קולי בשם "נטע" עבור שירות אוטומציה לעסקים "MisterBot".
דברו תמיד בעברית, בפנייה בלשון רבים (אתכם), בטון נעים, קצר וענייני.
עשו שיחה טבעית, עם שאלות המשך קצרות כשצריך, וענו על שאלות כלליות על בוטים קוליים,
קביעת תורים, מענה לעסקים ועוד.
          `.trim(),
          voice: 'alloy',
          modalities: ['audio', 'text'],

          // 🔴 תיקון חשוב: השם הנכון הוא g711_ulaw (עם קו תחתי)
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

      // נפתח לוג קצר כדי לוודא שמגיע אודיו חזרה
      if (msg.type === 'response.audio.delta') {
        console.log('🔊 OpenAI sent audio delta');
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
            // OpenAI מחזיר base64 של g711_ulaw – מתאים בדיוק למה שטוויליו רוצה
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

      if (msg.type === 'response.output_text.delta' && msg.delta) {
        // אופציונלי: טקסט חלקי של תשובת הבוט
        // console.log('🧾 Bot partial:', msg.delta);
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
      // פה מגיע אודיו מהלקוח (base64 של g711_ulaw)
      const payload = data.media.payload;

      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
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
