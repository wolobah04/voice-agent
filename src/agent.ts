/**
 * Agentic Core — Groq (openai/gpt-oss-120b) orchestrator with tool calling.
 *
 * Maintains per-call conversation state, streams responses clause-by-clause
 * to the TTS layer to minimise time-to-first-audio, and exposes tools the
 * model can invoke (RAG against LRA knowledge base, human handoff signal).
 */
import { config } from "./config.js";
import { queryKnowledgeBase } from "./rag.js";

// Groq is OpenAI-compatible — same request/response shape, faster inference.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const SYSTEM_PROMPT = `You are "Tina", a warm, professional customer service
representative for the Liberia Revenue Authority (LRA). You are speaking with
a Liberian citizen on a live phone call.

GUIDELINES
- Speak naturally and conversationally, as if on the phone. Short sentences.
- Liberian English is welcome. Understand colloquialisms ("I wan pay my tax",
  "How much for clearing?", "small small", "make I"). Mirror politeness, not
  slang.
- NEVER invent or guess tax rates, tariff codes, deadlines, fees, office
  addresses, or policy details. If a question requires specifics, you MUST
  call the \`query_knowledge_base\` tool first and ground your answer in the
  returned passages. Cite no source numbers — just state the fact.
- If the knowledge base returns nothing relevant, OR the caller is angry,
  confused after two clarifications, asks for a human, reports fraud, or
  needs account-specific action you cannot perform, call \`request_human_handoff\`.
- Keep replies under ~40 words unless the caller explicitly asks for detail.
- Confirm understanding before acting ("So you want to know the import duty
  on a used vehicle, correct?").
- Do not read URLs, long numbers, or codes letter-by-letter unless asked.
- Never discuss politics, make legal promises, or threaten penalties.

You are voice-only. Do not use markdown, bullet points, or emojis.`;

const tools: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "query_knowledge_base",
      description:
        "Search the LRA knowledge base (tariffs, tax codes, FAQs, policies, " +
        "office locations, deadlines). Use this before stating any specific " +
        "rate, fee, code, address, or policy fact.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Concise search query in standard English, e.g. 'import duty " +
              "rate for used vehicles' or 'GST registration threshold'.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_human_handoff",
      description:
        "Transfer the caller to a human LRA agent. Use when the caller asks " +
        "for a person, is upset, reports fraud, or needs account-specific " +
        "action the assistant cannot complete.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short reason for handoff." },
        },
        required: ["reason"],
      },
    },
  },
];

export type AgentEvent =
  | { type: "text_chunk"; text: string }   // streamed clause for TTS
  | { type: "turn_complete" }
  | { type: "handoff"; reason: string };

/**
 * Stateful per-call agent. One instance per Twilio call.
 */
export class Agent {
  private history: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  /**
   * Process a final user transcript. Yields agent events as they happen so
   * the WebSocket hub can pipe text into ElevenLabs immediately.
   */
  async *handleUserTurn(userText: string): AsyncGenerator<AgentEvent> {
    this.history.push({ role: "user", content: userText });

    // The agent may need multiple tool-calling rounds before producing audio.
    // Cap at 4 rounds to bound latency.
    for (let round = 0; round < 4; round++) {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.groqModel,
          messages: this.history,
          tools,
          temperature: 0.4,
          stream: true,
        }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        console.error("[agent] groq error", res.status, errText);
        yield { type: "text_chunk", text: "Sorry, I'm having trouble right now. Please try again in a moment." };
        yield { type: "turn_complete" };
        return;
      }

      let assistantText = "";
      const toolCalls: Record<
        number,
        { id: string; name: string; args: string }
      > = {};
      let buffer = "";

      for await (const chunk of parseSSE(res.body)) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantText += delta.content;
          buffer += delta.content;
          // Flush at clause boundaries (. ! ? , ;) so TTS can start early.
          const flushIdx = lastClauseBoundary(buffer);
          if (flushIdx > 0) {
            const toSpeak = buffer.slice(0, flushIdx + 1).trim();
            buffer = buffer.slice(flushIdx + 1);
            if (toSpeak) yield { type: "text_chunk", text: toSpeak };
          }
        }

        for (const tc of delta.tool_calls ?? []) {
          const slot = (toolCalls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }

      // Flush trailing buffer.
      if (buffer.trim()) yield { type: "text_chunk", text: buffer.trim() };

      const calls = Object.values(toolCalls);
      if (calls.length === 0) {
        // Plain assistant turn — done.
        if (assistantText) {
          this.history.push({ role: "assistant", content: assistantText });
        }
        yield { type: "turn_complete" };
        return;
      }

      // Record the assistant's tool-call message, then resolve each tool.
      this.history.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        })),
      });

      for (const call of calls) {
        const args = safeJson(call.args);
        if (call.name === "query_knowledge_base") {
          const hits = await queryKnowledgeBase(String(args.query ?? ""));
          this.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(
              hits.length
                ? hits.map((h) => ({
                    source: h.source,
                    title: h.title,
                    content: h.content,
                    similarity: h.similarity,
                  }))
                : { note: "No matching documents. Do not guess." },
            ),
          });
        } else if (call.name === "request_human_handoff") {
          const reason = String(args.reason ?? "unspecified");
          this.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ ok: true }),
          });
          yield {
            type: "text_chunk",
            text:
              "Okay, I'll connect you with one of our agents now. Please hold.",
          };
          yield { type: "handoff", reason };
          yield { type: "turn_complete" };
          return;
        } else {
          this.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: "unknown tool" }),
          });
        }
      }
      // Loop continues — model gets tool results and produces final answer.
    }

    yield { type: "turn_complete" };
  }
}

function lastClauseBoundary(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === "." || c === "!" || c === "?" || c === "," || c === ";") return i;
  }
  return -1;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

/**
 * Parse an OpenAI-compatible SSE stream into JSON chunks.
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload);
      } catch {
        // partial — push back and wait for more
        buf = line + "\n" + buf;
        break;
      }
    }
  }
}
