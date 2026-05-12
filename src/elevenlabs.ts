/**
 * ElevenLabs streaming TTS.
 *
 * We use the WebSocket multi-stream endpoint with `output_format=ulaw_8000`
 * so the bytes coming out are already in Twilio's required format and can be
 * forwarded with zero transcoding — just base64 + a `media` envelope.
 */
import WebSocket from "ws";
import { config } from "./config.js";

export interface ElevenStreamHandlers {
  /** Base64 μ-law 8kHz audio chunk, ready to wrap in a Twilio media frame. */
  onAudio: (base64Mulaw: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export class ElevenLabsStream {
  private ws: WebSocket;
  private opened: Promise<void>;
  private closed = false;

  constructor(handlers: ElevenStreamHandlers) {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}` +
      `/stream-input?model_id=eleven_turbo_v2_5&output_format=ulaw_8000` +
      `&optimize_streaming_latency=3`;

    this.ws = new WebSocket(url, {
      headers: { "xi-api-key": config.elevenlabs.apiKey },
    });

    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => {
        // Initial config message — required by the streaming protocol.
        this.ws.send(
          JSON.stringify({
            text: " ",
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.8,
              speed: 1.0,
            },
            generation_config: {
              chunk_length_schedule: [50, 90, 120, 150],
            },
          }),
        );
        resolve();
      });
      this.ws.once("error", reject);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.audio) handlers.onAudio(msg.audio); // already base64 μ-law
        if (msg.isFinal) handlers.onDone();
      } catch (err) {
        handlers.onError(err as Error);
      }
    });
    this.ws.on("error", handlers.onError);
    this.ws.on("close", () => {
      this.closed = true;
      handlers.onDone();
    });
  }

  async sendText(text: string) {
    if (this.closed) return;
    await this.opened;
    // try_trigger_generation forces ElevenLabs to start synthesising even
    // before we've sent enough text to fill the schedule — critical for TTFA.
    this.ws.send(
      JSON.stringify({ text: text + " ", try_trigger_generation: true }),
    );
  }

  /** Signal end-of-utterance so ElevenLabs flushes the final chunk. */
  async finish() {
    if (this.closed) return;
    await this.opened;
    this.ws.send(JSON.stringify({ text: "" }));
  }

  /** Hard-abort (used on barge-in). */
  abort() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
