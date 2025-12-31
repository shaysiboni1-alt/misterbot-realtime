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

function sanitizeWebhookUrl(url) {
  const u = (url || '').trim();
  if (!u) return '';
  // prevent placeholder-like values that accidentally were put into ENV
  if (/^MB_[A-Z0-9_]+$/.test(u)) return '';
  if (u === 'MB_LEADS_AIRTABLE_WEBHOOK_URL') return '';
  if (u === 'MB_WEBHOOK_URL') return '';
  if (!/^https?:\/\//i.test(u)) return ''; // must be http(s)
  return u;
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

const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 1.15); // (OpenAI Realtime voice currently ignores "speed" but kept for future)
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

// -----------------------------
// ✅ Dashboard / Make webhooks (safe layer)
// -----------------------------
const MB_SETTINGS_API_URL = sanitizeWebhookUrl(process.env.MB_SETTINGS_API_URL || '');
const MB_CALL_LOG_WEBHOOK_URL = sanitizeWebhookUrl(process.env.MB_CALL_LOG_WEBHOOK_URL || '');
const MB_CALL_LOG_ENABLED = envBool('MB_CALL_LOG_ENABLED', !!MB_CALL_LOG_WEBHOOK_URL);
const MB_SETTINGS_MIN_INTERVAL_MS = envNumber('MB_SETTINGS_MIN_INTERVAL_MS', 60 * 1000);

// cache for remote settings
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
      console.error(`[ERROR][${tag}] Settings webhook HTTP ${res.status}`, txt);
      return;
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      console.error(`[ERROR][${tag}] Settings webhook returned invalid JSON.`);
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
// MAX_OUTPUT_TOKENS – always number or "inf"
// -----------------------------
const MAX_OUTPUT_TOKENS_ENV = process.env.MAX_OUTPUT_TOKENS;
let MAX_OUTPUT_TOKENS = 'inf';
if (MAX_OUTPUT_TOKENS_ENV) {
  const n = Number(MAX_OUTPUT_TOKENS_ENV);
  if (Number.isFinite(n) && n > 0) {
    MAX_OUTPUT_TOKENS = n;
  } else if (MAX_OUTPUT_TOKENS_ENV === 'inf') {
    MAX_OUTPUT_TOKENS = 'inf';
  }
}

// -----------------------------
// Normalize for closing phrase detection
// -----------------------------
function normalizeForClosing(text) {
  return (text || '')
    .toLowerCase()
    .replace(/["'״׳]/g, '')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// -----------------------------
// VAD defaults (noise hardened)
// -----------------------------
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);

// Max call
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 5000);

// Barge-in
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 1600);

// Leads / webhooks
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = sanitizeWebhookUrl(process.env.MB_WEBHOOK_URL || '');
const MB_LEADS_AIRTABLE_WEBHOOK_URL = sanitizeWebhookUrl(process.env.MB_LEADS_AIRTABLE_WEBHOOK_URL || '');

// Smart parsing
const MB_ENABLE_SMART_LEAD_PARSING = envBool('MB_ENABLE_SMART_LEAD_PARSING', true);
const MB_LEAD_PARSING_MODEL = process.env.MB_LEAD_PARSING_MODEL || 'gpt-4.1-mini';

// Debug
const MB_DEBUG = envBool('MB_DEBUG', false);

// Twilio credentials
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

console.log(`[CONFIG] MB_HANGUP_GRACE_MS=${MB_HANGUP_GRACE_MS} ms`);
console.log(
  `[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS} ms, MB_LANGUAGES=${MB_LANGUAGES.join(
    ','
  )}`
);

// -----------------------------
// Dynamic KB from Google Drive
// -----------------------------
const MB_DYNAMIC_KB_URL = process.env.MB_DYNAMIC_KB_URL || '';
let dynamicBusinessPrompt = '';
let lastDynamicKbRefreshAt = 0;
const MB_DYNAMIC_KB_MIN_INTERVAL_MS = envNumber('MB_DYNAMIC_KB_MIN_INTERVAL_MS', 5 * 60 * 1000);

async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) {
    if (MB_DEBUG) {
      console.log(`[DEBUG][${tag}] MB_DYNAMIC_KB_URL is empty – skip refresh.`);
    }
    return;
  }

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
// Phone normalization (IL)
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

    if (digits.length === 9) {
      return ['02', '03', '04', '07', '08', '09'].includes(prefix2);
    } else {
      if (prefix2 === '05' || prefix2 === '07') return true;
      if (['02', '03', '04', '07', '08', '09'].includes(prefix2)) return true;
      return false;
    }
  }

  function clean(num) {
    let digits = toDigits(num);
    if (!digits) return null;
    digits = normalize972(digits);
    if (!isValidIsraeliPhone(digits)) return null;
    return digits;
  }

  const fromLead = clean(rawPhone);
  if (fromLead) return fromLead;

  const fromCaller = clean(callerNumber);
  if (fromCaller) return fromCaller;

  return null;
}

function digitsOnly(v) {
  if (!v) return null;
  const d = String(v).replace(/\D/g, '');
  return d ? d : null;
}
function toIsraeliLocalFromAny(raw) {
  const d = digitsOnly(raw);
  if (!d) return null;
  if (d.startsWith('0') && (d.length === 9 || d.length === 10)) return d;
  if (d.startsWith('972') && (d.length === 11 || d.length === 12)) return '0' + d.slice(3);
  return null;
}
function toE164FromIsraeliLocal(local) {
  if (!local) return null;
  const d = digitsOnly(local);
  if (!d) return null;
  if (d.startsWith('0')) return `+972${d.slice(1)}`;
  if (d.startsWith('972')) return `+${d}`;
  if (d.startsWith('+972')) return d;
  return null;
}

function formatIsraeliPhoneForTts(ilLocalDigits) {
  // expects 0XXXXXXXXX or 0XXXXXXXXXX
  const d = digitsOnly(ilLocalDigits);
  if (!d || !d.startsWith('0')) return ilLocalDigits;
  // common mobile: 05X-XXX-XXXX
  if (d.length === 10 && d.startsWith('05')) {
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  // landline: 0X-XXX-XXXX (9 digits) / 0XX-XXX-XXXX (10 digits)
  if (d.length === 9) {
    return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  }
  if (d.length === 10 && !d.startsWith('05')) {
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return d;
}

function detectPhoneCandidateFromText(text) {
  const t = String(text || '');
  // Accept patterns like: 050-970-3561, 0509703561, +972509703561, 972509703561
  const digits = t.replace(/\D/g, '');
  if (!digits) return null;

  // Prefer the longest plausible sequence inside the utterance
  // but keep it simple: normalizePhoneNumber already validates.
  const normalized = normalizePhoneNumber(digits, null);
  return normalized; // returns IL local digits like 0509703561 or null
}

function isYes(text) {
  const t = (text || '').trim().toLowerCase();
  return /^(כן|נכון|בדיוק|אכן|כן נכון|נכון מאוד|כן זה נכון)\b/.test(t);
}
function isNo(text) {
  const t = (text || '').trim().toLowerCase();
  return /^(לא|ממש לא|לא נכון|טעות|זה לא|לא זה)\b/.test(t);
}

// -----------------------------
// System instructions builder
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים (גבוהים מהפרומפט העסקי):
1. אל תתייחסי למוזיקה, רעשים או איכות הקו, גם אם את מזהה אותם. התייחסי רק לתוכן מילולי שנשמע כמו דיבור מכוון אלייך. אם לא הבנת משפט – אמרי בקצרה משהו כמו: "לא שמעתי טוב, אפשר לחזור על זה?" בלי לתאר את הרעש.
2. לעולם אל תחליטי לסיים שיחה רק בגלל מילים שהלקוח אמר (כמו "תודה", "זהו", "לא צריך" וכדומה). המשיכי לענות באופן רגיל עד שמערכת הטלפון מסיימת את השיחה או עד שמבקשים ממך במפורש מתוך ההנחיות הטכניות לומר את משפט הסיום המלא.
3. כאשר את מתבקשת לסיים שיחה, אמרי את משפט הסיום המדויק שהוגדר במערכת בלבד, בלי להוסיף ובלי לשנות.
4. שמרי על תשובות קצרות, ברורות וממוקדות (בדרך-כלל עד 2–3 משפטים), אלא אם הלקוח ביקש הסבר מפורט.
5. כאשר השיחה מגיעה באופן טבעי לסיום (הכול ברור, אין עוד שאלות, סיכמתם פעולה וכדומה) – אל תסיימי מיד. קודם שאלי שאלה קצרה בסגנון: "לפני שאני מסיימת, יש עוד משהו שתרצו או שהכול ברור?". אם הלקוח עונה בצורה שלילית (למשל: "לא", "זהו", "זה הכול", "הכול בסדר", "הכול ברור" וכדומה) – זה נחשב רשות לסיים את השיחה, ומיד לאחר מכן אמרי רק את משפט הסיום המדויק מהמערכת, בלי להוסיף מידע חדש. אם הלקוח כן רוצה להמשיך – תעני כרגיל ואל תאמרי את משפט הסיום עדיין.
6. מספרי טלפון: אם הלקוח מסר מספר טלפון, חזרי עליו בדיוק כפי שנמסר, ובקשי אישור קצר: "זה נכון?". אל תשני ספרות ואל "תנחשי" מספר.
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
    instructions = `
אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור שירות "${BUSINESS_NAME}".
דברו בטון נעים, מקצועי וקצר, ברירת המחדל היא עברית, ותמיד התאימו את עצמכם ללקוח.
`.trim();
  }

  instructions += '\n\n' + EXTRA_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Dashboard reload
app.post('/dashboard/reload', async (req, res) => {
  try {
    lastSettingsFetchAt = 0;
    await refreshRemoteSettings('Startup');
    res.status(200).json({ ok: true, reloaded: true, ts: Date.now() });
  } catch (err) {
    console.error('[ERROR][Dashboard] /dashboard/reload failed', err);
    res.status(500).json({ ok: false, error: 'reload_failed' });
  }
});

app.post('/twilio-voice', (req, res) => {
  const host = process.env.DOMAIN || req.headers.host;
  const wsUrl =
    process.env.MB_TWILIO_STREAM_URL ||
    `wss://${String(host || '').replace(/^https?:\/\//, '')}/twilio-media-stream`;

  // Twilio sends From/To in form-urlencoded
  const caller = req.body.From || '';
  const called = req.body.To || '';
  const direction = req.body.Direction || 'inbound';

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}"/>
      <Parameter name="called" value="${called}"/>
      <Parameter name="direction" value="${direction}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  logInfo('Twilio-Voice', `Returning TwiML with Stream URL: ${wsUrl}, From=${caller}, To=${called}`);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);

// -----------------------------
// WebSocket server for Twilio Media Streams
// -----------------------------
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Smart lead parsing helper
// -----------------------------
async function extractLeadFromConversation(conversationLog) {
  const tag = 'LeadParse';

  if (!MB_ENABLE_SMART_LEAD_PARSING) {
    logDebug(tag, 'Smart lead parsing disabled via ENV.');
    return null;
  }

  if (!OPENAI_API_KEY) {
    logError(tag, 'Missing OPENAI_API_KEY for lead parsing.');
    return null;
  }

  if (!Array.isArray(conversationLog) || conversationLog.length === 0) {
    logDebug(tag, 'Empty conversationLog – skipping lead parsing.');
    return null;
  }

  try {
    const conversationText = conversationLog
      .map((m) => `${m.from === 'user' ? 'לקוח' : BOT_NAME}: ${m.text}`)
      .join('\n');

    const systemPrompt = `
אתה מנתח שיחות טלפון בעברית (ולעתים גם בשפות אחרות) בין לקוח לבין בוט שירות.
תפקידך להוציא JSON אחד בלבד שתואם בדיוק לסכמה הבאה:

{
  "is_lead": boolean,
  "lead_type": "new" | "existing" | "unknown",
  "full_name": string | null,
  "business_name": string | null,
  "phone_number": string | null,
  "reason": string | null,
  "notes": string | null
}

החזר אך ורק JSON תקין לפי הסכמה, בלי טקסט נוסף, בלי הסברים ובלי הערות.
`.trim();

    const userPrompt = `
להלן תמלול שיחה בין לקוח ובוט שירות בשם "${BOT_NAME}" עבור העסק "${BUSINESS_NAME}".

תמלול:
${conversationText}
`.trim();

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

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logError(tag, `OpenAI lead parsing HTTP ${response.status}`, text);
      return null;
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) {
      logError(tag, 'No content in lead parsing response.');
      return null;
    }

    let parsed = null;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      parsed = raw;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      logError(tag, 'Parsed lead is not an object.', parsed);
      return null;
    }

    logInfo(tag, 'Lead parsed successfully.', parsed);
    return parsed;
  } catch (err) {
    logError(tag, 'Error in extractLeadFromConversation', err);
    return null;
  }
}

// -----------------------------
// Helper – Twilio hangup
// -----------------------------
async function hangupTwilioCall(callSid, tag = 'Call') {
  if (!callSid) {
    logDebug(tag, 'No callSid – skipping Twilio hangup.');
    return;
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    logDebug(tag, 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing – cannot hang up via Twilio API.');
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(tag, `Twilio hangup HTTP ${res.status}`, txt);
    } else {
      logInfo(tag, 'Twilio call hangup requested successfully.');
    }
  } catch (err) {
    logError(tag, 'Error calling Twilio hangup API', err);
  }
}

// -----------------------------
// Helper – fetch caller number from Twilio
// -----------------------------
async function fetchCallerNumberFromTwilio(callSid, tag = 'Call') {
  if (!callSid) {
    logDebug(tag, 'fetchCallerNumberFromTwilio: no callSid provided.');
    return null;
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    logDebug(tag, 'fetchCallerNumberFromTwilio: missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.');
    return null;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
      }
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(tag, `fetchCallerNumberFromTwilio HTTP ${res.status}`, txt);
      return null;
    }

    const data = await res.json();
    const fromRaw = data.from || null;

    logInfo(tag, `fetchCallerNumberFromTwilio: resolved caller="${fromRaw}" from Twilio Call resource.`);
    return fromRaw;
  } catch (err) {
    logError(tag, 'fetchCallerNumberFromTwilio: error fetching from Twilio', err);
    return null;
  }
}

// -----------------------------
// Per-call handler
// -----------------------------
wss.on('connection', (connection, req) => {
  const tag = 'Call';
  logInfo(tag, 'New Twilio Media Stream connection established.');

  if (!OPENAI_API_KEY) {
    logError(tag, 'OPENAI_API_KEY missing – closing connection.');
    connection.close();
    return;
  }

  refreshRemoteSettings('OnConnect').catch(() => {});

  let streamSid = null;
  let callSid = null;
  let callerNumber = null; // raw
  let calledNumber = null;
  let callDirection = null;

  // ✅ anti-hallucination: deterministic slot capture
  let awaitingPhone = false;
  let awaitingPhoneConfirm = false;
  let collectedPhoneIL = null; // 0XXXXXXXXX/0XXXXXXXXXX
  let awaitingName = false;
  let collectedName = null;

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
  let twilioClosed = false;
  let openAiClosed = false;
  let callEnded = false;

  let botSpeaking = false;
  let hasActiveResponse = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  let leadWebhookSent = false;

  function getGraceMs() {
    const rawGrace = MB_HANGUP_GRACE_MS && MB_HANGUP_GRACE_MS > 0 ? MB_HANGUP_GRACE_MS : 3000;
    return Math.max(2000, Math.min(rawGrace, 8000));
  }

  let graceHangupTimer = null;
  function scheduleForceEndAfterGrace(ph, why = 'closing_done') {
    if (!ph || callEnded) return;
    if (graceHangupTimer) return;

    const graceMs = getGraceMs();
    logInfo(tag, `Scheduling endCall AFTER GRACE (${graceMs} ms). why=${why}`);

    graceHangupTimer = setTimeout(() => {
      graceHangupTimer = null;
      if (callEnded) return;
      endCall(ph.reason, ph.closingMessage);
    }, graceMs);
  }

  function safeCancelResponseIfNeeded() {
    if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;
    if (!hasActiveResponse) return;
    try {
      openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
    } catch (_) {}
    hasActiveResponse = false;
    botSpeaking = false;
    botTurnActive = false;
  }

  function sendModelPrompt(text, purpose) {
    if (openAiWs.readyState !== WebSocket.OPEN) {
      logDebug(tag, `Cannot send model prompt (${purpose || 'no-tag'}) – WS not open.`);
      return;
    }
    if (hasActiveResponse) {
      logDebug(tag, `Skipping model prompt (${purpose || 'no-tag'}) – active response exists.`);
      return;
    }

    const item = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    };
    openAiWs.send(JSON.stringify(item));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
    hasActiveResponse = true;
    botTurnActive = true;
    logInfo(tag, `Sending model prompt (${purpose || 'no-tag'})`);
  }

  function conversationMentionsCallerId() {
    const patterns = [/מזוהה/, /למספר שממנו/, /למספר שממנו אני מתקשר/, /למספר שממנו התקשרתי/];
    return conversationLog.some((m) => m.from === 'user' && patterns.some((re) => re.test(m.text || '')));
  }

  function mapCallStatus(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('error')) return 'error';
    if (r.includes('twilio') || r.includes('ws_closed') || r.includes('stop')) return 'abandoned';
    return 'completed';
  }

  async function sendCallLogWebhook({ reason, closingMessage, parsedLead }) {
    if (!MB_CALL_LOG_ENABLED || !MB_CALL_LOG_WEBHOOK_URL) return;

    try {
      const endedAt = new Date().toISOString();
      const startedAt = new Date(callStartTs).toISOString();
      const durationSec = Math.max(0, Math.round((Date.now() - callStartTs) / 1000));

      const lastUser = [...conversationLog].reverse().find((m) => m.from === 'user')?.text || '';
      const transcript = conversationLog
        .map((m) => `${m.from === 'user' ? 'לקוח' : BOT_NAME}: ${m.text}`)
        .join('\n');

      const collectedPhone = normalizePhoneNumber(parsedLead?.phone_number, callerNumber) || collectedPhoneIL;

      const payload = {
        call_id: callSid || streamSid || `call_${Date.now()}`,
        call_direction: callDirection || 'inbound',
        started_at: startedAt,
        ended_at: endedAt,
        duration_sec: durationSec,
        caller_id: callerNumber || null,
        collected_phone: collectedPhone
          ? collectedPhone.startsWith('0')
            ? `+972${collectedPhone.slice(1)}`
            : collectedPhone
          : callerNumber || null,
        contact_name: parsedLead?.full_name || collectedName || null,
        call_status: mapCallStatus(reason),
        last_user_utterance: lastUser || null,
        transcript,
        summary: parsedLead?.reason || null,
        has_lead: parsedLead?.is_lead === true,
        lead_type: parsedLead?.lead_type || null,
        lead_notes: parsedLead?.notes || null,
        reason: reason || null,
        streamSid: streamSid || null
      };

      await fetchWithTimeout(
        MB_CALL_LOG_WEBHOOK_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        },
        4500
      ).catch(() => {});
    } catch (err) {
      logError(tag, 'sendCallLogWebhook error', err);
    }
  }

  // -----------------------------
  // ✅ Lead webhook – now accepts parsedLead to avoid double parsing
  // -----------------------------
  async function sendLeadWebhook(reason, closingMessage, parsedLeadFromEndCall) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) {
      logDebug(tag, 'Lead capture disabled or no MB_WEBHOOK_URL – skipping webhook.');
      return;
    }
    if (leadWebhookSent) {
      logDebug(tag, 'Lead webhook already sent for this call – skipping.');
      return;
    }

    try {
      // Ensure we have callerNumber if possible
      if (!callerNumber && callSid) {
        const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
        if (resolved) callerNumber = resolved;
      }

      // Use parsed lead from endCall (preferred). If missing, parse once here.
      let parsedLead = parsedLeadFromEndCall;
      if (!parsedLead || typeof parsedLead !== 'object') {
        parsedLead = await extractLeadFromConversation(conversationLog);
      }

      if (!parsedLead || typeof parsedLead !== 'object') {
        logInfo(tag, 'No parsed lead object – skipping webhook (לא ליד מלא).');
        return;
      }

      const callerRaw = callerNumber ? String(callerNumber) : null;
      const callerIL = toIsraeliLocalFromAny(callerRaw) || null;
      const callerE164 = toE164FromIsraeliLocal(callerIL) || (callerRaw && callerRaw.startsWith('+') ? callerRaw : null);

      // Deterministic collected phone
      const normalizedPhone = normalizePhoneNumber(parsedLead.phone_number, callerRaw) || collectedPhoneIL || null;
      parsedLead.phone_number = normalizedPhone;

      if (!parsedLead.phone_number && callerRaw) {
        parsedLead.phone_number = normalizePhoneNumber(callerRaw, callerRaw) || null;
        const suffixNote = conversationMentionsCallerId()
          ? 'הלקוח ביקש חזרה למספר המזוהה ממנו התקשר.'
          : 'לא נמסר מספר טלפון מפורש בשיחה – נעשה שימוש במספר המזוהה מהמערכת.';
        parsedLead.notes = (parsedLead.notes || '') + (parsedLead.notes ? ' ' : '') + suffixNote;
      }

      parsedLead.caller_id_raw = callerRaw;
      parsedLead.caller_id_il = callerIL;
      parsedLead.caller_id_e164 = callerE164;

      if (!parsedLead.business_name || typeof parsedLead.business_name !== 'string' || !parsedLead.business_name.trim()) {
        parsedLead.business_name = 'לא רלוונטי';
      }

      const isFullLead = parsedLead.is_lead === true && !!parsedLead.phone_number;
      if (!isFullLead) {
        logInfo(tag, 'Parsed lead is NOT full lead – webhook will NOT be sent.', {
          is_lead: parsedLead.is_lead,
          lead_type: parsedLead.lead_type,
          phone_number: parsedLead.phone_number
        });
        return;
      }

      const finalPhoneNumber = parsedLead.phone_number || callerIL || callerRaw || null;
      const finalCallerId = callerE164 || callerIL || callerRaw || null;

      parsedLead.identified_number = finalCallerId;
      parsedLead.identifiedNumber = finalCallerId;
      parsedLead.identified = finalCallerId;
      parsedLead['מספר_מזוהה'] = finalCallerId;
      parsedLead['מספר מזוהה'] = finalCallerId;

      const payload = {
        streamSid,
        callSid,

        callerNumber: callerRaw,
        CALLERID: finalCallerId,
        callerIdRaw: callerRaw,
        callerIdNormalized: callerIL,

        caller_id: finalCallerId,
        callerId: finalCallerId,
        identified_number: finalCallerId,
        identifiedNumber: finalCallerId,
        identified: finalCallerId,
        From: callerRaw,
        caller_il: callerIL,
        caller_e164: callerE164,

        מספר_מזוהה: finalCallerId,
        'מספר מזוהה': finalCallerId,

        phone_number: finalPhoneNumber,
        botName: BOT_NAME,
        businessName: BUSINESS_NAME,
        startedAt: new Date(callStartTs).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - callStartTs,
        reason,
        closingMessage,
        conversationLog,
        parsedLead,
        isFullLead
      };

      logInfo(tag, `Sending lead webhook to ${MB_WEBHOOK_URL}`);
      logInfo(tag, 'Lead webhook short summary', { phone_number: finalPhoneNumber, caller_id: finalCallerId });

      leadWebhookSent = true;

      const res = await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        logError(tag, `Lead webhook HTTP ${res.status}`, await res.text());
      } else {
        logInfo(tag, `Lead webhook delivered successfully. status=${res.status}`);
      }

      if (MB_LEADS_AIRTABLE_WEBHOOK_URL) {
        logInfo(tag, `Sending lead webhook to MB_LEADS_AIRTABLE_WEBHOOK_URL`);
        const res2 = await fetchWithTimeout(
          MB_LEADS_AIRTABLE_WEBHOOK_URL,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          },
          4500
        ).catch(() => null);

        if (res2 && !res2.ok) {
          const t2 = await res2.text().catch(() => '');
          logError(tag, `Airtable lead webhook HTTP ${res2.status}`, t2);
        } else {
          logInfo(tag, `Airtable lead webhook delivered (or timeout-safe).`);
        }
      }
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err);
    }
  }

  // -----------------------------
  // End call (non-blocking)
  // -----------------------------
  async function endCall(reason, closingMessage) {
    if (callEnded) {
      logDebug(tag, `endCall called again (${reason}) – already ended.`);
      return;
    }
    callEnded = true;

    if (graceHangupTimer) {
      clearTimeout(graceHangupTimer);
      graceHangupTimer = null;
    }

    logInfo(tag, `endCall called with reason="${reason}"`);
    logInfo(tag, 'Final conversation log:', conversationLog);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);

    const effectiveClosing = closingMessage || getClosingScript();

    // Snapshot
    const callSidSnapshot = callSid;
    const streamSidSnapshot = streamSid;
    const callerSnapshot = callerNumber;
    const callStartSnapshot = callStartTs;
    const convoSnapshot = Array.isArray(conversationLog) ? [...conversationLog] : [];
    const reasonSnapshot = reason;
    const closingSnapshot = effectiveClosing;
    const collectedPhoneSnapshot = collectedPhoneIL;
    const collectedNameSnapshot = collectedName;

    // Hangup ASAP
    if (callSidSnapshot) hangupTwilioCall(callSidSnapshot, tag).catch(() => {});

    // Close sockets ASAP
    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiClosed = true;
      openAiWs.close();
    }
    if (!twilioClosed && connection.readyState === WebSocket.OPEN) {
      twilioClosed = true;
      connection.close();
    }

    // Fire-and-forget post-call tasks
    (async () => {
      try {
        let parsedLeadForLog = null;

        try {
          parsedLeadForLog = await extractLeadFromConversation(convoSnapshot);
          if (parsedLeadForLog && typeof parsedLeadForLog === 'object') {
            // merge deterministic captures
            if (!parsedLeadForLog.phone_number && collectedPhoneSnapshot) parsedLeadForLog.phone_number = collectedPhoneSnapshot;
            if (!parsedLeadForLog.full_name && collectedNameSnapshot) parsedLeadForLog.full_name = collectedNameSnapshot;

            const normalized = normalizePhoneNumber(parsedLeadForLog.phone_number, callerSnapshot);
            parsedLeadForLog.phone_number = normalized || parsedLeadForLog.phone_number || null;
          }
        } catch (_) {}

        // Temporarily swap context for webhooks
        const prev = { callStartTs, conversationLog, callerNumber, callSid, streamSid };
        callStartTs = callStartSnapshot;
        conversationLog = convoSnapshot;
        callerNumber = callerSnapshot;
        callSid = callSidSnapshot;
        streamSid = streamSidSnapshot;

        if (MB_CALL_LOG_ENABLED && MB_CALL_LOG_WEBHOOK_URL) {
          await sendCallLogWebhook({
            reason: reasonSnapshot,
            closingMessage: closingSnapshot,
            parsedLead: parsedLeadForLog
          }).catch(() => {});
        }

        if (MB_ENABLE_LEAD_CAPTURE && MB_WEBHOOK_URL) {
          await sendLeadWebhook(reasonSnapshot, closingSnapshot, parsedLeadForLog).catch(() => {});
        }

        // Restore
        callStartTs = prev.callStartTs;
        conversationLog = prev.conversationLog;
        callerNumber = prev.callerNumber;
        callSid = prev.callSid;
        streamSid = prev.streamSid;

        if (MB_DYNAMIC_KB_URL) {
          refreshDynamicBusinessPrompt('PostCall').catch((err) =>
            logError(tag, 'DynamicKB post-call refresh failed', err)
          );
        }
      } catch (err) {
        logError(tag, 'Post-call background tasks error', err);
      }
    })().catch(() => {});
  }

  function scheduleEndCall(reason, closingMessage) {
    if (callEnded) return;

    const msg = closingMessage || getClosingScript();

    if (pendingHangup) return;

    logInfo(tag, `scheduleEndCall invoked. reason="${reason}", closingMessage="${msg}"`);
    pendingHangup = { reason, closingMessage: msg };

    if (openAiWs.readyState === WebSocket.OPEN) {
      sendModelPrompt(`סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף שום משפט נוסף: "${msg}"`, 'closing');
      logInfo(tag, `Closing message sent to model: ${msg}`);
    } else {
      const ph = pendingHangup;
      pendingHangup = null;
      scheduleForceEndAfterGrace(ph, 'no_openai');
      return;
    }

    const graceMs = getGraceMs();
    setTimeout(() => {
      if (callEnded) return;
      if (!pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      logInfo(tag, `Closing fallback reached (${graceMs} ms), forcing end AFTER GRACE.`);
      scheduleForceEndAfterGrace(ph, 'closing_fallback');
    }, graceMs + 6000);
  }

  function scheduleHangupAfterBotClosing(reason) {
    if (callEnded) return;
    if (pendingHangup) return;

    const msg = getClosingScript();
    const ph = { reason, closingMessage: msg };
    scheduleForceEndAfterGrace(ph, 'bot_closing_detected');

    logInfo(tag, `Bot closing detected – hangup scheduled AFTER GRACE reason="${reason}".`);
  }

  function checkBotClosing(botText) {
    const closingScript = getClosingScript();
    const normalizedClosing = normalizeForClosing(closingScript);
    if (!botText || !normalizedClosing) return;

    const norm = normalizeForClosing(botText);
    if (!norm) return;

    if (norm.includes(normalizedClosing) || normalizedClosing.includes(norm)) {
      logInfo(tag, `Detected configured bot closing phrase in output: "${botText}"`);
      scheduleHangupAfterBotClosing('bot_closing_config');
    }
  }

  function updateDialogueStateFromBotText(botText) {
    const t = normalizeForClosing(botText);

    // When bot asks for phone
    if (
      /מה מספר הטלפון|מהו מספר הטלפון|מספר טלפון לחזרה|מספר טלפון שנוח|טלפון לחזור|טלפון לחזרה/.test(t)
    ) {
      awaitingPhone = true;
      awaitingPhoneConfirm = false;
      logDebug(tag, 'State: awaitingPhone=true');
      return;
    }

    // When bot asks for name
    if (/איך אפשר לפנות אליך|איך אפשר לפנות אליכם|מה השם שלך|מה השם שלכם|שם פרטי|שם מלא/.test(t)) {
      awaitingName = true;
      logDebug(tag, 'State: awaitingName=true');
      return;
    }
  }

  function handleDeterministicPhoneFlowOnUserTranscript(userText) {
    if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

    const phoneIL = detectPhoneCandidateFromText(userText);
    if (!phoneIL) return;

    // If we were awaiting confirmation: user says yes/no
    if (awaitingPhoneConfirm) {
      if (isYes(userText)) {
        collectedPhoneIL = collectedPhoneIL || phoneIL;
        awaitingPhoneConfirm = false;
        awaitingPhone = false;

        const sayPhone = formatIsraeliPhoneForTts(collectedPhoneIL);
        safeCancelResponseIfNeeded();
        sendModelPrompt(
          `הלקוח אישר שמספר הטלפון שלו הוא "${sayPhone}". תודה קצרה ואז המשיכי לשלב הבא בצורה טבעית (למשל: בקשת שם אם חסר, או סיכום שיחזרו אליו). אל תשני את המספר ואל תחזרי לבקש אותו שוב.`,
          'phone_confirmed'
        );
        return;
      }
      if (isNo(userText)) {
        collectedPhoneIL = null;
        awaitingPhoneConfirm = false;
        awaitingPhone = true;

        safeCancelResponseIfNeeded();
        sendModelPrompt(
          `הלקוח אמר שהמספר לא נכון. בקשי שוב מספר טלפון לחזרה, ובקשי שיאמר אותו לאט ספרה-ספרה. תשובה קצרה.`,
          'phone_retake'
        );
        return;
      }
      // if unclear, ignore and let model continue normally
      return;
    }

    // If bot asked for phone -> lock the number deterministically and force exact echo+confirm
    if (awaitingPhone) {
      collectedPhoneIL = phoneIL;
      awaitingPhone = false;
      awaitingPhoneConfirm = true;

      const sayPhone = formatIsraeliPhoneForTts(collectedPhoneIL);

      safeCancelResponseIfNeeded();
      sendModelPrompt(
        `הלקוח מסר מספר טלפון. המספר שנקלט (חובה לדייק ללא שינוי) הוא: "${sayPhone}". חזרי עליו בדיוק ושאלי: "זה נכון?" בלי להוסיף שום מספר אחר ובלי לשנות ספרות.`,
        'phone_echo_confirm'
      );
      return;
    }

    // If not awaiting phone: still store as best effort (in case lead parsing misses)
    if (!collectedPhoneIL) {
      collectedPhoneIL = phoneIL;
      logDebug(tag, 'Captured phone opportunistically', { collectedPhoneIL });
    }
  }

  function sendIdleWarningIfNeeded() {
    if (idleWarningSent || callEnded) return;
    idleWarningSent = true;

    const text = 'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
    sendModelPrompt(`תגיבי ללקוח במשפט קצר בסגנון הבא (אפשר לשנות קצת): "${text}"`, 'idle_warning');
  }

  // -----------------------------
  // OpenAI WS handlers
  // -----------------------------
  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, 'Connected to OpenAI Realtime API.');

    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;

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
          silence_duration_ms: effectiveSilenceMs,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        max_response_output_tokens: MAX_OUTPUT_TOKENS,
        instructions
      }
    };

    logDebug(tag, 'Sending session.update to OpenAI.', sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));

    const greetingText = getOpeningScript();
    sendModelPrompt(
      `פתחי את השיחה עם הלקוח במשפט הבא (אפשר לשנות מעט את הניסוח אבל לא להאריך): "${greetingText}" ואז עצרי והמתיני לתשובה שלו.`,
      'opening_greeting'
    );
  });

  openAiWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logError(tag, 'Failed to parse OpenAI WS message', err);
      return;
    }

    const type = msg.type;

    switch (type) {
      case 'response.created':
        currentBotText = '';
        hasActiveResponse = true;
        botTurnActive = true;
        botSpeaking = false;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
        break;

      case 'response.output_text.delta': {
        const delta = msg.delta || '';
        if (delta) currentBotText += delta;
        break;
      }

      case 'response.audio_transcript.delta': {
        const delta = msg.delta || '';
        if (delta) currentBotText += delta;
        break;
      }

      case 'response.output_text.done':
      case 'response.audio_transcript.done': {
        if (!currentBotText) break;
        const text = currentBotText.trim();
        if (text) {
          conversationLog.push({ from: 'bot', text });
          logInfo('Bot', text);

          // ✅ update dialogue state (phone/name)
          updateDialogueStateFromBotText(text);

          checkBotClosing(text);
        }
        currentBotText = '';
        break;
      }

      case 'response.audio.delta': {
        const b64 = msg.delta;
        if (!b64 || !streamSid) break;
        botSpeaking = true;

        const now = Date.now();
        noListenUntilTs = now + MB_NO_BARGE_TAIL_MS;

        if (connection.readyState === WebSocket.OPEN) {
          const twilioMsg = {
            event: 'media',
            streamSid,
            media: { payload: b64 }
          };
          connection.send(JSON.stringify(twilioMsg));
        }
        break;
      }

      case 'response.audio.done': {
        botSpeaking = false;
        botTurnActive = false;

        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          logInfo(tag, 'Closing audio finished, scheduling hangup AFTER GRACE.');
          scheduleForceEndAfterGrace(ph, 'audio_done');
        }
        break;
      }

      case 'response.completed': {
        botSpeaking = false;
        hasActiveResponse = false;
        botTurnActive = false;

        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          logInfo(tag, 'Response completed for closing, scheduling hangup AFTER GRACE.');
          scheduleForceEndAfterGrace(ph, 'response_completed');
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcriptRaw = msg.transcript || '';
        let t = transcriptRaw.trim();
        if (t) {
          t = t.replace(/\s+/g, ' ').replace(/\s+([,.:;!?])/g, '$1');
          conversationLog.push({ from: 'user', text: t });
          logInfo('User', t);

          // ✅ deterministic phone capture + exact confirm (prevents hallucinated numbers)
          handleDeterministicPhoneFlowOnUserTranscript(t);

          // basic name capture (best effort, lightweight)
          if (awaitingName && !collectedName) {
            const possiblePhone = detectPhoneCandidateFromText(t);
            if (!possiblePhone) {
              // keep short name (first 1-3 words)
              const words = t.split(' ').filter(Boolean).slice(0, 3);
              const name = words.join(' ').trim();
              if (name && name.length <= 40) {
                collectedName = name;
              }
            }
            awaitingName = false;
          }
        }
        break;
      }

      case 'error': {
        logError(tag, 'OpenAI Realtime error event', msg);
        hasActiveResponse = false;
        botSpeaking = false;
        botTurnActive = false;
        noListenUntilTs = 0;
        break;
      }

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    logInfo(tag, 'OpenAI WS closed.');
    if (!callEnded) {
      endCall('openai_ws_closed', getClosingScript());
    }
  });

  openAiWs.on('error', (err) => {
    logError(tag, 'OpenAI WS error', err);
    if (!openAiClosed) {
      openAiClosed = true;
      openAiWs.close();
    }
    if (!callEnded) {
      endCall('openai_ws_error', getClosingScript());
    }
  });

  // -----------------------------
  // Twilio Media Stream handlers
  // -----------------------------
  connection.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logError(tag, 'Failed to parse Twilio WS message', err);
      return;
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      const cp = msg.start?.customParameters || {};
      // ✅ FIX: caller can arrive under different keys depending on Twilio routing
      callerNumber =
        cp.caller ||
        cp.From ||
        cp.from ||
        msg.start?.caller ||
        msg.start?.from ||
        null;

      calledNumber = cp.called || cp.To || cp.to || msg.start?.to || null;
      callDirection = cp.direction || msg.start?.direction || 'inbound';

      callStartTs = Date.now();
      lastMediaTs = Date.now();

      logInfo(tag, `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`);

      // ✅ best effort: if caller missing, fetch from Twilio ASAP (non-blocking)
      if (!callerNumber && callSid) {
        fetchCallerNumberFromTwilio(callSid, tag)
          .then((resolved) => {
            if (resolved && !callerNumber) {
              callerNumber = resolved;
              logInfo(tag, `Caller backfilled from Twilio API: ${callerNumber}`);
            }
          })
          .catch(() => {});
      }

      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (!idleWarningSent && sinceMedia >= MB_IDLE_WARNING_MS && !callEnded) {
          sendIdleWarningIfNeeded();
        }
        if (!idleHangupScheduled && sinceMedia >= MB_IDLE_HANGUP_MS && !callEnded) {
          idleHangupScheduled = true;
          logInfo(tag, 'Idle timeout reached, scheduling endCall.');
          scheduleEndCall('idle_timeout', getClosingScript());
        }
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
          maxCallWarningTimeout = setTimeout(() => {
            const t =
              'אנחנו מתקרבים לסיום הזמן לשיחה הזאת. אם תרצו להתקדם, אפשר עכשיו לסכם ולהשאיר פרטים.';
            sendModelPrompt(`תני ללקוח משפט קצר בסגנון הבא (אפשר לשנות קצת): "${t}"`, 'max_call_warning');
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          logInfo(tag, 'Max call duration reached, scheduling endCall.');
          scheduleEndCall('max_call_duration', getClosingScript());
        }, MB_MAX_CALL_MS);
      }
    } else if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;

      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) {
          logDebug('BargeIn', 'Ignoring media because bot is speaking / tail (MB_ALLOW_BARGE_IN=false)', {
            botTurnActive,
            botSpeaking,
            now,
            noListenUntilTs
          });
          return;
        }
      }

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
    } else if (event === 'stop') {
      logInfo(tag, 'Twilio stream stopped.');
      twilioClosed = true;
      if (!callEnded) {
        endCall('twilio_stop', getClosingScript());
      }
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logInfo(tag, 'Twilio WS closed.');
    if (!callEnded) {
      endCall('twilio_ws_closed', getClosingScript());
    }
  });

  connection.on('error', (err) => {
    twilioClosed = true;
    logError(tag, 'Twilio WS error', err);
    if (!callEnded) {
      endCall('twilio_ws_error', getClosingScript());
    }
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
