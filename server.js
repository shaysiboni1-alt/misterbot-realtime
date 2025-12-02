// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ===== משתני סביבה מ-Render =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing! Make sure it is set in Render env.');
}

const app = express();
app.get('/', (req, res) => {
  res.send('MisterBot realtime server is running.');
});

const server = http.createServer(app);

// ===== WebSocket לטוויליו =====

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

      // שים לב: g711_ulaw עם קו תחתון, זה חשוב מאוד!
      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: `
אתם עוזר קולי בשם "נטע" עבור שירות האוטומציה לעסקים "MisterBot".
דברו תמיד בעברית, בפנייה בלשון רבים (אתכם), בטון נעים, קצר וענייני.
אפשר גם אנגלית ורוסית אם השיחה זזה לשפה אחרת.
ענו על שאלות כלליות על בוטים קוליים, קביעת תורים ומענה לעסקים,
אבל אל תתנו לעולם מידע מפורט על חברות מתחרות.
          `.trim(),
          voice: 'alloy',
          modalities: ['audio', 'text'],
          // *** זה התיקון הקריטי ***
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

      // לוג כללי לכל האירועים – לעכשיו לדיבוג
      console.log('🔁 OpenAI event:', msg.type);

      if (msg.type === 'error' || msg.type === 'response.error') {
        console.error('❌ OpenAI error event:', JSON.stringify(msg, null, 2));
      }

      // אודיו מהבוט לטוויליו
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
            // OpenAI מחזיר base64 של g711_ulaw – בדיוק מה שטוויליו מצפה לו
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

  // מחברים ל-OpenAI ברגע שטוויליו נכנס
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
      // אודיו מהלקוח (base64 של G711 μ-law)
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

// ===== הרצת השרת =====
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Realtime server listening on port ${PORT}`);
});
