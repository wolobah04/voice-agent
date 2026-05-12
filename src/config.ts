import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  publicHost: req("PUBLIC_HOST"),
  twilio: {
    accountSid: req("TWILIO_ACCOUNT_SID"),
    authToken: req("TWILIO_AUTH_TOKEN"),
  },
  deepgramKey: req("DEEPGRAM_API_KEY"),
  groqKey: req("GROQ_API_KEY"),
  huggingfaceKey: req("HUGGINGFACE_API_KEY"),
  groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  elevenlabs: {
    apiKey: req("ELEVENLABS_API_KEY"),
    voiceId: req("ELEVENLABS_VOICE_ID"),
  },
  supabase: {
    url: req("SUPABASE_URL"),
    serviceRoleKey: req("SUPABASE_SERVICE_ROLE_KEY"),
  },
  humanHandoffNumber: process.env.HUMAN_HANDOFF_NUMBER ?? "",
};
