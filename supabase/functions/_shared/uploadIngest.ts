// Paper Studio — upload ingestion. Resolves a DOI/URL or pasted text into a
// PaperPlanUpload preview card: metadata (OpenAlex → Crossref → Semantic Scholar
// for DOI; Qwen extraction for paste) + a single-paper SMS classification +
// a corpus-match lookup. Reads external APIs + the works table; NEVER writes
// works (golden rule). Pure resolution — the endpoint persists.

import { callQwen } from "./jelPaperPipeline.ts";

const MAILTO = "horizon-scanner@iadb.org";

export interface UploadCard {
  design: string | null;
  intervention: string | null;
  outcome: string | null;
  effectDirection: string | null;
  findingShort: string | null;
  mechanism: string | null;
}

export interface UploadResult {
  uploadId: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  abstract: string | null;
  venue: string | null;      // journal / conference / book series name
  smsLevel: number | null;
  matchedWorkId: string | null;
  source: "doi" | "paste";
  card: UploadCard | null;   // grounded evidence card extracted from the document text
}

// DOI extraction from a raw string or URL (handles doi.org links + bare DOIs).
export function extractDoi(input: string): string | null {
  const m = input.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return m ? m[0].replace(/[.,;)]+$/, "").toLowerCase() : null;
}

// Venue helpers — exported for tests.
export function venueFromOpenAlex(w: any): string | null {
  return w?.primary_location?.source?.display_name ?? w?.host_venue?.display_name ?? null;
}
export function venueFromCrossref(w: any): string | null {
  const c = w?.["container-title"];
  return Array.isArray(c) && c[0] ? String(c[0]) : null;
}

function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null;
  const positions: { pos: number; word: string }[] = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) positions.push({ pos: i, word });
  if (positions.length === 0) return null;
  positions.sort((a, b) => a.pos - b.pos);
  return positions.map((p) => p.word).join(" ").slice(0, 4000);
}

async function fetchOpenAlex(doi: string): Promise<Partial<UploadResult> | null> {
  try {
    // DOI is a path segment with a literal "/" — OpenAlex 404s on %2F, so do NOT encode it.
    const url = `https://api.openalex.org/works/doi:${doi}?mailto=${MAILTO}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const w = await r.json();
    return {
      title: w.title ?? w.display_name ?? null,
      authors: (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
      year: w.publication_year ?? null,
      abstract: reconstructAbstract(w.abstract_inverted_index),
      venue: venueFromOpenAlex(w),
      doi,
    } as Partial<UploadResult>;
  } catch { return null; }
}

function stripJats(s: string | null | undefined): string | null {
  return s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
}

async function fetchCrossref(doi: string): Promise<Partial<UploadResult> | null> {
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`);
    if (!r.ok) return null;
    const m = (await r.json())?.message;
    if (!m) return null;
    return {
      title: Array.isArray(m.title) ? m.title[0] : (m.title ?? null),
      authors: (m.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
      year: m.issued?.["date-parts"]?.[0]?.[0] ?? null,
      abstract: stripJats(m.abstract),
      venue: venueFromCrossref(m),
      doi,
    } as Partial<UploadResult>;
  } catch { return null; }
}

async function fetchSemanticScholar(doi: string): Promise<Partial<UploadResult> | null> {
  try {
    // Raw DOI in the path (literal "/"); encoding to %2F breaks SS routing.
    const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=title,abstract,year,authors,venue`);
    if (!r.ok) return null;
    const p = await r.json();
    return {
      title: p.title ?? null,
      authors: (p.authors ?? []).map((a: any) => a.name).filter(Boolean),
      year: p.year ?? null,
      abstract: p.abstract ?? null,
      venue: p.venue ?? null,
      doi,
    } as Partial<UploadResult>;
  } catch { return null; }
}

// Merge sources, preferring the first non-empty value for each field.
function mergeMeta(...parts: (Partial<UploadResult> | null)[]): Partial<UploadResult> {
  const out: Partial<UploadResult> = {};
  for (const p of parts) {
    if (!p) continue;
    if (!out.title && p.title) out.title = p.title;
    if ((!out.authors || out.authors.length === 0) && p.authors?.length) out.authors = p.authors;
    if (out.year == null && p.year != null) out.year = p.year;
    if (!out.abstract && p.abstract) out.abstract = p.abstract;
    if (!out.venue && p.venue) out.venue = p.venue;
    if (!out.doi && p.doi) out.doi = p.doi;
  }
  return out;
}

// Regex-based best-effort extraction from the first chunk of PDF/paste text.
// Used as a fallback when Qwen is unavailable. Heuristics only — better than blank.
function regexExtract(text: string): Partial<UploadResult> {
  const head = text.slice(0, 4000);

  // DOI — robust pattern.
  const doiMatch = head.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  const doi = doiMatch ? doiMatch[0].replace(/[.,;)]+$/, "").toLowerCase() : null;

  // Year — 4-digit year in range 1900–2030.
  const yearMatch = head.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  // Title — the longest line in the first ~800 chars that looks like a title
  // (all-caps or title-case, no "Abstract", no "Introduction").
  const titleLines = head.slice(0, 800).split(/\n+/).map((l) => l.trim()).filter((l) =>
    l.length > 10 && l.length < 200 &&
    !/^(abstract|introduction|keywords|contents|acknowledgements|references|doi|http)/i.test(l) &&
    !/^\d+$/.test(l)
  );
  const title = titleLines.length > 0
    ? titleLines.reduce((best, l) => (l.length > best.length ? l : best), titleLines[0])
    : undefined;

  // Abstract — text following the word "Abstract" up to ~1500 chars.
  const absMatch = head.match(/\bAbstract[:\s]*\n?([\s\S]{100,1500}?)(?:\n\s*\n|\bKeywords|\bIntroduction|\b1\s*\.?\s+Introduction)/i);
  const abstract = absMatch ? absMatch[1].replace(/\s+/g, " ").trim() : null;

  return { title, authors: [], year, abstract, doi, venue: null };
}

// Qwen extraction from a pasted blob OR extracted document text
// (title/authors/year/abstract/doi). The doi is used for corpus matching.
// Falls back to regex heuristics when Qwen is unavailable, so the preview
// card is never entirely blank for a PDF upload.
async function extractFromPaste(text: string): Promise<Partial<UploadResult>> {
  const system = [
    "Extract bibliographic metadata from the text of an academic paper (title page,",
    "abstract, citation, or the first pages of a PDF/Word document). Return JSON only:",
    '{ "title": "...", "authors": ["First Last", ...], "year": 2020 or null, "abstract": "...", "doi": "10.xxxx/..." or null, "journal": "Journal or conference name" or null }',
    "The abstract is the paper's own abstract paragraph if present. Capture the DOI if it",
    "appears anywhere in the text. The journal is the name of the journal, conference, or",
    "book series where the paper was published. Use null/empty when a field is absent. Do not invent.",
  ].join("\n");
  try {
    const raw = await callQwen(system, text.slice(0, 8000), 1024);
    const doi = typeof raw.doi === "string" ? (raw.doi.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]?.toLowerCase() ?? null) : null;
    return {
      title: typeof raw.title === "string" ? raw.title : null,
      authors: Array.isArray(raw.authors) ? raw.authors.map(String) : [],
      year: typeof raw.year === "number" ? raw.year : null,
      abstract: typeof raw.abstract === "string" ? raw.abstract : null,
      venue: typeof raw.journal === "string" && raw.journal.trim() ? raw.journal.trim() : null,
      doi,
    };
  } catch {
    // Qwen unavailable or timed out — use regex heuristics so the preview card
    // is not entirely blank. The user can still add the paper.
    console.warn("[extractFromPaste] Qwen failed — using regex fallback");
    return regexExtract(text);
  }
}

// One grounded Qwen pass → SMS level + an evidence card (design/finding/mechanism).
// Reasons over the document text (or abstract) and extracts ONLY what's stated.
async function classifyCardAndSms(title: string, context: string | null): Promise<{ smsLevel: number | null; card: UploadCard | null }> {
  if (!context) return { smsLevel: null, card: null };
  const system = [
    "You are a research methodologist. From the paper text below, extract a structured evidence",
    "card AND score methodological rigor on the Maryland Scientific Methods Scale (SMS):",
    "1=cross-sectional correlation; 2=before/after no control; 3=comparison group;",
    "4=quasi-experimental (DiD/IV/RDD/matching); 5=RCT; 0=non-empirical (review/theory).",
    "Extract ONLY what the text states — do NOT invent. Return JSON only:",
    '{ "sms_level": 0-5, "design": "RCT|DiD|IV|RDD|observational|review|..." or null,',
    '  "intervention": "..." or null, "outcome": "..." or null,',
    '  "effectDirection": "positive|negative|null|mixed" or null,',
    '  "findingShort": "one-sentence headline finding" or null, "mechanism": "..." or null }',
  ].join("\n");
  try {
    const raw = await callQwen(system, `TITLE: ${title}\n\n${context.slice(0, 6000)}`, 700);
    const lvl = Number(raw?.sms_level);
    const smsLevel = Number.isFinite(lvl) && lvl >= 0 && lvl <= 5 ? lvl : null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const card: UploadCard = {
      design: str(raw?.design), intervention: str(raw?.intervention), outcome: str(raw?.outcome),
      effectDirection: str(raw?.effectDirection), findingShort: str(raw?.findingShort), mechanism: str(raw?.mechanism),
    };
    return { smsLevel, card: Object.values(card).some(Boolean) ? card : null };
  } catch { return { smsLevel: null, card: null }; }
}

// Corpus match (read-only) → matchedWorkId or null. Tries DOI first (precise),
// then a case-insensitive exact title match so documents WITHOUT a clean DOI
// (most uploaded PDFs) still get the "already in corpus" check.
async function matchCorpus(db: any, doi: string | null, title?: string | null): Promise<string | null> {
  try {
    if (doi) {
      const { data } = await db.from("works").select("id").eq("canonical_doi", doi).limit(1).maybeSingle();
      if (data?.id) return data.id;
    }
    const t = (title ?? "").trim();
    if (t.length >= 20 && t !== "(untitled upload)") {
      // ilike without wildcards = case-insensitive exact match (index-friendly, low false-positive).
      const { data } = await db.from("works").select("id").ilike("title", t).limit(1).maybeSingle();
      if (data?.id) return data.id;
    }
    return null;
  } catch { return null; }
}

// Returns true if the resolved upload is already present in the plan:
// - matched workId is in curatedWorkIds and NOT in removedWorkIds, OR
// - doi/title matches an entry in plan.uploads (case-insensitive, doi-org prefix stripped).
export function isAlreadyInPlan(plan: any, upload: { matchedWorkId?: string | null; doi?: string | null; title?: string | null }): boolean {
  const removed = new Set<string>(plan?.removedWorkIds ?? []);
  const curated = new Set<string>((plan?.curatedWorkIds ?? []).filter((id: string) => !removed.has(id)));
  if (upload.matchedWorkId && curated.has(upload.matchedWorkId)) return true;
  const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").trim();
  const upDoi = norm(upload.doi), upTitle = norm(upload.title);
  for (const u of (plan?.uploads ?? [])) {
    if (upDoi && norm(u.doi) === upDoi) return true;
    if (upTitle && norm(u.title) === upTitle) return true;
  }
  return false;
}

// Main entry: resolve an upload request into a preview card. `uploadId` is
// supplied by the caller (stable id for attach/dedup). Never writes works.
export async function resolveUpload(
  db: any,
  input: { doiOrUrl?: string; pastedText?: string },
  uploadId: string,
): Promise<UploadResult> {
  const doi = input.doiOrUrl ? extractDoi(input.doiOrUrl) : null;
  let meta: Partial<UploadResult>;
  let source: "doi" | "paste";

  if (doi) {
    source = "doi";
    const oa = await fetchOpenAlex(doi);
    let merged = mergeMeta(oa, null);
    if (!merged.title || !merged.abstract) merged = mergeMeta(merged, await fetchCrossref(doi));
    if (!merged.title || !merged.abstract) merged = mergeMeta(merged, await fetchSemanticScholar(doi));
    meta = merged.title ? merged : await extractFromPaste(input.doiOrUrl ?? "");
  } else {
    source = "paste";
    meta = await extractFromPaste(input.pastedText ?? input.doiOrUrl ?? "");
  }

  const title = meta.title ?? "(untitled upload)";
  const abstract = meta.abstract ?? null;
  const matchedWorkId = await matchCorpus(db, meta.doi ?? doi, title);
  // Card context: the original paste/PDF text is richest; for a DOI, use the abstract.
  const cardContext = source === "paste" ? (input.pastedText ?? input.doiOrUrl ?? abstract) : abstract;
  const { smsLevel, card } = await classifyCardAndSms(title, cardContext);

  return {
    uploadId,
    title,
    authors: meta.authors ?? [],
    year: meta.year ?? null,
    doi: meta.doi ?? doi,
    abstract,
    venue: meta.venue ?? null,
    smsLevel,
    matchedWorkId,
    source,
    card,
  };
}
