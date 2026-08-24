/**
 * dossiers.ts — Tyler Tier-A dossier ACCESSOR (Deno, read-only).
 *
 * 🔑 ARCHITECTURE (corrected 2026-06-22): PDF extraction (pdf-parse) runs in
 * NODE, not the Deno request path — pdf-parse is not resolvable under the Deno
 * server runtime (import_map pins 1.1.1, node_modules has 2.4.5), and
 * pdfChunker.fetchAndChunkPdf was never actually wired in prod. So:
 *
 *   • A NODE dossier-worker (scripts/, reuses the proven pdf-parse path) fetches
 *     each cited paper's OA PDF, extracts full text, and WRITES `work_dossiers`.
 *   • This Deno module only READS that cache + builds the Tier-1 index entry
 *     (which needs no fetch — it's just the works-row metadata).
 *
 * Activated POST-first-draft, for the CITED set only. A cache HIT returns the
 * worker-built Tier-2 full text; a MISS returns Tier-1-only (status "pending")
 * and the caller enqueues the id for the worker — so the dossier is available on
 * the next regeneration/revision (cache-and-grow). First paper citing a work =
 * abstract-only enrichment; subsequent = full-text. Degrades gracefully.
 *
 * 🔒 GOLDEN RULE: never writes `works`. (This module doesn't write at all.)
 * 🛡  SOFT-FAIL: if `work_dossiers` is absent, every read no-ops to Tier-1-only.
 */

export interface DossierWork {
  id: string;
  title?: string | null;
  authors?: string[] | string | null;
  year?: number | null;
  venue?: string | null;
  abstract?: string | null;
  open_access_pdf_url?: string | null;
}

export interface Dossier {
  workId: string;
  indexEntry: string;          // Tier-1 (always present, from the works row)
  fullText: string | null;     // Tier-2 (present only on a worker-built cache hit)
  tokenCount: number;
  source: "oa_pdf" | "web" | "abstract_only";
  status: "ok" | "no_fulltext" | "fetch_failed" | "pending"; // pending = not yet built
  cached: boolean;
}

function authorsStr(a: DossierWork["authors"]): string {
  if (Array.isArray(a)) return a.filter(Boolean).join("; ");
  return String(a ?? "").trim();
}

/** Normalize the stored source to the Dossier union, preserving `web` provenance
 * (so the section prompt HEDGEs web-sourced magnitudes vs ASSERTs oa_pdf ones). */
function normSource(s: unknown): Dossier["source"] {
  return s === "oa_pdf" ? "oa_pdf" : s === "web" ? "web" : "abstract_only";
}

/** Tier-1 compact index entry (~400 tok). Built from the works row — no fetch. */
export function buildIndexEntry(w: DossierWork): string {
  const lines = [
    `[${w.id}] ${w.title ?? "(untitled)"}`,
    `authors: ${authorsStr(w.authors) || "n/a"}   year: ${w.year ?? "n/a"}   venue: ${w.venue ?? "n/a"}`,
  ];
  if (w.abstract) lines.push(`abstract: ${w.abstract.slice(0, 1200)}`);
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
async function readCache(client: any, workId: string): Promise<any | null> {
  try {
    const { data, error } = await client.from("work_dossiers").select("*").eq("work_id", workId).maybeSingle();
    if (error) return null; // table missing / PostgREST error → no cache
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a paper's dossier from the cache. Cache hit → returns worker-built Tier-2
 * full text. Miss → Tier-1-only with status "pending" (caller should enqueue the
 * id for the Node dossier-worker). Never fetches a PDF in-process.
 */
// deno-lint-ignore no-explicit-any
export async function getDossier(client: any, w: DossierWork): Promise<Dossier> {
  const workId = w.id;
  const indexEntry = buildIndexEntry(w);
  const cached = await readCache(client, workId);
  if (cached && (cached.status === "ok" || cached.status === "no_fulltext")) {
    return {
      workId,
      indexEntry: cached.index_entry ?? indexEntry,
      fullText: cached.full_text ?? null,
      tokenCount: cached.token_count ?? 0,
      source: normSource(cached.source),
      status: cached.status,
      cached: true,
    };
  }
  // Miss (or transient fetch_failed): Tier-1 only, mark pending for the worker.
  return { workId, indexEntry, fullText: null, tokenCount: 0, source: "abstract_only", status: "pending", cached: false };
}

/** Batch cache-read for the cited set. Returns a map; ids with no dossier are pending. */
// deno-lint-ignore no-explicit-any
export async function getDossiers(client: any, works: DossierWork[]): Promise<Map<string, Dossier>> {
  const out = new Map<string, Dossier>();
  // One round-trip: fetch all cached rows, then assemble (Tier-1 always available).
  const ids = works.map((w) => w.id).filter(Boolean);
  // deno-lint-ignore no-explicit-any
  const byId = new Map<string, any>();
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await client.from("work_dossiers").select("*").in("work_id", ids.slice(i, i + 200));
      if (error) break; // table missing → all pending
      for (const r of data ?? []) byId.set(r.work_id, r);
    }
  } catch { /* table missing → all pending */ }
  for (const w of works) {
    const c = byId.get(w.id);
    const indexEntry = buildIndexEntry(w);
    if (c && (c.status === "ok" || c.status === "no_fulltext")) {
      out.set(w.id, {
        workId: w.id, indexEntry: c.index_entry ?? indexEntry, fullText: c.full_text ?? null,
        tokenCount: c.token_count ?? 0, source: normSource(c.source),
        status: c.status, cached: true,
      });
    } else {
      out.set(w.id, { workId: w.id, indexEntry, fullText: null, tokenCount: 0, source: "abstract_only", status: "pending", cached: false });
    }
  }
  return out;
}

/** Work ids in the set that have no usable dossier yet — to enqueue for the worker. */
// deno-lint-ignore no-explicit-any
export function pendingIds(dossiers: Map<string, Dossier>): string[] {
  return [...dossiers.values()].filter((d) => d.status === "pending" || (!d.fullText && d.status !== "no_fulltext")).map((d) => d.workId);
}
