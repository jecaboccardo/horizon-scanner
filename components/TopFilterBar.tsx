import React, { useState } from 'react';
import { SearchFilters } from '../types';
import { JournalTier } from '../services/journalTiers';
import {
  SourcesPicker,
  SourcesSelection,
  DEFAULT_SOURCES_SELECTION,
  summariseJournals,
  summariseInstitutionalAll,
  WorkingPaperSourceId,
  InstitutionalSourceId,
} from './SourcesPicker';
import { RigorPicker, summariseRigor } from './RigorPicker';
import { YearsPicker, YearsValue, summariseYears } from './YearsPicker';
import { logEvent } from '../services/analytics';
// PublicationTypePicker removed from chip bar (2026-05-21). Import kept
// in case LinkedFilterBuilder still pulls it, but not used here.
// import { PublicationTypePicker, summarisePublicationTypes } from './PublicationTypePicker';

type OpenChip = 'rigor' | 'sources' | 'years' | null;

// Determine whether a filter dimension has been edited away from its default.
// Used to render the "· custom" indicator on chips so the user can see at a
// glance which filters they've actually touched.
const arraysEqualAsSet = <T,>(a: readonly T[], b: readonly T[]): boolean => {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
};

const rigorIsCustom = (smsLevels: number[] | undefined | null): boolean => {
  // Default = [] (all SMS levels permitted, no filter).
  return !!(smsLevels && smsLevels.length > 0);
};

const sourcesIsCustom = (sv: SourcesSelection): boolean => {
  if (!arraysEqualAsSet(sv.tiers, DEFAULT_SOURCES_SELECTION.tiers)) return true;
  if (!arraysEqualAsSet(sv.workingPaperSources, DEFAULT_SOURCES_SELECTION.workingPaperSources)) return true;
  if (!arraysEqualAsSet(sv.institutionalSources, DEFAULT_SOURCES_SELECTION.institutionalSources)) return true;
  // Any per-tier journal exclusions count as custom.
  const exclusions = Object.values(sv.excludedJournalsByTier ?? {}).flat();
  if (exclusions.length > 0) return true;
  return false;
};

const yearsIsCustom = (f: SearchFilters): boolean => f.timePeriod !== 'all';

const pubTypeIsCustom = (pubTypes: string[] | undefined | null): boolean => {
  return !!(pubTypes && pubTypes.length > 0);
};

const yearsToTimeFilter = (y: YearsValue): Pick<SearchFilters, 'timePeriod' | 'startDate' | 'endDate'> => {
  if (y.startYear == null && y.endYear == null) return { timePeriod: 'all', startDate: '', endDate: '' };
  return {
    timePeriod: 'custom',
    startDate: y.startYear != null ? `${y.startYear}-01-01` : '',
    endDate:   y.endYear   != null ? `${y.endYear}-12-31`   : '',
  };
};

const filtersToYearsValue = (f: SearchFilters): YearsValue => {
  if (f.timePeriod === 'all' || (!f.startDate && !f.endDate)) return { startYear: null, endYear: null };
  const start = f.startDate ? Number(f.startDate.slice(0, 4)) : null;
  const end   = f.endDate   ? Number(f.endDate.slice(0, 4))   : null;
  return {
    startYear: Number.isFinite(start) ? start : null,
    endYear:   Number.isFinite(end)   ? end   : null,
  };
};

const filtersToSourcesValue = (f: SearchFilters): SourcesSelection => ({
  tiers: (f.journalTiers ?? DEFAULT_SOURCES_SELECTION.tiers) as JournalTier[],
  excludedJournalsByTier: (f.excludedJournalsByTier ?? {}) as Partial<Record<JournalTier, string[]>>,
  workingPaperSources: (f.workingPaperSources ?? DEFAULT_SOURCES_SELECTION.workingPaperSources) as WorkingPaperSourceId[],
  institutionalSources: (f.institutionalSources ?? DEFAULT_SOURCES_SELECTION.institutionalSources) as InstitutionalSourceId[],
});

interface TopFilterBarProps {
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
}

const chipClasses = (active: boolean) =>
  `flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition ${
    active
      ? 'bg-white border-teal-600 ring-2 ring-teal-100'
      : 'bg-slate-100 border-slate-200 hover:bg-teal-50 hover:border-teal-600'
  }`;

const TopFilterBar: React.FC<TopFilterBarProps> = ({ filters, setFilters }) => {
  const [open, setOpen] = useState<OpenChip>(null);
  const close = () => setOpen(null);
  const toggle = (chip: OpenChip) => setOpen((cur) => (cur === chip ? null : chip));

  const rigorLabel = summariseRigor(filters.smsLevels);
  const sourcesValue = filtersToSourcesValue(filters);
  // Combined "Sources" summary: journals + working papers + institutional in
  // one chip, matching the LinkedFilterBuilder section name (Step 1). Format:
  //   "Tier 1,2,3 + NBER,SSRN + IADB"  →  trimmed if long.
  const sourcesSummary = (() => {
    const journals = summariseJournals(sourcesValue.tiers);
    const inst = summariseInstitutionalAll(
      sourcesValue.workingPaperSources,
      sourcesValue.institutionalSources,
    );
    if (!journals && !inst) return 'None';
    if (!inst) return journals;
    if (!journals) return inst;
    return `${journals} + ${inst}`;
  })();
  const yearsLabel = summariseYears(filtersToYearsValue(filters));
  // pubTypeLabel removed (Type chip removed from bar).
  // "· custom" badges — fire when each filter dimension diverges from its
  // App.tsx defaultFilters / DEFAULT_SOURCES_SELECTION baseline.
  const rigorCustom = rigorIsCustom(filters.smsLevels);
  const sourcesCustom = sourcesIsCustom(sourcesValue);
  const yearsCustom = yearsIsCustom(filters);
  // Publication type filter removed from the chip bar per UX review 2026-05-21.
  // (The picker still exists in LinkedFilterBuilder / types for future use.)

  const customSuffix = (isCustom: boolean) =>
    isCustom ? <span className="text-amber-700 text-[11px] ml-1">· custom</span> : null;

  const onSourcesChange = (next: SourcesSelection) => {
    // Telemetry: "used filters" — filter values are non-PII, kept in our DB.
    logEvent({ eventType: 'filters.changed', status: 'completed', payload: { filter: 'sources', tiers: next.tiers, workingPaperSources: next.workingPaperSources, institutionalSources: next.institutionalSources } });
    setFilters((f) => ({
      ...f,
      journalTiers: next.tiers,
      excludedJournalsByTier: next.excludedJournalsByTier,
      workingPaperSources: next.workingPaperSources,
      institutionalSources: next.institutionalSources,
    }));
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pl-3" data-print-hide>
      <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mr-2">Filters</span>

      {/* Rigor */}
      <div className="relative">
        <button onClick={() => toggle('rigor')} className={chipClasses(open === 'rigor')}>
          <span className="text-slate-500 font-medium">Rigor:</span>
          <span className="text-teal-700 font-semibold">{rigorLabel}</span>
          {customSuffix(rigorCustom)}
          <span className="text-slate-400 text-[10px]">▾</span>
        </button>
        {open === 'rigor' && (
          <RigorPicker
            value={filters.smsLevels}
            onChange={(next) => { logEvent({ eventType: 'filters.changed', status: 'completed', payload: { filter: 'rigor', smsLevels: next } }); setFilters((f) => ({ ...f, smsLevels: next })); }}
            onClose={close}
          />
        )}
      </div>

      {/* Sources — single chip covering journal tiers, working-paper
          repositories, and institutional publishers. Matches the "Sources"
          section in Step 1's LinkedFilterBuilder so chip naming stays
          consistent between setup and brief view. */}
      <div className="relative">
        <button onClick={() => toggle('sources')} className={chipClasses(open === 'sources')}>
          <span className="text-slate-500 font-medium">Sources:</span>
          <span className="text-teal-700 font-semibold">{sourcesSummary}</span>
          {customSuffix(sourcesCustom)}
          <span className="text-slate-400 text-[10px]">▾</span>
        </button>
        {open === 'sources' && (
          <SourcesPicker
            mode="all"
            value={sourcesValue}
            onChange={onSourcesChange}
            onClose={close}
          />
        )}
      </div>

      {/* Publication type chip removed — Type filter not shown in the chip bar.
          The picker in LinkedFilterBuilder still works for the Step 1 source
          setup, but we don't expose it as a post-search chip. */}

      {/* Years */}
      <div className="relative">
        <button onClick={() => toggle('years')} className={chipClasses(open === 'years')}>
          <span className="text-slate-500 font-medium">Years:</span>
          <span className="text-teal-700 font-semibold">{yearsLabel}</span>
          {customSuffix(yearsCustom)}
          <span className="text-slate-400 text-[10px]">▾</span>
        </button>
        {open === 'years' && (
          <YearsPicker
            value={filtersToYearsValue(filters)}
            onChange={(next) => {
              logEvent({ eventType: 'filters.changed', status: 'completed', payload: { filter: 'years', ...yearsToTimeFilter(next) } });
              setFilters((f) => ({ ...f, ...yearsToTimeFilter(next) }));
            }}
            onClose={close}
          />
        )}
      </div>
    </div>
  );
};

export default TopFilterBar;
