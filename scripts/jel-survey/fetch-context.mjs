// scripts/jel-survey/fetch-context.mjs
//
// Fetch institutional / descriptive context for a JEL section that needs
// facts NOT in the evidence_cards (e.g. program names, founding dates, scale).
//
// Today's pipeline retrieves causal-evaluation papers. When a section like
// "Landscape of CCT Programs" needs descriptive history (Bolsa Família was
// launched in 2003, PROGRESA in 1997), our evidence pool lacks that.
//
// This pulls grounded snippets from Wikipedia (REST API, no auth, well-curated
// for major social-policy programs) and writes them to a context JSON the
// drafter can inject into the prompt for the relevant section.
//
// Usage:
//   node scripts/jel-survey/fetch-context.mjs --query cash-transfers-education-lac
//
// Output: reports/institutional-context-<query>-<date>.json with shape:
//   { topics: [{ title, url, extract, source: "wikipedia" }, ...] }
//
// The drafter (with --context <path>) injects these as a CONTEXT BLOCK
// separate from the EVIDENCE BLOCK. Drafter rules: claims from CONTEXT may
// cite [wiki:Title] (not [workId]); claims about empirical findings must
// still cite [workId] from EVIDENCE.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// Curated search terms per JEL fixture query. Wikipedia's search API resolves
// these to canonical article titles, so we don't have to guess slug spelling.
const SEARCH_TERMS = {
  "cash-transfers-education-lac": [
    "Bolsa Família program Brazil",
    "Oportunidades Mexico Progresa",
    "Conditional cash transfer Latin America",
    "Familias en Acción Colombia",
    "Juntos Peru cash transfer",
    "Bono de Desarrollo Humano Ecuador",
    "Asignación Universal por Hijo Argentina",
  ],
  "ai-automation-labor": [
    "Routine-biased technological change",
    "Skill-biased technological change",
    "Job polarization",
    "Industrial robot adoption",
    "Generative artificial intelligence economic effects",
  ],
  "informality-lac": [
    "Informal economy Latin America",
    "Simples Nacional Brazil tax",
    "Monotributo Argentina",
    "Labor informality measurement",
    "Pension systems Latin America",
  ],
};

const WIKI_SEARCH = "https://en.wikipedia.org/w/api.php";
const WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary";

function parseArgs(argv) {
  const out = { query: null };
  for (let i = 2; i < argv.length; i++) {
    const f = argv[i], n = argv[i + 1];
    if (f === "--query") { out.query = n; i++; }
  }
  return out;
}

const UA = "HorizonScanner/1.0 (JEL pipeline; mailto:horizon-scanner@iadb.org)";

async function searchForTitle(query) {
  const url = `${WIKI_SEARCH}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const data = await r.json();
  return data?.query?.search?.[0]?.title ?? null;
}

async function fetchSummary(title) {
  const url = `${WIKI_SUMMARY}/${encodeURIComponent(title)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  return r.json();
}

const STOPWORDS = new Set(["a", "an", "the", "in", "on", "of", "for", "and", "or", "with"]);

// Reject articles whose title shares almost nothing with the query — Wikipedia
// search returns weakly-related fallbacks (e.g. "Medellín" for "Familias en
// Acción Colombia") that would just be noise in the prompt.
function isRelevant(query, resolvedTitle, description, extract) {
  const queryTokens = query.toLowerCase().split(/[^a-záéíóúñ]+/).filter((t) => t.length > 3 && !STOPWORDS.has(t));
  const haystack = `${resolvedTitle} ${description ?? ""} ${(extract ?? "").slice(0, 300)}`.toLowerCase();
  // Require at least 2 distinctive tokens to overlap (so "Bono de Desarrollo Humano Ecuador" → "List of national identity card policies" gets rejected).
  let hits = 0;
  for (const t of queryTokens) {
    if (haystack.includes(t)) hits++;
  }
  return hits >= 2;
}

async function fetchTopic(query) {
  try {
    const resolved = await searchForTitle(query);
    if (!resolved) {
      console.log(`[context] MISS  "${query}" (no search result)`);
      return null;
    }
    const data = await fetchSummary(resolved);
    if (!data) {
      console.log(`[context] MISS  "${query}" → "${resolved}" (no summary)`);
      return null;
    }
    if (!isRelevant(query, resolved, data.description, data.extract)) {
      console.log(`[context] DROP  "${query}" → "${resolved}" (low relevance)`);
      return null;
    }
    return {
      searchQuery: query,
      title: data.title ?? resolved,
      url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(resolved)}`,
      description: data.description ?? null,
      extract: data.extract ?? null,
      source: "wikipedia",
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.log(`[context] ERROR "${query}": ${err.message}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.query) {
    console.error("Usage: node scripts/jel-survey/fetch-context.mjs --query <id>");
    process.exit(1);
  }
  const queries = SEARCH_TERMS[args.query];
  if (!queries) {
    console.error(`No search-term list for query "${args.query}". Available: ${Object.keys(SEARCH_TERMS).join(", ")}`);
    process.exit(1);
  }
  console.log(`[context] resolving ${queries.length} Wikipedia search terms for ${args.query}`);

  const out = [];
  const seen = new Set();
  for (const q of queries) {
    const result = await fetchTopic(q);
    if (result) {
      if (seen.has(result.title)) {
        console.log(`[context] DUP   "${q}" → "${result.title}" (already have it)`);
      } else {
        console.log(`[context] OK    "${q}" → ${result.title} (${result.extract?.length ?? 0} chars)`);
        seen.add(result.title);
        out.push(result);
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(ROOT, "reports", `institutional-context-${args.query}-${today}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({
    queryId: args.query,
    fetchedAt: new Date().toISOString(),
    source: "wikipedia",
    topics: out,
  }, null, 2) + "\n");

  console.log(`\n[context] wrote ${outPath} — ${out.length} topics`);
}

main().catch((err) => { console.error("[context] fatal:", err); process.exit(1); });
