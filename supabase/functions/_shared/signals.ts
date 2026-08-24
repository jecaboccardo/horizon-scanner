// supabase/functions/_shared/signals.ts
//
// Signals fetch — separate from the corpus-only evidence path.
//
// Two profiles:
//   1. "policy"  — curated grey-lit + working papers + multilaterals.
//                  Exa restricted to whitelist. Last 5 years.
//   2. "buzz"    — open web (news/blogs/Substack/social commentary).
//                  Exa unrestricted. Last 30 days.
//
// Signals NEVER enter the evidence table or the synthesis prompt. They are
// rendered in a separate panel below the brief and clearly badged so the user
// knows these are non-corpus, non-peer-reviewed inputs.
//
// Frontend pills default OFF — user must opt in per query. No region filter.

const POLICY_DOMAINS = [
  // Tier A — IADB sister institutions & multilaterals
  "iadb.org", "blogs.iadb.org", "publications.iadb.org",
  "worldbank.org", "blogs.worldbank.org", "openknowledge.worldbank.org",
  "imf.org", "oecd.org", "oecd-ilibrary.org",
  "adb.org", "afdb.org",
  // Tier B — major think tanks & dev research
  "cgdev.org", "brookings.edu", "ifpri.org", "3ieimpact.org",
  "giz.de", "ilo.org", "unctad.org", "un.org",
  // Tier C — working paper repositories (kept ssrn, dropped ideas.repec)
  "nber.org", "iza.org", "ssrn.com",
  // Tier D — LAC-specific research orgs
  "cepal.org", "ipea.gov.br", "cide.edu", "caf.com",
  "fundar.org.mx", "grade.org.pe",
  // Tier E — health-specific (heavy in IADB reference lists)
  "paho.org", "iris.paho.org", "who.int", "iris.who.int", "ihme.org",
];

export interface SignalItem {
  id: string;
  title: string;
  url: string | null;
  snippet: string | null;
  publishedDate: string | null;
  domain: string | null;
  author: string | null;
  profile: "policy" | "buzz";
}

interface FetchSignalsOptions {
  policy?: boolean;
  buzz?: boolean;
  policyLimit?: number;
  buzzLimit?: number;
}

const POLICY_LOOKBACK_DAYS = 365 * 5;
const BUZZ_LOOKBACK_DAYS = 30;

function isoNDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function domainOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

interface ExaResult {
  id?: string;
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
  author?: string | string[];
}

async function callExa(
  query: string,
  {
    numResults,
    startPublishedDate,
    includeDomains,
  }: {
    numResults: number;
    startPublishedDate: string;
    includeDomains?: string[];
  },
): Promise<ExaResult[]> {
  // deno-lint-ignore no-explicit-any
  const apiKey = (typeof Deno !== "undefined"
    ? Deno.env.get("EXA_API_KEY")
    : (globalThis as any).process?.env?.EXA_API_KEY);
  if (!apiKey) {
    console.warn("[signals] EXA_API_KEY not set — returning empty");
    return [];
  }

  const body: Record<string, unknown> = {
    query,
    type: "auto",
    numResults,
    startPublishedDate,
    contents: { text: { maxCharacters: 600 } },
  };
  if (includeDomains && includeDomains.length > 0) {
    body.includeDomains = includeDomains;
  }

  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[signals] Exa ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.results) ? (data.results as ExaResult[]) : [];
  } catch (err) {
    console.error(`[signals] Exa fetch failed: ${(err as Error).message}`);
    return [];
  }
}

function toSignalItem(raw: ExaResult, profile: "policy" | "buzz"): SignalItem {
  const url = raw.url ?? null;
  const author = Array.isArray(raw.author)
    ? raw.author.filter(Boolean).join(", ")
    : (raw.author ?? null);
  return {
    id: `exa:${profile}:${raw.id ?? url ?? raw.title ?? Math.random().toString(36).slice(2)}`,
    title: raw.title ?? "(untitled)",
    url,
    snippet: raw.text ? String(raw.text).trim().slice(0, 600) : null,
    publishedDate: raw.publishedDate ?? null,
    domain: domainOfUrl(url),
    author: author || null,
    profile,
  };
}

// ---------------------------------------------------------------------------
// Follow-digest signals (Lane B of the Follow tab).
//
// Open-web fan-out scoped to a per-subscription query and a configurable
// lookback window. Each result is classified into a coarse source type
// (news / blog / x / other) using URL heuristics so the frontend can show
// source pills and let the user filter the signals lane.
// ---------------------------------------------------------------------------

export type FollowSignalSource = "news" | "blog" | "x" | "other";

export interface FollowSignalItem extends SignalItem {
  sourceType: FollowSignalSource;
}

const X_DOMAINS = new Set(["twitter.com", "x.com", "mobile.twitter.com"]);
const NEWS_DOMAIN_HINTS = [
  "nytimes.com", "ft.com", "wsj.com", "bloomberg.com", "reuters.com",
  "economist.com", "bbc.com", "bbc.co.uk", "theguardian.com",
  "washingtonpost.com", "apnews.com", "cnbc.com", "axios.com",
  "elpais.com", "lanacion.com.ar", "americaeconomia.com", "infobae.com",
  "clarin.com", "folha.uol.com.br", "globo.com", "valor.globo.com",
  "el-pais.com", "eltiempo.com", "elcomercio.pe",
];

function classifySignalSource(url: string | null, domain: string | null): FollowSignalSource {
  if (!url && !domain) return "other";
  const d = (domain || "").toLowerCase();
  if (X_DOMAINS.has(d)) return "x";
  if (NEWS_DOMAIN_HINTS.some((hint) => d.endsWith(hint))) return "news";
  if (d.includes("/news/") || (url ?? "").toLowerCase().includes("/news/")) return "news";
  // Heuristic: known blog/substack patterns
  if (d.includes("substack.com") || d.includes("medium.com") || d.includes("wordpress.com") || d.includes("blogspot.")) {
    return "blog";
  }
  if (d.startsWith("blog.") || d.includes(".blog") || (url ?? "").toLowerCase().includes("/blog/")) return "blog";
  // Default everything else (open-web pages that aren't academic) to blog;
  // the academic-ish results are pre-filtered out by excludeDomains below.
  return "blog";
}

const ACADEMIC_EXCLUDE_DOMAINS = [
  "arxiv.org", "ssrn.com", "nber.org", "iza.org", "ideas.repec.org",
  "researchgate.net", "academia.edu", "semanticscholar.org",
  "openalex.org", "core.ac.uk", "scholar.google.com",
];

export async function fetchFollowSignals(
  query: string,
  { windowDays = 7, limit = 12 }: { windowDays?: number; limit?: number } = {},
): Promise<FollowSignalItem[]> {
  if (!query || !query.trim()) return [];
  const startPublishedDate = isoNDaysAgo(Math.max(1, windowDays));

  // deno-lint-ignore no-explicit-any
  const apiKey = (typeof Deno !== "undefined"
    ? Deno.env.get("EXA_API_KEY")
    : (globalThis as any).process?.env?.EXA_API_KEY);
  if (!apiKey) {
    console.warn("[follow-signals] EXA_API_KEY not set — returning empty");
    return [];
  }

  const body: Record<string, unknown> = {
    query,
    type: "auto",
    numResults: limit,
    startPublishedDate,
    excludeDomains: ACADEMIC_EXCLUDE_DOMAINS,
    contents: { text: { maxCharacters: 500 } },
  };

  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[follow-signals] Exa ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    const results = Array.isArray(data.results) ? (data.results as ExaResult[]) : [];
    return results.map((raw) => {
      const base = toSignalItem(raw, "buzz");
      return { ...base, sourceType: classifySignalSource(base.url, base.domain) };
    });
  } catch (err) {
    console.error(`[follow-signals] fetch failed: ${(err as Error).message}`);
    return [];
  }
}

export async function fetchSignals(
  query: string,
  opts: FetchSignalsOptions = {},
): Promise<{ policy: SignalItem[]; buzz: SignalItem[] }> {
  const wantPolicy = opts.policy === true;
  const wantBuzz = opts.buzz === true;
  if (!wantPolicy && !wantBuzz) return { policy: [], buzz: [] };

  const policyLimit = opts.policyLimit ?? 12;
  const buzzLimit = opts.buzzLimit ?? 10;

  const calls: Array<Promise<ExaResult[]>> = [];
  const tags: Array<"policy" | "buzz"> = [];

  if (wantPolicy) {
    calls.push(
      callExa(query, {
        numResults: policyLimit,
        startPublishedDate: isoNDaysAgo(POLICY_LOOKBACK_DAYS),
        includeDomains: POLICY_DOMAINS,
      }),
    );
    tags.push("policy");
  }
  if (wantBuzz) {
    calls.push(
      callExa(query, {
        numResults: buzzLimit,
        startPublishedDate: isoNDaysAgo(BUZZ_LOOKBACK_DAYS),
        // No includeDomains — open web for buzz
      }),
    );
    tags.push("buzz");
  }

  const settled = await Promise.allSettled(calls);
  const out: { policy: SignalItem[]; buzz: SignalItem[] } = { policy: [], buzz: [] };
  settled.forEach((r, i) => {
    const profile = tags[i];
    const results = r.status === "fulfilled" ? r.value : [];
    out[profile] = results.map((raw) => toSignalItem(raw, profile));
  });
  return out;
}
