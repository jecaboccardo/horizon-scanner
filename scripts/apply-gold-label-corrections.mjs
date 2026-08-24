/**
 * apply-gold-label-corrections.mjs
 *
 * Parse the user-edited "Gold Eval Label Review — 2026-05-12.txt" (which
 * carries Jess's manual relevant/partial/irrelevant labels for q04-q23,
 * 20 papers each = 400 labels) and merge them into evals/queries.json.
 *
 * Cross-references against reports/label-review-2026-05-12.json to map
 * (query, rank N) → DOI + title.
 *
 * Idempotent: re-running overwrites only the labels that come from the
 * corrections file. Labels already present in queries.json for q01-q03
 * are untouched.
 *
 * Usage:
 *   node scripts/apply-gold-label-corrections.mjs          # apply
 *   node scripts/apply-gold-label-corrections.mjs --dry    # show diff only
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const TXT_PATH = join(__dir, '..', 'Gold Eval Label Review — 2026-05-12.txt');
const REVIEW_JSON_PATH = join(__dir, '..', 'reports', 'label-review-2026-05-12.json');
const QUERIES_JSON_PATH = join(__dir, '..', 'evals', 'queries.json');

const DRY = process.argv.includes('--dry');

function parseLabels(text) {
  const lines = text.split(/\r?\n/);
  const byQuery = new Map();
  let currentQuery = null;
  let currentRank = null;
  for (const line of lines) {
    const mq = line.match(/^##\s+(q\d{2}-[a-z0-9-]+)\s*$/i);
    if (mq) { currentQuery = mq[1]; if (!byQuery.has(currentQuery)) byQuery.set(currentQuery, new Map()); continue; }
    const mr = line.match(/^###\s+Rank\s+(\d+):\s*(.*)$/i);
    if (mr) { currentRank = parseInt(mr[1], 10); continue; }
    if (!currentQuery || currentRank == null) continue;
    // Match "[x] relevant", "[X ] partial", "[ X] irrelevant" — any whitespace around x
    const lm = line.match(/-\s*\*\*LABEL:\*\*(.*)$/i);
    if (!lm) continue;
    const labelLine = lm[1];
    const hits = [];
    for (const m of labelLine.matchAll(/\[\s*([xX]?)\s*\]\s*(relevant|partial|irrelevant)/gi)) {
      if (m[1].toLowerCase() === 'x') hits.push(m[2].toLowerCase());
    }
    if (hits.length === 0) continue;     // user left blank → skip
    if (hits.length > 1)  continue;       // user marked multiple → ambiguous, skip
    byQuery.get(currentQuery).set(currentRank, hits[0]);
    currentRank = null;
  }
  return byQuery;
}

function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }

function main() {
  const txt = readFileSync(TXT_PATH, 'utf8');
  const labelsByRank = parseLabels(txt);

  const reviewJson = JSON.parse(readFileSync(REVIEW_JSON_PATH, 'utf8'));
  const rankToPaperByQuery = new Map(
    reviewJson.map(q => [q.id, new Map(q.papers.map(p => [p.rank, p]))])
  );

  // Build (queryId → { rank → { doi, title, label } })
  const correctionsByQuery = new Map();
  let totalLabels = 0, ambiguous = 0, unmatched = 0;
  for (const [qid, ranksMap] of labelsByRank.entries()) {
    const rankPapers = rankToPaperByQuery.get(qid);
    if (!rankPapers) { console.warn(`No retrieval data for ${qid}, skipping`); continue; }
    const out = new Map();
    for (const [rank, label] of ranksMap.entries()) {
      const paper = rankPapers.get(rank);
      if (!paper || !paper.doi) { unmatched++; continue; }
      out.set(rank, { doi: normDoi(paper.doi), title: paper.title, year: paper.year, label });
      totalLabels++;
    }
    correctionsByQuery.set(qid, out);
  }

  // Merge into queries.json
  const evals = JSON.parse(readFileSync(QUERIES_JSON_PATH, 'utf8'));
  let updated = 0, addedQueries = 0;

  for (const q of evals.queries) {
    const corrections = correctionsByQuery.get(q.id);
    if (!corrections || corrections.size === 0) continue;

    const newLabels = q.labels ? { ...q.labels } : {};
    const seenDois = new Set();
    let queryChanged = false;
    for (const [rank, entry] of corrections.entries()) {
      const slot = String(rank);
      const existing = newLabels[slot];
      if (existing && existing.doi && normDoi(existing.doi) === entry.doi && existing.label === entry.label) continue;
      newLabels[slot] = { ...(existing ?? {}), doi: entry.doi, title: entry.title, label: entry.label };
      queryChanged = true;
      updated++;
      seenDois.add(entry.doi);
    }
    if (queryChanged) {
      q.labels = newLabels;
      q.labeled_at = '2026-05-12';
      addedQueries++;
    }
  }

  console.log(`Parsed ${totalLabels} labels from corrections file (${unmatched} unmatched to retrieval).`);
  console.log(`Updated ${updated} label slots across ${addedQueries} queries.`);

  if (DRY) {
    console.log('\n--dry mode, no write. Sample of new labels for q04:');
    const q4 = evals.queries.find(q => q.id.startsWith('q04'));
    if (q4) {
      for (const [k, v] of Object.entries(q4.labels ?? {}).slice(0, 5)) {
        console.log(`  rank ${k}: ${v.label.padEnd(10)} ${(v.title ?? '').slice(0, 65)}`);
      }
    }
    return;
  }

  writeFileSync(QUERIES_JSON_PATH, JSON.stringify(evals, null, 2));
  console.log(`Wrote ${QUERIES_JSON_PATH}`);
}

main();
