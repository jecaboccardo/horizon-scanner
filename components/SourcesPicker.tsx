import React, { useEffect, useRef, useState } from 'react';
import { getAllTiers, JournalTier } from '../services/journalTiers';

const WORKING_PAPER_SOURCES = [
  { id: 'NBER',     label: 'NBER (National Bureau of Economic Research)', count: 18836 },
  { id: 'SSRN',     label: 'SSRN Electronic Journal',                     count: 2910 },
  { id: 'OECD_WP',  label: 'OECD Economics Department working papers',    count: 1047 },
  { id: 'WB_WP',    label: 'World Bank Policy Research Working Paper',    count: 394 },
  { id: 'IZA',      label: 'IZA Discussion Papers',                       count: 93 },
  { id: 'CEPR_REPEC', label: 'CEPR / Other RePEc-indexed working papers', count: 1950 },
] as const;

const INSTITUTIONAL_SOURCES = [
  { id: 'IADB',  label: 'IADB Publications',                count: 12880 },
  { id: 'WB',    label: 'World Bank', count: 3374 },
  { id: 'OECD',  label: 'OECD',                              count: 1400 },
  { id: 'OTHER', label: 'CEPAL · UNESCO · UNICEF',           count: null },
];

// Merged grouping for the "Institutional" picker chip. `bucket` indicates
// which underlying SearchFilters array each checkbox writes to — backend
// retrieval still reads `workingPaperSources` and `institutionalSources`
// as separate fields, but the user-facing UI shows all 9 sources together
// under three semantic categories.
type InstCategory = 'multilateral' | 'working_paper' | 'research_bureau';
type InstBucket = 'wp' | 'inst';

interface InstMember {
  id: string;
  bucket: InstBucket;
}

interface InstSourceRow {
  rowId: string;
  label: string;
  count: number | null;
  category: InstCategory;
  // One row can fan out to multiple underlying IDs across both backend
  // arrays — used to merge e.g. WB Open Knowledge + WB working papers into
  // a single "World Bank" row.
  members: InstMember[];
}

const ALL_INSTITUTIONAL_SOURCES: InstSourceRow[] = [
  // Multilateral institutions (publish a mix of reports + WPs + briefs).
  // WB and OECD are merged: one row toggles both the institutional source
  // and its working-paper sibling, so the user picks "World Bank" as one
  // organization regardless of document type.
  { rowId: 'IADB',  label: 'IADB Publications', count: 12880, category: 'multilateral',
    members: [{ id: 'IADB', bucket: 'inst' }] },
  { rowId: 'WB',    label: 'World Bank',        count: 3374,  category: 'multilateral',
    members: [
      { id: 'WB',    bucket: 'inst' },
      { id: 'WB_WP', bucket: 'wp'   },
    ] },
  { rowId: 'OECD',  label: 'OECD',              count: 2447,  category: 'multilateral',
    members: [
      { id: 'OECD',    bucket: 'inst' },
      { id: 'OECD_WP', bucket: 'wp'   },
    ] },
  { rowId: 'OTHER', label: 'CEPAL · UNESCO · UNICEF', count: null, category: 'multilateral',
    members: [{ id: 'OTHER', bucket: 'inst' }] },
  // Working paper repositories / aggregators
  { rowId: 'SSRN',  label: 'SSRN Electronic Journal', count: 2910, category: 'working_paper',
    members: [{ id: 'SSRN', bucket: 'wp' }] },
  { rowId: 'IZA', label: 'IZA Discussion Papers', count: 93, category: 'working_paper',
    members: [{ id: 'IZA', bucket: 'wp' }] },
  { rowId: 'CEPR_REPEC', label: 'CEPR / Other RePEc-indexed working papers', count: 1950, category: 'working_paper',
    members: [{ id: 'CEPR_REPEC', bucket: 'wp' }] },
  // Research bureaus
  { rowId: 'NBER',  label: 'NBER (National Bureau of Economic Research)', count: 18836, category: 'research_bureau',
    members: [{ id: 'NBER', bucket: 'wp' }] },
];

// Row is "checked" when any of its underlying member IDs is selected in
// the matching backend array. Toggling on adds all members; toggling off
// removes all members.
function rowIsSelected(
  row: InstSourceRow,
  wp: WorkingPaperSourceId[],
  inst: InstitutionalSourceId[],
): boolean {
  return row.members.some((m) =>
    m.bucket === 'wp'
      ? wp.includes(m.id as WorkingPaperSourceId)
      : inst.includes(m.id as InstitutionalSourceId),
  );
}

const INST_CATEGORY_LABELS: Record<InstCategory, string> = {
  multilateral:     'Multilateral institutions',
  working_paper:    'Working paper repositories',
  research_bureau:  'Research bureaus',
};

export type WorkingPaperSourceId = typeof WORKING_PAPER_SOURCES[number]['id'];
export type InstitutionalSourceId = (typeof INSTITUTIONAL_SOURCES)[number]['id'];

export interface SourcesSelection {
  tiers: JournalTier[];
  excludedJournalsByTier: Partial<Record<JournalTier, string[]>>;
  workingPaperSources: WorkingPaperSourceId[];
  institutionalSources: InstitutionalSourceId[];
}

export const DEFAULT_SOURCES_SELECTION: SourcesSelection = {
  tiers: [1, 2, 3],
  excludedJournalsByTier: {},
  // Reconciled 2026-06-12 with App.tsx defaultFilters + SourcesQuestion DEFAULT_*
  // (the 2026-06-11 source restructure). IMF is a clarifier-only institutional
  // source (~0 corpus coverage here) and is intentionally not modeled by this
  // legacy picker, so the institutional default is the 3 sources it does model.
  workingPaperSources: ['NBER', 'IZA', 'CEPR_REPEC', 'SSRN'],
  institutionalSources: ['IADB', 'WB', 'OECD'],
};

interface SourcesPickerProps {
  value: SourcesSelection;
  onChange: (next: SourcesSelection) => void;
  onClose: () => void;
  // When set, only that section renders (presets and the other sections are hidden).
  // 'all' (default) renders everything for the legacy combined picker.
  mode?: SourcesPickerMode;
}

const SUMMARY_FOR = (s: SourcesSelection): string => {
  const parts: string[] = [];
  if (s.tiers.length === 0) parts.push('No journals');
  else if (s.tiers.length === 5) parts.push('All journals');
  else parts.push(summariseJournals(s.tiers));
  if (s.workingPaperSources.length > 0) parts.push('WP');
  if (s.institutionalSources.length > 0) parts.push(s.institutionalSources.includes('IADB') ? 'IADB' : 'Inst');
  return parts.join(' · ');
};

export const summariseSources = SUMMARY_FOR;

// Per-section summaries for when each is its own top-bar chip.
export const summariseJournals = (tiers: JournalTier[]): string => {
  if (tiers.length === 0) return 'None';
  if (tiers.length === 5) return 'All journals';
  // Describe the tier selection in human terms (not ABS codes)
  const has = (t: JournalTier) => tiers.includes(t);
  if (has(1) && has(2) && has(3) && !has(4) && !has(5)) return 'Top journals';     // default
  if (has(1) && has(2) && !has(3)) return 'Elite journals only';
  if (!has(1) && !has(2) && has(3)) return 'Strong journals';
  if (has(1) && has(2) && has(3) && has(4)) return 'Top + wider journals';
  const parts: string[] = [];
  if (has(1) || has(2)) parts.push('Top');
  if (has(3)) parts.push('Strong');
  if (has(4)) parts.push('Wider');
  if (has(5)) parts.push('Unranked');
  return parts.join(' + ');
};

export const summariseWorkingPapers = (selected: WorkingPaperSourceId[]): string => {
  if (selected.length === 0) return 'None';
  if (selected.length === WORKING_PAPER_SOURCES.length) return 'All';
  const labels: Partial<Record<WorkingPaperSourceId, string>> = {
    CEPR_REPEC: 'CEPR/RePEc',
  };
  if (selected.length <= 2) return selected.map((id) => labels[id] ?? id).join('+');
  return `${selected.length} sources`;
};

export const summariseInstitutional = (selected: InstitutionalSourceId[]): string => {
  if (selected.length === 0) return 'None';
  if (selected.length === INSTITUTIONAL_SOURCES.length) return 'All';
  if (selected.length <= 2) return selected.join('+');
  return `${selected.length} sources`;
};

// Combined summary for the merged Institutional chip — counts selected
// ROWS (not raw IDs), so a fully-checked "World Bank" row (which spans 2
// underlying IDs) reads as 1 selected, not 2.
export const summariseInstitutionalAll = (
  wp: WorkingPaperSourceId[],
  inst: InstitutionalSourceId[],
): string => {
  const selected = ALL_INSTITUTIONAL_SOURCES.filter((r) => rowIsSelected(r, wp, inst));
  if (selected.length === 0) return 'None';
  if (selected.length === ALL_INSTITUTIONAL_SOURCES.length) return 'All';
  const rowIds = selected.map((r) => r.rowId);
  if (
    rowIds.length === 3 &&
    ['IADB', 'NBER', 'SSRN'].every((id) => rowIds.includes(id))
  ) {
    return 'IADB + NBER/SSRN';
  }
  if (selected.length === 1) return selected[0].rowId;
  if (selected.length <= 4) return selected.map((r) => r.rowId).join('+');
  return `${selected.length} sources`;
};

export type SourcesPickerMode = 'all' | 'journals' | 'working-papers' | 'institutional';

const JOURNAL_SCOPE_GROUPS: Array<{
  id: string;
  label: string;
  description: string;
  tiers: JournalTier[];
}> = [
  {
    id: 'abs4',
    label: 'ABS 4*/4',
    description: 'Highest-ranked journals in the curated ABS scope.',
    tiers: [1, 2],
  },
  {
    id: 'abs3',
    label: 'ABS 3',
    description: 'Strong mainstream journals; recommended in the default academic scan.',
    tiers: [3],
  },
  {
    id: 'field_lac',
    label: 'ABS 2/1 + field-specific/LAC',
    description: 'Optional widening tier for local, emerging, or thinner topics.',
    tiers: [4],
  },
  {
    id: 'unranked',
    label: 'Unranked / unmapped indexed venues',
    description: 'Fallback only; still subject to venue screening elsewhere.',
    tiers: [5],
  },
];

export const SourcesPicker: React.FC<SourcesPickerProps> = ({ value, onChange, onClose, mode = 'all' }) => {
  const tiers = getAllTiers();
  const [drillGroupId, setDrillGroupId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const showJournals = mode === 'all' || mode === 'journals';
  const showWorkingPapers = mode === 'all' || mode === 'working-papers';
  const showInstitutional = mode === 'all' || mode === 'institutional';
  const showPresets = mode === 'all';

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const toggleTier = (t: JournalTier) => {
    const next = value.tiers.includes(t) ? value.tiers.filter((x) => x !== t) : [...value.tiers, t];
    onChange({ ...value, tiers: next });
  };

  const toggleTierGroup = (groupTiers: JournalTier[]) => {
    const allSelected = groupTiers.every((tier) => value.tiers.includes(tier));
    const next = allSelected
      ? value.tiers.filter((tier) => !groupTiers.includes(tier))
      : Array.from(new Set([...value.tiers, ...groupTiers]));
    onChange({ ...value, tiers: next });
  };

  const toggleWP = (id: WorkingPaperSourceId) => {
    const next = value.workingPaperSources.includes(id)
      ? value.workingPaperSources.filter((x) => x !== id)
      : [...value.workingPaperSources, id];
    onChange({ ...value, workingPaperSources: next });
  };

  const toggleInst = (id: InstitutionalSourceId) => {
    const next = value.institutionalSources.includes(id)
      ? value.institutionalSources.filter((x) => x !== id)
      : [...value.institutionalSources, id];
    onChange({ ...value, institutionalSources: next });
  };

  const toggleExcludedJournal = (tier: JournalTier, journal: string) => {
    const current = value.excludedJournalsByTier[tier] ?? [];
    const next = current.includes(journal)
      ? current.filter((j) => j !== journal)
      : [...current, journal];
    onChange({
      ...value,
      excludedJournalsByTier: { ...value.excludedJournalsByTier, [tier]: next },
    });
  };

  const applyPreset = (preset: 'credible' | 'top' | 'iadb-wb' | 'all') => {
    if (preset === 'credible') {
      onChange({
        tiers: [1, 2, 3],
        excludedJournalsByTier: {},
        workingPaperSources: ['NBER', 'IZA', 'CEPR_REPEC', 'SSRN'],
        institutionalSources: ['IADB', 'WB', 'OECD'],
      });
    } else if (preset === 'top') {
      onChange({
        tiers: [1, 2, 3],
        excludedJournalsByTier: {},
        workingPaperSources: [],
        institutionalSources: [],
      });
    } else if (preset === 'iadb-wb') {
      onChange({
        tiers: [],
        excludedJournalsByTier: {},
        workingPaperSources: [],
        institutionalSources: ['IADB', 'WB'],
      });
    } else if (preset === 'all') {
      onChange({
        tiers: [1, 2, 3, 4, 5],
        excludedJournalsByTier: {},
        workingPaperSources: ['NBER', 'SSRN', 'OECD_WP', 'WB_WP', 'IZA', 'CEPR_REPEC'],
        institutionalSources: ['IADB', 'WB', 'OECD', 'OTHER'],
      });
    }
  };

  const drillGroup = drillGroupId ? JOURNAL_SCOPE_GROUPS.find((group) => group.id === drillGroupId) : null;
  const drillJournalRows = drillGroup
    ? drillGroup.tiers.flatMap((tier) => {
        const tierData = tiers.find((t) => t.tier === tier);
        return (tierData?.journals ?? []).map((journal) => ({ tier, journal }));
      })
    : [];

  const popoverWidth = mode === 'all' ? 'w-[600px]' : 'w-[480px]';

  return (
    <div
      ref={ref}
      className={`absolute top-full left-0 mt-2 ${popoverWidth} bg-white border border-slate-200 rounded-2xl shadow-xl p-5 z-50`}
      onClick={(e) => e.stopPropagation()}
    >
      {!drillGroup && (
        <>
          {showJournals && (<>
          <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-3">Top journals</h4>
          <div className="space-y-1">
            {JOURNAL_SCOPE_GROUPS.map((group) => {
              const checked = group.tiers.every((tier) => value.tiers.includes(tier));
              const someChecked = group.tiers.some((tier) => value.tiers.includes(tier));
              const sample = group.tiers
                .flatMap((tier) => tiers.find((t) => t.tier === tier)?.journals ?? [])
                .slice(0, 4)
                .join(' · ');
              return (
                <div key={group.id}>
                  <div
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-100 cursor-pointer"
                    onClick={() => setDrillGroupId(group.id)}
                    title={group.description}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      ref={(el) => {
                        if (el) el.indeterminate = !checked && someChecked;
                      }}
                      onChange={() => toggleTierGroup(group.tiers)}
                      onClick={(e) => e.stopPropagation()}
                      className="accent-teal-600"
                    />
                    <span className="text-sm text-slate-900 flex-1">{group.label}</span>
                    <span className="text-xs text-slate-500">Details</span>
                    <span className="text-slate-400 text-xs">›</span>
                  </div>
                  {sample && (
                    <div className="pl-9 text-xs text-slate-500 italic mb-1">{sample} ...</div>
                  )}
                  <div className="pl-9 text-xs text-slate-500 mb-1">{group.description}</div>
                </div>
              );
            })}
          </div>
          </>)}

          {showWorkingPapers && (<>
          <div className={showJournals ? "mt-4 pt-4 border-t border-slate-200" : ""}>
            <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-3">📄 Working papers</h4>
            {WORKING_PAPER_SOURCES.map((s) => (
              <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-100 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value.workingPaperSources.includes(s.id)}
                  onChange={() => toggleWP(s.id)}
                  className="accent-teal-600"
                />
                <span className="text-sm text-slate-900 flex-1">{s.label}</span>
                <span className="text-xs text-slate-500 tabular-nums">{s.count.toLocaleString()}</span>
              </label>
            ))}
          </div>
          </>)}

          {showInstitutional && (<>
          <div className={showJournals || showWorkingPapers ? "mt-4 pt-4 border-t border-slate-200" : ""}>
            <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-3">🏛 Institutional</h4>
            {/* Bounded-height scroll for smaller viewports — even with 7 rows
                across 3 sub-headers the picker should never overflow the
                viewport. 60vh leaves room for chrome + Done button. */}
            <div className="max-h-[60vh] overflow-y-auto pr-1">
              {(['multilateral', 'working_paper', 'research_bureau'] as InstCategory[]).map((cat, catIdx) => {
                const rows = ALL_INSTITUTIONAL_SOURCES.filter((s) => s.category === cat);
                if (rows.length === 0) return null;
                return (
                  <div key={cat} className={catIdx > 0 ? 'mt-3 pt-3 border-t border-slate-100' : ''}>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 px-2">
                      {INST_CATEGORY_LABELS[cat]}
                    </div>
                    {rows.map((row) => {
                      const checked = rowIsSelected(row, value.workingPaperSources, value.institutionalSources);
                      const onToggle = () => {
                        if (checked) {
                          // Remove every member of this row from its bucket.
                          const nextWp = value.workingPaperSources.filter(
                            (id) => !row.members.some((m) => m.bucket === 'wp' && m.id === id),
                          );
                          const nextInst = value.institutionalSources.filter(
                            (id) => !row.members.some((m) => m.bucket === 'inst' && m.id === id),
                          );
                          onChange({ ...value, workingPaperSources: nextWp, institutionalSources: nextInst });
                        } else {
                          // Add every member to its bucket (deduped).
                          const wpSet = new Set<WorkingPaperSourceId>(value.workingPaperSources);
                          const instSet = new Set<InstitutionalSourceId>(value.institutionalSources);
                          for (const m of row.members) {
                            if (m.bucket === 'wp') wpSet.add(m.id as WorkingPaperSourceId);
                            else instSet.add(m.id as InstitutionalSourceId);
                          }
                          onChange({
                            ...value,
                            workingPaperSources: [...wpSet],
                            institutionalSources: [...instSet],
                          });
                        }
                      };
                      return (
                        <label key={row.rowId} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-100 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={onToggle}
                            className="accent-teal-600"
                          />
                          <span className="text-sm text-slate-900 flex-1">{row.label}</span>
                          <span className="text-xs text-slate-500 tabular-nums">{row.count != null ? row.count.toLocaleString() : 'live retrieval'}</span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          </>)}

          {showPresets && (
          <div className="mt-4 pt-4 border-t border-slate-200 flex flex-wrap gap-2 items-center justify-between">
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mr-1">Presets:</span>
              <button onClick={() => applyPreset('credible')} className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">Top journals + IADB</button>
              <button onClick={() => applyPreset('top')}      className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">Journals only</button>
              <button onClick={() => applyPreset('iadb-wb')}  className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">IADB & WB only</button>
              <button onClick={() => applyPreset('all')}      className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">Everything credible</button>
            </div>
            <button onClick={onClose} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-100">Done</button>
          </div>
          )}
          {!showPresets && (
            <div className="mt-4 pt-3 border-t border-slate-200 flex justify-end">
              <button onClick={onClose} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-100">Done</button>
            </div>
          )}
        </>
      )}

      {drillGroup && (
        <>
          <button onClick={() => setDrillGroupId(null)} className="text-teal-700 text-sm font-semibold mb-3 hover:underline">‹ Back to sources</button>
          <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-1">{drillGroup.label}</h4>
          <p className="text-xs text-slate-600 mb-3">{drillGroup.description}</p>
          <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg p-2">
            {drillJournalRows.map(({ tier, journal }) => {
              const excluded = (value.excludedJournalsByTier[tier] ?? []).includes(journal);
              return (
                <label key={`${tier}-${journal}`} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-100 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!excluded}
                    onChange={() => toggleExcludedJournal(tier, journal)}
                    className="accent-teal-600"
                  />
                  <span className="text-sm text-slate-900 flex-1">{journal}</span>
                </label>
              );
            })}
          </div>
          <div className="flex justify-between items-center pt-3 mt-3 border-t border-slate-200">
            <span className="text-xs text-slate-500">Uncheck to exclude individual journals from this search</span>
            <button onClick={() => setDrillGroupId(null)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-100">Done</button>
          </div>
        </>
      )}
    </div>
  );
};

export default SourcesPicker;
