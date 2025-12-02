// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ====== ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing! Make sure it is set in Render env.');
}

const app = express();
app.get('/', (req, res) => {
  res.send('MisterBot realtime server is running.');
});

const server = http.createServer(app);

// ====== WebSocket לטוויליו ======
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

      // הגדרת session: עברית, g711-ulaw, VAD בצד השרת
      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: `
אתם עוזר קולי בשם "נטע" עבור שירות האוטומציה לעסקים "MisterBot".
דברו תמיד בעברית, בלשון רבים (אתכם), בטון נעים, טבעי וקצר.
אפשר גם לענות באנגלית או רוסית אם הלקוח מדבר בשפות הללו.
ענו על כל שאלה כללית, אבל אל תתנו מידע מפורט על חברות או שירותים מתחרים בתחום של בוטים קוליים ואוטומציה לעסקים.
          `.trim(),
          voice: 'alloy',
          modalities: ['audio', 'text'],
          input_audio_format: 'g711-ulaw',
          output_audio_format: 'g711-ulaw',
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

      // ברכת פתיחה אוטומטית – כדי לוודא שיש אודיו חוזר
      const greeting = {
        type: 'response.create',
        response: {
          instructions: `
ברכי את הלקוח בעברית כ"נטע ממיסטר בוט".
הציגי את עצמך בקצרה ושאלי איך אפשר לעזור, במשפט אחד קצר.
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

      // לוג בסיסי לדעת מה קורה
      // console.log('🧠 OpenAI event:', msg.type);

      // אודיו מהבוט ← אל טוויליו
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
            payload: msg.delta, // base64 g711-ulaw
          },
        };
        // לוג לצורך דיבוג
        // console.log('🎧 Sending audio chunk to Twilio, size:', msg.delta.length);
        twilioWs.send(JSON.stringify(twilioMediaMsg));
      }

      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
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
      // אודיו מהלקוח (base64 g711-ulaw)
      const payload = data.media && data.media.payload;
      if (!payload) return;

      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        const openaiAudioMsg = {
          type: 'input_audio_buffer.append', // שים לב: עם _
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
