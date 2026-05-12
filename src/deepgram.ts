/**
 * Deepgram Nova-3 streaming STT client.
 *
 * Twilio sends 8kHz μ-law mono audio in base64 frames. Deepgram accepts that
 * directly with `encoding=mulaw&sample_rate=8000` — no transcoding needed.
 */
import WebSocket from "ws";
import { config } from "./config.js";

export interface DeepgramHandlers {
  onFinal: (text: string) => void;        // final, endpointed utterance
  onInterim: (text: string) => void;      // partial — used for barge-in
  onError: (err: Error) => void;
  onClose: () => void;
}

export function openDeepgramStream(handlers: DeepgramHandlers) {
  const url =
    "wss://api.deepgram.com/v1/listen?" +
    new URLSearchParams({
      model: "nova-3",
      encoding: "mulaw",
      sample_rate: "8000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "150",          // ms of silence before final
      utterance_end_ms: "1000",
      vad_events: "true",
      language: "en",
      // Boost LRA-specific terms — improves Liberian English accuracy.
      keywords: [
        "LRA:2",
        "Monrovia:2",
        "GST:2",
        "tariff:2",
        "duty:2",
        "TIN:2",
        "customs:2",
      ].join("&keywords="),
    }).toString();

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${config.deepgramKey}` },
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "Results") {
        const alt = msg.channel?.alternatives?.[0];
        const transcript: string = alt?.transcript ?? "";
        if (!transcript) return;
        if (msg.is_final && msg.speech_final) handlers.onFinal(transcript);
        else handlers.onInterim(transcript);
      }
    } catch (err) {
      handlers.onError(err as Error);
    }
  });
  ws.on("error", handlers.onError);
  ws.on("close", handlers.onClose);

  return {
    /** Forward a base64 μ-law frame from Twilio straight to Deepgram. */
    sendAudio(base64Mulaw: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(base64Mulaw, "base64"));
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        // Tell Deepgram to flush + close cleanly.
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      ws.close();
    },
  };
}
