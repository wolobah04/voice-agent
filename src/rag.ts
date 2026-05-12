/**
 * RAG layer — embeds the user query via Lovable AI Gateway (Gemini, 768 dims)
 * and runs cosine similarity search against `kb_embeddings` via the
 * `match_kb_embeddings` RPC. Falls back to full-text `search_kb` when the
 * vector index is empty or the embedding call fails.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

const HF_MODEL = "BAAI/bge-small-en-v1.5";

const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});

export interface KnowledgeHit {
  id: string;
  source: string;
  title: string | null;
  content: string;
  similarity: number;
}

async function embed(query: string): Promise<number[] | null> {
  try {
    const res = await fetch(
      `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.huggingfaceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: query,
          options: { wait_for_model: true },
        }),
      },
    );
    if (!res.ok) {
      console.error("[rag] embed failed", res.status, await res.text());
      return null;
    }
    // HF feature-extraction returns number[] for a single string input.
    const vec = (await res.json()) as number[] | number[][];
    return Array.isArray(vec[0]) ? (vec[0] as number[]) : (vec as number[]);
  } catch (e) {
    console.error("[rag] embed exception", e);
    return null;
  }
}

export async function queryKnowledgeBase(
  query: string,
  matchCount = 5,
  minSimilarity = 0.5,
): Promise<KnowledgeHit[]> {
  const embedding = await embed(query);

  if (embedding) {
    const { data, error } = await supabase.rpc("match_kb_embeddings", {
      query_embedding: embedding as unknown as string,
      match_count: matchCount,
      min_similarity: minSimilarity,
    });
    if (!error && data && data.length) {
      // Hydrate source/title from kb_documents.
      const ids = Array.from(new Set(data.map((d: any) => d.document_id)));
      const { data: docs } = await supabase
        .from("kb_documents")
        .select("id, source, title")
        .in("id", ids);
      const meta = new Map((docs ?? []).map((d: any) => [d.id, d]));
      return data.map((d: any) => ({
        id: d.id,
        source: meta.get(d.document_id)?.source ?? "policy",
        title: meta.get(d.document_id)?.title ?? null,
        content: d.content,
        similarity: d.similarity,
      }));
    }
    if (error) console.error("[rag] match_kb_embeddings error", error);
  }

  // Fallback: full-text search via existing search_kb RPC.
  const { data: ftData, error: ftErr } = await supabase.rpc("search_kb", {
    _query: query,
    _limit: matchCount,
  });
  if (ftErr) {
    console.error("[rag] search_kb error", ftErr);
    return [];
  }
  return (ftData ?? []).map((r: any) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    content: r.content,
    similarity: Math.min(1, Number(r.rank) || 0),
  }));
}
