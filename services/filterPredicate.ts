/**
 * Unified filter predicate — single source of truth for which works pass the
 * user's current filter chips on the frontend.
 *
 * Before this lived in `BriefView.tsx:passesQualityFilters` and only checked
 * smsLevels / absRatings / repecBands / publicationTypes. Backend
 * `retrieval.ts:passesQualityFilters` checked five additional dimensions
 * (journalTiers, excludedJournalsByTier, workingPaperSources,
 * institutionalSources, year range) that the frontend never re-applied —
 * so toggling a Source / Years filter chip post-search did nothing to the
 * table. See the 2026-05-21 audit for details.
 *
 * This module mirrors the backend's source/tier/year logic verbatim so the
 * predicate result agrees with what retrieval.ts would have done. The lookup
 * tables (WP hints/families, institutional hints/families) are duplicated
 * from `retrieval.ts:73-107` — keep in sync if either side changes.
 *
 * Skipped dimensions (intentionally, no current UI):
 *   - regions          → `RegionPicker.tsx` exists but isn't mounted in App.tsx
 *   - evidenceMatch    → set at search-time via EvidenceScope, not a post-filter
 *   - topics           → no picker
 */

import type { EvidenceRow, SearchFilters, Work } from '../types';
import { getTierForVenue, JournalTier } from './journalTiers';

const NORMALIZE_VENUE = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

const WORKING_PAPER_HINTS: Record<string, string[]> = {
  NBER: ['nber', 'national bureau of economic research'],
  SSRN: ['ssrn'],
  OECD_WP: ['oecd'],
  WB_WP: ['policy research working paper', 'world bank working paper', 'world bank discussion paper'],
  IZA: ['iza'],
  CEPR_REPEC: ['cepr', 'repec', 'ideas', 'econpapers'],
  RePEc: ['repec', 'ideas', 'econpapers'],
};

const WORKING_PAPER_SOURCE_FAMILIES: Record<string, string[]> = {
  NBER: ['NBER'],
  SSRN: ['SSRN'],
  OECD_WP: ['OECD'],
  WB_WP: ['World Bank'],
  IZA: ['IZA'],
  CEPR_REPEC: ['CEPR', 'RePEc'],
  RePEc: ['RePEc'],
};

const INSTITUTIONAL_HINTS: Record<string, string[]> = {
  IADB: ['iadb', 'inter-american development bank', 'publications.iadb', 'idb publications', 'idb working paper'],
  WB: ['world bank', 'open knowledge repository', 'worldbank.org', 'the world bank economic review', 'the world bank research observer'],
  OECD: ['oecd'],
  OTHER: ['cepal', 'eclac', 'unesco', 'unicef', 'ilo', 'imf', 'undp'],
};

const INSTITUTIONAL_SOURCE_FAMILIES: Record<string, string[]> = {
  IADB: ['IADB'],
  WB: ['World Bank'],
  OECD: ['OECD'],
  OTHER: ['ECLAC', 'UNESCO', 'UNICEF', 'ILO', 'IMF', 'UNDP'],
};

const matchesAnyHint = (haystack: string, hints: string[]): boolean => {
  if (!haystack) return false;
  return hints.some((h) => haystack.includes(h));
};

function matchesWorkingPaperSource(work: Work, sourceId: string): boolean {
  const families = WORKING_PAPER_SOURCE_FAMILIES[sourceId] ?? [];
  if (families.length > 0 && families.includes(String(work.sourceFamily ?? ''))) {
    return true;
  }
  const haystack = `${work.venue ?? ''} ${work.source ?? ''} ${work.url ?? ''}`.toLowerCase();
  if (!haystack) return false;

  // CEPR/RePEc has a stricter check on the backend: exclude papers that
  // belong to other named WP sources (NBER, SSRN, etc.) so the bucket isn't
  // a catch-all. Mirror the same logic.
  if (sourceId === 'CEPR_REPEC') {
    if (haystack.includes('cepr')) return true;
    const isRepec =
      String(work.source ?? '').toLowerCase() === 'repec' ||
      haystack.includes('ideas.repec.org') ||
      haystack.includes('econpapers.repec.org');
    if (!isRepec) return false;
    const namedElsewhere = ['nber', 'ssrn', 'iza', 'oecd', 'world bank'];
    return !namedElsewhere.some((n) => haystack.includes(n));
  }

  return matchesAnyHint(haystack, WORKING_PAPER_HINTS[sourceId] ?? []);
}

interface PredicateContext {
  /** Inclusive lower bound on publication year. */
  yearStart?: number | null;
  /** Inclusive upper bound on publication year. */
  yearEnd?: number | null;
}

/**
 * Returns a predicate `(work, row?) => boolean` that returns true iff the
 * work passes every active filter dimension. Empty arrays mean "no filter."
 *
 * The `row` argument is optional — used only for SMS level lookup
 * (`row.smsLevel` takes precedence over `work.smsLevel` because the brief's
 * evidenceRows can carry a refined SMS that the work hasn't been updated to).
 */
export function buildFilterPredicate(
  filters: SearchFilters,
  ctx: PredicateContext = {},
): (work: Work | undefined, row?: EvidenceRow) => boolean {
  const { yearStart, yearEnd } = ctx;

  // Pre-compute which dimensions are active so the predicate doesn't do
  // useless work per-row.
  const smsActive = !!(filters.smsLevels && filters.smsLevels.length > 0 && filters.smsLevels.length < 6);
  const absActive = !!(filters.absRatings && filters.absRatings.length > 0 && filters.absRatings.length < 5);
  const repecActive = !!(filters.repecBands && filters.repecBands.length > 0);
  const pubActive = !!(filters.publicationTypes && filters.publicationTypes.length > 0 && filters.publicationTypes.length < 11);
  const wpActive = !!(filters.workingPaperSources && filters.workingPaperSources.length > 0);
  const instActive = !!(filters.institutionalSources && filters.institutionalSources.length > 0);
  const tiersActive = !!(filters.journalTiers && filters.journalTiers.length > 0 && filters.journalTiers.length < 5);
  const sourceGateActive = wpActive || instActive || tiersActive;
  const yearActive = yearStart != null || yearEnd != null;

  return (work, row) => {
    // ── Year filter ─────────────────────────────────────────────────────
    // Papers with no year pass (no signal to exclude). Mirror backend
    // retrieval.ts:1924-1930.
    if (yearActive) {
      const y = work?.year ?? (row?.year as number | null | undefined);
      if (y != null && Number.isFinite(Number(y))) {
        const n = Number(y);
        if (yearStart != null && n < yearStart) return false;
        if (yearEnd != null && n > yearEnd) return false;
      }
    }

    // ── SMS filter ──────────────────────────────────────────────────────
    // row.smsLevel takes precedence over work.smsLevel.
    const smsLevel = row?.smsLevel ?? work?.smsLevel ?? null;
    if (smsActive && smsLevel != null && !filters.smsLevels.includes(smsLevel)) return false;

    // From here on we need a work object; undefined works pass the rest.
    if (!work) return true;

    // ── ABS / RePEc / Publication-type ──────────────────────────────────
    if (absActive && work.absRating != null && !filters.absRatings.includes(work.absRating)) return false;
    if (repecActive && work.repecPercentile != null) {
      const band = percentileToBand(work.repecPercentile);
      if (!filters.repecBands.includes(band)) return false;
    }
    if (pubActive && work.publicationType != null && !filters.publicationTypes!.includes(work.publicationType)) return false;

    // ── Source / Tier gate (OR-combined across journals + WP + inst) ────
    // Mirror backend retrieval.ts:1957-1996. A paper passes if it matches
    // ANY of the selected source buckets.
    if (sourceGateActive) {
      const haystack = `${work.venue ?? ''} ${work.source ?? ''}`.toLowerCase();
      let matched = false;

      if (tiersActive) {
        const tier = getTierForVenue(work.venue ?? null) as JournalTier;
        if (filters.journalTiers!.includes(tier)) {
          const excluded = work.venue && filters.excludedJournalsByTier?.[String(tier)];
          if (!excluded || !excluded.some((j: string) => NORMALIZE_VENUE(j) === NORMALIZE_VENUE(work.venue!))) {
            matched = true;
          }
        }
      }

      if (!matched && wpActive) {
        if (filters.workingPaperSources!.some((id) => matchesWorkingPaperSource(work, id))) matched = true;
      }

      if (!matched && instActive) {
        const family = String(work.sourceFamily ?? '');
        if (filters.institutionalSources!.some((id) => (INSTITUTIONAL_SOURCE_FAMILIES[id] ?? []).includes(family))) {
          matched = true;
        }
      }

      if (!matched && instActive) {
        const allHints = filters.institutionalSources!.flatMap((id) => INSTITUTIONAL_HINTS[id] ?? []);
        if (matchesAnyHint(haystack, allHints)) matched = true;
      }

      if (!matched) return false;
    }

    return true;
  };
}

/**
 * Resolve `filters.timePeriod` + `startDate` / `endDate` into numeric
 * year bounds suitable for `buildFilterPredicate`. Mirrors backend
 * retrieval.ts year-resolution logic so the table and backend agree.
 */
export function resolveYearBounds(filters: SearchFilters): { yearStart: number | null; yearEnd: number | null } {
  if (filters.timePeriod === 'custom') {
    const start = filters.startDate ? Number(String(filters.startDate).slice(0, 4)) : null;
    const end = filters.endDate ? Number(String(filters.endDate).slice(0, 4)) : null;
    return {
      yearStart: Number.isFinite(start as number) ? (start as number) : null,
      yearEnd: Number.isFinite(end as number) ? (end as number) : null,
    };
  }
  if (filters.timePeriod === 'recent') {
    const now = new Date().getUTCFullYear();
    return { yearStart: now - 4, yearEnd: null };
  }
  return { yearStart: null, yearEnd: null };
}

function percentileToBand(percentile: number): 'top_5' | 'top_5_10' | 'top_10_25' | 'top_25_50' | 'bottom_50' {
  if (percentile >= 95) return 'top_5';
  if (percentile >= 90) return 'top_5_10';
  if (percentile >= 75) return 'top_10_25';
  if (percentile >= 50) return 'top_25_50';
  return 'bottom_50';
}
