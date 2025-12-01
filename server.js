// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)

// ===================== SETUP בסיסי =====================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// משתני סביבה – מגיעים מ-Render Environment Group
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// שומרים גם את ElevenLabs, לשימוש עתידי
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

// שים לב: הנתיב חייב להתאים ל-<Stream url="wss://.../twilio-media">
const wss = new WebSocket.Server({ server, path: '/twilio-media' });

console.log('✅ MisterBot Realtime bridge starting up...');

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // ---------- מחברים ל-OpenAI Realtime ----------
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

      // מגדירים את הסשן: אודיו g711-ulaw (תואם Twilio), VAD בצד השרת
      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: `
אתם עוזר קולי בשם "נטע" עבור שירות האוטומציה לעסקים "MisterBot".
דברו תמיד בעברית, בלשון רבים (אתם), בטון נעים, קצר וענייני.
נהלו שיחה טבעית: ברכו את המתקשר, הסבירו בקצרה מי אתם,
ושאלו איך אפשר לעזור. אפשר לשאול שאלות המשך קצרות כשצריך.
ענו רק על נושאים שקשורים לבוטים קוליים, וואטסאפ בוטים, קביעת תורים,
מענה טלפוני לעסקים ועוד. הימנעו מלענות על נושאים שלא קשורים.
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

      // 🔊 שלב חשוב: מבקשים מהמודל תגובת פתיחה – אחרת הוא שותק
      const greeting = {
        type: 'response.create',
        response: {
          instructions:
            'פתחי בשיחת פתיחה קצרה בעברית, הציגי את עצמך כ"נטע ממיסטרבוט" ושאלי איך אפשר לעזור לעסק שלהם.',
        },
      };
      openaiWs.send(JSON.stringify(greeting));
      console.log('👋 OpenAI greeting response.create sent');
    });

    openaiWs.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.error('⚠️ Failed to parse OpenAI message', e);
        return;
      }

      // למעקב – אפשר לפתוח/לסגור לפי הצורך
      // console.log('🔁 OpenAI event:', msg.type);

      // שולחים אודיו חזרה לטוויליו
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
            // OpenAI מחזיר base64 של g711-ulaw – בדיוק מה שטוויליו מצפה לקבל
            payload: msg.delta,
          },
        };
        twilioWs.send(JSON.stringify(twilioMediaMsg));
      }

      // לוג כשתגובה הסתיימה
      if (msg.type === 'response.completed') {
        console.log('✅ OpenAI response completed');
      }

      // תמלול מלא של מה שהלקוח אמר
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
        }
      }

      // טקסט חלקי של תשובת הבוט (רק ללוג, לא חובה)
      if (msg.type === 'response.output_text.delta' && msg.delta) {
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

  // מחברים ל-OpenAI מיד כשהחיבור של טוויליו נפתח
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
      // לוג קל שנדע שמדיה באמת זורמת
      console.log('🎧 Twilio media frame received');

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
