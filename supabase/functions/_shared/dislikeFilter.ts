/**
 * supabase/functions/_shared/dislikeFilter.ts
 *
 * Suppresses papers that a user has thumbs-down'd on semantically similar
 * past queries. Threshold: cosine similarity >= 0.85 between the current
 * query embedding and the originating-query embedding stored on the
 * feedback row.
 *
 * Design (2026-05-12):
 *   - feedback.query_embedding (vector(768)) is populated when user POSTs
 *     a dislike (see POST /api/feedback handler).
 *   - At retrieval time we pull the user's dislike rows + compute cosine
 *     similarity vs the current query embedding in app code. Volume per
 *     user is small (capped at 500) so no pgvector ANN index is needed.
 *   - Returns the set of work_ids to exclude + a count for the coverage
 *     card ("hidden by your feedback").
 */

const DISLIKE_SIM_THRESHOLD = 0.85;
const MAX_DISLIKES_PER_USER = 500;

export interface DislikeFilterResult {
  excludedWorkIds: Set<string>;
  hiddenCount: number;
}

/**
 * Cosine similarity for two equal-length vectors. Vectors are NOT assumed
 * to be unit-normalized.
 */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Parse pgvector textual form `[0.1,0.2,...]` (which is what supabase-js
 * returns when reading a vector column) into a number[].
 */
function parseVector(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw !== "string") return null;
  const trimmed = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const parts = trimmed.split(",");
  const out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

export async function computeUserDislikeFilter(
  // deno-lint-ignore no-explicit-any
  supabaseClient: any,
  userId: string | null | undefined,
  currentQueryEmbedding: number[] | null,
  threshold: number = DISLIKE_SIM_THRESHOLD,
): Promise<DislikeFilterResult> {
  const empty: DislikeFilterResult = { excludedWorkIds: new Set(), hiddenCount: 0 };
  if (!userId || !currentQueryEmbedding || currentQueryEmbedding.length === 0) {
    return empty;
  }

  try {
    const { data, error } = await supabaseClient
      .from("feedback")
      .select("work_id, query_embedding")
      .eq("user_id", userId)
      .eq("type", "dislike")
      .not("work_id", "is", null)
      .not("query_embedding", "is", null)
      .limit(MAX_DISLIKES_PER_USER);

    if (error || !data || data.length === 0) return empty;

    const excluded = new Set<string>();
    for (const row of data) {
      const vec = parseVector(row.query_embedding);
      if (!vec) continue;
      const sim = cosineSim(currentQueryEmbedding, vec);
      if (sim >= threshold) excluded.add(row.work_id);
    }

    return { excludedWorkIds: excluded, hiddenCount: excluded.size };
  } catch {
    return empty;
  }
}
