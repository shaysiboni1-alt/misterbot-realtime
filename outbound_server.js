// outbound_server.js
//
// MisterBot Realtime OUTBOUND Voice Bot – "נטע" (שיחות יוצאות)
// Twilio Calls API -> TwiML -> Media Streams <-> OpenAI Realtime
//
// ✅ מופרד לחלוטין מה-INBOUND (קובץ נפרד, נתיבים נפרדים, ENV עם OUTBOUND_)
// ✅ כולל: סטטוסים, לוג, ניתוק אוטומטי אחרי סגירה (GRACE)
// ✅ כולל: Lead parsing + Summary (וובהוק נוסף לוואטסאפ שלך)
//
// Endpoints:
//   GET  /outbound/health
//   POST /outbound/twilio-voice        (TwiML)
//   POST /outbound/status              (StatusCallback from Twilio)
//
// WS:
//   /outbound-media-stream
//

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

let fetchFn = global.fetch;
if (!fetchFn) {
  // package.json כבר כולל node-fetch ^2.7.0
  fetchFn = require('node-fetch');
}

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

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function formatTemplate(str, vars) {
  return String(str || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// -----------------------------
// Core ENV
// -----------------------------
const PORT = envNumber('OUTBOUND_PORT', envNumber('PORT', 3001));
const OUTBOUND_DOMAIN = (process.env.OUTBOUND_DOMAIN || '').replace(/^https?:\/\//, '').trim();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');

// Twilio creds (לסטטוס/ניתוק)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID_OUTBOUND || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN_OUTBOUND || '';

const BOT_NAME = process.env.OUTBOUND_BOT_NAME || process.env.MB_BOT_NAME || 'נֶטַע';
const BUSINESS_NAME = process.env.OUTBOUND_BUSINESS_NAME || process.env.MB_BUSINESS_NAME || 'MisterBot';

const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru,ar').trim();

// Opening/Closing
const OUTBOUND_OPENING_SCRIPT = process.env.OUTBOUND_OPENING_SCRIPT || 'הֵיי… הַאִם אֲנִי מְדַבֶּרֶת עִם {FULL_NAME}?';
const OUTBOUND_CLOSING_SCRIPT = process.env.OUTBOUND_CLOSING_SCRIPT || 'תּוֹדָה רַבָּה. יוֹם נָעִים וּלְהִתְרָאוֹת.';

// Prompts
const OUTBOUND_GENERAL_PROMPT = process.env.OUTBOUND_GENERAL_PROMPT || '';
const OUTBOUND_BUSINESS_PROMPT = process.env.OUTBOUND_BUSINESS_PROMPT || '';

// Controls
const OUTBOUND_DEBUG = envBool('OUTBOUND_DEBUG', false);

const VAD_THRESHOLD = envNumber('OUTBOUND_VAD_THRESHOLD', envNumber('MB_VAD_THRESHOLD', 0.75));
const VAD_SILENCE_MS = envNumber('OUTBOUND_VAD_SILENCE_MS', envNumber('MB_VAD_SILENCE_MS', 900));
const VAD_PREFIX_MS = envNumber('OUTBOUND_VAD_PREFIX_MS', envNumber('MB_VAD_PREFIX_MS', 200));
const VAD_SUFFIX_MS = envNumber('OUTBOUND_VAD_SUFFIX_MS', envNumber('MB_VAD_SUFFIX_MS', 150));

const ALLOW_BARGE_IN = envBool('OUTBOUND_ALLOW_BARGE_IN', envBool('MB_ALLOW_BARGE_IN', true));
const NO_BARGE_TAIL_MS = envNumber('OUTBOUND_NO_BARGE_TAIL_MS', envNumber('MB_NO_BARGE_TAIL_MS', 1600));

const IDLE_WARNING_MS = envNumber('OUTBOUND_IDLE_WARNING_MS', 40000);
const IDLE_HANGUP_MS = envNumber('OUTBOUND_IDLE_HANGUP_MS', 90000);

const MAX_CALL_MS = envNumber('OUTBOUND_MAX_CALL_MS', 500000);
const MAX_WARN_BEFORE_MS = envNumber('OUTBOUND_MAX_WARN_BEFORE_MS', 45000);

const HANGUP_GRACE_MS = envNumber('OUTBOUND_HANGUP_GRACE_MS', envNumber('MB_HANGUP_GRACE_MS', 4000));

const OPENAI_REALTIME_MODEL =
  process.env.OUTBOUND_REALTIME_MODEL ||
  process.env.OPENAI_REALTIME_MODEL ||
  'gpt-4o-realtime-preview-2024-12-17';

const OPENAI_VOICE =
  process.env.OUTBOUND_OPENAI_VOICE ||
  process.env.OPENAI_VOICE ||
  'alloy';

// Webhooks
const OUTBOUND_STATUS_WEBHOOK_URL = process.env.OUTBOUND_STATUS_WEBHOOK_URL || ''; // Make status updates
const OUTBOUND_CALL_LOG_WEBHOOK_URL = process.env.OUTBOUND_CALL_LOG_WEBHOOK_URL || process.env.MB_CALL_LOG_WEBHOOK_URL || '';

const OUTBOUND_LEADS_WEBHOOK_URL = process.env.OUTBOUND_LEADS_WEBHOOK_URL || process.env.MB_LEADS_AIRTABLE_WEBHOOK_URL || '';
const OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL = process.env.OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL || ''; // חדש לוואטסאפ שלך

const LEAD_PARSING_MODEL = process.env.OUTBOUND_LEAD_PARSING_MODEL || process.env.MB_LEAD_PARSING_MODEL || 'gpt-4.1-mini';
const ENABLE_LEAD_CAPTURE = envBool('OUTBOUND_ENABLE_LEAD_CAPTURE', envBool('MB_ENABLE_LEAD_CAPTURE', true));

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
    const res = await fetchFn(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------
// Twilio REST (ניתוק שיחה לפי CallSid)
// -----------------------------
function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
}

async function hangupTwilioCall(callSid, tag = 'Hangup') {
  if (!callSid) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetchFn(url, {
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
      logInfo(tag, 'Twilio hangup requested', { callSid });
    }
  } catch (err) {
    logError(tag, 'Twilio hangup error', err);
  }
}

// -----------------------------
// OUTBOUND instructions builder
// -----------------------------
const OUTBOUND_BEHAVIOR_RULES = `
חוקי מערכת לשיחות יוצאות:
1) זו שיחה יוזמת: קודם מוודאים אדם נכון + זמן מתאים ("מַפְרִיעַ לָכֶם דַּקָּה?").
2) אם הלקוח אומר "לא" / "לא מעוניין" / "תסירו אותי" – מכבדים מיד, מתנצלים, ומסיימים. בלי להתווכח.
3) לא נשמעים כמו רובוט: תשובות קצרות, טבעיות, בלי נאומים.
4) לא מדברים על מחירים מספריים. רק מודל תמחור כללי והעברה לאיש מכירות.
5) אם יש עניין: עושים בירור צורך ראשוני קצר + אוספים פרטים (שם, עסק אם יש, טלפון לחזרה, צורך/כאב).
6) בסיום: מסכמים במשפט אחד, ואז אומרים רק את משפט הסגירה. לא מוסיפים שאלות אחרי הסגירה.
7) עברית עם ניקוד כברירת מחדל, לשון רבים. מעבר שפה טבעי לפי הלקוח (MB_LANGUAGES).
`.trim();

function buildOutboundInstructions(ctx) {
  const base = String(OUTBOUND_GENERAL_PROMPT || '').trim();
  const biz = String(OUTBOUND_BUSINESS_PROMPT || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (biz) instructions += (instructions ? '\n\n' : '') + biz;

  if (!instructions) {
    instructions = `
אתם "נֶטַע" — בוט קולי בזמן אמת שמבצע שיחה יוצאת מטעם "${BUSINESS_NAME}".
עברית עם ניקוד כברירת מחדל, לשון רבים, טון חם וקצר, נשמע אנושי.
`.trim();
  }

  const ctxLines = [];
  if (ctx.outboundId) ctxLines.push(`outbound_id: ${ctx.outboundId}`);
  if (ctx.fullName) ctxLines.push(`שם יעד (full_name): ${ctx.fullName}`);
  if (ctx.to) ctxLines.push(`טלפון יעד (to): ${ctx.to}`);
  if (ctx.from) ctxLines.push(`מספר יוצא (from): ${ctx.from}`);

  if (ctxLines.length) {
    instructions += '\n\n' + `הקשר טכני לשיחה:\n${ctxLines.join('\n')}`;
  }

  instructions += '\n\n' + OUTBOUND_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Lead parsing + Summary
// -----------------------------
function buildLeadParserPrompt(payload) {
  return `
אתה מנתח שיחה יוצאת של בוט מכירות בשם "נטע" מטעם MisterBot.
המטרה: להחזיר JSON תקין בלבד, בלי טקסט נוסף.

כללים:
- interested=true רק אם הלקוח הביע עניין אמיתי/רצון לשמוע/ביקש פרטים/הסכים לשיחה חוזרת/מסר פרטים.
- אם הלקוח אמר "לא מעוניין" / "תסירו" / "הפרעה" => interested=false.
- phone: אם נאמר מספר – החזר E164 אם אפשר; אם לא נאמר, השתמש ב-to אם הוא נראה טלפון.
- full_name: מהעמודה full_name אם קיימת; אחרת מהשיחה אם נאמר; אחרת null.
- business_name: אם נאמר; אחרת null.
- pain_points: מערך קצר (למשל ["פספוס שיחות", "שירות לקוחות"]).
- next_step: "sales_callback" / "send_whatsapp" / "schedule_call" / "not_interested"
- client_summary_he: סיכום קצר בעברית (עם ניקוד), 1-2 משפטים, שמתאים לשליחה ללקוח בוואטסאפ.
- internal_summary: סיכום קצר לצוות (ללא ניקוד, תמציתי).
- objections: מערך קצר אם היו.
- consent_to_contact: true אם הלקוח הסכים לחזרה/שליחה.

הנה הנתונים:
${JSON.stringify(payload, null, 2)}

החזר JSON בלבד בפורמט:
{
  "interested": boolean,
  "consent_to_contact": boolean,
  "full_name": string|null,
  "business_name": string|null,
  "phone": string|null,
  "pain_points": string[],
  "objections": string[],
  "next_step": "sales_callback"|"send_whatsapp"|"schedule_call"|"not_interested",
  "client_summary_he": string|null,
  "internal_summary": string
}
`.trim();
}

async function parseLeadAndSummary({ outboundId, fullName, to, from, transcript }) {
  const tag = 'LeadParser';

  if (!OPENAI_API_KEY) return null;

  const payload = {
    outbound_id: outboundId || null,
    full_name: fullName || null,
    to: to || null,
    from: from || null,
    transcript: transcript || ''
  };

  const prompt = buildLeadParserPrompt(payload);

  try {
    const res = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: LEAD_PARSING_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'You output ONLY valid JSON. No markdown. No extra text.' },
            { role: 'user', content: prompt }
          ]
        })
      },
      9000
    );

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      logError(tag, `OpenAI parser HTTP ${res.status}`, text);
      return null;
    }

    const json = safeJsonParse(text);
    const content = json?.choices?.[0]?.message?.content || '';
    const parsed = safeJsonParse(content);

    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    logError(tag, 'parseLeadAndSummary error', e);
    return null;
  }
}

async function maybeSendLeadWebhooks({ lead, outboundId, to, from }) {
  if (!lead) return;

  const interested = !!lead.interested;
  const consent = lead.consent_to_contact !== false; // default true if not provided
  const phone = lead.phone || to || null;

  const hasMinimum = interested && consent && phone;

  if (!hasMinimum) return;

  // 1) leads webhook (Airtable/Make)
  if (ENABLE_LEAD_CAPTURE && OUTBOUND_LEADS_WEBHOOK_URL) {
    fetchWithTimeout(
      OUTBOUND_LEADS_WEBHOOK_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'outbound_lead',
          outbound_id: outboundId || null,
          phone,
          from: from || null,
          full_name: lead.full_name || null,
          business_name: lead.business_name || null,
          pain_points: lead.pain_points || [],
          objections: lead.objections || [],
          next_step: lead.next_step || 'sales_callback',
          internal_summary: lead.internal_summary || '',
          ts: Date.now()
        })
      },
      4500
    ).catch(() => {});
  }

  // 2) client summary webhook (וואטסאפ שלך)
  if (OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL) {
    fetchWithTimeout(
      OUTBOUND_CLIENT_SUMMARY_WEBHOOK_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'outbound_client_summary',
          outbound_id: outboundId || null,
          phone,
          full_name: lead.full_name || null,
          client_summary_he: lead.client_summary_he || null,
          ts: Date.now()
        })
      },
      4500
    ).catch(() => {});
  }
}

// -----------------------------
// Express server
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health
app.get('/outbound/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// TwiML endpoint for OUTBOUND: Twilio calls THIS to get <Connect><Stream>
app.post('/outbound/twilio-voice', (req, res) => {
  const baseHost = OUTBOUND_DOMAIN || (req.headers.host || '');
  const wsUrl = `wss://${baseHost}/outbound-media-stream`;

  // You can pass params via querystring (recommended from Airtable/Twilio Function)
  const outboundId = req.query?.outbound_id || req.query?.outboundId || '';
  const fullName = req.query?.full_name || req.query?.fullName || '';
  const to = req.query?.to || '';
  const from = req.query?.from || '';

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="outbound_id" value="${String(outboundId).replace(/"/g, '')}"/>
      <Parameter name="full_name" value="${String(fullName).replace(/"/g, '')}"/>
      <Parameter name="to" value="${String(to).replace(/"/g, '')}"/>
      <Parameter name="from" value="${String(from).replace(/"/g, '')}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// Status callback from Twilio
app.post('/outbound/status', async (req, res) => {
  try {
    const outboundId = req.query?.outbound_id || req.query?.outboundId || null;

    const payload = {
      event: 'twilio_status',
      outbound_id: outboundId,
      CallSid: req.body?.CallSid || null,
      CallStatus: req.body?.CallStatus || null,
      To: req.body?.To || null,
      From: req.body?.From || null,
      Timestamp: Date.now(),
      raw: req.body || {}
    };

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
  } catch {
    res.status(200).json({ ok: true });
  }
});

const server = http.createServer(app);

// -----------------------------
// WebSocket: Twilio Media Stream (OUTBOUND)
// -----------------------------
const wss = new WebSocket.Server({ server, path: '/outbound-media-stream' });

wss.on('connection', (connection) => {
  const tag = 'OUTBOUND';
  if (!OPENAI_API_KEY) {
    connection.close();
    return;
  }

  let streamSid = null;
  let callSid = null;

  let outboundId = null;
  let fullName = null;
  let to = null;
  let from = null;

  let conversationLog = []; // {from:'user'|'bot', text:''}
  let currentBotText = '';

  let callEnded = false;
  let openAiReady = false;

  let hasActiveResponse = false;
  let botSpeaking = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  let lastMediaTs = Date.now();
  let idleWarningSent = false;
  let idleHangupScheduled = false;

  let idleInterval = null;
  let maxCallTimeout = null;
  let maxCallWarnTimeout = null;

  let pendingHangup = false;
  let graceHangupTimer = null;

  function getGraceMs() {
    const raw = HANGUP_GRACE_MS > 0 ? HANGUP_GRACE_MS : 4000;
    return Math.max(2000, Math.min(raw, 8000));
  }

  async function finalizeAndSendWebhooks(reason) {
    try {
      const transcript = conversationLog
        .map((m) => `${m.from === 'user' ? 'USER' : 'BOT'}: ${m.text}`)
        .join('\n');

      // call log webhook (optional)
      if (OUTBOUND_CALL_LOG_WEBHOOK_URL) {
        fetchWithTimeout(
          OUTBOUND_CALL_LOG_WEBHOOK_URL,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'outbound_call_log',
              reason,
              outbound_id: outboundId,
              callSid,
              to,
              from,
              ts: Date.now(),
              transcript
            })
          },
          4500
        ).catch(() => {});
      }

      // Lead parse + summary -> only if interested+details
      const lead = await parseLeadAndSummary({
        outboundId,
        fullName,
        to,
        from,
        transcript
      });

      await maybeSendLeadWebhooks({ lead, outboundId, to, from });
    } catch (e) {
      logError(tag, 'finalizeAndSendWebhooks error', e);
    }
  }

  function scheduleForceEndAfterGrace(reason) {
    if (callEnded) return;
    if (graceHangupTimer) return;

    const g = getGraceMs();
    graceHangupTimer = setTimeout(async () => {
      graceHangupTimer = null;
      if (callEnded) return;
      callEnded = true;

      // ניתוק טלפוני אמיתי אחרי GRACE
      if (callSid) await hangupTwilioCall(callSid, `${tag}-Hangup`);

      await finalizeAndSendWebhooks(reason);

      try { connection.close(); } catch {}
      try { openAiWs.close(); } catch {}
    }, g);
  }

  function sendModelPrompt(text, purpose) {
    if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;
    if (hasActiveResponse) return;

    openAiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    }));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));

    hasActiveResponse = true;
    botTurnActive = true;
    logDebug(tag, `prompt sent (${purpose || 'no-tag'})`);
  }

  function sendIdleWarningIfNeeded() {
    if (idleWarningSent || callEnded) return;
    idleWarningSent = true;
    sendModelPrompt('תַּגִּיבִי קָצָר: "אֲנִי עַל הַקּוֹ, זֶה זְמַן נוֹחַ לְדַבֵּר?"', 'idle_warning');
  }

  // OpenAI Realtime WS
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openAiWs.on('open', () => {
    openAiReady = true;

    const effectiveSilenceMs = VAD_SILENCE_MS + VAD_SUFFIX_MS;

    // instructions (כולל הקשר של fullName וכו')
    const instructions = buildOutboundInstructions({ outboundId, fullName, to, from });

    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ['audio', 'text'],
        voice: OPENAI_VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: VAD_THRESHOLD,
          silence_duration_ms: effectiveSilenceMs,
          prefix_padding_ms: VAD_PREFIX_MS
        },
        instructions
      }
    }));

    // Opening: אם אין שם -> הנחיה להחליף לנוסח כללי
    const nameValue = (fullName || '').trim();
    const opening = formatTemplate(OUTBOUND_OPENING_SCRIPT, {
      FULL_NAME: nameValue || 'בַּעַל/ת הָעֵסֶק',
      BUSINESS_NAME
    });

    const openingDirective = nameValue
      ? `פִּתְחִי בְּמִשְׁפָּט זֶה בִּלְבַד: "${opening}" אַחֲרֵי זֶה שַׁאֲלִי: "מַפְרִיעַ לָכֶם דַּקָּה?" וְתַעַצְרִי.`
      : `פִּתְחִי בְּ"הֵיי… (הַפְסָקָה קְצָרָה). הַאִם הִגַּעְתִּי לְבַעַל/ת הָעֵסֶק?" אַחֲרֵי זֶה שַׁאֲלִי: "מַפְרִיעַ לָכֶם דַּקָּה?" וְתַעַצְרִי.`;

    sendModelPrompt(openingDirective, 'opening');
  });

  openAiWs.on('message', (data) => {
    const msg = safeJsonParse(data.toString());
    if (!msg) return;

    const type = msg.type;

    if (type === 'response.created') {
      currentBotText = '';
      hasActiveResponse = true;
      botTurnActive = true;
      botSpeaking = false;
      noListenUntilTs = Date.now() + NO_BARGE_TAIL_MS;
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
        logInfo('BOT', text);
      }
      currentBotText = '';
      return;
    }

    if (type === 'response.audio.delta') {
      const b64 = msg.delta;
      if (!b64 || !streamSid) return;

      botSpeaking = true;
      noListenUntilTs = Date.now() + NO_BARGE_TAIL_MS;

      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
      }
      return;
    }

    if (type === 'response.audio.done' || type === 'response.completed') {
      botSpeaking = false;
      botTurnActive = false;
      hasActiveResponse = false;

      if (pendingHangup && !callEnded) {
        pendingHangup = false;
        scheduleForceEndAfterGrace('closing_done');
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const t = (msg.transcript || '').trim();
      if (t) {
        conversationLog.push({ from: 'user', text: t });
        logInfo('USER', t);
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

  // Twilio Media Stream WS
  connection.on('message', (data) => {
    const msg = safeJsonParse(data.toString());
    if (!msg) return;

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      outboundId = msg.start?.customParameters?.outbound_id || msg.start?.customParameters?.outboundId || null;
      fullName = msg.start?.customParameters?.full_name || msg.start?.customParameters?.fullName || null;
      to = msg.start?.customParameters?.to || null;
      from = msg.start?.customParameters?.from || null;

      lastMediaTs = Date.now();

      // idle timers
      idleInterval = setInterval(() => {
        const now = Date.now();
        const since = now - lastMediaTs;

        if (!idleWarningSent && since >= IDLE_WARNING_MS && !callEnded) {
          sendIdleWarningIfNeeded();
        }
        if (!idleHangupScheduled && since >= IDLE_HANGUP_MS && !callEnded) {
          idleHangupScheduled = true;
          pendingHangup = true;
          sendModelPrompt(`סַיְּמִי בְּנִימוּס בְּמִשְׁפָּט הַזֶּה בִּלְבַד: "${OUTBOUND_CLOSING_SCRIPT}"`, 'idle_hangup');
        }
      }, 1000);

      // max call timers
      if (MAX_CALL_MS > 0) {
        if (MAX_WARN_BEFORE_MS > 0 && MAX_CALL_MS > MAX_WARN_BEFORE_MS) {
          maxCallWarnTimeout = setTimeout(() => {
            sendModelPrompt(
              'תֹּאמְרוּ מִשְׁפָּט קָצָר: "אֲנַחְנוּ תֵּכֶף מְסַיְּמִים, תִּרְצוּ שֶׁנִּשְׁלַח פְּרָטִים בְּוָאטְסְאַפּ אוֹ שֶׁנְּתַאֵם שִׂיחָה קְצָרָה?"',
              'max_call_warn'
            );
          }, MAX_CALL_MS - MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          if (callEnded) return;
          pendingHangup = true;
          sendModelPrompt(`סַיְּמִי בְּנִימוּס בְּמִשְׁפָּט הַזֶּה בִּלְבַד: "${OUTBOUND_CLOSING_SCRIPT}"`, 'max_call_end');
        }, MAX_CALL_MS);
      }

      logInfo(tag, 'start', { streamSid, callSid, outboundId, fullName });
      return;
    }

    if (event === 'media') {
      lastMediaTs = Date.now();

      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      if (!ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) {
          logDebug(tag, 'Ignoring media (no barge-in)', { botTurnActive, botSpeaking });
          return;
        }
      }

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      return;
    }

    if (event === 'stop') {
      scheduleForceEndAfterGrace('twilio_stop');
      return;
    }
  });

  connection.on('close', () => {
    if (!callEnded) scheduleForceEndAfterGrace('twilio_closed');
    if (idleInterval) clearInterval(idleInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarnTimeout) clearTimeout(maxCallWarnTimeout);
  });

  connection.on('error', (err) => {
    logError(tag, 'twilio_ws_error', err);
    if (!callEnded) scheduleForceEndAfterGrace('twilio_error');
  });
});

// Start
server.listen(PORT, () => {
  console.log(`✅ OUTBOUND server running on port ${PORT}`);
  console.log(`   Health:   /outbound/health`);
  console.log(`   TwiML:    POST /outbound/twilio-voice`);
  console.log(`   Status:   POST /outbound/status`);
  console.log(`   WS:       /outbound-media-stream`);
});
