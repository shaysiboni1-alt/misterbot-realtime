// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge
// תומך בשני מצבי TTS: Alloy (OpenAI) או ElevenLabs לפי TTS_PROVIDER

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ====== ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// TTS provider: "openai" (Alloy) או "eleven"
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'openai').toLowerCase();

// ElevenLabs env
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const ELEVEN_MODEL_ID = process.env.ELEVEN_MODEL_ID || 'eleven_v3';
const ELEVEN_OUTPUT_FORMAT =
  process.env.ELEVEN_OUTPUT_FORMAT || process.env.ELEVEN_OUTPUT_FORMAT || 'ulaw_8000';

const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME =
  process.env.MB_BUSINESS_NAME || 'MisterBot – שירותי בוטים קוליים לעסקים';

const OPENING_SCRIPT =
  process.env.MB_OPENING_SCRIPT ||
  'שלום, הגעתם למיסטר בוט, שירות הבוטים הקוליים לעסקים. שמי נטע, איך אפשר לעזור לכם היום?';

const CLOSING_SCRIPT =
  process.env.MB_CLOSING_SCRIPT ||
  'תודה שפניתם למיסטר בוט, שיהיה לכם המשך יום נעים. להתראות.';

const GENERAL_PROMPT =
  process.env.MB_GENERAL_PROMPT || '';

const BUSINESS_PROMPT =
  process.env.MB_BUSINESS_PROMPT || '';

const LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// VAD
const TURN_THRESHOLD = parseFloat(
  process.env.MB_VAD_THRESHOLD || '0.4'
);
const TURN_SILENCE_MS = parseInt(
  process.env.MB_VAD_SILENCE_MS || '800',
  10
);
const TURN_PREFIX_MS = parseInt(
  process.env.MB_VAD_PREFIX_MS || '300',
  10
);

// Idle timeouts
const IDLE_WARNING_MS = parseInt(
  process.env.MB_IDLE_WARNING_MS || '20000',
  10
);
const IDLE_HANGUP_MS = parseInt(
  process.env.MB_IDLE_HANGUP_MS || '35000',
  10
);

// Max call time (5 דקות)
const MAX_CALL_MS = parseInt(
  process.env.MB_MAX_CALL_MS || '300000',
  10
);
const MAX_WARN_BEFORE_MS = parseInt(
  process.env.MB_MAX_WARN_BEFORE_MS || '45000',
  10
);

const HANGUP_AFTER_GOODBYE =
  (process.env.MB_HANGUP_AFTER_GOODBYE || 'true').toLowerCase() === 'true';
const HANGUP_GRACE_MS = parseInt(
  process.env.MB_HANGUP_GRACE_MS || '2000',
  10
);

// Webhook ללוג/ליד (Make / Zapier וכו')
const LEAD_WEBHOOK_URL =
  process.env.MB_WEBHOOK_URL ||
  process.env.LEAD_WEBHOOK_URL ||
  process.env.MAKE_WEBHOOK_URL ||
  '';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing in env!');
}

console.log('🔊 TTS provider set to:', TTS_PROVIDER);

// ====== Express + HTTP ======
const app = express();
app.get('/', (req, res) => {
  res.send('MisterBot Realtime server is running.');
});
const server = http.createServer(app);

// ====== Helper: POST webhook ======
async function postToWebhook(url, body) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('📤 Webhook sent to:', url);
  } catch (err) {
    console.error('❌ Webhook error:', err.message || err);
  }
}

// ====== Helper: Base64 → Twilio media ======
function sendAudioToTwilio(streamSid, twilioWs, base64Audio) {
  if (!streamSid || !base64Audio) return;
  if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;

  const msg = {
    event: 'media',
    streamSid,
    media: { payload: base64Audio },
  };
  twilioWs.send(JSON.stringify(msg));
}

// ====== ElevenLabs TTS (טקסט → אודיו ulaw_8000) ======
async function ttsWithEleven(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    throw new Error('Missing ElevenLabs API key or voice id');
  }

  console.log('🎙️ ElevenLabs TTS text:', text);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
  const body = {
    text,
    model_id: ELEVEN_MODEL_ID,
    output_format: ELEVEN_OUTPUT_FORMAT, // חשוב: ulaw_8000 לטוויליו
    voice_settings: {
      stability: 0.7,
      similarity_boost: 0.8,
      style: 0.2,
      use_speaker_boost: true,
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/*',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs error: ${resp.status} ${txt}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return base64;
}

// זיהוי "פרידה"
function isGoodbye(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  const patterns = [
    /תודה רבה/,
    /תודה,? זהו/,
    /זה הכל/,
    /אין לי.*שאלות/,
    /סיימנו/,
    /יאללה תודה/,
    /להתראות/,
    /ביי/,
    /יום טוב/,
    /ערב טוב/,
    /לילה טוב/,
    /that's all/,
    /no more questions/,
    /thank you,? that's all/,
  ];
  return patterns.some(re => re.test(t));
}

// ====== WebSocket server for Twilio ======
const wss = new WebSocket.Server({
  server,
  path: '/twilio-media-stream',
});

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  const conversationLog = [];
  const callStartTs = Date.now();
  let lastMediaTs = Date.now();
  let idleWarningSent = false;
  let maxTimeWarningSent = false;
  let idleInterval = null;
  let callEnded = false;
  let closingStarted = false;
  let goodbyeHandled = false;

  function endCall(reason) {
    if (callEnded) return;
    callEnded = true;
    console.log('🔚 Ending call, reason:', reason);

    if (idleInterval) clearInterval(idleInterval);

    if (LEAD_WEBHOOK_URL) {
      const payload = {
        reason,
        businessName: BUSINESS_NAME,
        botName: BOT_NAME,
        timestamp: new Date().toISOString(),
        closingMessage: CLOSING_SCRIPT,
        conversationLog,
      };
      postToWebhook(LEAD_WEBHOOK_URL, payload);
    }

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  }

  // ====== Connect to OpenAI Realtime ======
  function connectToOpenAI() {
    console.log('🔌 Connecting to OpenAI Realtime...');
    const url =
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

    openaiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openaiWs.on('open', () => {
      console.log('✅ OpenAI Realtime connected');
      openaiReady = true;

      const langsText = LANGUAGES.join(', ');

      const defaultPrompt = `
אתם עוזר קולי בשם "${BOT_NAME}" עבור שירות "${BUSINESS_NAME}".

שפה:
- תמיד תענו בעברית ברורה עם ניקוד חלקי.
- רק אם הלקוח מבקש במפורש לדבר באנגלית או ברוסית – תעברו לשפה שביקש.
- אם הלקוח זורק מילים באנגלית אבל לא ביקש – תישארו בעברית.

טון:
- דיבור נעים, אנושי, בקול בטוח.
- פנייה בלשון רבים ("אתכם").
- משפטים קצרים וברורים.

טלפונים:
- כשמבקשים מספר טלפון, בקשו ספרה-ספרה.
- לעולם אל תוסיפו +972. השאירו את האפס בתחילת המספר.

ידע עסקי:
${BUSINESS_PROMPT || '(אין כרגע מידע עסקי נוסף).'}

המטרה:
- להבין בקצרה מי הלקוח, מה סוג העסק ומה הוא צריך.
- לתת מידע בסיסי על השירות, ולעזור לו להשאיר פרטים אם רלוונטי.
      `.trim();

      const finalPrompt =
        (GENERAL_PROMPT && GENERAL_PROMPT.trim()) || defaultPrompt;

      // session.update בהתאם ל־TTS_PROVIDER
      const session = {
        instructions: finalPrompt,
        modalities: TTS_PROVIDER === 'eleven' ? ['text'] : ['audio', 'text'],
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: TURN_THRESHOLD,
          silence_duration_ms: TURN_SILENCE_MS,
          prefix_padding_ms: TURN_PREFIX_MS,
        },
      };

      if (TTS_PROVIDER === 'openai') {
        session.voice = 'alloy';
        session.output_audio_format = 'g711_ulaw';
      }

      const sessionUpdate = {
        type: 'session.update',
        session,
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      console.log('🧠 session.update sent (TTS:', TTS_PROVIDER, ')');

      // ברכת פתיחה
      const greeting = {
        type: 'response.create',
        response: {
          instructions: OPENING_SCRIPT,
        },
      };
      openaiWs.send(JSON.stringify(greeting));
      console.log('📢 Greeting response.create sent');

      // טיימר לשקט + מגבלת זמן שיחה
      idleInterval = setInterval(() => {
        const now = Date.now();
        const idleMs = now - lastMediaTs;
        const callMs = now - callStartTs;

        if (!idleWarningSent && idleMs >= IDLE_WARNING_MS && !closingStarted) {
          idleWarningSent = true;
          console.log('⏳ Idle warning triggered');
          if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            const warn = {
              type: 'response.create',
              response: {
                instructions:
                  'לא שמעתי אתכם כמה רגעים. אתם עדיין על הקו? יש משהו נוסף שאוכל לעזור בו?',
              },
            };
            openaiWs.send(JSON.stringify(warn));
          }
        }

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
                instructions:
                  'נראה שלא נשמעת תגובה, אז אסיים את השיחה. תודה שפניתם למיסטר בוט, ולהתראות.',
              },
            };
            openaiWs.send(JSON.stringify(bye));
          }
          setTimeout(() => endCall('idle_timeout'), HANGUP_GRACE_MS);
        }

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
                instructions:
                  'אנחנו מתקרבים לסיום הזמן המוקצה לשיחה. אם תרצו להתקדם, תוכלו עכשיו לסכם איתי שם ומספר טלפון.',
              },
            };
            openaiWs.send(JSON.stringify(warnTime));
          }
        }

        if (callMs >= MAX_CALL_MS && !closingStarted) {
          closingStarted = true;
          console.log('🛑 Max-call hangup triggered');
          if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            const byeTime = {
              type: 'response.create',
              response: {
                instructions: CLOSING_SCRIPT,
              },
            };
            openaiWs.send(JSON.stringify(byeTime));
          }
          setTimeout(() => endCall('max_call_time'), HANGUP_GRACE_MS);
        }
      }, 1000);
    });

    openaiWs.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.error('⚠️ Failed to parse OpenAI msg', e);
        return;
      }

      console.log('🧾 OpenAI event:', msg.type);

      // ====== MODE 1: TTS = OPENAI (Alloy Realtime) ======
      if (TTS_PROVIDER === 'openai') {
        if (
          msg.type === 'response.audio.delta' &&
          streamSid &&
          twilioWs.readyState === WebSocket.OPEN
        ) {
          sendAudioToTwilio(streamSid, twilioWs, msg.delta);
        }
      }

      // תמלול מהלקוח
      if (
        msg.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
          conversationLog.push({ from: 'user', text: transcript });

          if (!goodbyeHandled && isGoodbye(transcript) && HANGUP_AFTER_GOODBYE) {
            goodbyeHandled = true;
            closingStarted = true;
            console.log('👋 User goodbye detected');
            const bye = {
              type: 'response.create',
              response: { instructions: CLOSING_SCRIPT },
            };
            openaiWs.send(JSON.stringify(bye));
            setTimeout(() => endCall('user_goodbye'), HANGUP_GRACE_MS);
          }
        }
      }

      // טקסט מהבוט (משותף לשני המצבים)
      if (
        msg.type === 'response.output_text.delta' ||
        msg.type === 'response.output_text.done'
      ) {
        let contentArray = null;

        if (msg.type === 'response.output_text.delta' && msg.delta?.content) {
          contentArray = msg.delta.content;
        } else if (msg.type === 'response.output_text.done') {
          if (Array.isArray(msg.output)) {
            contentArray = msg.output[0]?.content || null;
          } else if (msg.output?.content) {
            contentArray = msg.output.content;
          }
        }

        if (Array.isArray(contentArray)) {
          const textParts = contentArray
            .filter(p => p.type === 'output_text' || p.type === 'text')
            .map(p => p.text || p.output_text || '')
            .filter(Boolean);

          if (textParts.length) {
            const botText = textParts.join(' ');
            console.log('🤖 Bot said:', botText);
            conversationLog.push({ from: 'bot', text: botText });

            // ====== MODE 2: TTS = ELEVEN (טקסט → אודיו בעצמנו) ======
            if (TTS_PROVIDER === 'eleven' && streamSid && twilioWs.readyState === WebSocket.OPEN) {
              try {
                const base64Audio = await ttsWithEleven(botText);
                sendAudioToTwilio(streamSid, twilioWs, base64Audio);
              } catch (err) {
                console.error('❌ ElevenLabs TTS failed, bot stays silent for this turn:', err.message || err);
              }
            }
          }
        }
      }

      if (msg.type === 'error') {
        console.error('❌ OpenAI error event:', msg);
      }
    });

    openaiWs.on('close', () => {
      console.log('🔌 OpenAI Realtime closed');
      openaiReady = false;
    });

    openaiWs.on('error', (err) => {
      console.error('❌ OpenAI Realtime error:', err);
      openaiReady = false;
    });
  }

  connectToOpenAI();

  // ====== Twilio → OpenAI ======
  twilioWs.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      console.error('⚠️ Failed to parse Twilio msg', e);
      return;
    }

    const event = data.event;

    if (event === 'start') {
      streamSid = data.start.streamSid;
      console.log('▶️ Stream started, streamSid:', streamSid);
      lastMediaTs = Date.now();
    }

    if (event === 'media') {
      const payload = data.media && data.media.payload;
      if (!payload) return;

      lastMediaTs = Date.now();

      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        const msg = {
          type: 'input_audio_buffer.append',
          audio: payload,
        };
        openaiWs.send(JSON.stringify(msg));
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
    console.error('❌ Twilio WS error:', err);
    endCall('twilio_ws_error');
  });
});

// ====== RUN SERVER ======
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 MisterBot Realtime server listening on port ${PORT}`);
});
