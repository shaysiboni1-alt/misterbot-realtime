// server.js
//
// MisterBot Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (gpt-4o-realtime-preview-2024-12-17)
//
//
// חוקים עיקריים לפי ה-MASTER PROMPT:
// - שיחה בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
// - שליטה מלאה דרך ENV (פתיח, סגיר, פרומפט כללי, KB עסקי, טיימרים, לידים, VAD).
// - טיימר שקט + ניתוק אוטומטי + מקסימום זמן שיחה.
// - לוג שיחה + וובהוק לידים (אם מופעל) + PARSING חכם ללידים.
//
// דרישות:
//   npm install express ws dotenv
//   (מומלץ Node 18+ כדי ש-fetch יהיה זמין גלובלית)
//
//
// להרצה (למשל):
//   PORT=3000 node server.js
//
// Twilio Voice Webhook -> /twilio-voice  (TwiML)
// Twilio Media Streams -> wss://<domain>/twilio-media-stream
//

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// -----------------------------
// ENV Helpers
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
  'תודה שדיברתם עם מיסטר בוט. המשך יום נעים, ולהתראות.';

const MB_GENERAL_PROMPT = process.env.MB_GENERAL_PROMPT || '';
const MB_BUSINESS_PROMPT = process.env.MB_BUSINESS_PROMPT || '';

const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 1.15);

const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';
const MAX_OUTPUT_TOKENS = process.env.MAX_OUTPUT_TOKENS || 'inf';

// VAD – ברירות מחדל מחוזקות לרעשי רקע
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200); // קטע שקט נוסף אחרי הזיהוי

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000); // 40 שניות
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);  // 90 שניות
// מגבלת זמן שיחה – ברירת מחדל 5 דקות (אפשר לשנות ב-ENV אם תרצה)
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000); // 45 שניות לפני הסוף
// העליתי ל־8 שניות כדי לא לחתוך את משפט הסיום
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 8000);

// האם מותר ללקוח לקטוע את הבוט (barge-in). ברירת מחדל: false = חוק ברזל שאי אפשר לקטוע.
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);

// לידים / וובהוק
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL || '';

// PARSING חכם ללידים
const MB_ENABLE_SMART_LEAD_PARSING = envBool('MB_ENABLE_SMART_LEAD_PARSING', true);
const MB_LEAD_PARSING_MODEL = process.env.MB_LEAD_PARSING_MODEL || 'gpt-4.1-mini';

// Debug
const MB_DEBUG = envBool('MB_DEBUG', false);

// -----------------------------
// Helpers – logging
// -----------------------------
function logDebug(tag, msg, extra) {
  if (!MB_DEBUG) return;
  if (extra !== undefined) {
    console.log(`[DEBUG][${tag}] ${msg}`, extra);
  } else {
    console.log(`[DEBUG][${tag}] ${msg}`);
  }
}

function logInfo(tag, msg, extra) {
  if (extra !== undefined) {
    console.log(`[INFO][${tag}] ${msg}`, extra);
  } else {
    console.log(`[INFO][${tag}] ${msg}`);
  }
}

function logError(tag, msg, extra) {
  if (extra !== undefined) {
    console.error(`[ERROR][${tag}] ${msg}`, extra);
  } else {
    console.error(`[ERROR][${tag}] ${msg}`);
  }
}

// -----------------------------
// System instructions builder
// -----------------------------
function buildSystemInstructions() {
  if (MB_GENERAL_PROMPT && MB_GENERAL_PROMPT.trim().length > 0) {
    // אם המשתמש הגדיר פרומפט כללי – משתמשים בו כמו שהוא.
    return MB_GENERAL_PROMPT;
  }

  const langsTxt =
    MB_LANGUAGES.length > 0
      ? `שפות נתמכות: ${MB_LANGUAGES.join(', ')}. ברירת מחדל: עברית. אם הלקוח מדבר באנגלית או רוסית – עוברים לשפה שלו.`
      : 'ברירת מחדל: עברית.';

  const businessKb =
    MB_BUSINESS_PROMPT && MB_BUSINESS_PROMPT.trim().length > 0
      ? `\n\nמידע עסקי על "${BUSINESS_NAME}":\n${MB_BUSINESS_PROMPT}\n`
      : '\n\nאם אין מידע עסקי רלוונטי, להישאר כללית ולהודות בחוסר הוודאות.\n';

  return `
אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור שירות "${BUSINESS_NAME}".

${langsTxt}

טון דיבור:
- חם, נעים, מקצועי ולא רובוטי.
- תמיד פנייה בלשון רבים ("אתם", "בשבילכם").
- משפטים קצרים וברורים (1–3 משפטים לכל תשובה).
- קצב דיבור מעט מהיר מהרגיל (בערך ${MB_SPEECH_SPEED}).

חוקי שיחה כלליים:
- ברירת מחדל בעברית.
- לא להחליף שפה ללא סיבה ברורה (הלקוח מדבר באנגלית או רוסית).
- לא להתנצל כל הזמן, לא לחפור, לא לחזור על עצמך.
- לנהל שיחה זורמת, לשאול שאלות המשך קצרות כשצריך.
- בסביבה רועשת (רכב, אנשים מדברים) – אם אינכם בטוחים במה שנאמר, אל תענו תשובה מיידית. בקשו מהלקוח לחזור שוב לאט ובברור במקום להמציא תשובה.

פתיחת שיחה:
- בפתיחת השיחה, אחרי הברכה והצגה עצמית, לשאול בקצרה "איך אפשר לעזור לכם היום?" או ניסוח דומה.
- אחרי השאלה הזאת – לעצור ולחכות שהלקוח ידבר. לא לתת הסברים נוספים, לא להמשיך לדבר ולא לענות לעצמכם לפני שהלקוח הגיב בפעם הראשונה.

טלפונים:
- כאשר מבקשים מספר טלפון – לבקש ספרה-ספרה בקול, בקצב איטי וברור.
- להתייחס למספר כרצף ספרות בלבד.
- לא להוסיף +972 ולא להוריד 0 בהתחלה.
- כאשר חוזרים על המספר ללקוח:
  - אסור לוותר על שום ספרה.
  - אסור לאחד ספרות ("שלושים ושתיים") – יש לומר כל ספרה בנפרד: "שלוש, שתיים".
  - אם אינכם בטוחים במספר – לבקש בנימוס שיחזרו עליו שוב במקום לנחש מספר אחר.
  - אם המספר כולל 10 ספרות – בעת החזרה על המספר חייבים להקריא 10 ספרות בדיוק. אם שמעתם פחות – בקשו מהלקוח לחזור שוב כדי לא לטעות.
- אם הלקוח אומר "תחזרו למספר שממנו אני מתקשר" או "למספר המזוהה":
  - אל תקריאו מספר בקול.
  - תגידו משפט בסגנון: "מעולה, ירשם שנחזור אליכם למספר שממנו אתם מתקשרים כעת."
  - אל תמציאו מספר כלשהו.

רוסית:
- כאשר הלקוח מדבר ברוסית – לדבר ברוסית פשוטה, יומיומית, בלי מילים גבוהות או פורמליות מדי.
- להשתמש במשפטים קצרים מאוד (משפט או שניים בכל פעם).
- אם משהו לא ברור – לבקש מהלקוח לחזור על המשפט לאט יותר.

מתחרים:
- מותר להסביר באופן כללי על עולם הבוטים והאוטומציה.
- אסור לתת מידע שיווקי מפורט, המלצות או השוואות ישירות על חברות מתחרות.
- אם שואלים על מתחרה ספציפי – להסביר בעדינות שאינכם נותנים מידע שיווקי מפורט על מתחרים, ולהחזיר את הפוקוס לשירותי MisterBot.

איסוף פרטים (לידים):
- איסוף פרטים נעשה רק אם ברור שיש התעניינות בשירות / פנייה עסקית ולא רק שיחת היכרות כללית.
- לפני איסוף פרטים: להסביר בעדינות למה לוקחים פרטים ("כדי שנוכל לחזור אליכם / להתקדם מול נציג").
- אסור לבקש כמה פרטים באותה שאלה. תמיד:
  - שואלים שאלה אחת בלבד.
  - מחכים לתשובה.
  - ורק אחר כך עוברים לשאלה הבאה.
- סדר מומלץ:
  1. קודם: "איך אפשר לפנות אליכם? אפשר שם פרטי או מלא."
  2. אחרי שהתשובה מגיעה: לשאול אם יש שם עסק. אם אין – לדלג הלאה.
  3. אחר כך: "מה מספר הטלפון שנוח לחזור אליכם אליו?" (לבקש ספרה-ספרה ולהקריא בחזרה במדויק).
  4. לבסוף: לבקש במשפט אחד קצר מה סיבת הפנייה.
- בסיום איסוף הפרטים:
  - לסכם בקצרה ללקוח את מה שנרשם ולוודא שזה נכון.
  - אחרי הסיכום תמיד לשאול: "יש עוד משהו שתרצו לשאול או לבדוק?".
  - אם הלקוח עונה "לא", "לא תודה", "זהו", "זה הכל" וכדומה – לסיים במשפט סיום קצר ומכבד ולהיפרד.

דוגמאות / סימולציה של בוטים קוליים:
- אם לקוח בכל שפה מבקש "לשמוע דוגמה של בוט קולי", "סימולציה", "דמו" וכדומה:
  1. קודם לשאול: "לאיזה סוג עסק תרצו לשמוע דוגמה? למשל מסעדה, מרפאת שיניים, רופאה, עורך דין, מספרה, חנות בגדים וכדומה."
  2. אחרי שהלקוח בוחר סוג עסק – להדגים שיחה קצרה באותה השפה שבה הלקוח מדבר כעת, בסגנון:
     - "לקוח: ..." / "בוט: ..." (או פשוט לדבר כקול של הבוט מול "לקוח").
     - להראות איך הבוט מקבל מידע, קובע תור, עונה לשאלות נפוצות וכו'.
  3. להבהיר שהשיחה היא רק דוגמה, ולא שיחה אמיתית למקום אמיתי.
  4. בזמן הדוגמה לא לאסוף פרטים אמיתיים של מי שמדבר איתכם עכשיו (שם, טלפון שלו). איסוף פרטים אמיתי יהיה רק אם הלקוח מבקש להתקדם באמת.
- אסור לומר "אני לא יכולה לעשות סימולציה" או "אני רק אחבר אתכם לנציג" רק בגלל שביקשו דוגמה. רק אם הלקוח מבקש במפורש נציג אנושי – אפשר להציע חזרה מנציג.

סיום שיחה:
- אם הלקוח אומר "זהו", "זהו זה", "זה הכל", "זה הכול", "סיימנו", "מספיק לעכשיו", "להתראות", "ביי", "ביי ביי", "יאללה ביי",
  "טוב תודה", "טוב תודה, זהו", "בסדר תודה", "שיהיה יום טוב", "לילה טוב", "שבוע טוב", "goodbye", "bye", "ok thanks" וכדומה –
  להבין שזאת סיום שיחה.
- במקרה כזה – לתת משפט סיכום קצר וחיובי, ולהיפרד בעדינות.

${businessKb}

זכרו:
- תמיד לדבר בנימוס, ברוגע, ובקצב מעט מהיר.
- לתת עדיפות למידע העסקי שניתן בפרומפט העסק.
- אם אין מידע, להודות בזה ולענות כללי, בלי להמציא עובדות.
`.trim();
}

// -----------------------------
// Express & HTTP
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio Voice webhook – מחזיר TwiML שמחבר את השיחה ל־Media Streams
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

// -----------------------------
// WebSocket Server for Twilio Media Streams
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

הסברים:
- "is_lead": true אם ברור שיש כאן פנייה עסקית / התעניינות אמיתית בשירות / הזמנת שירות. אחרת false.
- "lead_type": "new" אם מדובר בלקוח חדש, "existing" אם הוא מציין שהוא לקוח קיים, אחרת "unknown".
- "full_name": אם הלקוח נותן שם (פרטי או מלא) – כתוב כפי שנשמע. אם השם נאמר בעברית, כתוב אותו באותיות עבריות ולא באנגלית. אם לא ברור – null.
- "business_name": אם הלקוח מזכיר שם עסק – כתוב כפי שנשמע. אם שם העסק נאמר בעברית, כתוב אותו באותיות עבריות ולא באנגלית. אחרת null.
- "phone_number": אם בשיחה מופיע מספר טלפון של הלקוח – החזר אותו כרצף ספרות בלבד, בלי רווחים ובלי +972 ובלי להוריד 0 בהתחלה.
  אם נשמעים כמה מספרים – בחר את המספר הרלוונטי ביותר ליצירת קשר, אחרת null.
- "reason": תיאור קצר וקולע בעברית של סיבת הפנייה (משפט אחד קצר).
- "notes": כל דבר נוסף שיכול להיות רלוונטי לאיש מכירות / שירות (למשל: "מעוניין בדמו לבוט קולי", "פנייה דחופה", "שאל על מחירים" וכו').

חשוב:
- אם נראה שהשיחה היא רק הדגמה / סימולציה / תיאור של תסריט דוגמה לבוט קולי, ולא פנייה אמיתית של לקוח – החזר "is_lead": false ו-"phone_number": null.
- אם רוב השיחה היא בעברית – העדף עברית בכל השדות הטקסטואליים (reason, notes, שמות אם נאמרו בעברית וכו').

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

  const instructions = buildSystemInstructions();
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;

  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let conversationLog = []; // [{ from: 'user'|'bot', text }]
  let currentBotText = '';
  let callStartTs = Date.now();
  let lastMediaTs = Date.now();
  let idleCheckInterval = null;
  let maxCallTimeout = null;
  let pendingHangup = null; // { reason, closingMessage }
  let hangupGraceTimeout = null; // טיימר ניתוק לאחר פרידה
  let openAiReady = false;
  let twilioClosed = false;
  let openAiClosed = false;

  // האם הבוט מדבר כרגע (חוק ברזל – אין barge-in)
  let botSpeaking = false;

  // -----------------------------
  // Helper: האם הלקוח ביקש חזרה למספר המזוהה
  // -----------------------------
  function conversationMentionsCallerId() {
    const patterns = [/מזוהה/, /למספר שממנו/, /למספר שממנו אני מתקשר/, /למספר שממנו התקשרתי/];
    return conversationLog.some(
      (m) => m.from === 'user' && patterns.some((re) => re.test(m.text || ''))
    );
  }

  // -----------------------------
  // Helper: שליחת וובהוק לידים / לוג
  // -----------------------------
  async function sendLeadWebhook(reason, closingMessage) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) {
      logDebug(tag, 'Lead webhook disabled or URL missing – skipping.');
      return;
    }
    try {
      let parsedLead = await extractLeadFromConversation(conversationLog);

      // תמיד מוודאים שיש אובייקט לוגי, גם אם המודל לא החזיר כלום
      if (!parsedLead || typeof parsedLead !== 'object') {
        parsedLead = {
          is_lead: false,
          lead_type: 'unknown',
          full_name: null,
          business_name: null,
          phone_number: null,
          reason: null,
          notes: ''
        };
      }

      // אם הלקוח ביקש חזרה למספר המזוהה ואין מספר בליד – נשתמש ב-callerNumber
      if (!parsedLead.phone_number && callerNumber && conversationMentionsCallerId()) {
        parsedLead.phone_number = callerNumber;
        parsedLead.notes =
          (parsedLead.notes || '') +
          (parsedLead.notes ? ' ' : '') +
          'הלקוח ביקש חזרה למספר המזוהה ממנו התקשר.';
      }

      const payload = {
        streamSid,
        callSid,
        callerNumber,         // מספר מזוהה כפי שהגיע מטוויליו
        botName: BOT_NAME,
        businessName: BUSINESS_NAME,
        startedAt: new Date(callStartTs).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - callStartTs,
        reason,
        closingMessage,
        conversationLog,
        parsedLead
      };

      logInfo(tag, `Sending lead webhook to ${MB_WEBHOOK_URL}`);
      const res = await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        logError(tag, `Lead webhook HTTP ${res.status}`, await res.text());
      }
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err);
    }
  }

  // -----------------------------
  // Helper: סיום שיחה מרוכז
  // -----------------------------
  async function endCall(reason, closingMessage) {
    logInfo(tag, `endCall called with reason="${reason}"`);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (hangupGraceTimeout) clearTimeout(hangupGraceTimeout);

    await sendLeadWebhook(reason, closingMessage || MB_CLOSING_SCRIPT);

    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiClosed = true;
      openAiWs.close();
    }

    if (!twilioClosed && connection.readyState === WebSocket.OPEN) {
      twilioClosed = true;
      connection.close();
    }

    // בטוח שהבוט לא "מדבר" יותר
    botSpeaking = false;
  }

  // -----------------------------
  // Helper: תזמון סיום שיחה אחרי שהבוט יגיד משפט סיום
  // -----------------------------
  function scheduleEndCall(reason, closingMessage) {
    if (pendingHangup) {
      logDebug(tag, 'Hangup already scheduled, skipping duplicate.');
      return;
    }
    pendingHangup = { reason, closingMessage: closingMessage || MB_CLOSING_SCRIPT };

    if (openAiWs.readyState === WebSocket.OPEN) {
      const text = pendingHangup.closingMessage || MB_CLOSING_SCRIPT;
      const item = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף משפטים נוספים: "${text}"`
            }
          ]
        }
      };
      openAiWs.send(JSON.stringify(item));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      logInfo(tag, `Scheduled hangup with closing message: ${text}`);

      // ניתוק בטוח לאחר MB_HANGUP_GRACE_MS גם אם לא קיבלנו response.output_audio.done / response.completed
      if (!hangupGraceTimeout && MB_HANGUP_GRACE_MS > 0) {
        hangupGraceTimeout = setTimeout(() => {
          if (pendingHangup) {
            const { reason: r, closingMessage: cm } = pendingHangup;
            logInfo(
              tag,
              `Hangup grace timeout reached (${MB_HANGUP_GRACE_MS} ms), forcing endCall.`
            );
            pendingHangup = null;
            endCall(r, cm);
          }
        }, MB_HANGUP_GRACE_MS);
      }
    } else {
      // אם אין חיבור למודל – מנתקים מיד
      endCall(reason, closingMessage);
    }
  }

  // -----------------------------
  // Helper: בדיקת מילות פרידה של המשתמש
  // -----------------------------
  function checkUserGoodbye(transcript) {
    if (!transcript) return;
    const t = transcript.toLowerCase().trim();

    // לא מגבילים כמעט אורך – גם משפט פרידה ארוך עם "ביי" בסוף צריך להיתפס
    if (t.length === 0 || t.length > 200) {
      return;
    }

    const goodbyePatterns = [
      'זהו',
      'זהו זה',
      'זה הכל',
      'זה הכול',
      'סיימנו',
      'מספיק לעכשיו',
      'להתראות',
      'להתראות לך',
      'ביי',
      'ביי ביי',
      'יאללה ביי',
      'יאללה, ביי',
      'תודה רבה',
      'תודה, זהו',
      'תודה, זה הכל',
      'תודה זה הכל',
      'תודה זהו',
      'טוב תודה',
      'טוב, תודה',
      'לא תודה',
      'לא, תודה',
      'לא צריך',
      'לא צריך תודה',
      'אין, תודה',
      'אין תודה',
      'זהו תודה',
      'זה הכל תודה',
      'שיהיה יום טוב',
      'שיהיה לכם יום טוב',
      'לילה טוב',
      'שבוע טוב',
      'goodbye',
      'bye',
      'bye bye',
      'ok thanks',
      "that's all",
      'that is all'
    ];

    if (goodbyePatterns.some((p) => t.includes(p))) {
      logInfo(tag, `Detected user goodbye phrase in transcript: "${transcript}"`);
      scheduleEndCall('user_goodbye', MB_CLOSING_SCRIPT);
    }
  }

  // -----------------------------
  // Helper: הודעת "אתם עדיין איתי?"
  // -----------------------------
  let idleWarningSent = false;

  function sendIdleWarningIfNeeded() {
    if (idleWarningSent) return;
    idleWarningSent = true;

    if (openAiWs.readyState === WebSocket.OPEN) {
      const text = 'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
      const item = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `תגיבי ללקוח במשפט קצר בסגנון הבא (אפשר לשנות קצת): "${text}"`
            }
          ]
        }
      };
      openAiWs.send(JSON.stringify(item));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
      logInfo(tag, 'Idle warning sent via model.');
    }
  }

  // -----------------------------
  // OpenAI WS handlers
  // -----------------------------
  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, 'Connected to OpenAI Realtime API.');

    // זמן שקט אפקטיבי = בסיס + סיומת
    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;

    const sessionUpdate = {
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['audio', 'text'],
        voice: OPENAI_VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // ✅ תמלול בכוונה בעברית כדי למנוע תרגום לאנגלית
        input_audio_transcription: { model: 'whisper-1', language: 'he' },
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

    const greetingText = MB_OPENING_SCRIPT;
    const initialItem = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `פתחי את השיחה עם הלקוח בעברית במשפטים קצרים בסגנון הבא (אפשר טיפה לשנות, אבל לא יותר מדי): "${greetingText}"`
          }
        ]
      }
    };

    openAiWs.send(JSON.stringify(initialItem));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  });

  openAiWs.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (err) {
      logError(tag, 'Failed to parse OpenAI WS message', err);
      return;
    }

    if (MB_DEBUG) {
      logDebug(tag, `OpenAI event type: ${event.type}`, event);
    }

    switch (event.type) {
      case 'session.updated':
        logDebug(tag, 'Session updated', event);
        break;

      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (!event.delta) return;
        if (connection.readyState !== WebSocket.OPEN) return;

        // הבוט מדבר כרגע – חוסמים barge-in
        botSpeaking = true;

        const audioDelta = {
          event: 'media',
          streamSid,
          media: { payload: event.delta }
        };
        connection.send(JSON.stringify(audioDelta));
        break;
      }

      // כשהאודיו של התשובה הסתיים – נטע סיימה לדבר
      case 'response.output_audio.done':
      case 'response.audio.done': {
        botSpeaking = false;

        if (pendingHangup) {
          const { reason, closingMessage } = pendingHangup;
          pendingHangup = null;
          endCall(reason, closingMessage);
        }
        break;
      }

      case 'response.output_text.delta':
        if (typeof event.delta === 'string') {
          currentBotText += event.delta;
        }
        break;

      case 'response.output_text.done':
      case 'response.completed':
      case 'response.done':
        // הטקסט של הבוט מוכן – שומרים בלוג
        if (currentBotText.trim().length > 0) {
          conversationLog.push({ from: 'bot', text: currentBotText.trim() });
          currentBotText = '';
        }
        // לא מנתקים כאן – הניתוק קורה על output_audio.done כדי לסיים משפט בקול.
        break;

      case 'conversation.item.input_audio_transcription.completed':
      case 'response.audio_transcript.done': {
        const transcript =
          event.transcript ||
          (event.output && event.output[0] && event.output[0].content) ||
          '';

        if (typeof transcript === 'string' && transcript.trim().length > 0) {
          const clean = transcript.trim();
          logInfo(tag, 'User transcript:', clean);
          conversationLog.push({ from: 'user', text: clean });
          checkUserGoodbye(clean);
        }
        break;
      }

      case 'error':
        logError(tag, 'OpenAI error event', event);
        break;

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    botSpeaking = false;
    logInfo(tag, 'OpenAI WS connection closed.');
  });

  openAiWs.on('error', (err) => {
    logError(tag, 'OpenAI WS error', err);
  });

  // -----------------------------
  // Twilio WS handlers
  // -----------------------------
  connection.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      logError(tag, 'Failed to parse Twilio WS message', err);
      return;
    }

    if (MB_DEBUG) {
      logDebug(tag, `Twilio event: ${data.event}`, data);
    }

    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        callSid = data.start.callSid || null;

        // ✅ קריאה חזקה של customParameters כדי שתמיד נקבל את caller (מזוהה)
        (() => {
          const cp = data.start.customParameters;
          let extracted = null;

          if (cp) {
            if (Array.isArray(cp)) {
              const found = cp.find((p) => p.name === 'caller');
              if (found && typeof found.value === 'string') {
                extracted = found.value;
              }
            } else if (typeof cp === 'object') {
              if (typeof cp.caller === 'string') {
                extracted = cp.caller;
              }
            }
          }

          callerNumber = extracted || null;
        })();

        callStartTs = Date.now();
        lastMediaTs = Date.now();
        logInfo(
          tag,
          `Incoming stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`
        );

        // טיימר בדיקת שקט + מגבלת זמן שיחה (5 דקות)
        idleCheckInterval = setInterval(() => {
          const now = Date.now();
          const idleMs = now - lastMediaTs;
          const callMs = now - callStartTs;

          if (!idleWarningSent && idleMs >= MB_IDLE_WARNING_MS) {
            sendIdleWarningIfNeeded();
          }

          if (idleMs >= MB_IDLE_HANGUP_MS) {
            logInfo(tag, `Idle timeout reached (${idleMs} ms), scheduling hangup.`);
            scheduleEndCall('idle_timeout', MB_CLOSING_SCRIPT);
          }

          // אם עברנו את 5 הדקות – נפרדים ומנתקים
          if (MB_MAX_CALL_MS > 0 && callMs >= MB_MAX_CALL_MS) {
            logInfo(tag, `Max call duration reached (${callMs} ms), scheduling hangup.`);
            const finalText =
              'הזמן שהוקצה לשיחה שלנו הסתיים, תודה שדיברתם איתי. נמשיך משלב זה מול נציג מטעם מיסטר בוט. יום נעים ולהתראות.';
            scheduleEndCall('max_duration', finalText);
          }
        }, 1000);

        // אזהרה לפני סוף 5 הדקות – לתת אפשרות להתקדם ולהשאיר פרטים
        if (MB_MAX_CALL_MS > 0 && MB_MAX_WARN_BEFORE_MS > 0) {
          const warnAt = MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS;
          if (warnAt > 0) {
            maxCallTimeout = setTimeout(() => {
              if (openAiWs.readyState === WebSocket.OPEN) {
                const warnText =
                  'אנחנו מתקרבים לסיום הזמן לשיחה. אם תרצו להתקדם ולהשאיר פרטים, זה זמן טוב לעשות זאת עכשיו.';
                const item = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'message',
                    role: 'user',
                    content: [
                      {
                        type: 'input_text',
                        text: `תני ללקוח אזהרה קצרה בסגנון הבא (אפשר לשנות מעט): "${warnText}"`
                      }
                    ]
                  }
                };
                openAiWs.send(JSON.stringify(item));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
                logInfo(tag, 'Max duration warning sent.');
              }
            }, warnAt);
          }
        }

        break;

      case 'media':
        lastMediaTs = Date.now();

        // חוק ברזל: אם הבוט מדבר ואין barge-in – מתעלמים מהאודיו של הלקוח
        if (!MB_ALLOW_BARGE_IN && botSpeaking) {
          return;
        }

        if (openAiReady && openAiWs.readyState === WebSocket.OPEN) {
          const audioAppend = {
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          };
          openAiWs.send(JSON.stringify(audioAppend));
        }
        break;

      case 'mark':
        break;

      case 'stop':
        logInfo(tag, 'Twilio sent stop event – ending call.');
        endCall('twilio_stop', MB_CLOSING_SCRIPT);
        break;

      default:
        logDebug(tag, `Unhandled Twilio event: ${data.event}`);
        break;
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logInfo(tag, 'Twilio Media Stream WS closed.');
    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (hangupGraceTimeout) clearTimeout(hangupGraceTimeout);
    botSpeaking = false;
  });

  connection.on('error', (err) => {
    logError(tag, 'Twilio WS error', err);
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ MisterBot Realtime server listening on port ${PORT}`);
  console.log(`   /twilio-voice (TwiML)`);
  console.log(`   /twilio-media-stream (WebSocket for Twilio Media Streams)`);
});
