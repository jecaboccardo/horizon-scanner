/**
 * utils/selectionToPills.ts
 *
 * Pure function: selection state → Step-2 confirmation pills.
 *
 * Each pill corresponds to a real, non-default choice the user made that
 * FEEDS retrieval or synthesis. No cosmetic pills — if a pill appears, there
 * is a corresponding request field that carries it forward.
 *
 * Rules
 * -----
 * Channels (source 'channels'):
 *   One pill per channel present in the Set.
 *   causal → 'Causal'  |  foundational → 'Foundational'
 *   recent → 'Recent 2020+'  |  lac → 'LAC'
 *   The lac pill is the CHANNEL (always show when the channel is active).
 *
 * Region (source 'regions'):
 *   When filters.regions is non-empty → 'Region: <joined list>'.
 *
 * Population (source 'populationFocus'):
 *   One pill PER chip returned by normalizePopulationFocus, label = chip verbatim.
 *
 * Breadth (source 'evidenceMatch'):
 *   Only when evidenceMatch === 'direct' → 'On-topic only'.
 *   'both' is the default → NO pill.
 *   'all' is loose → 'All matches' pill.
 *
 * Sources (source 'sources'):
 *   Emitted only when the caller has explicitly set any of:
 *   journalTiers, institutionalSources, workingPaperSources, publicationTypes
 *   to a non-undefined value. A present (even empty) explicit list means the
 *   user changed source scope. No pill when all four are undefined (test case).
 *
 * No React. No side effects. Deterministic.
 */

import type { SearchFilters } from '../types.ts';
import { normalizePopulationFocus } from '../types.ts';
import { absBandLabel } from '../services/journalTiers.ts';

export interface SelectionPill {
  label: string;
  /** Names the request field this pill came from — guarantees every pill is real. */
  source: 'channels' | 'regions' | 'populationFocus' | 'evidenceMatch' | 'sources' | 'timePeriod';
}

const CHANNEL_LABELS: Record<string, string> = {
  causal:       'Causal',
  foundational: 'Foundational',
  recent:       'Recent 2020+',
  lac:          'LAC',
};

/**
 * Derive the confirmed-selection pills from the current filter state.
 *
 * @param filters  The SearchFilters object (partial — only checked fields matter).
 * @param channels The active Set<ChannelId> from the search-intent card Q1.
 */
export function selectionToPills(
  filters: Partial<SearchFilters>,
  channels: Set<string>,
): SelectionPill[] {
  const pills: SelectionPill[] = [];

  // ── 1. Channels ──────────────────────────────────────────────────────────
  for (const id of ['causal', 'foundational', 'recent', 'lac'] as const) {
    if (channels.has(id)) {
      pills.push({ label: CHANNEL_LABELS[id], source: 'channels' });
    }
  }

  // ── 1b. Time period (only non-default choices get a pill) ─────────────────
  if (filters.timePeriod === '2000+') {
    pills.push({ label: 'From 2000+', source: 'timePeriod' });
  }

  // ── 2. Region ─────────────────────────────────────────────────────────────
  if (filters.regions && filters.regions.length > 0) {
    pills.push({ label: `Region: ${filters.regions.join(', ')}`, source: 'regions' });
  }

  // ── 3. Population focus — single "Focus: …" pill (text-input UX)
  const popChips = normalizePopulationFocus(filters.populationFocus);
  if (popChips.length > 0) {
    const label = `Focus: ${popChips.slice(0, 2).join(' · ')}${popChips.length > 2 ? '…' : ''}`;
    pills.push({ label, source: 'populationFocus' });
  }

  // ── 4. Breadth / evidenceMatch ────────────────────────────────────────────
  //  'both' = semantic default → no pill
  //  'direct' → 'On-topic only'
  //  'all'    → 'All matches'
  if (filters.evidenceMatch === 'direct') {
    pills.push({ label: 'On-topic only', source: 'evidenceMatch' });
  } else if (filters.evidenceMatch === 'all') {
    pills.push({ label: 'All matches', source: 'evidenceMatch' });
  }

  // ── 5. Sources ────────────────────────────────────────────────────────────
  // Only emit when the user has explicitly customized any source dimension
  // (i.e. at least one of the four source fields is present / non-undefined).
  // An empty array [] IS a customization (user cleared all WP repos).
  const hasSourceCustomization =
    filters.journalTiers !== undefined ||
    filters.institutionalSources !== undefined ||
    filters.workingPaperSources !== undefined ||
    filters.publicationTypes !== undefined;

  if (hasSourceCustomization) {
    // Build a concise human label from whatever is set.
    const parts: string[] = [];
    if (filters.journalTiers && filters.journalTiers.length > 0) {
      // tier 1 = ABS 4★ … tier 4 = ABS 1–2, so the raw number is NOT the ABS rating.
      // absBandLabel maps correctly (e.g. [1,2,3] → "ABS 3+"), fixing the old
      // "ABS 1/2/3★" mislabel.
      parts.push(absBandLabel(filters.journalTiers));
    }
    if (filters.publicationTypes && filters.publicationTypes.length > 0) {
      parts.push(filters.publicationTypes.slice(0, 2).join(', '));
    }
    if (filters.institutionalSources && filters.institutionalSources.length > 0) {
      parts.push(filters.institutionalSources.slice(0, 2).join(', '));
    }
    if (filters.workingPaperSources && filters.workingPaperSources.length > 0) {
      parts.push(filters.workingPaperSources.slice(0, 2).join(', '));
    }
    const label = parts.length > 0 ? `Sources: ${parts.join(' · ')}` : 'Sources: custom';
    pills.push({ label, source: 'sources' });
  }

  return pills;
}
