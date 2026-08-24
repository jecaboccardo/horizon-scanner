/**
 * supabase/functions/_shared/rssSignals.ts
 *
 * Free RSS-based replacement for the Exa-powered Signals lane in the Follow
 * tab. Pulls a curated list of development-economics feeds and filters items
 * by date window + per-subscription text match.
 *
 * No API key, no cost. We tolerate individual feed failures via Promise.allSettled.
 *
 * FEED ROSTER AUDIT 2026-07-09: 10 of the original 11 feeds were dead (the
 * lane had silently become VoxDev-only). Dropped — RSS removed or bot-blocked
 * at the CDN (403 even with a browser UA, so a server fetch can never work):
 *   IADB blogs (moved to iadb.org/idb-blog, no feed), World Bank blogs (RSS
 *   removed in replatform), CGD + CEPR/VoxEU + ODI (Cloudflare 403; CEPR's
 *   generic rss.xml is stale since 2024), IMF blog + Brookings + IZA + ILO
 *   (RSS removed), 3ie (stale since 2019), J-PAL (stale since 2021).
 * Current roster below was verified alive + fresh on 2026-07-09. If a feed
 * rots, fetchFollowSignalsRss logs a per-run health summary — grep the deno-api
 * journal for "[rss] health".
 */

export type FollowSignalSource = "news" | "blog" | "x" | "other";

export interface FollowSignalItem {
  id: string;
  title: string;
  url: string | null;
  snippet: string | null;
  publishedDate: string | null;
  domain: string | null;
  author: string | null;
  profile: "buzz";
  sourceType: FollowSignalSource;
}

interface CuratedFeed {
  url: string;
  domain: string;
  // sourceType is "blog" for everything in v1; we keep the field so a future
  // expansion (e.g. RSS news outlets) can mix types into the same lane.
  sourceType: FollowSignalSource;
}

const CURATED_FEEDS: CuratedFeed[] = [
  // NOTE: every feed here must be verified FROM THE VPS, not a dev machine —
  // NBER (back.nber.org) and EconoFact serve residential IPs fine but 403/429
  // datacenter IPs, so they can never work in prod. All five below returned
  // 200 + fresh items from CT134 on 2026-07-09.
  // Research-into-policy columns, updated daily — the workhorse feed.
  { url: "https://voxdev.org/rss.xml", domain: "voxdev.org", sourceType: "blog" },
  // Innovations for Poverty Action — news + results announcements.
  { url: "https://poverty-action.org/rss.xml", domain: "poverty-action.org", sourceType: "blog" },
  // New general-economics working papers on arXiv (daily).
  { url: "https://rss.arxiv.org/rss/econ.GN", domain: "arxiv.org", sourceType: "blog" },
  // Our World in Data — data-driven explainers, frequently development-focused.
  { url: "https://ourworldindata.org/atom.xml", domain: "ourworldindata.org", sourceType: "blog" },
  // LSE International Development blog — active daily, strong dev-econ fit.
  { url: "https://blogs.lse.ac.uk/internationaldevelopment/feed/", domain: "blogs.lse.ac.uk", sourceType: "blog" },
];

// Some publishers bot-block generic fetchers; a browser-like UA keeps the
// currently-working roster maximally compatible.
const FEED_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function stripCData(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  return decodeEntities(stripCData(m[1])).trim();
}

function extractLink(block: string): string | null {
  // RSS 2.0: <link>https://…</link>
  const rss = extractTag(block, "link");
  if (rss && /^https?:/i.test(rss)) return rss;
  // Atom: <link href="…" />
  const atom = block.match(/<link[^>]*href="([^"]+)"/i);
  return atom ? atom[1] : null;
}

interface ParsedItem {
  title: string;
  link: string | null;
  description: string | null;
  pubDate: string | null;
  author: string | null;
}

function parseFeedXml(xml: string): ParsedItem[] {
  // RSS 2.0 first, then Atom.
  let blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (blocks.length === 0) {
    blocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
  }
  return blocks.map((block) => {
    const title = extractTag(block, "title") || "(untitled)";
    const link = extractLink(block);
    const desc =
      extractTag(block, "description") ||
      extractTag(block, "summary") ||
      extractTag(block, "content:encoded") ||
      extractTag(block, "content");
    const pubDate =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated") ||
      extractTag(block, "dc:date");
    const author =
      extractTag(block, "dc:creator") ||
      extractTag(block, "author") ||
      extractTag(block, "name");
    return {
      title: stripHtml(title).slice(0, 300),
      link,
      description: desc ? stripHtml(desc).slice(0, 500) : null,
      pubDate,
      author: author ? stripHtml(author).slice(0, 120) : null,
    };
  });
}

async function fetchOneFeed(
  feed: CuratedFeed,
): Promise<{ feed: CuratedFeed; items: ParsedItem[]; failure: string | null }> {
  try {
    const res = await fetch(feed.url, {
      method: "GET",
      headers: FEED_FETCH_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.warn(`[rss] ${feed.url} → HTTP ${res.status}`);
      return { feed, items: [], failure: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    const items = parseFeedXml(xml);
    // A 200 with zero parseable items is feed rot too (HTML error page, feed
    // emptied by a replatform) — surface it in the health summary.
    return { feed, items, failure: items.length === 0 ? "0 items" : null };
  } catch (err) {
    console.warn(`[rss] ${feed.url} fetch failed: ${(err as Error).message}`);
    return { feed, items: [], failure: (err as Error).message.slice(0, 80) };
  }
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .filter((t) => t.length >= 3);
}

function matchesSubscription(item: ParsedItem, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return true;
  const haystack = `${item.title} ${item.description ?? ""}`.toLowerCase();
  // Match if ANY token appears (OR-match — RSS feeds are pre-curated by topic
  // already, so we don't need strict AND-match like the corpus does).
  return queryTokens.some((t) => haystack.includes(t));
}

/**
 * Public entry point. Returns up to `limit` curated-blog items from the last
 * `windowDays` matching the subscription's text. Items already deduped by URL.
 */
export async function fetchFollowSignalsRss(
  query: string,
  { windowDays = 30, limit = 12 }: { windowDays?: number; limit?: number } = {},
): Promise<FollowSignalItem[]> {
  if (!query || !query.trim()) return [];

  const queryTokens = tokenize(query);
  const cutoffMs = Date.now() - Math.max(1, windowDays) * 24 * 60 * 60 * 1000;

  const results = await Promise.allSettled(CURATED_FEEDS.map(fetchOneFeed));
  const items: FollowSignalItem[] = [];
  const seenUrls = new Set<string>();

  // One-line health summary per run so feed rot is visible in the journal
  // (individually-failed feeds only warn, which nobody watches).
  const failures = results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((v) => v && v.failure)
    .map((v) => `${v!.feed.domain} (${v!.failure})`);
  console.log(
    `[rss] health: ${CURATED_FEEDS.length - failures.length}/${CURATED_FEEDS.length} feeds ok` +
      (failures.length ? ` — FAILING: ${failures.join(", ")}` : ""),
  );

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { feed, items: feedItems } = r.value;
    for (const it of feedItems) {
      if (!matchesSubscription(it, queryTokens)) continue;

      const ts = it.pubDate ? Date.parse(it.pubDate) : NaN;
      if (Number.isFinite(ts) && ts < cutoffMs) continue;
      // If pubDate missing, include but penalize ranking later.

      if (it.link && seenUrls.has(it.link)) continue;
      if (it.link) seenUrls.add(it.link);

      items.push({
        id: `rss:${feed.domain}:${it.link ?? it.title}`,
        title: it.title,
        url: it.link,
        snippet: it.description,
        publishedDate: it.pubDate ?? null,
        domain: feed.domain,
        author: it.author,
        profile: "buzz",
        sourceType: feed.sourceType,
      });
    }
  }

  // Sort by date desc; items with no date sink to the bottom.
  items.sort((a, b) => {
    const aT = a.publishedDate ? Date.parse(a.publishedDate) : 0;
    const bT = b.publishedDate ? Date.parse(b.publishedDate) : 0;
    return bT - aT;
  });

  return items.slice(0, limit);
}
