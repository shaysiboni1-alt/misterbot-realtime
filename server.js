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
  'תודה שדיברתם עם מיסטר בוט, יום נעים ולהתראות.';

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
// זמן חסד לפני ניתוק סופי אחרי סגיר – כדי לא לחתוך את המשפט
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
// Dynamic KB from Google Drive
// -----------------------------
const MB_DYNAMIC_KB_URL = process.env.MB_DYNAMIC_KB_URL || '';
let dynamicBusinessPrompt = '';

// לוגרים יוגדרו בהמשך, אבל הפונקציה תשתמש בהם (פונקציות ב-JS מונפות)
async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) {
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
// Helper – נורמליזציה למספר טלפון (10 ספרות ישראלי)
// -----------------------------
function normalizePhoneNumber(rawPhone, callerNumber) {
  function clean(num) {
    if (!num) return null;
    let digits = String(num).replace(/\D/g, '');

    // אם הגיע בפורמט בינלאומי ישראלי (+97250...) – נהפוך ל-0...
    if (digits.startsWith('972') && digits.length === 12) {
      digits = '0' + digits.slice(3); // 97250xxxxxxx -> 050xxxxxxx
    }

    if (/^0\d{9}$/.test(digits)) {
      return digits;
    }
    return null;
  }

  // קודם כל המספר שה-parser מצא מהשיחה
  const fromLead = clean(rawPhone);
  if (fromLead) return fromLead;

  // אם הוא לא תקין – ננסה את ה-callerID מטוויליו
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

  // חיבור בין KB סטטי (מה-ENV) לבין KB דינאמי מהדרייב
  const staticKb = MB_BUSINESS_PROMPT && MB_BUSINESS_PROMPT.trim().length > 0
    ? MB_BUSINESS_PROMPT.trim()
    : '';

  const dynamicKb = dynamicBusinessPrompt && dynamicBusinessPrompt.trim().length > 0
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
    businessKb = '\n\nאם אין מידע עסקי רלוונטי, להישאר כללית ולהודות בחוסר הוודאות.\n';
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
- כאשר חוזרים על המספר ללקוח:
  - אסור לוותר על שום ספרה.
  - אסור לאחד ספרות ("שלושים ושתיים") – יש לומר כל ספרה בנפרד: "שלוש, שתיים".
  - אם אינכם בטוחים במספר – לבקש בנימוס שיחזרו עליו שוב במקום לנחש מספר אחר.
  - אם המספר כולל 10 ספרות – בעת החזרה על המספר חייבים להקריא 10 ספרות בדיוק. אם שמעתם פחות – בקשו מהלקוח לחזור שוב כדי לא לטעות.
  - לפני שאתם מקריאים מספר, ודאו שיש לכם בדיוק 10 ספרות. אם חסרה ספרה או יש ספק – בקשו שוב מהלקוח לומר אותו, ואל תקצרו או תסכמו.
  - למשל: אם נאמר "0 5 0 3 2 2 2 2 3 7" אתם חייבים להגיד בקול: "אפס, חמש, אפס, שלוש, שתיים, שתיים, שתיים, שתיים, שלוש, שבע" – בלי לדלג על אף "שתיים" ובלי לחבר אותן.
- חשוב: אל תוסיפו או תמציאו ספרות שלא נאמרו בשיחה.
- בישראל רוב מספרי הסלולר הם באורך 10 ספרות ומתחילים ב-0. אם המספר שאתם לא בטוחים לגביו אינו באורך 10 ספרות או לא מתחיל ב-0 – עדיף להחזיר phone_number: null מאשר לנחש מספר.

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
  אל תוסיף ספרות שלא נאמרו, ואל תנחש מספר אם לא ברור.
  אם המספר שנשמע אינו באורך 10 ספרות או לא מתחיל ב-0 – עדיף להחזיר phone_number: null.
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

  // דגל: האם יש response.create פעיל במודל
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
  }

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
    // חוק ברזל: שולחים וובהוק רק אם:
    // 1. MB_ENABLE_LEAD_CAPTURE=true
    // 2. יש MB_WEBHOOK_URL
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) {
      logDebug(tag, 'Lead capture disabled or no MB_WEBHOOK_URL – skipping webhook.');
      return;
    }

    try {
      let parsedLead = await extractLeadFromConversation(conversationLog);

      // אם אין אובייקט – אין ליד, לא שולחים
      if (!parsedLead || typeof parsedLead !== 'object') {
        logInfo(tag, 'No parsed lead object – skipping webhook.');
        return;
      }

      // אם הלקוח ביקש חזרה למספר המזוהה ואין מספר בליד – נשתמש ב-callerNumber
      if (!parsedLead.phone_number && callerNumber && conversationMentionsCallerId()) {
        parsedLead.phone_number = callerNumber;
        parsedLead.notes =
          (parsedLead.notes || '') +
          (parsedLead.notes ? ' ' : '') +
          'הלקוח ביקש חזרה למספר המזוהה ממנו התקשר.';
      }

      // נורמליזציה למספר טלפון (10 ספרות). אם לא תקין – ננסה callerID, ואם גם הוא לא תקין – phone_number=null.
      const normalizedPhone = normalizePhoneNumber(
        parsedLead.phone_number,
        callerNumber
      );
      parsedLead.phone_number = normalizedPhone;

      // 🔹 הוספת מידע על המזוהה לתוך parsedLead
      const callerIdRaw = callerNumber || null;
      const callerIdNormalized = normalizePhoneNumber(null, callerNumber);

      parsedLead.caller_id_raw = callerIdRaw;
      parsedLead.caller_id_normalized = callerIdNormalized;

      const isFullLead =
        parsedLead.is_lead === true &&
        (parsedLead.lead_type === 'new' || parsedLead.lead_type === 'existing') &&
        !!parsedLead.phone_number;

      // גם אם זה לא "ליד מלא" – עדיין נשלח וובהוק, כדי שתראה הכל במאק
      const payload = {
        streamSid,
        callSid,
        callerNumber: callerIdRaw,          // מספר כפי שהוא הגיע מטוויליו
        callerIdRaw,                        // אותו דבר בשם ברור
        callerIdNormalized: callerIdNormalized, // מזוהה מנורמל אם היה אפשר
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
    hasActiveResponse = false;
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
      // ננסה לתת לבוט להגיד משפט סיום, אבל רק אם אין response פעיל
      sendModelPrompt(
        `סיימי את השיחה עם הלקוח במשפט הבא בלבד, בלי להוסיף משפטים נוספים: "${text}"`,
        'closing'
      );
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

    const text =
      'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
    sendModelPrompt(
      `תגיבי ללקוח במשפט קצר בסגנון הבא (אפשר לשנות קצת): "${text}"`,
      'idle_warning'
    );
    if (!hasActiveResponse) {
      // אם לא הצלחנו לשלוח (למשל כי כבר יש תשובה), פשוט נרשום בלוג
      logDebug(tag, 'Idle warning not sent because of active response.');
    } else {
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
    sendModelPrompt(
      `פתחי את הש
