// outbound_server.js
//
// MisterBot Realtime OUTBOUND Voice Bot – "נטע" (שיחות יוצאות)
// Twilio Calls API -> TwiML -> Media Streams <-> OpenAI Realtime
//
// ✅ מופרד לחלוטין מה-INBOUND (נתיבים, ENV, לוגיקה)
// ✅ משתמש ב-ENV עם OUTBOUND_
//
// Endpoints:
//   POST /outbound/dispatch
//   POST /outbound/twilio-voice
//   POST /outbound/status
//   WS   /outbound-media-stream
//

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

// -----------------------------
// Core ENV
// -----------------------------
const PORT = envNumber('OUTBOUND_PORT', envNumber('PORT', 3001)); // כדי לא להתנגש אם תריץ מקומית
const DOMAIN = process.env.OUTBOUND_DOMAIN || process.env.DOMAIN || '';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');

// Twilio creds (חובה לשיחות יוצאות)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error('❌ Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN for OUTBOUND calls.');
}

// Identity
const BOT_NAME = process.env.OUTBOUND_BOT_NAME || process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.OUTBOUND_BUSINESS_NAME || process.env.MB_BUSINESS_NAME || 'MisterBot';

// Opening/Closing (יוצא)
const OUTBOUND_OPENING_SCRIPT =
  process.env.OUTBOUND_OPENING_SCRIPT ||
  'שלום, מדברת נטע מ־${BUSINESS_NAME}. מפריע לכם דקה?';

const OUTBOUND_CLOSING_SCRIPT =
  process.env.OUTBOUND_CLOSING_SCRIPT ||
  'תודה רבה, יום נעים ולהתראות.';

// Prompt (יוצא)
const OUTBOUND_GENERAL_PROMPT = process.env.OUTBOUND_GENERAL_PROMPT || '';
const OUTBOUND_BUSINESS_PROMPT = process.env.OUTBOUND_BUSINESS_PROMPT || '';

// Controls
const OUTBOUND_DEBUG = envBool('OUTBOUND_DEBUG', false);

const MB_VAD_THRESHOLD = envNumber('OUTBOUND_VAD_THRESHOLD', envNumber('MB_VAD_THRESHOLD', 0.65));
const MB_VAD_SILENCE_MS = envNumber('OUTBOUND_VAD_SILENCE_MS', envNumber('MB_VAD_SILENCE_MS', 900));
const MB_VAD_PREFIX_MS = envNumber('OUTBOUND_VAD_PREFIX_MS', envNumber('MB_VAD_PREFIX_MS', 200));
const MB_VAD_SUFFIX_MS = envNumber('OUTBOUND_VAD_SUFFIX_MS', envNumber('MB_VAD_SUFFIX_MS', 200));

const OUTBOUND_ALLOW_BARGE_IN = envBool('OUTBOUND_ALLOW_BARGE_IN', envBool('MB_ALLOW_BARGE_IN', true));
const OUTBOUND_NO_BARGE_TAIL_MS = envNumber('OUTBOUND_NO_BARGE_TAIL_MS', envNumber('MB_NO_BARGE_TAIL_MS', 1600));

const OUTBOUND_IDLE_WARNING_MS = envNumber('OUTBOUND_IDLE_WARNING_MS', 40000);
const OUTBOUND_IDLE_HANGUP_MS = envNumber('OUTBOUND_IDLE_HANGUP_MS', 90000);

const OUTBOUND_MAX_CALL_MS = envNumber('OUTBOUND_MAX_CALL_MS', 5 * 60 * 1000);
const OUTBOUND_MAX_WARN_BEFORE_MS = envNumber('OUTBOUND_MAX_WARN_BEFORE_MS', 45000);

const OUTBOUND_HANGUP_GRACE_MS = envNumber('OUTBOUND_HANGUP_GRACE_MS', 4000);

const OPENAI_VOICE = process.env.OUTBOUND_OPENAI_VOICE || process.env.OPENAI_VOICE || 'alloy';

// Webhooks (אופציונלי)
const OUTBOUND_CALL_LOG_WEBHOOK_URL = process.env.OUTBOUND_CALL_LOG_WEBHOOK_URL || '';
const OUTBOUND_STATUS_WEBHOOK_URL = process.env.OUTBOUND_STATUS_WEBHOOK_URL || '';

// -----------------------------
// Logging helpers
// -----------------------------
function logDebug(tag, msg, extra) {
  if (!OUTBOUND_DEBUG) return;
  if (extra !== undefined) console.log(`[DEBUG][${tag}] ${msg}`, extra);
  else console.log(`[DEBUG][${tag}] ${msg}`);
}
function logInfo(tag, msg, extra) {
  if (extra !== undefined) console.log(`[INFO][${tag}] ${msg}`, extra);
  else console.log(`[INFO][${tag}] ${msg}`);
}
function logError(tag, msg, extra) {
  if (extra !== undefined) console.error(`[ERROR][${tag}] ${msg}`, extra);
  else console.error(`[ERROR][${tag}] ${msg}`);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function formatTemplate(str, vars) {
  return String(str || '').replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// -----------------------------
// System instructions (OUTBOUND)
// -----------------------------
const OUTBOUND_BEHAVIOR_RULES = `
חוקי מערכת לשיחות יוצאות:
1. זו שיחה יוזמת: קודם מוודאים שזה זמן מתאים ("מפריע לכם דקה?"). אם לא מתאים – מציעים לחזור בזמן אחר ושואלים מתי.
2. אם הלקוח מתנגד/לא מעוניין – מכבדים מיד, לא מתווכחים, מסיימים בנימוס.
3. לא נשמע "כמו רובוט": תשובות קצרות, טבעיות, בלי נאומים.
4. המטרה: לבדוק עניין קצר, להבין צורך, ולהציע המשך (לינק/וואטסאפ/שיחת המשך/העברה לנציג).
5. בסיום טבעי – שואלים "לפני שאני מסיימת, יש עוד משהו?" ואז משפט סגירה בלבד.
`.trim();

function buildOutboundInstructions(context = {}) {
  const base = (OUTBOUND_GENERAL_PROMPT || '').trim();
  const biz = (OUTBOUND_BUSINESS_PROMPT || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (biz) instructions += (instructions ? '\n\n' : '') + biz;

  if (!instructions) {
    instructions = `
אתם עוזרת קולית בזמן אמת בשם "${BOT_NAME}" שמתקשרת בשיחה יוצאת מטעם "${BUSINESS_NAME}".
דברו בעברית כברירת מחדל, בלשון רבים, בטון חם וקצר.
`.trim();
  }

  // Inject minimal context
  const ctxLines = [];
  if (context.recordId) ctxLines.push(`recordId: ${context.recordId}`);
  if (context.to) ctxLines.push(`יעד (to): ${context.to}`);
  if (context.from) ctxLines.push(`שיחה יוצאת ממספר (from): ${context.from}`);
  if (context.leadName) ctxLines.push(`שם ליד (אם קיים): ${context.leadName}`);

  if (ctxLines.length) {
    instructions += '\n\n' + `הקשר טכני לשיחה:\n${ctxLines.join('\n')}`;
  }

  instructions += '\n\n' + OUTBOUND_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Twilio REST helpers (OUTBOUND)
// -----------------------------
function basicAuthHeader() {
  return (
    'Basic ' +
    Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
  );
}

async function twilioCreateCall({ to, from, voiceWebhookUrl, statusCallbackUrl, recordId }) {
  const tag = 'TwilioCreateCall';

  if (!to || !from || !voiceWebhookUrl) {
    throw new Error('Missing to/from/voiceWebhookUrl');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`;

  const body = new URLSearchParams();
  body.set('To', to);
  body.set('From', from);
  body.set('Url', voiceWebhookUrl);

  // statusCallback (optional but recommended)
  if (statusCallbackUrl) {
    body.set('StatusCallback', statusCallbackUrl);
    body.set('StatusCallbackEvent', 'initiated ringing answered completed');
    body.set('StatusCallbackMethod', 'POST');
  }

  // Keep recordId for visibility in Twilio (optional)
  if (recordId) {
    // Twilio supports "MachineDetection" etc; recordId not native,
    // but we pass it through querystring in Url; still fine.
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    logError(tag, `Twilio Calls API HTTP ${res.status}`, text);
    throw new Error(`Twilio create call failed: ${res.status}`);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}

  logInfo(tag, 'Call created', { sid: json?.sid, to, from });
  return json;
}

async function hangupTwilioCall(callSid, tag = 'Hangup') {
  if (!callSid) return;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(tag, `Twilio hangup HTTP ${res.status}`, txt);
    } else {
      logInfo(tag, 'Twilio hangup requested');
    }
  } catch (err) {
    logError(tag, 'Twilio hangup error', err);
  }
}

// -----------------------------
// Express & server
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health
app.get('/outbound/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// 1) Dispatcher: Airtable -> POST כאן
app.post('/outbound/dispatch', async (req, res) => {
  const tag = 'Dispatch';
  try {
    const recordId = req.body?.recordId || null;

    // אתה יכול לשלוח מהאיירטייבל גם את זה/שם/וכו'
    const to = req.body?.to || req.body?.phone || null;     // מומלץ לשלוח כבר E164
    const from = req.body?.from || process.env.OUTBOUND_FROM_NUMBER || null;
    const leadName = req.body?.leadName || null;

    if (!to) return res.status(400).json({ ok: false, error: 'missing_to' });
    if (!from) return res.status(400).json({ ok: false, error: 'missing_from' });

    // voiceWebhookUrl - Twilio will request TwiML from here
    // We pass recordId/leadName in querystring so the TwiML can attach params into Stream
    const baseHost = DOMAIN ? DOMAIN.replace(/^https?:\/\//, '') : (req.headers.host || '');
    const origin = `https://${baseHost}`;

    const voiceWebhookUrl =
      `${origin}/outbound/twilio-voice?recordId=${encodeURIComponent(recordId || '')}&leadName=${encodeURIComponent(leadName || '')}&to=${encodeURIComponent(to)}&from=${encodeURIComponent(from)}`;

    const statusCallbackUrl =
      `${origin}/outbound/status?recordId=${encodeURIComponent(recordId || '')}`;

    const call = await twilioCreateCall({
      to,
      from,
      voiceWebhookUrl,
      statusCallbackUrl,
      recordId
    });

    // Optional: log webhook
    if (OUTBOUND_CALL_LOG_WEBHOOK_URL) {
      fetchWithTimeout(
        OUTBOUND_CALL_LOG_WEBHOOK_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'dispatch_created',
            recordId,
            to,
            from,
            callSid: call?.sid || null,
            ts: Date.now()
          })
        },
        4500
      ).catch(() => {});
    }

    res.json({ ok: true, recordId, to, from, callSid: call?.sid || null });
  } catch (err) {
    logError(tag, 'dispatch failed', err);
    res.status(500).json({ ok: false, error: 'dispatch_failed' });
  }
});

// 2) TwiML for outbound call -> connects stream
app.post('/outbound/twilio-voice', (req, res) => {
  const tag = 'TwiML';

  const baseHost = DOMAIN ? DOMAIN.replace(/^https?:\/\//, '') : (req.headers.host || '');
  const wsUrl = `wss://${baseHost}/outbound-media-stream`;

  // querystring values from /dispatch
  const recordId = req.query?.recordId || '';
  const leadName = req.query?.leadName || '';
  const to = req.query?.to || '';
  const from = req.query?.from || '';

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="recordId" value="${String(recordId).replace(/"/g, '')}"/>
      <Parameter name="leadName" value="${String(leadName).replace(/"/g, '')}"/>
      <Parameter name="to" value="${String(to).replace(/"/g, '')}"/>
      <Parameter name="from" value="${String(from).replace(/"/g, '')}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  logInfo(tag, `Returning TwiML for outbound stream: ${wsUrl}`);
  res.type('text/xml').send(twiml);
});

// 3) Status callback from Twilio
app.post('/outbound/status', async (req, res) => {
  try {
    const recordId = req.query?.recordId || null;

    // Twilio posts form-encoded fields like CallSid, CallStatus, To, From...
    const payload = {
      recordId,
      CallSid: req.body?.CallSid || null,
      CallStatus: req.body?.CallStatus || null,
      To: req.body?.To || null,
      From: req.body?.From || null,
      Timestamp: Date.now(),
      raw: req.body || {}
    };

    // Forward to Make / Airtable update if you want
    if (OUTBOUND_STATUS_WEBHOOK_URL) {
      fetchWithTimeout(
        OUTBOUND_STATUS_WEBHOOK_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        },
        4500
      ).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true }); // never break Twilio
  }
});

const server = http.createServer(app);

// -----------------------------
// WebSocket: Twilio Media Stream (OUTBOUND)
// -----------------------------
const wss = new WebSocket.Server({ server, path: '/outbound-media-stream' });

wss.on('connection', (connection) => {
  const tag = 'OutboundCall';
  logInfo(tag, 'New OUTBOUND Twilio Media Stream connection');

  if (!OPENAI_API_KEY) {
    logError(tag, 'OPENAI_API_KEY missing – closing connection.');
    connection.close();
    return;
  }

  let streamSid = null;
  let callSid = null;
  let to = null;
  let from = null;
  let recordId = null;
  let leadName = null;

  let conversationLog = [];
  let currentBotText = '';
  let callStartTs = Date.now();
  let lastMediaTs = Date.now();

  let idleWarningSent = false;
  let idleHangupScheduled = false;
  let idleInterval = null;

  let maxCallTimeout = null;
  let maxCallWarnTimeout = null;

  let pendingHangup = null;
  let graceHangupTimer = null;

  let openAiReady = false;
  let callEnded = false;

  let botSpeaking = false;
  let hasActiveResponse = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  function getGraceMs() {
    const raw = OUTBOUND_HANGUP_GRACE_MS > 0 ? OUTBOUND_HANGUP_GRACE_MS : 3000;
    return Math.max(2000, Math.min(raw, 8000));
  }

  function scheduleForceEndAfterGrace(reason) {
    if (callEnded) return;
    if (graceHangupTimer) return;

    const g = getGraceMs();
    logInfo(tag, `Scheduling hangup after grace ${g}ms. reason=${reason}`);

    graceHangupTimer = setTimeout(async () => {
      graceHangupTimer = null;
      if (callEnded) return;
      callEnded = true;

      // Hangup Twilio call if we have callSid
      if (callSid) hangupTwilioCall(callSid, tag).catch(() => {});

      try { connection.close(); } catch (_) {}
      try { openAiWs.close(); } catch (_) {}
    }, g);
  }

  function sendModelPrompt(text, purpose) {
    if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;
    if (hasActiveResponse) return;

    openAiWs.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }]
        }
      })
    );
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
    hasActiveResponse = true;
    botTurnActive = true;
    logInfo(tag, `Model prompt (${purpose || 'no-tag'}) sent`);
  }

  function sendIdleWarningIfNeeded() {
    if (idleWarningSent || callEnded) return;
    idleWarningSent = true;
    sendModelPrompt('תגיבי קצר: "אני על הקו, זה זמן נוח לדבר?"', 'idle_warning');
  }

  // OpenAI WS
  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, 'Connected to OpenAI Realtime');

    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;

    const instructions = buildOutboundInstructions({ recordId, to, from, leadName });

    openAiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          model: 'gpt-4o-realtime-preview-2024-12-17',
          modalities: ['audio', 'text'],
          voice: OPENAI_VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: MB_VAD_THRESHOLD,
            silence_duration_ms: effectiveSilenceMs,
            prefix_padding_ms: MB_VAD_PREFIX_MS
          },
          instructions
        }
      })
    );

    // Opening for outbound – template
    const opening = formatTemplate(OUTBOUND_OPENING_SCRIPT, { BUSINESS_NAME });
    sendModelPrompt(
      `פתחי שיחה יוצאת במשפט קצר בלבד: "${opening}". מיד אחר כך שאלי: "מפריע לכם דקה?" ואז עצרי.`,
      'opening'
    );
  });

  openAiWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    const type = msg.type;

    if (type === 'response.created') {
      currentBotText = '';
      hasActiveResponse = true;
      botTurnActive = true;
      botSpeaking = false;
      noListenUntilTs = Date.now() + OUTBOUND_NO_BARGE_TAIL_MS;
      return;
    }

    if (type === 'response.output_text.delta' || type === 'response.audio_transcript.delta') {
      const delta = msg.delta || '';
      if (delta) currentBotText += delta;
      return;
    }

    if (type === 'response.output_text.done' || type === 'response.audio_transcript.done') {
      const text = (currentBotText || '').trim();
      if (text) {
        conversationLog.push({ from: 'bot', text });
        logInfo('Bot', text);
      }
      currentBotText = '';
      return;
    }

    if (type === 'response.audio.delta') {
      const b64 = msg.delta;
      if (!b64 || !streamSid) return;

      botSpeaking = true;
      noListenUntilTs = Date.now() + OUTBOUND_NO_BARGE_TAIL_MS;

      if (connection.readyState === WebSocket.OPEN) {
        connection.send(
          JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } })
        );
      }
      return;
    }

    if (type === 'response.audio.done' || type === 'response.completed') {
      botSpeaking = false;
      botTurnActive = false;
      hasActiveResponse = false;

      if (pendingHangup && !callEnded) {
        pendingHangup = null;
        scheduleForceEndAfterGrace('closing_done');
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const t = (msg.transcript || '').trim();
      if (t) {
        conversationLog.push({ from: 'user', text: t });
        logInfo('User', t);
      }
      return;
    }

    if (type === 'error') {
      logError(tag, 'OpenAI error', msg);
      hasActiveResponse = false;
      botSpeaking = false;
      botTurnActive = false;
      noListenUntilTs = 0;
      return;
    }
  });

  openAiWs.on('close', () => {
    if (!callEnded) scheduleForceEndAfterGrace('openai_closed');
  });

  openAiWs.on('error', () => {
    if (!callEnded) scheduleForceEndAfterGrace('openai_error');
  });

  // Twilio Media Stream
  connection.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      // customParameters from TwiML <Parameter>
      recordId = msg.start?.customParameters?.recordId || null;
      leadName = msg.start?.customParameters?.leadName || null;
      to = msg.start?.customParameters?.to || null;
      from = msg.start?.customParameters?.from || null;

      callStartTs = Date.now();
      lastMediaTs = Date.now();

      logInfo(tag, `OUTBOUND start: streamSid=${streamSid}, callSid=${callSid}, recordId=${recordId}`);

      idleInterval = setInterval(() => {
        const now = Date.now();
        const since = now - lastMediaTs;

        if (!idleWarningSent && since >= OUTBOUND_IDLE_WARNING_MS && !callEnded) {
          sendIdleWarningIfNeeded();
        }
        if (!idleHangupScheduled && since >= OUTBOUND_IDLE_HANGUP_MS && !callEnded) {
          idleHangupScheduled = true;
          pendingHangup = true;
          sendModelPrompt(
            `סיימי בנימוס במשפט הבא בלבד: "${OUTBOUND_CLOSING_SCRIPT}"`,
            'idle_hangup'
          );
        }
      }, 1000);

      if (OUTBOUND_MAX_CALL_MS > 0) {
        if (OUTBOUND_MAX_WARN_BEFORE_MS > 0 && OUTBOUND_MAX_CALL_MS > OUTBOUND_MAX_WARN_BEFORE_MS) {
          maxCallWarnTimeout = setTimeout(() => {
            sendModelPrompt(
              'תגידי משפט קצר: "אנחנו עוד רגע מסיימים, תרצו שאשלח לכם פרטים או שנקבע שיחה קצרה?"',
              'max_call_warn'
            );
          }, OUTBOUND_MAX_CALL_MS - OUTBOUND_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          if (callEnded) return;
          pendingHangup = true;
          sendModelPrompt(
            `סיימי בנימוס במשפט הבא בלבד: "${OUTBOUND_CLOSING_SCRIPT}"`,
            'max_call_end'
          );
        }, OUTBOUND_MAX_CALL_MS);
      }

      return;
    }

    if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      if (!OUTBOUND_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) {
          logDebug(tag, 'Ignoring media (no barge-in)', { botTurnActive, botSpeaking, now, noListenUntilTs });
          return;
        }
      }

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      return;
    }

    if (event === 'stop') {
      logInfo(tag, 'Twilio stream stop');
      scheduleForceEndAfterGrace('twilio_stop');
      return;
    }
  });

  connection.on('close', () => {
    logInfo(tag, 'Twilio WS closed');
    if (!callEnded) scheduleForceEndAfterGrace('twilio_closed');
    if (idleInterval) clearInterval(idleInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarnTimeout) clearTimeout(maxCallWarnTimeout);
  });

  connection.on('error', (err) => {
    logError(tag, 'Twilio WS error', err);
    if (!callEnded) scheduleForceEndAfterGrace('twilio_error');
  });
});

// Start
server.listen(PORT, () => {
  console.log(`✅ OUTBOUND server running on port ${PORT}`);
  console.log(`   /outbound/dispatch`);
  console.log(`   /outbound/twilio-voice`);
  console.log(`   /outbound/status`);
  console.log(`   WS /outbound-media-stream`);
});
