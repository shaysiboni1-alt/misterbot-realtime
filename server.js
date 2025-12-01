import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// --- OpenAI client ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Memory per call ---
const CALL_STATE = new Map();

// ----------------------------------------------------------------------
// 1) Handle upgrade to WebSocket (Twilio media stream)
// ----------------------------------------------------------------------
server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/ws")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ----------------------------------------------------------------------
// 2) Handle WebSocket connection
// ----------------------------------------------------------------------
wss.on("connection", (ws, request) => {
  console.log("WS connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "start") {
        console.log("call started");

        CALL_STATE.set(ws, {
          history: [],
        });
      }

      if (data.event === "media") {
        // We receive audio chunks base64
        // Here you can decode/use OpenAI Realtime STT if wanted
      }

      if (data.event === "user_text") {
        // Custom event (from your Twilio Function) containing recognized text
        const txt = data.text || "";
        console.log("User said:", txt);

        const state = CALL_STATE.get(ws) || { history: [] };

        const messages = [
          {
            role: "system",
            content:
              "אתה נטע, עוזרת קולית של MisterBot. דבר בעברית, בניקוד בסיסי, בקצרה וברצף.",
          },
          ...state.history,
          {
            role: "user",
            content: txt,
          },
        ];

        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages,
          max_tokens: 120,
          temperature: 0.5,
        });

        const reply = completion.choices[0].message.content.trim();
        console.log("Bot replied:", reply);

        // Update memory
        state.history.push({ role: "user", content: txt });
        state.history.push({ role: "assistant", content: reply });
        CALL_STATE.set(ws, state);

        // Send text back → Twilio Function converts to speech using OpenAI TTS
        ws.send(
          JSON.stringify({
            event: "bot_reply",
            text: reply,
          })
        );
      }
    } catch (e) {
      console.error("WS error:", e);
    }
  });

  ws.on("close", () => {
    console.log("WS closed");
    CALL_STATE.delete(ws);
  });
});

// ----------------------------------------------------------------------
// 3) Health check
// ----------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("MisterBot realtime server is running.");
});

// ----------------------------------------------------------------------
// 4) Start server
// ----------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
