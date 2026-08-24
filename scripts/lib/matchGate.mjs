/**
 * Strict same-paper match gate for TITLE/AUTHOR-keyed abstract lookups (no DOI).
 *
 * A candidate is accepted ONLY if ALL hold (HARD RULE 2):
 *   - normalized-title similarity >= 0.92
 *   - |year - candidateYear| <= 1   (skipped if either year is null)
 *   - first-author surname match    (skipped only if our paper has no authors)
 *
 * Same discipline as the dedup author-check (feedback_dedup_author_check):
 * never accept a similar-but-different paper's abstract.
 */

export function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Dice coefficient over word bigrams — robust for title comparison.
function bigrams(s) {
  const words = s.split(' ').filter(Boolean);
  const grams = new Set();
  for (let i = 0; i < words.length - 1; i++) grams.add(words[i] + ' ' + words[i + 1]);
  if (words.length === 1) grams.add(words[0]);
  return grams;
}

export function titleSimilarity(a, b) {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ga = bigrams(na), gb = bigrams(nb);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

export function firstAuthorSurname(authors) {
  // authors stored as string[] of "First Last" or "Last, First".
  if (!Array.isArray(authors) || authors.length === 0) return null;
  const a = String(authors[0] || '').trim();
  if (!a) return null;
  if (a.includes(',')) return a.split(',')[0].trim().toLowerCase(); // "Last, First"
  const parts = a.split(/\s+/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

const TITLE_THRESHOLD = 0.92;

/**
 * @param paper   { title, year, authors }      our DB row
 * @param cand    { title, year, firstAuthorSurname, abstract }  external candidate
 * @returns { ok, sim, reason }
 */
export function passesGate(paper, cand) {
  const sim = titleSimilarity(paper.title, cand.title);
  if (sim < TITLE_THRESHOLD) return { ok: false, sim, reason: `title sim ${sim.toFixed(3)} < ${TITLE_THRESHOLD}` };

  if (paper.year != null && cand.year != null && Math.abs(paper.year - cand.year) > 1) {
    return { ok: false, sim, reason: `year ${paper.year} vs ${cand.year} > 1` };
  }

  const ourSurname = firstAuthorSurname(paper.authors);
  if (ourSurname) {
    const theirs = (cand.firstAuthorSurname || '').toLowerCase();
    if (!theirs) return { ok: false, sim, reason: 'candidate has no first-author surname' };
    // Accept exact or one contains the other (handles "van der X" / hyphenation).
    if (theirs !== ourSurname && !theirs.includes(ourSurname) && !ourSurname.includes(theirs)) {
      return { ok: false, sim, reason: `surname "${ourSurname}" vs "${theirs}"` };
    }
  }
  return { ok: true, sim, reason: 'pass' };
}

export { TITLE_THRESHOLD };
