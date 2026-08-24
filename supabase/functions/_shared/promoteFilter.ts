/**
 * supabase/functions/_shared/promoteFilter.ts
 *
 * POSITIVE mirror of dislikeFilter.ts (2026-06-25). Surfaces papers the user
 * explicitly endorsed — liked/saved in an evidence table, or ADDED to a JEL
 * paper plan (grounded/discovered/curated additions) — on a semantically
 * similar PAST query, so they get a bounded rerank boost on the current query.
 *
 * Signal source = `feedback` rows whose `query_embedding` is set and whose type
 * is one of:
 *   'like' | 'save'  — explicit thumbs-up / save on a paper (also feed the
 *                       methodology-weight agent)
 *   'add'            — paper added to a paper plan (PATCH curatedWorkIds /
 *                       discoveredWorkIds). 'add' is INTENTIONALLY a type the
 *                       weight agent ignores (signalFromType → 0/0), so this
 *                       paper-level learning is INDEPENDENT of domain weights.
 *
 * Returns a Map<work_id, maxSim> (the strongest query-similarity across the
 * user's endorsements of that paper) — the caller scales a bounded, relevance-
 * ramp-gated boost by it in rerankUnified, so it REORDERS within the relevant
 * pool and never floats an off-topic paper. Never gates/pins.
 */

const PROMOTE_SIM_THRESHOLD = 0.85; // mirror dislike: only "near-same query"
const MAX_SIGNALS_PER_USER = 500;
const PROMOTE_TYPES = ["like", "save", "add"];

export interface PromoteFilterResult {
  promoteWorkIds: Map<string, number>; // work_id -> max query-cosine similarity
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

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

export async function computeUserPromoteFilter(
  // deno-lint-ignore no-explicit-any
  supabaseClient: any,
  userId: string | null | undefined,
  currentQueryEmbedding: number[] | null,
  threshold: number = PROMOTE_SIM_THRESHOLD,
): Promise<PromoteFilterResult> {
  const empty: PromoteFilterResult = { promoteWorkIds: new Map() };
  if (!userId || !currentQueryEmbedding || currentQueryEmbedding.length === 0) return empty;

  try {
    const { data, error } = await supabaseClient
      .from("feedback")
      .select("work_id, query_embedding")
      .eq("user_id", userId)
      .in("type", PROMOTE_TYPES)
      .not("work_id", "is", null)
      .not("query_embedding", "is", null)
      .limit(MAX_SIGNALS_PER_USER);

    if (error || !data || data.length === 0) return empty;

    const promote = new Map<string, number>();
    for (const row of data) {
      const vec = parseVector(row.query_embedding);
      if (!vec) continue;
      const sim = cosineSim(currentQueryEmbedding, vec);
      if (sim >= threshold) {
        const prev = promote.get(row.work_id) ?? 0;
        if (sim > prev) promote.set(row.work_id, sim);
      }
    }
    return { promoteWorkIds: promote };
  } catch {
    return empty;
  }
}
