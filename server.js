// server.js
// MisterBot <-> Twilio <-> OpenAI Realtime bridge (אודיו בזמן אמת)
// גרסה משודרגת – נטע עם אישיות מלאה, קונפיג, זיכרון בסיסי, ומניעת Barge-in

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// ===================== CONFIG – שליטה מלאה מהקוד =====================

const CONFIG = {
  BOT_NAME_HE: 'נטע',
  BOT_NAME_EN: 'Netta',
  BUSINESS_NAME_HE: 'MisterBot',
  BUSINESS_NAME_EN: 'MisterBot',

  // פתיח – מה שהיא אומרת בתחילת השיחה (ננעל בפרומפט, לא טקסט קבוע אחד לאחד,
  // אבל הבוט מכוון להגיד את זה בפתיחה)
  OPENING_SCRIPT: `
שלום, הגעתם ל־MisterBot – פתרונות בוטים קוליים חכמים לעסקים.
אני נטע, העוזרת הקולית האוטומטית. איך אפשר לעזור לכם היום?
  `.trim(),

  // סגירת שיחה – ניסוח מועדף לפרידה
  CLOSING_SCRIPT: `
תודה שפניתם ל־MisterBot. היה לי לעונג לדבר אתכם.
אם תצטרכו משהו נוסף – אנחנו כאן בשבילכם. יום נעים ובהצלחה בעסק!
  `.trim(),

  // פרומפט עסקי – להזין כאן כל מידע על השירותים שלך, הצעות, תהליכים וכו׳
  BUSINESS_KB_PROMPT: `
אתה עוזר קולי עבור השירות "MisterBot" המתמחה בבוטים קוליים חכמים לעסקים:
- בניית בוטים קוליים למענה טלפוני, קביעת תורים, סינון שיחות ושירות לקוחות.
- אינטגרציה למערכות CRM, וואטסאפ, אוטומציות שיווק ועוד.
- התאמה אישית לעסקים קטנים, מרפאות, משרדי עורכי דין, חברות שילוח ועוד.
- דגש על חוויית שיחה טבעית, מהירה ונעימה, עם איסוף לידים חכם.
  `.trim(),

  // פרומפט כללי – התנהגות כללית, כולל איסור מתחרים וכו׳
  GENERAL_BEHAVIOR_PROMPT: `
אתה מודל שיחה חכם בשם "נטע" (${/* keep name */ ''}Netta) עבור שירות "MisterBot".
חוקים חשובים:

1. שפה:
   - ברירת מחדל: עברית.
   - אם הלקוח מדבר אנגלית – תענה באנגלית.
   - אם הלקוח מדבר רוסית – תענה ברוסית.
   - לעולם אל תערבב שפות באותו משפט. מותר לעבור שפה אם הלקוח החליף שפה.

2. סגנון דיבור:
   - קול טבעי, אנושי, חם ומקצועי.
   - משפטים קצרים וברורים, לא שוטף בלתי נגמר.
   - מהירות דיבור מעט מהירה מהרגיל, אבל עדיין נינוחה וברורה.
   - אל תדבר יותר מ-2–3 משפטים ברצף בלי לעצור ולאפשר ללקוח לענות.

3. תחומי ידע:
   - אתה יכול לענות על כל שאלה כללית בעולם (כמו GPT רגיל).
   - אבל: לעולם אל תתן מידע על חברות מתחרות בתחום הבוטים הקוליים,
     אוטומציות לעסקים, מרכזיות חכמות או שירותים דומים.
   - אם מבקשים ממך השוואה או מידע על מתחרים: תענה בצורה כללית
     ותסביר שאתה לא מספק מידע מפורט על שמות של מתחרים.

4. פתיחת שיחה:
   - תתחיל תמיד בפתיח בסגנון הטקסט הבא (אפשר לנסח אותו טבעי יותר):
     """{OPENING_SCRIPT}"""
   - אחרי הפתיח, שאל שאלה פתוחה קצרה: "איך אפשר לעזור לכם היום?"

5. סוג לקוח – חדש או קיים:
   - בשלב מוקדם בשיחה שאל: "אתם לקוחות חדשים או לקוחות קיימים?"
   - אם עונים "חדש" או משהו דומה:
       * שאל את השאלות המוגדרות כלקוח חדש (ראה סעיף 6).
   - אם עונים "קיים":
       * שאל את השאלות המוגדרות כלקוח קיים (ראה סעיף 7).

6. איסוף פרטים – לקוח חדש:
   השאלות המועדפות ללקוח חדש הן (אפשר לנסח טבעי, אבל לשמור על אותו תוכן):
   {NEW_LEAD_QUESTIONS}

7. איסוף פרטים – לקוח קיים:
   השאלות המועדפות ללקוח קיים הן:
   {EXISTING_CLIENT_QUESTIONS}

8. סגירת שיחה:
   - כשהשיחה מסתיימת, או כשברור שהלקוח סיים:
       * תסכם בקצרה מה סוכם ותשתמש בסגנון הבא:
         """{CLOSING_SCRIPT}"""

9. התנהלות כללית:
   - תמיד תשמור על כבוד, אדיבות וסבלנות.
   - אם לא ברור לך משהו – תשאל שאלה מבהירה לפני שאתה עונה.
   - אם הלקוח מתבלבל – תרגיע, תסביר לאט ותעזור לו להתקדם.
  `.trim(),

  // שאלות לקוח חדש – כאן יש לך שליטה מלאה בטקסט
  NEW_LEAD_QUESTIONS: [
    'איך קוראים לכם?',
    'מה שם העסק שלכם?',
    'באיזה תחום העסק פועל?',
    'מה מספר הטלפון הכי טוב לחזרה אליכם?',
    'במה בדיוק תרצו שנעזור לכם – מענה טלפוני, קביעת תורים, וואטסאפ, או משהו אחר?'
  ],

  // שאלות לקוח קיים
  EXISTING_CLIENT_QUESTIONS: [
    'איך קוראים לכם?',
    'מה שם העסק שלכם?',
    'על איזה שירות של MisterBot אתם רוצים לדבר – קיים או חדש?',
    'האם מדובר בתקלה, שינוי בבוט קיים, או בקשה לפיתוח חדש?',
    'מה מספר הטלפון הכי טוב לחזרה אליכם, למקרה שנצטרך לעדכן?'
  ],

  // שליטה על זיהוי סוף דיבור (זמן תגובה)
  VAD: {
    THRESHOLD: 0.5,
    SILENCE_MS: 600,    // כמה מילי־שניות של שקט עד שנטע מתחילה לענות
    PREFIX_MS: 300
  }
};

// ===================== ENV =====================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is missing! Make sure it is set in Render env.');
}

// (לא חובה בשלב זה, נשתמש בזה בשלב הבא אם נרצה לנתק שיחה דרך Twilio REST)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// ===================== EXPRESS =====================

const app = express();
app.get('/', (req, res) => {
  res.send('MisterBot realtime server is running.');
});

const server = http.createServer(app);

// ===================== WebSocket – Twilio Media Stream =====================

const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

console.log('✅ MisterBot Realtime bridge starting up...');

wss.on('connection', (twilioWs) => {
  console.log('📞 Twilio media stream connected');

  let streamSid = null;
  let callSid = null;          // נשמור את ה-CallSid אם נרצה לנתק בעתיד
  let openaiWs = null;
  let openaiReady = false;

  // זיכרון בסיסי של השיחה
  const conversation = [];     // {role: 'user' | 'assistant', text: string}
  let currentAssistantBuffer = '';

  // נעקוב אחרי מצב "הבוט מדבר" כדי למנוע Barge-in
  let botSpeaking = false;

  // ---------- פותחים חיבור ל-OpenAI Realtime ----------
  function connectToOpenAI() {
    console.log('🔌 Connecting to OpenAI Realtime...');

    const openaiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('✅ OpenAI Realtime connected');
      openaiReady = true;

      // נבנה פרומפט משולב מהקונפיג
      const businessKb = CONFIG.BUSINESS_KB_PROMPT;
      const openingScript = CONFIG.OPENING_SCRIPT;
      const closingScript = CONFIG.CLOSING_SCRIPT;

      const newLeadQuestionsText = CONFIG.NEW_LEAD_QUESTIONS
        .map((q, i) => `${i + 1}. ${q}`)
        .join('\n');

      const existingClientQuestionsText = CONFIG.EXISTING_CLIENT_QUESTIONS
        .map((q, i) => `${i + 1}. ${q}`)
        .join('\n');

      const fullBehaviorPrompt = CONFIG.GENERAL_BEHAVIOR_PROMPT
        .replace('{OPENING_SCRIPT}', openingScript)
        .replace('{CLOSING_SCRIPT}', closingScript)
        .replace('{NEW_LEAD_QUESTIONS}', newLeadQuestionsText)
        .replace('{EXISTING_CLIENT_QUESTIONS}', existingClientQuestionsText);

      const fullInstructions = `
${businessKb}

-------------------------
הנחיות התנהגות מפורטות:
${fullBehaviorPrompt}
      `.trim();

      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions: fullInstructions,
          voice: 'alloy',
          modalities: ['audio', 'text'],
          input_audio_format: 'g711-ulaw',
          output_audio_format: 'g711-ulaw',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: CONFIG.VAD.THRESHOLD,
            silence_duration_ms: CONFIG.VAD.SILENCE_MS,
            prefix_padding_ms: CONFIG.VAD.PREFIX_MS
          },
          max_response_output_tokens: 'inf'
        }
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      console.log('🧠 OpenAI session.update sent');
    });

    openaiWs.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.error('⚠️ Failed to parse OpenAI message', e);
        return;
      }

      // אפשר לפתוח לוגים אם צריך:
      // console.log('🔁 OpenAI event:', msg.type);

      // 1) אודיו החוצה ל-Twilio
      if (
        msg.type === 'response.audio.delta' &&
        msg.delta &&
        streamSid &&
        twilioWs.readyState === WebSocket.OPEN
      ) {
        // מתחיל דיבור – ננעל על botSpeaking = true
        botSpeaking = true;

        const twilioMediaMsg = {
          event: 'media',
          streamSid,
          media: {
            payload: msg.delta // g711-ulaw base64
          }
        };
        twilioWs.send(JSON.stringify(twilioMediaMsg));
      }

      // 2) טקסט חלקי של הבוט – נאסוף לזיכרון
      if (msg.type === 'response.output_text.delta' && msg.delta) {
        currentAssistantBuffer += msg.delta;
      }

      // 3) תשובת בוט הסתיימה
      if (msg.type === 'response.completed') {
        if (currentAssistantBuffer.trim().length > 0) {
          conversation.push({ role: 'assistant', text: currentAssistantBuffer.trim() });
          currentAssistantBuffer = '';
        }
        botSpeaking = false;
        console.log('✅ OpenAI response completed');
      }

      // 4) תמלול מלא של מה שהלקוח אמר
      if (msg.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = msg.transcript;
        if (transcript) {
          console.log('👂 User said:', transcript);
          conversation.push({ role: 'user', text: transcript });
        }
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
      callSid = data.start.callSid || null;
      console.log('▶️ Stream started, streamSid:', streamSid, 'callSid:', callSid);
    }

    if (event === 'media') {
      // פה מגיע אודיו מהלקוח (base64 של g711-ulaw)

      // מניעת Barge-in – אם הבוט מדבר, מתעלמים מהאודיו שנכנס
      if (botSpeaking) {
        return;
      }

      const payload = data.media.payload;

      if (openaiWs && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        const openaiAudioMsg = {
          type: 'input.audio_buffer.append',
          audio: payload
        };
        openaiWs.send(JSON.stringify(openaiAudioMsg));
      }
    }

    if (event === 'mark') {
      // כרגע לא משתמשים ב-mark, אפשר להרחיב בעתיד
      console.log('📍 Twilio mark:', data.mark.name);
    }

    if (event === 'stop') {
      console.log('⏹️ Stream stopped');

      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
      twilioWs.close();

      // בשלב הבא נוסיף כאן:
      // - שליחת כל ה-conversation ל-webhook
      // - ניתוק השיחה דרך Twilio REST אם רוצים
      console.log('📝 Conversation summary (for debug only):');
      conversation.forEach((turn) => {
        console.log(turn.role === 'user' ? '👤' : '🤖', turn.text);
      });
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
