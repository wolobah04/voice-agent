/**
 * Per-call bridge: Twilio Media Stream  ⇄  Deepgram  ⇄  Agent  ⇄  ElevenLabs.
 *
 * Twilio frames are JSON envelopes containing base64 μ-law 8kHz audio.
 * We forward inbound audio to Deepgram, run agent turns on final transcripts,
 * and stream synthesised audio back to Twilio in `media` events.
 */
import type { WebSocket } from "ws";
import { Agent } from "./agent.js";
import { openDeepgramStream } from "./deepgram.js";
import { ElevenLabsStream } from "./elevenlabs.js";
import { config } from "./config.js";

type TwilioInbound =
  | { event: "connected" }
  | { event: "start"; start: { streamSid: string; callSid: string } }
  | { event: "media"; media: { payload: string } }
  | { event: "mark"; mark: { name: string } }
  | { event: "stop" };

export function handleTwilioConnection(twilio: WebSocket) {
  let streamSid = "";
  let callSid = "";
  const agent = new Agent();

  let activeTts: ElevenLabsStream | null = null;
  let agentSpeaking = false;
  let pendingFinal: string | null = null;
  let processing = false;

  // ---- Twilio outbound helpers ------------------------------------------
  const sendMedia = (payload: string) => {
    if (twilio.readyState !== twilio.OPEN || !streamSid) return;
    twilio.send(
      JSON.stringify({ event: "media", streamSid, media: { payload } }),
    );
  };
  const sendClear = () => {
    if (twilio.readyState !== twilio.OPEN || !streamSid) return;
    twilio.send(JSON.stringify({ event: "clear", streamSid }));
  };

  // ---- Barge-in ----------------------------------------------------------
  const bargeIn = () => {
    if (!agentSpeaking) return;
    sendClear();                 // drop Twilio's playback buffer
    activeTts?.abort();
    activeTts = null;
    agentSpeaking = false;
  };

  // ---- Deepgram → Agent --------------------------------------------------
  const dg = openDeepgramStream({
    onInterim: (text) => {
      // Treat any meaningful interim as a barge-in signal.
      if (text.trim().length > 1) bargeIn();
    },
    onFinal: (text) => {
      const clean = text.trim();
      if (!clean) return;
      if (processing) {
        // Buffer the latest final; we'll process once current turn finishes.
        pendingFinal = pendingFinal ? `${pendingFinal} ${clean}` : clean;
        return;
      }
      void runTurn(clean);
    },
    onError: (err) => console.error("[deepgram]", err),
    onClose: () => console.log("[deepgram] closed"),
  });

  // ---- Agent turn --------------------------------------------------------
  const runTurn = async (userText: string) => {
    processing = true;
    try {
      console.log(`[call ${callSid}] user: ${userText}`);

      // Spin up a fresh ElevenLabs stream for this turn.
      const tts = new ElevenLabsStream({
        onAudio: (b64) => sendMedia(b64),
        onDone: () => { agentSpeaking = false; },
        onError: (e) => console.error("[elevenlabs]", e),
      });
      activeTts = tts;
      agentSpeaking = true;

      let handoffReason: string | null = null;

      for await (const evt of agent.handleUserTurn(userText)) {
        if (evt.type === "text_chunk") {
          if (activeTts !== tts) break;       // bargedin
          await tts.sendText(evt.text);
        } else if (evt.type === "handoff") {
          handoffReason = evt.reason;
        } else if (evt.type === "turn_complete") {
          await tts.finish();
        }
      }

      if (handoffReason) {
        console.log(`[call ${callSid}] handoff: ${handoffReason}`);
        // Give the farewell audio a moment to flush, then transfer.
        setTimeout(() => transferToHuman(callSid), 1500);
      }
    } catch (err) {
      console.error("[agent turn] error", err);
    } finally {
      processing = false;
      if (pendingFinal) {
        const next = pendingFinal;
        pendingFinal = null;
        void runTurn(next);
      }
    }
  };

  // ---- Twilio inbound ----------------------------------------------------
  twilio.on("message", (raw) => {
    let msg: TwilioInbound;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        console.log(`[call ${callSid}] stream started`);
        // Greet the caller proactively.
        void runTurn(
          "[SYSTEM] Call just connected. Greet the caller warmly as the LRA " +
            "assistant and ask how you can help.",
        );
        break;
      case "media":
        dg.sendAudio(msg.media.payload);
        break;
      case "stop":
        console.log(`[call ${callSid}] stream stopped`);
        cleanup();
        break;
    }
  });

  twilio.on("close", cleanup);
  twilio.on("error", (e) => console.error("[twilio ws]", e));

  function cleanup() {
    try { dg.close(); } catch { /* ignore */ }
    try { activeTts?.abort(); } catch { /* ignore */ }
  }
}

/**
 * Transfer the active call to a human. Uses Twilio REST to update the live
 * call with new TwiML that <Dial>s the agent line.
 */
async function transferToHuman(callSid: string) {
  if (!callSid || !config.humanHandoffNumber) return;
  const twiml =
    `<Response><Dial>${config.humanHandoffNumber}</Dial></Response>`;
  const auth = Buffer.from(
    `${config.twilio.accountSid}:${config.twilio.authToken}`,
  ).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls/${callSid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Twiml: twiml }),
    },
  );
  if (!res.ok) {
    console.error("[handoff] twilio update failed", res.status, await res.text());
  }
}
