/**
 * Multi-source abstract acquisition cascade.
 *
 * HARD RULES enforced here:
 *  - NEVER synthesize an abstract. Every function returns verbatim text from an
 *    authoritative external source (or the paper's own PDF), or null.
 *  - DOI-keyed lookups are TRUSTED (a DOI identifies one paper).
 *  - Title/author lookups must pass the strict gate in matchGate.mjs before the
 *    CALLER accepts them. The source functions here just return candidates; the
 *    caller is responsible for gating no-DOI matches.
 *
 * Each source returns { abstract, matchedBy } or null.
 */

const MAILTO = process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || 'horizon-scanner@iadb.org';
const S2_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.S2_API_KEY || '';
const MIN_ABSTRACT_LEN = 100;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── cleaning ────────────────────────────────────────────────────────────────

export function cleanAbstract(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw;
  // Strip JATS / XML / HTML tags (Crossref returns <jats:p>…</jats:p>).
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  // Decode a few common entities.
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  // Strip leading boilerplate labels.
  s = s.replace(/^\s*(abstract|summary|a\s*b\s*s\s*t\s*r\s*a\s*c\s*t)\s*[:.\-—]?\s*/i, '');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // Reject obvious junk fragments / copyright-only blurbs.
  if (s.length < MIN_ABSTRACT_LEN) return null;
  const lower = s.toLowerCase();
  // Reject pure copyright / "no abstract available" placeholders.
  if (/^(©|\(c\)|copyright)\b/i.test(s) && s.length < 200) return null;
  if (/no abstract (is )?(available|provided)/.test(lower) && s.length < 200) return null;
  return s;
}

function reconstructInverted(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const positions = Object.values(invertedIndex).flat();
  if (positions.length === 0) return null;
  const max = Math.max(...positions) + 1;
  const words = Array(max).fill('');
  for (const [w, ps] of Object.entries(invertedIndex)) for (const p of ps) words[p] = w;
  return words.join(' ').trim() || null;
}

function normDoi(doi) {
  return String(doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').trim();
}

async function tryFetch(url, opts = {}, attempts = 3) {
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeout || 25000), headers: opts.headers });
      if (res.status === 429 || res.status === 503) {
        // Honor Retry-After when present; otherwise short capped backoff.
        if (a === attempts - 1) return res; // give up — caller treats as miss
        const ra = parseInt(res.headers.get('retry-after') || '', 10);
        await sleep(Math.min(5000, ra > 0 ? ra * 1000 : 1500 * (a + 1)));
        continue;
      }
      return res;
    } catch {
      if (a === attempts - 1) return null;
      await sleep(1000 * (a + 1));
    }
  }
  return null;
}

// ─── DOI-trusted sources (batchable where possible) ──────────────────────────

/**
 * OpenAlex — batch up to 50 DOIs. Returns Map<normDoi, abstract>.
 */
export async function openAlexBatch(dois) {
  const out = new Map();
  if (!dois.length) return out;
  const filter = `doi:${dois.map(normDoi).join('|')}`;
  const params = new URLSearchParams({
    filter, 'per-page': '50',
    select: 'doi,abstract_inverted_index',
    mailto: MAILTO,
  });
  const res = await tryFetch(`https://api.openalex.org/works?${params}`);
  if (!res || !res.ok) return out;
  const json = await res.json().catch(() => null);
  for (const r of json?.results || []) {
    const doi = normDoi(r.doi);
    const abs = cleanAbstract(reconstructInverted(r.abstract_inverted_index));
    if (doi && abs) out.set(doi, abs);
  }
  return out;
}

/**
 * Crossref single-DOI lookup. Returns abstract or null.
 */
export async function crossrefOne(doi) {
  const d = normDoi(doi);
  const res = await tryFetch(
    `https://api.crossref.org/works/${encodeURIComponent(d)}?mailto=${MAILTO}`,
    { headers: { 'User-Agent': `HorizonScanner/1.0 (mailto:${MAILTO})` } }
  );
  if (!res || !res.ok) return null;
  const json = await res.json().catch(() => null);
  return cleanAbstract(json?.message?.abstract);
}

/**
 * Semantic Scholar single-DOI lookup. Returns abstract or null.
 */
export async function s2One(doi) {
  const d = normDoi(doi);
  const headers = S2_KEY ? { 'x-api-key': S2_KEY } : {};
  // Without an API key S2 rate-limits hard (429); single attempt to avoid stalling.
  const res = await tryFetch(
    `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(d)}?fields=abstract`,
    { headers, timeout: 12000 }, S2_KEY ? 3 : 1
  );
  if (!res || !res.ok) return null;
  const json = await res.json().catch(() => null);
  return cleanAbstract(json?.abstract);
}

/**
 * Europe PMC — good for biomedical DOIs. Returns abstract or null.
 */
export async function europePmcOne(doi) {
  const d = normDoi(doi);
  const params = new URLSearchParams({
    query: `DOI:${d}`, format: 'json', resultType: 'core', pageSize: '1',
  });
  const res = await tryFetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`);
  if (!res || !res.ok) return null;
  const json = await res.json().catch(() => null);
  const rec = json?.resultList?.result?.[0];
  return cleanAbstract(rec?.abstractText);
}

/**
 * Publisher landing-page meta tags via DOI resolve.
 * Looks for citation_abstract / dc.description / og:description.
 */
export async function landingPageMetaOne(doi) {
  const d = normDoi(doi);
  const res = await tryFetch(`https://doi.org/${d}`, {
    headers: { 'User-Agent': `Mozilla/5.0 (compatible; HorizonScanner/1.0; mailto:${MAILTO})` },
    timeout: 20000,
  }, 2);
  if (!res || !res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!/html/i.test(ct)) return null;
  const html = await res.text().catch(() => '');
  if (!html) return null;
  // Try meta name/property in priority order.
  const patterns = [
    /<meta[^>]+name=["']citation_abstract["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']dc\.description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']dcterms\.abstract["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const cleaned = cleanAbstract(m[1]);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

// ─── No-DOI / title sources (caller must gate via matchGate) ─────────────────

/**
 * OpenAlex title search. Returns array of {title, year, authorSurname, abstract}
 * candidates for the caller to gate.
 */
export async function openAlexTitleSearch(title, year) {
  const params = new URLSearchParams({
    search: title.slice(0, 250),
    'per-page': '5',
    select: 'title,publication_year,authorships,abstract_inverted_index',
    mailto: MAILTO,
  });
  const res = await tryFetch(`https://api.openalex.org/works?${params}`);
  if (!res || !res.ok) return [];
  const json = await res.json().catch(() => null);
  return (json?.results || []).map((r) => ({
    title: r.title || '',
    year: r.publication_year ?? null,
    firstAuthorSurname: surnameFromOA(r.authorships?.[0]),
    abstract: cleanAbstract(reconstructInverted(r.abstract_inverted_index)),
  })).filter((c) => c.abstract);
}

/**
 * Crossref bibliographic title search. Returns gated candidates.
 */
export async function crossrefTitleSearch(title, year) {
  const params = new URLSearchParams({
    'query.bibliographic': title.slice(0, 250),
    rows: '5',
    select: 'title,abstract,author,issued',
    mailto: MAILTO,
  });
  const res = await tryFetch(
    `https://api.crossref.org/works?${params}`,
    { headers: { 'User-Agent': `HorizonScanner/1.0 (mailto:${MAILTO})` } }
  );
  if (!res || !res.ok) return [];
  const json = await res.json().catch(() => null);
  return (json?.message?.items || []).map((r) => ({
    title: (r.title && r.title[0]) || '',
    year: r.issued?.['date-parts']?.[0]?.[0] ?? null,
    firstAuthorSurname: (r.author?.[0]?.family || '').toLowerCase(),
    abstract: cleanAbstract(r.abstract),
  })).filter((c) => c.abstract);
}

/**
 * arXiv API title search (for working papers without a DOI). Returns gated candidates.
 */
export async function arxivTitleSearch(title) {
  const q = encodeURIComponent(`ti:"${title.slice(0, 200).replace(/"/g, '')}"`);
  const url = `http://export.arxiv.org/api/query?search_query=${q}&max_results=5`;
  const res = await tryFetch(url, {}, 2);
  if (!res || !res.ok) return [];
  const xml = await res.text().catch(() => '');
  const entries = xml.split('<entry>').slice(1);
  const out = [];
  for (const e of entries) {
    const t = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '';
    const author = (e.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '';
    const published = (e.match(/<published>(\d{4})/) || [])[1] || null;
    const abs = cleanAbstract(summary);
    if (abs) {
      out.push({
        title: t.replace(/\s+/g, ' ').trim(),
        year: published ? parseInt(published, 10) : null,
        firstAuthorSurname: lastWord(author).toLowerCase(),
        abstract: abs,
      });
    }
  }
  return out;
}

function surnameFromOA(authorship) {
  const name = authorship?.author?.display_name || '';
  return lastWord(name).toLowerCase();
}
function lastWord(s) {
  const parts = String(s || '').trim().split(/\s+/);
  return parts[parts.length - 1] || '';
}

export { normDoi, MIN_ABSTRACT_LEN };
