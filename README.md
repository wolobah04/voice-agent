# LRA Voice AI Call Center

Real-time bidirectional voice agent for the **Liberia Revenue Authority**. Bridges
Twilio Media Streams ⇄ Deepgram Nova-3 (STT) ⇄ **Groq `openai/gpt-oss-120b`** (agent + tools) ⇄
ElevenLabs (TTS), with semantic RAG over the Lovable Cloud `kb_embeddings` table
(Gemini 768-dim vectors).

> ⚠️ This service must run on a **long-lived Node host** (Railway, Fly.io, Render,
> a VPS, Kubernetes). It cannot run on Cloudflare Workers / Vercel Edge — raw
> WebSocket bridging plus persistent upstream sockets to Deepgram and ElevenLabs
> require a real Node runtime. **Recommended host: Railway.**

## Architecture

```
Caller → Twilio PSTN → POST /twiml  (returns <Connect><Stream url="wss://…/media"/>)
                              │
                              ▼
                       wss://…/media  ⇄  Deepgram Nova-3 (μ-law 8kHz, streaming)
                              │
                  final transcript + endpointing
                              ▼
                  Agent (Groq gpt-oss-120b, streaming) ── tool: query_knowledge_base
                              │                                     │
                              │                                     ▼
                              │              Lovable AI embeddings (Gemini 768d)
                              │                                     │
                              │                                     ▼
                              │              Lovable Cloud  match_kb_embeddings RPC
                              ▼
                  ElevenLabs Turbo v2.5 (μ-law 8kHz stream)
                              │
                              ▼
                  Twilio media frames → caller
```

## Environment variables

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default `8080`) |
| `PUBLIC_HOST` | Public hostname Twilio reaches, e.g. `voice-agent.up.railway.app` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio creds (signature validation, REST calls) |
| `DEEPGRAM_API_KEY` | Deepgram Nova-3 streaming |
| `GROQ_API_KEY` | Groq inference for the LLM |
| `GROQ_MODEL` | Defaults to `openai/gpt-oss-120b` |
| `LOVABLE_API_KEY` | Lovable AI Gateway — query embeddings |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | TTS streaming |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Lovable Cloud (RAG + call logging) |
| `HUMAN_HANDOFF_NUMBER` | E.164 fallback agent line |

No OpenAI key required.

## Knowledge base

Documents are uploaded through the Lovable web app (Knowledge → Upload). The
`kb-ingest` edge function parses, chunks, and writes both:

- `kb_documents` (full-text search for the playground)
- `kb_embeddings` (Gemini 768-dim vectors for the voice agent)

The voice agent's `queryKnowledgeBase()` calls `match_kb_embeddings` first and
falls back to `search_kb` (full-text) if vectors are unavailable.

## Run locally

```bash
npm install
cp .env.example .env   # fill in keys
npm run dev
```

## Deploy to Railway (recommended)

1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo**.
3. **Variables** tab → paste all values from `.env.example`.
4. **Settings → Networking → Generate Domain** → copy that hostname into the
   `PUBLIC_HOST` variable.
5. Twilio Console → your number → **Voice webhook** → `https://${PUBLIC_HOST}/twiml` (POST).
6. Place a test call.

## Latency budget — target ≤ 800 ms mouth-to-ear

| Stage | Target |
|---|---|
| Deepgram endpointing → final | ~250 ms |
| Groq first token (streamed) | ~150 ms |
| ElevenLabs first audio chunk (Turbo v2.5) | ~200 ms |
| Twilio jitter buffer | ~100 ms |

We stream **clause-by-clause** from the LLM into ElevenLabs so audio starts
before the full response is generated. On detected interruption (caller
speaks while agent is talking), we send Twilio a `clear` message and abort
the in-flight TTS socket.
