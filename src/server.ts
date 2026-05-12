/**
 * HTTP + WebSocket entry point.
 *
 *   POST /twiml   → returns TwiML that opens a bidirectional Media Stream
 *   WSS  /media   → Twilio connects here; bridged to STT/LLM/TTS
 *   GET  /healthz → liveness probe
 */
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { handleTwilioConnection } from "./twilio-bridge.js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

/**
 * Twilio Voice webhook. Returns TwiML telling Twilio to open a bidirectional
 * Media Stream to /media. <Connect><Stream> is bidirectional; <Start><Stream>
 * is inbound-only — we need <Connect>.
 */
app.post("/twiml", (_req, res) => {
  const wsUrl = `wss://${config.publicHost}/media`;
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`,
  );
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => handleTwilioConnection(ws));
  } else {
    socket.destroy();
  }
});

server.listen(config.port, () => {
  console.log(`[lra-voice] listening on :${config.port}`);
  console.log(`[lra-voice] twiml:  https://${config.publicHost}/twiml`);
  console.log(`[lra-voice] media:  wss://${config.publicHost}/media`);
});
