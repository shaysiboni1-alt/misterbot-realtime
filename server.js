// server.js
//
// MisterBot Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (gpt-4o-realtime-preview-2024-12-17)
//
// חוקים עיקריים לפי ה-MASTER PROMPT:
// - שיחה בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
// - שליטה מלאה דרך ENV (פתיח, סגיר, פרומפט כללי, KB עסקי, טיימרים, לידים, VAD).
// - טיימר שקט + ניתוק אוטומטי + מגבלת זמן שיחה.
// - לוג שיחה + וובהוק לידים (אם מופעל) + PARSING חכם ללידים.
//
// דרישות:
//   npm install express ws dotenv
//   (מומלץ Node 18+ כדי ש-fetch יהיה זמין גלובלית)
//
// Twilio Voice Webhook ->  POST /twilio-voice  (TwiML)
// Twilio Media Streams -> wss://<domain>/twilio-media-stream
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
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in ENV.');
}

const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'MisterBot';

const MB_OPENING_SCRIPT =
  process.env.MB_OPENING_SCRIPT ||
  'שלום, הגעתם למיסטר בוט – פתרונות בינה מלאכותית ובוטים קוליים לעסקים. שמי נטע, איך אפשר לעזור לכם היום?';

const MB_CLOSING_SCRIPT =
  process.env.MB_CLOSING_SCRIPT ||
  'תודה שדיברתם עם מיסטר בוט, יום נעים ולהתראות.';

const MB_GENERAL_PROMPT = process.env.MB_GENERAL_PROMPT || '';
const MB_BUSINESS_PROMPT = process.env.MB_BUSINESS_PROMPT || '';

const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 1.15);
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

// -----------------------------
// ✅ Dashboard / Make webhooks
// -----------------------------
const MB_SETTINGS_API_URL = process.env.MB_SETTINGS_API_URL || ''; // optional
const MB_CALL_LOG_WEBHOOK_URL = process.env.MB_CALL_LOG_WEBHOOK_URL || ''; // Calls -> Airtable
const MB_CALL_LOG_ENABLED = envBool('MB_CALL_LOG_ENABLED', !!MB_CALL_LOG_WEBHOOK_URL);
const MB_SETTINGS_MIN_INTERVAL_MS = envNumber('MB_SETTINGS_MIN_INTERVAL_MS', 60 * 1000);

// ✅ Leads -> Airtable (separate from mail lead)
const MB_LEADS_AIRTABLE_WEBHOOK_URL = process.env.MB_LEADS_AIRTABLE_WEBHOOK_URL || '';
const MB_LEADS_AIRTABLE_ENABLED = envBool(
  'MB_LEADS_AIRTABLE_ENABLED',
  !!MB_LEADS_AIRTABLE_WEBHOOK_URL
);

let remoteSettings = {
  bot_name: BOT_NAME,
  opening_script: null,
  closing_script: null,
  master_prompt: null,
  business_prompt: null,
  openai_voice: null,
  speech_speed: null
};
let lastSettingsFetchAt = 0;

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

// ✅ Fix for broken JSON from Make: sanitize missing values like  "x": ,  => "x": null,
function sanitizePossiblyBrokenJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;

  // Replace missing value after ":" before comma/} or newline => null
  // Example: "max_call_minutes": ,  => "max_call_minutes": null,
  return s.replace(/":\s*(?=[,\}\n\r])/g, '": null');
}

function tryParseJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ✅ read JSON safely, tolerate empty body and tolerate broken JSON by sanitizing once
async function safeReadSettingsJson(res, tag = 'Settings') {
  const txt = await res.text().catch(() => '');
  const raw = (txt || '').trim();
  if (!raw) return null;

  // First try direct parse
  let data = tryParseJson(raw);
  if (data) return data;

  // Try sanitize
  const fixed = sanitizePossiblyBrokenJson(raw);
  data = tryParseJson(fixed);
  if (data) return data;

  // Still broken => ignore (do not spam full raw)
  console.warn(`[WARN][${tag}] Settings webhook returned invalid JSON (ignored). snippet=`, raw.slice(0, 220));
  return null;
}

async function refreshRemoteSettings(tag = 'Settings') {
  if (!MB_SETTINGS_API_URL) return;

  const now = Date.now();
  if (tag !== 'Startup' && now - lastSettingsFetchAt < MB_SETTINGS_MIN_INTERVAL_MS) {
    return;
  }

  try {
    const res = await fetchWithTimeout(
      MB_SETTINGS_API_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_name: BOT_NAME })
      },
      4500
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[ERROR][${tag}] Settings webhook HTTP ${res.status}`, (txt || '').slice(0, 300));
      return;
    }

    const data = await safeReadSettingsJson(res, tag);
    if (!data) {
      // empty or invalid => ignore safely
      lastSettingsFetchAt = Date.now();
      return;
    }

    if (typeof data !== 'object') {
      console.warn(`[WARN][${tag}] Settings webhook returned non-object JSON (ignored).`);
      lastSettingsFetchAt = Date.now();
      return;
    }

    const s = data.settings && typeof data.settings === 'object' ? data.settings : data;

    remoteSettings = {
      ...remoteSettings,
      bot_name: s.bot_name || BOT_NAME,
      opening_script: s.opening_script ?? remoteSettings.opening_script,
      closing_script: s.closing_script ?? remoteSettings.closing_script,
      master_prompt: s.master_prompt ?? remoteSettings.master_prompt,
      business_prompt: s.business_prompt ?? remoteSettings.business_prompt,
      openai_voice: s.openai_voice ?? remoteSettings.openai_voice,
      speech_speed: s.speech_speed ?? remoteSettings.speech_speed
    };

    lastSettingsFetchAt = Date.now();
    console.log(`[INFO][${tag}] Remote settings loaded/updated.`);
  } catch (err) {
    console.error(`[ERROR][${tag}] Failed to refresh remote settings`, err);
  }
}

function getOpeningScript() {
  return (remoteSettings.opening_script || '').trim() || MB_OPENING_SCRIPT;
}
function getClosingScript() {
  return (remoteSettings.closing_script || '').trim() || MB_CLOSING_SCRIPT;
}
function getEffectiveOpenAiVoice() {
  return (remoteSettings.openai_voice || '').trim() || OPENAI_VOICE;
}
function getEffectiveSpeechSpeed() {
  const v = Number(remoteSettings.speech_speed);
  if (Number.isFinite(v) && v > 0) return v;
  return MB_SPEECH_SPEED;
}

// -----------------------------
// MAX_OUTPUT_TOKENS
// -----------------------------
const MAX_OUTPUT_TOKENS_ENV = process.env.MAX_OUTPUT_TOKENS;
let MAX_OUTPUT_TOKENS = 'inf';
if (MAX_OUTPUT_TOKENS_ENV) {
  const n = Number(MAX_OUTPUT_TOKENS_ENV);
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_TOKENS = n;
  else if (MAX_OUTPUT_TOKENS_ENV === 'inf') MAX_OUTPUT_TOKENS = 'inf';
}

function normalizeForClosing(text) {
  return (text || '')
    .toLowerCase()
    .replace(/["'״׳]/g, '')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// VAD
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);

const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 5000);

const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 1600);

// Leads / Mail webhook (existing – do not change)
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL || '';

// Parsing
const MB_ENABLE_SMART_LEAD_PARSING = envBool('MB_ENABLE_SMART_LEAD_PARSING', true);
const MB_LEAD_PARSING_MODEL = process.env.MB_LEAD_PARSING_MODEL || 'gpt-4.1-mini';

// Debug
const MB_DEBUG = envBool('MB_DEBUG', false);

// Twilio hangup
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

console.log(`[CONFIG] MB_HANGUP_GRACE_MS=${MB_HANGUP_GRACE_MS} ms`);

// -----------------------------
// Dynamic KB
// -----------------------------
const MB_DYNAMIC_KB_URL = process.env.MB_DYNAMIC_KB_URL || '';
let dynamicBusinessPrompt = '';

let lastDynamicKbRefreshAt = 0;
const MB_DYNAMIC_KB_MIN_INTERVAL_MS = envNumber('MB_DYNAMIC_KB_MIN_INTERVAL_MS', 5 * 60 * 1000);

async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) return;

  const now = Date.now();
  if (tag !== 'Startup' && now - lastDynamicKbRefreshAt < MB_DYNAMIC_KB_MIN_INTERVAL_MS) {
    console.log(
      `[INFO][${tag}] Skipping dynamic KB refresh – refreshed ${now - lastDynamicKbRefreshAt} ms ago (min interval ${MB_DYNAMIC_KB_MIN_INTERVAL_MS} ms).`
    );
    return;
  }

  try {
    const res = await fetch(MB_DYNAMIC_KB_URL);
    if (!res.ok) {
      console.error(`[ERROR][${tag}] Failed to fetch dynamic KB. HTTP ${res.status}`);
      return;
    }
    const text = (await res.text()).trim();
    dynamicBusinessPrompt = text;
    lastDynamicKbRefreshAt = Date.now();
    console.log(`[INFO][${tag}] Dynamic KB loaded. length=${text.length}`);
  } catch (err) {
    console.error(`[ERROR][${tag}] Error fetching dynamic KB`, err);
  }
}

// -----------------------------
// Logging helpers
// -----------------------------
function logDebug(tag, msg, extra) {
  if (!MB_DEBUG) return;
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

// -----------------------------
// Phone helpers
// -----------------------------
function normalizePhoneNumber(rawPhone, callerNumber) {
  function toDigits(num) {
    if (!num) return null;
    return String(num).replace(/\D/g, '');
  }
  function normalize972(digits) {
    if (digits.startsWith('972') && (digits.length === 11 || digits.length === 12)) {
      return '0' + digits.slice(3);
    }
    return digits;
  }
  function isValidIsraeliPhone(digits) {
    if (!/^0\d{8,9}$/.test(digits)) return false;
    const prefix2 = digits.slice(0, 2);
    if (digits.length === 9) return ['02', '03', '04', '07', '08', '09'].includes(prefix2);
    if (prefix2 === '05' || prefix2 === '07') return true;
    if (['02', '03', '04', '07', '08', '09'].includes(prefix2)) return true;
    return false;
  }
  function clean(num) {
    let digits = toDigits(num);
    if (!digits) return null;
    digits = normalize972(digits);
    if (!isValidIsraeliPhone(digits)) return null;
    return digits;
  }
  return clean(rawPhone) || clean(callerNumber) || null;
}
function toE164IL(normalized0) {
  const d = (normalized0 || '').trim();
  if (!d || !d.startsWith('0')) return null;
  return `+972${d.slice(1)}`;
}

// -----------------------------
// System instructions
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1. תשובות קצרות וממוקדות.
2. לא לסיים שיחה לבד בגלל "תודה"/"זהו" וכו', אלא רק כשמתבקשים לסיים.
3. בסיום – לומר את משפט הסיום המדויק בלבד.
4. לפני סיום טבעי – לשאול "לפני שאני מסיימת..." ואם הלקוח אומר שאין עוד שאלות – לסגור.
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const staticKb = (MB_BUSINESS_PROMPT || '').trim();
  const dynamicKb = (dynamicBusinessPrompt || '').trim();

  const remoteMaster = (remoteSettings.master_prompt || '').trim();
  const remoteBiz = (remoteSettings.business_prompt || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (remoteMaster) instructions += (instructions ? '\n\n' : '') + remoteMaster;

  if (staticKb) instructions += (instructions ? '\n\n' : '') + staticKb;
  if (remoteBiz) instructions += (instructions ? '\n\n' : '') + remoteBiz;

  if (dynamicKb) instructions += (instructions ? '\n\n' : '') + dynamicKb;

  if (!instructions) {
    instructions = `אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}". דברו בעברית.`;
  }

  instructions += '\n\n' + EXTRA_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Express
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/twilio-voice', (req, res) => {
  const host = process.env.DOMAIN || req.headers.host;
  const wsUrl =
    process.env.MB_TWILIO_STREAM_URL ||
    `wss://${host.replace(/^https?:\/\//, '')}/twilio-media-stream`;

  const caller = req.body.From || '';

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  logInfo('Twilio-Voice', `Returning TwiML with Stream URL: ${wsUrl}, From=${caller}`);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Lead parsing
// -----------------------------
async function extractLeadFromConversation(conversationLog) {
  const tag = 'LeadParse';
  if (!MB_ENABLE_SMART_LEAD_PARSING) return null;
  if (!OPENAI_API_KEY) return null;
  if (!Array.isArray(conversationLog) || conversationLog.length === 0) return null;

  try {
    const conversationText = conversationLog
      .map((m) => `${m.from === 'user' ? 'לקוח' : BOT_NAME}: ${m.text}`)
      .join('\n');

    const systemPrompt = `
החזר אך ורק JSON תקין לפי הסכמה:
{
  "is_lead": boolean,
  "lead_type": "new" | "existing" | "unknown",
  "full_name": string | null,
  "business_name": string | null,
  "phone_number": string | null,
  "reason": string | null,
  "notes": string | null
}
`.trim();

    const userPrompt = `תמלול:\n${conversationText}`.trim();

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MB_LEAD_PARSING_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) return null;

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      logInfo(tag, 'Lead parsed successfully.', parsed);
      return parsed;
    } catch {
      return null;
    }
  } catch (err) {
    logError(tag, 'Error in extractLeadFromConversation', err);
    return null;
  }
}

// -----------------------------
// Twilio hangup
// -----------------------------
async function hangupTwilioCall(callSid, tag = 'Call') {
  if (!callSid) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (res.ok) logInfo(tag, 'Twilio call hangup requested successfully.');
  } catch (err) {
    logError(tag, 'Error calling Twilio hangup API', err);
  }
}

async function fetchCallerNumberFromTwilio(callSid, tag = 'Call') {
  if (!callSid) return null;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
      }
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.from || null;
  } catch (err) {
    logError(tag, 'fetchCallerNumberFromTwilio error', err);
    return null;
  }
}

// -----------------------------
// Main call handler
// -----------------------------
wss.on('connection', (connection) => {
  const tag = 'Call';
  logInfo(tag, 'New Twilio Media Stream connection established.');

  refreshRemoteSettings('OnConnect').catch(() => {});

  let streamSid = null;
  let callSid = null;
  let callerNumber = null;

  const instructions = buildSystemInstructions();

  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let conversationLog = [];
  let currentBotText = '';
  let callStartTs = Date.now();
  let lastMediaTs = Date.now();

  let idleCheckInterval = null;
  let idleWarningSent = false;
  let idleHangupScheduled = false;

  let maxCallTimeout = null;
  let maxCallWarningTimeout = null;

  let pendingHangup = null;
  let openAiReady = false;
  let callEnded = false;

  let botSpeaking = false;
  let hasActiveResponse = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  let leadWebhookSent = false;
  let leadAirtableSent = false;

  let lastBotAskedPreCloseAt = 0;
  const PRECLOSE_WINDOW_MS = 60 * 1000;

  function sendModelPrompt(text, purpose) {
    if (openAiWs.readyState !== WebSocket.OPEN) return;
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
    logInfo(tag, `Sending model prompt (${purpose || 'no-tag'})`);
  }

  function botAskedPreClose(text) {
    const t = normalizeForClosing(text || '');
    return t.includes('לפני שאני מסיימת') || t.includes('לפני שאסיים');
  }

  function userConfirmedClose(text) {
    const t = normalizeForClosing(text || '');
    if (!t) return false;
    const patterns = [
      'הכל ברור',
      'הכול ברור',
      'זהו',
      'זה הכל',
      'זה הכול',
      'לא',
      'לא תודה',
      'אין עוד',
      'תודה',
      'ביי',
      'להתראות',
      'בסדר',
      'סבבה'
    ];
    return t.length <= 25 && patterns.some((p) => t.includes(p));
  }

  function transcriptAsText() {
    return conversationLog.map((m) => `${m.from === 'user' ? 'לקוח' : BOT_NAME}: ${m.text}`).join('\n');
  }

  function mapCallStatus(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('error')) return 'error';
    if (r.includes('twilio') || r.includes('ws_closed') || r.includes('stop')) return 'abandoned';
    return 'completed';
  }

  async function sendCallLogWebhook({ reason, parsedLead }) {
    if (!MB_CALL_LOG_ENABLED || !MB_CALL_LOG_WEBHOOK_URL) return;

    try {
      if (!callerNumber && callSid) {
        const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
        if (resolved) callerNumber = resolved;
      }

      const startedAt = new Date(callStartTs).toISOString();
      const endedAt = new Date().toISOString();
      const durationSec = Math.max(0, Math.round((Date.now() - callStartTs) / 1000));

      const lastUser = [...conversationLog].reverse().find((m) => m.from === 'user')?.text || '';
      const caller0 = normalizePhoneNumber(null, callerNumber);
      const collected0 = normalizePhoneNumber(parsedLead?.phone_number, callerNumber);

      const payload = {
        call_id: callSid || streamSid || `call_${Date.now()}`,
        call_direction: 'inbound',
        started_at: startedAt,
        ended_at: endedAt,
        duration_sec: durationSec,

        caller_id: caller0 || null,
        collected_phone: collected0 || null,

        caller_id_e164: caller0 ? toE164IL(caller0) : null,
        collected_phone_e164: collected0 ? toE164IL(collected0) : null,

        contact_name: parsedLead?.full_name || null,
        call_status: mapCallStatus(reason),
        last_user_utterance: lastUser || null,
        transcript: transcriptAsText(),
        summary: parsedLead?.reason || null,
        has_lead: parsedLead?.is_lead === true,

        lead_type: parsedLead?.lead_type || null,
        lead_notes: parsedLead?.notes || null,
        reason: reason || null,
        streamSid: streamSid || null,
        callSid: callSid || null
      };

      await fetchWithTimeout(
        MB_CALL_LOG_WEBHOOK_URL,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        4500
      ).catch(() => {});
    } catch (err) {
      logError(tag, 'sendCallLogWebhook error', err);
    }
  }

  async function sendLeadToAirtable({ parsedLead, reason }) {
    if (!MB_LEADS_AIRTABLE_ENABLED || !MB_LEADS_AIRTABLE_WEBHOOK_URL) return;
    if (leadAirtableSent) return;
    if (!parsedLead || typeof parsedLead !== 'object') return;

    const caller0 = normalizePhoneNumber(null, callerNumber);
    const lead0 = normalizePhoneNumber(parsedLead.phone_number, callerNumber);

    const isFullLead = parsedLead.is_lead === true && !!lead0;
    if (!isFullLead) return;

    leadAirtableSent = true;

    const payload = {
      lead_id: callSid || streamSid || `lead_${Date.now()}`,
      full_name: parsedLead.full_name || null,
      business_name: parsedLead.business_name || null,
      phone_number: lead0,
      phone_number_e164: toE164IL(lead0),
      caller_id: caller0 || lead0 || null,
      caller_id_e164: caller0 ? toE164IL(caller0) : (lead0 ? toE164IL(lead0) : null),
      lead_type: parsedLead.lead_type || null,
      reason: parsedLead.reason || reason || null,
      lead_notes: parsedLead.notes || null,
      created_at: new Date().toISOString(),
      callSid: callSid || null,
      streamSid: streamSid || null
    };

    try {
      await fetchWithTimeout(
        MB_LEADS_AIRTABLE_WEBHOOK_URL,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        4500
      );
      logInfo(tag, 'Lead -> Airtable webhook delivered.');
    } catch (err) {
      logError(tag, 'Lead -> Airtable webhook error', err);
    }
  }

  async function sendLeadWebhook(reason, closingMessage, parsedLeadOverride = null) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) return;
    if (leadWebhookSent) return;

    try {
      if (!callerNumber && callSid) {
        const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
        if (resolved) callerNumber = resolved;
      }

      const parsedLead = parsedLeadOverride || (await extractLeadFromConversation(conversationLog));
      if (!parsedLead || typeof parsedLead !== 'object') return;

      if (!parsedLead.phone_number && callerNumber) parsedLead.phone_number = callerNumber;
      parsedLead.phone_number = normalizePhoneNumber(parsedLead.phone_number, callerNumber);

      const isFullLead = parsedLead.is_lead === true && !!parsedLead.phone_number;
      if (!isFullLead) return;

      leadWebhookSent = true;

      const payload = {
        streamSid,
        callSid,
        phone_number: parsedLead.phone_number,
        CALLERID: parsedLead.phone_number,
        reason,
        closingMessage,
        conversationLog,
        parsedLead,
        isFullLead
      };

      const res = await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) logInfo(tag, 'Lead webhook (mail) delivered successfully.');
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err);
    }
  }

  async function endCall(reason, closingMessage) {
    if (callEnded) return;
    callEnded = true;

    logInfo(tag, `endCall called. reason="${reason}"`);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);

    if (!callerNumber && callSid) {
      const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
      if (resolved) callerNumber = resolved;
    }

    let parsedLead = null;
    try {
      parsedLead = await extractLeadFromConversation(conversationLog);
      if (parsedLead && typeof parsedLead === 'object') {
        if (!parsedLead.phone_number && callerNumber) parsedLead.phone_number = callerNumber;
        parsedLead.phone_number = normalizePhoneNumber(parsedLead.phone_number, callerNumber);
      }
    } catch {}

    // Calls log
    sendCallLogWebhook({ reason, parsedLead }).catch(() => {});
    // Lead -> Airtable
    sendLeadToAirtable({ parsedLead, reason }).catch(() => {});
    // Lead -> Mail (existing)
    sendLeadWebhook(reason, closingMessage || getClosingScript(), parsedLead).catch(() => {});

    // KB refresh after call
    refreshDynamicBusinessPrompt('PostCall').catch(() => {});

    // Hangup via Twilio after grace (forced)
    const rawGrace = MB_HANGUP_GRACE_MS && MB_HANGUP_GRACE_MS > 0 ? MB_HANGUP_GRACE_MS : 3000;
    const graceMs = Math.max(2000, Math.min(rawGrace, 8000));

    setTimeout(() => {
      if (callSid) hangupTwilioCall(callSid, tag).catch(() => {});
    }, graceMs);

    try {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    } catch {}
    try {
      if (connection.readyState === WebSocket.OPEN) connection.close();
    } catch {}
  }

  function scheduleEndCall(reason, closingMessage) {
    if (callEnded) return;
    if (pendingHangup) return;

    const msg = closingMessage || getClosingScript();
    pendingHangup = { reason, closingMessage: msg };

    if (openAiWs.readyState === WebSocket.OPEN) {
      sendModelPrompt(`סיימי את השיחה עם הלקוח במשפט הבא בלבד: "${msg}"`, 'closing');
    } else {
      const ph = pendingHangup;
      pendingHangup = null;
      endCall(ph.reason, ph.closingMessage);
      return;
    }

    const rawGrace = MB_HANGUP_GRACE_MS && MB_HANGUP_GRACE_MS > 0 ? MB_HANGUP_GRACE_MS : 3000;
    const graceMs = Math.max(2000, Math.min(rawGrace, 8000));

    setTimeout(() => {
      if (callEnded || !pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      endCall(ph.reason, ph.closingMessage);
    }, graceMs);
  }

  // -----------------------------
  // OpenAI WS
  // -----------------------------
  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, 'Connected to OpenAI Realtime API.');

    const sessionUpdate = {
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['audio', 'text'],
        voice: getEffectiveOpenAiVoice(),
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        max_response_output_tokens: MAX_OUTPUT_TOKENS,
        instructions
      }
    };

    openAiWs.send(JSON.stringify(sessionUpdate));

    const greetingText = getOpeningScript();
    sendModelPrompt(
      `פתחי את השיחה במשפט הבא (אפשר מעט לשנות בלי להאריך): "${greetingText}" ואז המתיני לתשובה.`,
      'opening'
    );
  });

  openAiWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'response.created':
        currentBotText = '';
        hasActiveResponse = true;
        botTurnActive = true;
        botSpeaking = false;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
        break;

      case 'response.output_text.delta':
      case 'response.audio_transcript.delta':
        if (msg.delta) currentBotText += msg.delta;
        break;

      case 'response.output_text.done':
      case 'response.audio_transcript.done': {
        const text = (currentBotText || '').trim();
        if (text) {
          conversationLog.push({ from: 'bot', text });
          logInfo('Bot', text);
          if (botAskedPreClose(text)) lastBotAskedPreCloseAt = Date.now();
        }
        currentBotText = '';
        break;
      }

      case 'response.audio.delta': {
        const b64 = msg.delta;
        if (!b64 || !streamSid) break;
        botSpeaking = true;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
        if (connection.readyState === WebSocket.OPEN) {
          connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
        }
        break;
      }

      case 'response.audio.done':
      case 'response.completed':
        botSpeaking = false;
        hasActiveResponse = false;
        botTurnActive = false;
        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          endCall(ph.reason, ph.closingMessage);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const t = String(msg.transcript || '').trim();
        if (t) {
          conversationLog.push({ from: 'user', text: t });
          logInfo('User', t);

          const now = Date.now();
          if (lastBotAskedPreCloseAt && now - lastBotAskedPreCloseAt <= PRECLOSE_WINDOW_MS) {
            if (userConfirmedClose(t)) {
              lastBotAskedPreCloseAt = 0;
              scheduleEndCall('user_confirmed_closing', getClosingScript());
            }
          }
        }
        break;
      }

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    logInfo(tag, 'OpenAI WS closed.');
    if (!callEnded) endCall('openai_ws_closed', getClosingScript());
  });

  openAiWs.on('error', (err) => {
    logError(tag, 'OpenAI WS error', err);
    if (!callEnded) endCall('openai_ws_error', getClosingScript());
  });

  // -----------------------------
  // Twilio WS
  // -----------------------------
  connection.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      callerNumber = msg.start?.customParameters?.caller || null;

      callStartTs = Date.now();
      lastMediaTs = Date.now();

      logInfo(tag, `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`);

      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (!idleWarningSent && sinceMedia >= MB_IDLE_WARNING_MS && !callEnded) {
          idleWarningSent = true;
          sendModelPrompt('אני עדיין כאן על הקו, אתם איתי?', 'idle_warning');
        }
        if (!idleHangupScheduled && sinceMedia >= MB_IDLE_HANGUP_MS && !callEnded) {
          idleHangupScheduled = true;
          scheduleEndCall('idle_timeout', getClosingScript());
        }
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
          maxCallWarningTimeout = setTimeout(() => {
            sendModelPrompt('אנחנו מתקרבים לסיום הזמן לשיחה הזאת. תרצו לסכם ולהשאיר פרטים?', 'max_call_warning');
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          scheduleEndCall('max_call_duration', getClosingScript());
        }, MB_MAX_CALL_MS);
      }
    }

    if (msg.event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) return;
      }

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
    }

    if (msg.event === 'stop') {
      logInfo(tag, 'Twilio stream stopped.');
      if (!callEnded) endCall('twilio_stop', getClosingScript());
    }
  });

  connection.on('close', () => {
    logInfo(tag, 'Twilio WS closed.');
    if (!callEnded) endCall('twilio_ws_closed', getClosingScript());
  });

  connection.on('error', (err) => {
    logError(tag, 'Twilio WS error', err);
    if (!callEnded) endCall('twilio_ws_error', getClosingScript());
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ MisterBot Realtime Voice Bot running on port ${PORT}`);

  refreshRemoteSettings('Startup').catch(() => {});
  refreshDynamicBusinessPrompt('Startup').catch((err) =>
    console.error('[ERROR][DynamicKB] initial load failed', err)
  );
});
