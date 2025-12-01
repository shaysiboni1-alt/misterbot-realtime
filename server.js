// server.js
// MisterBot realtime gateway – HTTP + WebSocket לטוויליו

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();

// בדיקת חיים בסיסית
app.get('/', (req, res) => {
  res.send('MisterBot realtime server is running.');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// יוצרים שרת HTTP רגיל
const server = http.createServer(app);

// WebSocket server עבור Twilio Media Streams
const wss = new WebSocket.Server({
  server,
  path: '/twilio-media', // לכאן טוויליו תתחבר
});

wss.on('connection', (ws, req) => {
  console.log('✅ Twilio media stream connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // כרגע רק לוגים – נשתמש בזה אחר כך לחיבור ל-GPT
      if (data.event === 'start') {
        console.log('▶️ Stream started', data.start);
      } else if (data.event === 'media') {
        // כאן מגיע האודיו ב-base64 (G.711 μ-law)
        // בעתיד נשלח אותו ל-OpenAI Realtime
      } else if (data.event === 'stop') {
        console.log('⏹ Stream stopped');
      } else {
        console.log('ℹ️ Event:', data.event);
      }
    } catch (err) {
      console.error('❌ Error parsing WS message:', err);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Twilio media stream disconnected');
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 MisterBot realtime listening on port ${PORT}`);
});
