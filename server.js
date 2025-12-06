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

const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 1.15);

const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

// ניהול נכון של MAX_OUTPUT_TOKENS – תמיד מספר או "inf"
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

// VAD – ברירות מחדל מחוזקות לרעשי רקע
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200); // קטע שקט נוסף אחרי הזיהוי

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000); // 40 שניות
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);  // 90 שניות

// מגבלת זמן שיחה – ברירת מחדל 5 דקות
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000); // 45 שניות לפני הסוף
// נשאיר את הפרמטר אבל לא נשתמש בו בפועל לנטע (הניתוק מיידי אחרי הסגיר)
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 8000);

// האם מותר ללקוח לקטוע את הבוט (barge-in)
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
// Dynamic KB from Google Drive
// -----------------------------
const MB_DYNAMIC_KB_URL = process.env.MB_DYNAMIC_KB_URL || '';
let dynamicBusinessPrompt = '';

async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) return;

  try {
    const res = await fetch(MB_DYNAMIC_KB_URL);
    if (!res.ok) {
      console.error(`[ERROR][${tag}] Failed to fetch dynamic KB. HTTP ${res.status}`);
      return;
    }
    const text = (await res.text()).trim();
    dynamicBusinessPrompt = text;
    console.log(`[INFO][${tag}] Dynamic KB loaded. length=${text.length}`);
  } catch (err) {
    console.error(`[ERROR][${tag}] Error fetching dynamic KB`, err);
  }
}

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
// Helper – נורמליזציה למספר טלפון ישראלי
// -----------------------------
function normalizePhoneNumber(rawPhone, callerNumber) {
  function toDigits(num) {
    if (!num) return null;
    return String(num).replace(/\D/g, '');
  }

  function normalize972(digits) {
    if (digits.startsWith('972') && (digits.length === 11 || digits.length === 12)) {
      // גם לנייד (12) וגם לנייח (11) – משאירים את המספר אחרי 972 ומוסיפים 0
      return '0' + digits.slice(3);
    }
    return digits;
  }

  function isValidIsraeliPhone(digits) {
    if (!/^0\d{8,9}$/.test(digits)) return false; // 9 או 10 ספרות, מתחיל ב-0
    const prefix2 = digits.slice(0, 2);

    if (digits.length === 9) {
      // נייחים קלאסיים
      return ['02', '03', '04', '07', '08', '09'].includes(prefix2);
    } else {
      // 10 ספרות – ניידים/07 וכדומה
      if (prefix2 === '05' || prefix2 === '07') return true;
      // ליתר ביטחון נאפשר גם 02/03/04/08/09 עם 10 ספרות
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

  const staticKb =
    MB_BUSINESS_PROMPT && MB_BUSINESS_PROMPT.trim().length > 0
      ? MB_BUSINESS_PROMPT.trim()
      : '';

  const dynamicKb =
    dynamicBusinessPrompt && dynamicBusinessPrompt.trim().length > 0
      ? dynamicBusinessPrompt.trim()
      : '';

  let businessKb = '';

  if (staticKb || dynamicKb) {
    let combined = '';
    if (staticKb) {
      combined += `מידע עסקי בסיסי על "${BUSINESS_NAME}":\n${staticKb}\n`;
    }
    if (dynamicKb) {
      combined += `\nלמידה מעודכנת מהשיחות האחרונות והטבלה:\n${dynamicKb}\n`;
    }
    businessKb = `\n\n${combined}\n`;
  } else {
    businessKb =
      '\n\nאם אין מידע עסקי רלוונטי, להישאר כללית ולהודות בחוסר הוודאות.\n';
  }

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
- מספר תקין בישראל:
  - 10 ספרות למספרי סלולר, בדרך כלל מתחילים ב-05 או 07.
  - או 9 ספרות למספרים נייחים שמתחילים בקידומות 02, 03, 04, 07, 08, 09.
- כאשר חוזרים על המספר ללקוח:
  - אסור לוותר על שום ספרה.
  - אסור לאחד ספרות ("שלושים ושתיים") – יש לומר כל ספרה בנפרד: "שלוש, שתיים".
  - חייבים להקריא את המספר בדיוק כפי שנקלט: אותן הספרות, באותו הסדר, בלי להמציא או לתקן ספרות.
  - אם אינכם בטוחים במספר – לבקש בנימוס שיחזרו עליו שוב במקום לנחש מספר אחר.
  - אם המספר כולל 10 ספרות או 9 ספרות – בעת החזרה על המספר חייבים להקריא את כל הספרות בדיוק (10 או 9). אם שמעתם פחות – בקשו מהלקוח לחזור שוב כדי לא לטעות.
  - לפני שאתם מקריאים מספר, ודאו שיש לכם בדיוק 9 או 10 ספרות. אם חסרה ספרה או יש ספק – בקשו שוב מהלקוח לומר אותו, ואל תקצרו או תסכמו.
  - למשל: אם נאמר "0 5 0 3 2 2 2 2 3 7" אתם חייבים להגיד בקול: "אפס, חמש, אפס, שלוש, שתיים, שתיים, שתיים, שתיים, שלוש, שבע" – בלי לדלג על אף "שתיים" ובלי לחבר אותן.
- חשוב: אל תוסיפו או תמציאו ספרות שלא נאמרו בשיחה.
- אם המספר שנשמע אינו באורך 9 או 10 ספרות, או שאינו מתחיל בקידומת תקינה – עדיף להחזיר phone_number: null, ולבקש מהלקוח לחזור על המספר במקום לנחש.
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
  2. אחרי שהתשובה מגיעה: לשאול אם יש שם עסק. אם אין – לציין "לא רלוונטי" בשדה שם העסק.
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
- אם הלקוח אומר "זהו", "זהו זה", "זה הכל", "זה הכול", "סיימנו", "מספיק לעכשיו", "להתראות", "להתראות לך",
  "ביי", "ביי ביי", "יאללה ביי", "יאללה, ביי",
  "טוב תודה", "טוב תודה, זהו", "בסדר תודה", "שיהיה יום טוב", "לילה טוב", "שבוע טוב",
  "goodbye", "bye", "ok thanks" וכדומה –
  להבין שזאת סיום שיחה.
- במקרה כזה – לתת משפט סיום קצר וחיובי, ולהיפרד בעדינות. מיד אחרי משפט הסיום – ניתוק השיחה.

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

  logInfo(
    'Twilio-Voice',
    `Returning TwiML with Stream URL: ${wsUrl}, From=${caller}`
  );
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

הסברים:
- "is_lead": true אם ברור שיש כאן פנייה עסקית / התעניינות אמיתית בשירות / הזמנת שירות. אחרת false.
- "lead_type": "new" אם מדובר בלקוח חדש, "existing" אם הוא מציין שהוא לקוח קיים, אחרת "unknown".
- "full_name": אם הלקוח נותן שם (פרטי או מלא) – כתוב כפי שנשמע. אם השם נאמר בעברית, כתוב אותו באותיות עבריות ולא באנגלית. אם לא ברור – null.
- "business_name": אם הלקוח מזכיר שם עסק – כתוב כפי שנשמע. אם שם העסק נאמר בעברית, כתוב אותו באותיות עבריות ולא באנגלית. אחרת null.
- "phone_number": אם בשיחה מופיע מספר טלפון של הלקוח – החזר אותו כרצף ספרות בלבד, בלי רווחים ובלי +972 ובלי להוריד 0 בהתחלה.
  אם נשמעים כמה מספרים – בחר את המספר הרלוונטי ביותר ליצירת קשר, אחרת null.
  אל תוסיף ספרות שלא נאמרו, ואל תנחש מספר אם לא ברור.
  אם המספר שנשמע אינו באורך 10 ספרות או 9 ספרות, או שאינו מתחיל בקידומת תקינה – עדיף להחזיר phone_number: null.
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
  let idleWarningSent = false;
  let maxCallTimeout = null;
  let maxCallWarningTimeout = null;
  let pendingHangup = null;    // { reason, closingMessage, closingSent }
  let openAiReady = false;
  let twilioClosed = false;
  let openAiClosed = false;

  // מצב דיבור של הבוט (לצורך barge-in)
  let botSpeaking = false;

  // האם יש response פעיל במודל
  let hasActiveResponse = false;

  // -----------------------------
  // Helper: שליחת טקסט למודל עם הגנה על response כפול
  // -----------------------------
  function sendModelPrompt(text, purpose) {
    if (openAiWs.readyState !== WebSocket.OPEN) {
      logDebug(tag, `Cannot send model prompt (${purpose || 'no-tag'}) – WS not open.`);
      return;
    }
    if (hasActiveResponse) {
      logDebug(
        tag,
        `Skipping model prompt (${purpose || 'no-tag'}) – conversation already has active response.`
      );
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
    logInfo(tag, `Sending model prompt (${purpose || 'no-tag'})`);
  }

  // -----------------------------
  // Helper: האם הלקוח הזכיר מזוהה
  // -----------------------------
  function conversationMentionsCallerId() {
    const patterns = [/מזוהה/, /למספר שממנו/, /למספר שממנו אני מתקשר/, /למספר שממנו התקשרתי/];
    return conversationLog.some(
      (m) => m.from === 'user' && patterns.some((re) => re.test(m.text || ''))
    );
  }

  // -----------------------------
  // Helper: שליחת וובהוק לידים
  // -----------------------------
  async function sendLeadWebhook(reason, closingMessage) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) {
      logDebug(tag, 'Lead capture disabled or no MB_WEBHOOK_URL – skipping webhook.');
      return;
    }

    try {
      let parsedLead = await extractLeadFromConversation(conversationLog);

      if (!parsedLead || typeof parsedLead !== 'object') {
        logInfo(tag, 'No parsed lead object – sending fallback payload with caller only.');
        parsedLead = {
          is_lead: false,
          lead_type: 'unknown',
          full_name: null,
          business_name: 'לא רלוונטי',
          phone_number: null,
          reason: null,
          notes: null
        };
      }

      if (!parsedLead.phone_number && callerNumber && conversationMentionsCallerId()) {
        parsedLead.phone_number = callerNumber;
        parsedLead.notes =
          (parsedLead.notes || '') +
          (parsedLead.notes ? ' ' : '') +
          'הלקוח ביקש חזרה למספר המזוהה ממנו התקשר.';
      }

      const normalizedPhone = normalizePhoneNumber(
        parsedLead.phone_number,
        callerNumber
      );
      parsedLead.phone_number = normalizedPhone;

      const callerIdRaw = callerNumber || null;
      const callerIdNormalized = normalizePhoneNumber(null, callerNumber);

      parsedLead.caller_id_raw = callerIdRaw;
      parsedLead.caller_id_normalized = callerIdNormalized;

      // חובה: business_name תמיד מלא
      if (
        !parsedLead.business_name ||
        typeof parsedLead.business_name !== 'string' ||
        !parsedLead.business_name.trim()
      ) {
        parsedLead.business_name = 'לא רלוונטי';
      }

      const isFullLead =
        parsedLead.is_lead === true &&
        (parsedLead.lead_type === 'new' || parsedLead.lead_type === 'existing') &&
        !!parsedLead.phone_number;

      const payload = {
        streamSid,
        callSid,
        callerNumber: callerIdRaw,
        callerIdRaw,
        callerIdNormalized,
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
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err);
    }
  }

  // -----------------------------
  // Helper: סיום שיחה מרוכז – ניתוק מיידי אחרי הסגיר
  // -----------------------------
  function endCall(reason, closingMessage) {
    logInfo(tag, `endCall called with reason="${reason}"`);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);

    // 🔔 לא מחכים ל-webhook – שולחים בפייר אנד פורגט
    if (MB_ENABLE_LEAD_CAPTURE && MB_WEBHOOK_URL) {
      sendLeadWebhook(reason, closingMessage || MB_CLOSING_SCRIPT).catch((err) =>
        logError(tag, 'sendLeadWebhook fire-and-forget error', err)
      );
    }

    // קודם כל סוגרים OpenAI ו-Twilio – כדי שהלקוח יתנתק מיד
    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiClosed = true;
      openAiWs.close();
    }

    if (!twilioClosed && connection.readyState === WebSocket.OPEN) {
      twilioClosed = true;
      connection.close();
    }

    botSpeaking = false;
    hasActiveResponse = false;
  }

  // -----------------------------
  // Helper: תזמון סיום שיחה אחרי סגיר – חוק ברזל:
  // ברגע שהסגיר נאמר ונגמר – ניתוק מיידי.
  // -----------------------------
  function scheduleEndCall(reason, closingMessage) {
    const msg = closingMessage || MB_CLOSING_SCRIPT;

    if (pendingHangup) {
      logDebug(tag, 'Hangup already scheduled, skipping duplicate.');
      return;
    }

    // מסמנים שיש בקשת ניתוק
    pendingHangup = {
      reason,
      closingMessage: msg,
      closingSent: false
    };

    if (openAiWs.readyState !== WebSocket.OPEN) {
      // אין חיבור – ניתוק מיידי
      endCall(reason, msg);
      return;
    }

    // אם אין כרגע response פעיל – שולחים מיד סגיר
    if (!hasActiveResponse) {
      const text = pendingHangup.closingMessage || MB_CLOSING_SCRIPT;
      sendModelPrompt(
        `סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף משפטים נוספים: "${text}"`,
        'closing'
      );
      pendingHangup.closingSent = true;
      logInfo(tag, `Scheduled hangup with closing message (immediate): ${text}`);
    } else {
      // יש response פעיל – נחכה שיסתיים, ואז ב-response.completed נשלח סגיר
      logDebug(
        tag,
        'scheduleEndCall: model has active response, will send closing after response.completed.'
      );
    }
  }

  // -----------------------------
  // Helper: בדיקת מילות פרידה של המשתמש
  // -----------------------------
  function checkUserGoodbye(transcript) {
    if (!transcript) return;
    const t = transcript.toLowerCase().trim();
    if (!t) return;

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
  function sendIdleWarningIfNeeded() {
    if (idleWarningSent) return;
    idleWarningSent = true;

    const text =
      'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
    sendModelPrompt(
      `תגיבי ללקוח במשפט קצר בסגנון הבא (אפשר לשנות קצת): "${text}"`,
      'idle_warning'
    );
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
        voice: OPENAI_VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
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
        botSpeaking = false;
        break;

      case 'response.output_text.delta': {
        const delta = msg.delta || '';
        if (delta) currentBotText += delta;
        break;
      }

      case 'response.output_text.done': {
        const text = (currentBotText || '').trim();
        if (text) {
          conversationLog.push({ from: 'bot', text });
        }
        currentBotText = '';
        break;
      }

      // שליחת אודיו לטוויליו
      case 'response.audio.delta': {
        const b64 = msg.delta;
        if (!b64 || !streamSid) break;
        botSpeaking = true;
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
        // האודיו הסתיים, אבל ה-Response עדיין פעיל עד response.completed
        botSpeaking = false;
        break;
      }

      case 'response.completed': {
        botSpeaking = false;
        hasActiveResponse = false;

        // אם יש ניתוק מתוכנן:
        if (pendingHangup) {
          if (!pendingHangup.closingSent && openAiWs.readyState === WebSocket.OPEN) {
            // response רגיל הסתיים – עכשיו שולחים את הסגיר
            const text =
              pendingHangup.closingMessage || MB_CLOSING_SCRIPT;
            sendModelPrompt(
              `סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף משפטים נוספים: "${text}"`,
              'closing_after_previous'
            );
            pendingHangup.closingSent = true;
            logInfo(
              tag,
              `Sending closing message after previous response completed: ${text}`
            );
          } else {
            // זה ה-response.completed של הסגיר עצמו – ניתוק מיידי (חוק ברזל)
            const { reason, closingMessage } = pendingHangup;
            pendingHangup = null;
            endCall(reason, closingMessage);
          }
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = msg.transcript || '';
        const t = transcript.trim();
        if (t) {
          conversationLog.push({ from: 'user', text: t });
          checkUserGoodbye(t);
        }
        break;
      }

      case 'error': {
        logError(tag, 'OpenAI Realtime error event', msg);
        break;
      }

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    logInfo(tag, 'OpenAI WS closed.');
    if (!twilioClosed) {
      scheduleEndCall('openai_ws_closed', MB_CLOSING_SCRIPT);
    }
  });

  openAiWs.on('error', (err) => {
    logError(tag, 'OpenAI WS error', err);
    if (!openAiClosed) {
      openAiClosed = true;
      openAiWs.close();
    }
    if (!twilioClosed) {
      scheduleEndCall('openai_ws_error', MB_CLOSING_SCRIPT);
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
      callerNumber = msg.start?.customParameters?.caller || null;
      callStartTs = Date.now();
      lastMediaTs = Date.now();

      logInfo(
        tag,
        `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${callerNumber}`
      );

      // Idle checker
      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (!idleWarningSent && sinceMedia >= MB_IDLE_WARNING_MS) {
          sendIdleWarningIfNeeded();
        }
        if (sinceMedia >= MB_IDLE_HANGUP_MS) {
          logInfo(tag, 'Idle timeout reached, scheduling endCall.');
          scheduleEndCall('idle_timeout', MB_CLOSING_SCRIPT);
        }
      }, 1000);

      // Max call duration + התראה לפני
      if (MB_MAX_CALL_MS > 0) {
        if (
          MB_MAX_WARN_BEFORE_MS > 0 &&
          MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS
        ) {
          maxCallWarningTimeout = setTimeout(() => {
            const t =
              'אנחנו מתקרבים לסיום הזמן לשיחה הזאת. אם תרצו להתקדם, אפשר עכשיו לסכם ולהשאיר פרטים.';
            sendModelPrompt(
              `תני ללקוח משפט קצר בסגנון הבא (אפשר לשנות קצת): "${t}"`,
              'max_call_warning'
            );
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          logInfo(tag, 'Max call duration reached, scheduling endCall.');
          scheduleEndCall('max_call_duration', MB_CLOSING_SCRIPT);
        }, MB_MAX_CALL_MS);
      }
    } else if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;

      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      if (!MB_ALLOW_BARGE_IN && botSpeaking) {
        // חוק ברזל – לא מאפשרים ללקוח לקטוע את הבוט
        return;
      }

      const oaMsg = {
        type: 'input_audio_buffer.append',
        audio: payload
      };
      openAiWs.send(JSON.stringify(oaMsg));
    } else if (event === 'stop') {
      logInfo(tag, 'Twilio stream stopped.');
      if (!twilioClosed) {
        twilioClosed = true;
      }
      scheduleEndCall('twilio_stop', MB_CLOSING_SCRIPT);
    } else {
      // events אחרים (mark וכו') – מתעלמים
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logInfo(tag, 'Twilio WS closed.');
    if (!openAiClosed) {
      scheduleEndCall('twilio_ws_closed', MB_CLOSING_SCRIPT);
    }
  });

  connection.on('error', (err) => {
    twilioClosed = true;
    logError(tag, 'Twilio WS error', err);
    if (!openAiClosed) {
      scheduleEndCall('twilio_ws_error', MB_CLOSING_SCRIPT);
    }
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ MisterBot Realtime Voice Bot running on port ${PORT}`);
  refreshDynamicBusinessPrompt('Startup').catch((err) =>
    console.error('[ERROR][DynamicKB] initial load failed', err)
  );
  // ריענון KB דינאמי כל 5 דקות
  if (MB_DYNAMIC_KB_URL) {
    setInterval(
      () => refreshDynamicBusinessPrompt('Interval').catch(() => {}),
      5 * 60 * 1000
    );
  }
});
