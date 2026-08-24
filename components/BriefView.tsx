import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EvidenceBrief, EvidenceRow, PaperPlanUpload, PersonaId, SearchFilters, Work } from '../types';
import { copyDoi, exportEvidenceTableAsCsv, copyEvidenceTableAsText } from '../services/exportService';
import { apiClient } from '../services/apiClient';
import { track, logEvent } from '../services/analytics';
import { buildFilterPredicate, resolveYearBounds } from '../services/filterPredicate';
import { regionsFromGeography } from '../utils/regionFromGeography';
import TwitterThreadView from './TwitterThreadView';
// POLICY-ONLY (2026-06-03): briefs are always the policy register; the persona
// picker / persona-swap UI (PersonaPills) was removed. TwitterThreadView stays
// imported so DB-stored twitter briefs still render their cached threads.
import PaperSidePanel from './PaperSidePanel';
import TopFilterBar from './TopFilterBar';
import {
  summariseJournals,
  summariseInstitutionalAll,
  WorkingPaperSourceId,
  InstitutionalSourceId,
} from './SourcesPicker';
import { summariseRigor } from './RigorPicker';
import { summariseYears, YearsValue } from './YearsPicker';
// summarisePublicationTypes removed from BriefView (Type chip removed 2026-05-21).

function filtersToYearsValue(filters: SearchFilters): YearsValue {
  if (filters.timePeriod === 'all' || (!filters.startDate && !filters.endDate)) {
    return { startYear: null, endYear: null };
  }

  const startYear = filters.startDate ? Number(filters.startDate.slice(0, 4)) : null;
  const endYear = filters.endDate ? Number(filters.endDate.slice(0, 4)) : null;

  return {
    startYear: Number.isFinite(startYear) ? startYear : null,
    endYear: Number.isFinite(endYear) ? endYear : null,
  };
}

function filterSummaryParts(filters: SearchFilters): { label: string; value: string }[] {
  const workingPaperSources = (filters.workingPaperSources ?? []) as WorkingPaperSourceId[];
  const institutionalSources = (filters.institutionalSources ?? []) as InstitutionalSourceId[];
  const region = (filters.regions ?? []).length === 0 ? 'Global' : filters.regions.join(', ');
  // "Sources" = journals + working papers + institutional — single chip
  // matching the LinkedFilterBuilder section name and TopFilterBar.
  const journalsPart = summariseJournals((filters.journalTiers ?? [1, 2, 3]) as unknown as import('../services/journalTiers').JournalTier[]);
  const instPart = summariseInstitutionalAll(workingPaperSources, institutionalSources);
  const sourcesSummary = [journalsPart, instPart].filter(Boolean).join(' · ') || 'None';

  // Rigor and Region are not user-facing controls in the current SearchIntentCard
  // flow — channels handle quality implicitly. Only show Sources and Years.
  const parts = [
    { label: 'Sources', value: sourcesSummary },
    { label: 'Years', value: summariseYears(filtersToYearsValue(filters)) },
  ];

  return parts;
}

function normalizeFilterForSummary(filters: SearchFilters): string {
  const sortStrings = (values: string[] | undefined) => [...(values ?? [])].sort();
  const sortNumbers = (values: number[] | undefined) => [...(values ?? [])].sort((a, b) => a - b);
  const excluded = filters.excludedJournalsByTier ?? {};
  const normalizedExcluded = Object.keys(excluded)
    .sort((a, b) => Number(a) - Number(b))
    .map((tier) => [tier, [...(excluded[Number(tier)] ?? [])].sort()]);

  return JSON.stringify({
    smsLevels: sortNumbers(filters.smsLevels),
    journalTiers: sortNumbers(filters.journalTiers),
    excludedJournalsByTier: normalizedExcluded,
    workingPaperSources: sortStrings(filters.workingPaperSources),
    institutionalSources: sortStrings(filters.institutionalSources),
    publicationTypes: sortStrings(filters.publicationTypes),
    regions: sortStrings(filters.regions),
    timePeriod: filters.timePeriod,
    startDate: filters.startDate || '',
    endDate: filters.endDate || '',
  });
}

function ActiveFilterSummary({
  filters,
  originalFilters,
  setFilters,
}: {
  filters: SearchFilters;
  originalFilters?: SearchFilters | null;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const parts = filterSummaryParts(filters);
  const isEdited = originalFilters
    ? normalizeFilterForSummary(filters) !== normalizeFilterForSummary(originalFilters)
    : false;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-left hover:text-teal-700 transition group"
        title="Click to edit filters"
      >
        {parts.map((p, i) => (
          <span key={p.label} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-300 mr-1">·</span>}
            <span className="text-slate-500 font-medium">{p.label}:</span>
            <span className="text-slate-700 group-hover:text-teal-700">{p.value}</span>
          </span>
        ))}
        {isEdited && (
          <span className="rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
            edited
          </span>
        )}
        <span className="text-slate-400 text-[10px]">✎</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-max max-w-[95vw] rounded-xl bg-white border border-slate-200 shadow-xl p-4">
          <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold mb-3">Search Filters</div>
          <TopFilterBar filters={filters} setFilters={setFilters} />
          <div className="mt-3 pt-3 border-t border-slate-100 flex justify-end">
            <button onClick={() => setOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-700 hover:bg-slate-50 transition">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// POLICY-ONLY (2026-06-03): SaveProjectButton removed — it was only rendered by
// the persona "Save as" affordance (onSaveAsPersona), which is gone now that
// briefs are always the policy register.

function ExportMenu({
  brief,
  worksById,
  rowsForExport,
  evidenceClassification,
  onCopyBrief,
  onExportJson,
  onExportDocx,
  onToast,
}: {
  brief: EvidenceBrief;
  worksById: Record<string, Work>;
  rowsForExport?: EvidenceRow[];
  evidenceClassification?: BriefViewProps['evidenceClassification'];
  onCopyBrief?: () => void;
  onExportJson: () => void;
  onExportDocx: () => void;
  onToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const evidenceRowCount = rowsForExport?.length ?? brief.sections.evidenceRows?.length ?? 0;

  function pick(fn: () => void) {
    return () => {
      fn();
      setOpen(false);
    };
  }

  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-full bg-white text-slate-900 px-4 py-1.5 text-xs font-semibold hover:bg-slate-100 transition flex items-center gap-1.5"
      >
        Export
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 w-64 rounded-xl bg-white border border-slate-200 shadow-xl py-2 text-sm text-slate-800">
            <div className="px-4 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.15em] text-slate-400 font-bold">Brief</div>
            {onCopyBrief && (
              <button onClick={pick(onCopyBrief)} className="w-full text-left px-4 py-2 hover:bg-slate-50 transition flex items-center justify-between">
                <span>Copy text</span>
                <span className="text-[10px] text-slate-400">clipboard</span>
              </button>
            )}
            <button onClick={pick(onExportJson)} className="w-full text-left px-4 py-2 hover:bg-slate-50 transition flex items-center justify-between">
              <span>Download JSON</span>
              <span className="text-[10px] text-slate-400">.json</span>
            </button>
            <button onClick={pick(onExportDocx)} className="w-full text-left px-4 py-2 hover:bg-slate-50 transition flex items-center justify-between">
              <span>Download Word</span>
              <span className="text-[10px] text-slate-400">.docx</span>
            </button>

            <div className="border-t border-slate-100 my-1" />

            <div className="px-4 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.15em] text-slate-400 font-bold">
              Evidence Table {evidenceRowCount > 0 && <span className="text-slate-400 normal-case tracking-normal">({evidenceRowCount})</span>}
            </div>
            <button
              onClick={pick(() => { logEvent({ eventType: 'brief.table_downloaded', targetType: 'brief', targetId: brief.id, status: 'completed', payload: { format: 'csv', rowCount: evidenceRowCount } }); exportEvidenceTableAsCsv(brief, worksById, rowsForExport, evidenceClassification); onToast('Evidence table CSV downloaded'); })}
              disabled={evidenceRowCount === 0}
              className="w-full text-left px-4 py-2 hover:bg-slate-50 transition flex items-center justify-between disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>Download as CSV</span>
              <span className="text-[10px] text-slate-400">.csv</span>
            </button>
            <button
              onClick={pick(async () => { logEvent({ eventType: 'brief.copied', targetType: 'brief', targetId: brief.id, status: 'completed', payload: { mode: 'table' } }); await copyEvidenceTableAsText(brief, worksById, rowsForExport, evidenceClassification); onToast('Evidence table copied'); })}
              disabled={evidenceRowCount === 0}
              className="w-full text-left px-4 py-2 hover:bg-slate-50 transition flex items-center justify-between disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>Copy table</span>
              <span className="text-[10px] text-slate-400">clipboard</span>
            </button>
          </div>
        </>
      )}
    </span>
  );
}

type SortField = 'relevance' | 'year' | 'sms' | 'citations' | 'authors' | 'source' | 'title' | 'channel';
type SortDirection = 'asc' | 'desc';
type TimeRange = 'recent-2020' | 'all' | 'last-5' | 'last-10' | 'last-20';

function IconMoreHorizontal({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
    </svg>
  );
}

function RowOverflowMenu({
  onSave,
  onDismiss,
  onExclude,
  isExcluded,
  isAdmin,
}: {
  onSave: () => void;
  onDismiss: () => void;
  onExclude?: () => void;
  isExcluded?: boolean;
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-full border border-slate-200 p-1.5 text-slate-400 hover:text-slate-600 hover:border-slate-300 transition"
        title="More actions"
      >
        <IconMoreHorizontal />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-36 rounded-lg bg-white border border-slate-200 shadow-lg py-1 text-xs">
            <button
              onClick={() => { onSave(); setOpen(false); }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 text-slate-700 transition"
            >
              Save
            </button>
            <button
              onClick={() => { onDismiss(); setOpen(false); }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 text-slate-700 transition"
            >
              Dismiss
            </button>
            {isAdmin && onExclude && (
              <button
                onClick={() => { onExclude(); setOpen(false); }}
                className={`w-full text-left px-3 py-2 transition ${isExcluded ? 'hover:bg-emerald-50 text-emerald-700' : 'hover:bg-rose-50 text-rose-700'}`}
              >
                {isExcluded ? 'Restore' : 'Exclude'}
              </button>
            )}
          </div>
        </>
      )}
    </span>
  );
}

interface BriefViewProps {
  brief: EvidenceBrief | null;
  worksById: Record<string, Work>;
  filters: SearchFilters;
  // Wave 2 (2026-05-07): per-paper Direct/Indirect classification map
  // (workId → {evidenceMatch, facetsMatched, facetsMissed}). Null when
  // facet retrieval was off for this run.
  //
  // `classification` is the four-bucket field (direct-lac / direct-global /
  // indirect / excluded) populated by the LLM judge or facet-cosine classifier.
  // `evidenceMatch` is the backward-compat collapsed string that maps both
  // direct-* into "direct". UI should prefer `classification` for display.
  // `llmRationale` is present only when the LLM judge tier classified the
  // paper — used as a hover-tooltip explanation.
  evidenceClassification?: Record<string, {
    evidenceMatch: 'direct' | 'indirect' | 'excluded';
    classification?: 'direct-lac' | 'direct-global' | 'indirect' | 'excluded';
    facetsMatched: string[];
    facetsMissed: string[];
    llmRationale?: string;
  }> | null;
  // Facet-retrieval telemetry (direct/indirect classifier counts removed 2026-07-08).
  facetCoverage?: {
    excludedByFacets?: number;
    facetLabels?: string[];
  } | null;
  isLoading?: boolean;
  isSynthesizing?: boolean;
  streamingText?: string;
  error?: string | null;
  timeRange: TimeRange;
  onTimeRangeChange: (range: string) => void;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  showLoadMoreSuggestion?: boolean;
  onFeedback: (type: 'like' | 'dislike' | 'save' | 'dismiss', workId?: string) => void;
  isAdmin?: boolean;
  onExcludeWork?: (workId: string, excluded: boolean) => void;
  onStarWork?: (workId: string, starred: boolean) => void;
  // Fired whenever the visible table set changes (load more, collapse,
  // sort, filter). Used by App.tsx to detect when the brief is stale
  // relative to what user currently sees, and offer a "Regenerate" prompt.
  onVisibleRowsChange?: (workIds: string[]) => void;
  // Export callbacks receive the post-filter rows (sortedRows) so the export
  // reflects what the user actually sees in the table — see audit 2026-05-21.
  // Callers should thread these into exportService functions as `rowsForExport`.
  onExportJson: (rowsForExport?: EvidenceRow[]) => void;
  onExportDocx: (rowsForExport?: EvidenceRow[]) => void;
  onCopyBrief?: (rowsForExport?: EvidenceRow[]) => void;
  onShare: () => void;
  onRetry?: () => void;
  onFollowUpQuestion?: (question: string) => void;
  savedWorkIds?: Set<string>;
  selectedLanguage?: 'en' | 'es' | 'pt';
  onLanguageChange?: (lang: 'en' | 'es' | 'pt') => void;
  activeFilters?: SearchFilters;
  originalFilters?: SearchFilters | null;
  setActiveFilters?: React.Dispatch<React.SetStateAction<SearchFilters>>;
  // Regenerate-brief flow (2026-05-21). `candidatePool` is the ordered list
  // of work IDs from the search run's admissible pool that did NOT make the
  // initial brief (positions past the synthesis cap). When the user clicks
  // "Load 10 more" after exhausting the brief's evidence rows, BriefView
  // surfaces shell rows for these IDs. `onRegenerateBrief` re-synthesizes
  // the brief over the now-expanded evidence set.
  candidatePool?: string[];
  onRegenerateBrief?: (workIds: string[], extraPapers?: PaperPlanUpload[]) => Promise<void> | void;
  onResolvePaper?: (input: { doiOrUrl?: string; pastedText?: string }) => Promise<PaperPlanUpload>;
  isRegenerating?: boolean;
  // Paper Studio: open the prep cockpit (the "door"). When provided, it
  // replaces the one-shot "Generate Paper" pill.
  onWriteSurvey?: (orderedWorkIds: string[]) => void;
  // True while the plan is being seeded (API call in flight) — disables the button.
  writeSurveyPending?: boolean;
  // JEL paper generation
  onGenerateJelPaper?: () => void;
  // 'generating' | 'done' | 'error'
  jelPaperStatus?: 'generating' | 'done' | 'error';
  // Live section progress while drafting
  jelPaperProgress?: { done: number; total: number };
  // Error message to show in error state
  jelPaperErrorMessage?: string;
  // Called when user clicks "Paper ready → Library"
  onJelPaperDone?: () => void;
  // PR3 progressive reveal. 'table-focus' shows only the evidence table
  // centered and full-width (used while the user is still in Step 2 picking
  // persona/language and retrieval has just finished). 'two-column' is the
  // normal PR2 layout. Defaults to 'two-column'.
  layoutMode?: 'table-focus' | 'two-column';
  // Active search channels — used to set the default table sort order.
  activeChannels?: Set<string>;
}

type EvidenceClassificationEntry = NonNullable<BriefViewProps['evidenceClassification']>[string];

function getRowSmsLevel(row: EvidenceRow, work: Work | undefined): number | null {
  return row.smsLevel ?? work?.smsLevel ?? null;
}

function getRowMethodologyDesign(row: EvidenceRow, work: Work | undefined): string | null {
  const rowDesign = row.methodologyBadge && row.methodologyBadge !== 'Unclassified'
    ? row.methodologyBadge
    : null;
  return rowDesign || work?.methodologyDesign || work?.methodology?.design || null;
}

// Returns the REGION bucket(s) (LAC, USA and Canada, …) for the evidence table /
// detail chips — derived from the paper's country-level geography[]. Empty when no
// region maps (Global) so the chip stays hidden. Was: raw country list.
// Coerce any value to a string[]. A persisted brief row (or work) can carry
// authors/geography as a JSON-encoded STRING (e.g. '["A","B"]'); a string passes
// the `x && x.length > 0` guard and then crashes `x.slice(...).join(...)` (String.slice
// returns a string, which has no .join). Parse a "[...]" string, wrap a plain string.
function toStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : [t]; } catch { return [t]; } }
    return [t];
  }
  return [];
}

function getRowGeography(row: EvidenceRow, work: Work | undefined): string[] {
  const rg = toStrArr(row.geography);
  const rowGeo = rg.length > 0 ? rg : toStrArr(work?.geography);
  return regionsFromGeography(rowGeo);
}

function getMatchBadgeInfo(cls: EvidenceClassificationEntry | undefined): { label: string; cls: string; title: string } | null {
  if (!cls || cls.evidenceMatch === 'excluded') return null;
  const fine = cls.classification ?? cls.evidenceMatch;
  const isDirectLac = fine === 'direct-lac';
  const isDirectGlobal = fine === 'direct-global' || (fine === 'direct' && !isDirectLac);
  const isDirect = isDirectLac || isDirectGlobal;
  const label = isDirectLac ? 'DIRECT · LAC'
    : isDirectGlobal ? 'DIRECT · GLOBAL'
    : 'INDIRECT';
  const matched = cls.facetsMatched.join(', ') || '—';
  const missed = cls.facetsMissed.join(', ');
  const title = cls.llmRationale
    ? cls.llmRationale
    : isDirect
      ? `Direct match — covers all query facets: ${matched}${isDirectLac ? ' · LAC geography matched' : ' · no LAC geography match'}`
      : `Indirect match — covers: ${matched}${missed ? ` · missing: ${missed}` : ''}`;
  const badgeCls = isDirectLac
    ? 'bg-teal-100 text-teal-800 border border-teal-300'
    : isDirectGlobal
      ? 'bg-sky-50 text-sky-700 border border-sky-200'
      : 'bg-slate-100 text-slate-600 border border-slate-300';
  return { label, cls: badgeCls, title };
}

function percentileToBand(percentile: number): 'top_5' | 'top_5_10' | 'top_10_25' | 'top_25_50' | 'bottom_50' {
  if (percentile >= 95) return 'top_5';
  if (percentile >= 90) return 'top_5_10';
  if (percentile >= 75) return 'top_10_25';
  if (percentile >= 50) return 'top_25_50';
  return 'bottom_50';
}

// passesQualityFilters was a local re-implementation of the filter predicate
// that only checked smsLevels / absRatings / repecBands / publicationTypes.
// Source-picker dimensions (journalTiers, workingPaperSources,
// institutionalSources) and the year range were missing on the frontend —
// see audit 2026-05-21. The unified predicate now lives in
// `services/filterPredicate.ts` and mirrors backend retrieval.ts exactly.
//
// Callers should use `buildFilterPredicate(filters, ctx)` instead.

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 'recent-2020', label: '2020-present' },
  { value: 'last-5', label: 'Last 5 years' },
  { value: 'last-10', label: 'Last 10 years' },
  { value: 'last-20', label: 'Last 20 years' },
  { value: 'all', label: 'All years (1961+)' },
];

function SortArrow({ field, activeField, direction }: { field: SortField; activeField: SortField; direction: SortDirection }) {
  if (field !== activeField) return null;
  return <span className="ml-1 text-cyan-700">{direction === 'asc' ? '↑' : '↓'}</span>;
}

function Spinner({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const cls = size === 'md' ? 'h-6 w-6' : 'h-4 w-4';
  return (
    <svg className={`animate-spin ${cls} text-cyan-700`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function SynthesisSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 bg-slate-200 rounded-md w-full" />
      <div className="h-4 bg-slate-200 rounded-md w-5/6" />
      <div className="h-4 bg-slate-200 rounded-md w-4/6" />
    </div>
  );
}

function briefLabel(lang: BriefViewProps['selectedLanguage'], key: string): string {
  const labels: Record<string, Record<string, string>> = {
    es: {
      sharperResultsTip: '¿Buscas resultados más precisos? Agrega un país, periodo o intervención específica a tu pregunta.',
      methodology: 'Metodología',
      evidenceStrength: 'Evidencia más sólida',
      methodsMix: 'Combinación de métodos',
      smsDistribution: 'Distribución SMS',
      atSMSStrong: 'en SMS 4–5',
      evidenceSpan: 'Rango temporal',
      medianYear: 'mediana',
      inLastYears: 'en los últimos 3 años',
      tierMix: 'Niveles de fuente',
      pubTypeMix: 'Tipo de publicación',
      noMethodologyNote: 'No se generó una nota metodológica.',
      coverageGaps: 'Cobertura y brechas',
      lacEvidence: 'Cobertura ALC',
      coveredCountries: 'Cubiertos',
      uncoveredCountries: 'Sin cobertura',
      noLacCoverage: 'Ningún país ALC en este conjunto.',
      recencyAlert: 'Recencia',
      thinEvidenceAreas: 'Brechas de cobertura',
      zeroResearch: 'Sin investigación sobre',
      weakRigor: 'Rigor débil en',
      lacNeedsRigor: 'ALC con poco rigor',
      taggingMethodology: 'Clasificando la combinación metodológica...',
      mappingCoverage: 'Mapeando brechas de cobertura...',
    },
    pt: {
      sharperResultsTip: 'Buscando resultados mais precisos? Adicione um país, período ou intervenção específica à sua pergunta.',
      methodology: 'Metodologia',
      evidenceStrength: 'Evidência mais sólida',
      methodsMix: 'Composição dos métodos',
      smsDistribution: 'Distribuição SMS',
      atSMSStrong: 'em SMS 4–5',
      evidenceSpan: 'Período',
      medianYear: 'mediana',
      inLastYears: 'nos últimos 3 anos',
      tierMix: 'Níveis de fonte',
      pubTypeMix: 'Tipo de publicação',
      noMethodologyNote: 'Nenhuma nota metodológica gerada.',
      coverageGaps: 'Cobertura e lacunas',
      lacEvidence: 'Cobertura ALC',
      coveredCountries: 'Cobertos',
      uncoveredCountries: 'Sem cobertura',
      noLacCoverage: 'Nenhum país ALC neste conjunto.',
      recencyAlert: 'Recência',
      thinEvidenceAreas: 'Lacunas de cobertura',
      zeroResearch: 'Sem pesquisa sobre',
      weakRigor: 'Rigor fraco em',
      lacNeedsRigor: 'ALC com pouco rigor',
      taggingMethodology: 'Classificando a composição metodológica...',
      mappingCoverage: 'Mapeando lacunas de cobertura...',
    },
  };
  return labels[lang ?? 'en']?.[key] ?? {
    sharperResultsTip: 'Looking for sharper results? Try adding a country, time period, or a specific intervention to your question.',
    methodology: 'Methodology',
    evidenceStrength: 'Strongest evidence',
    methodsMix: 'Methods mix',
    smsDistribution: 'SMS distribution',
    atSMSStrong: 'at SMS 4–5',
    evidenceSpan: 'Evidence span',
    medianYear: 'median',
    inLastYears: 'in last 3 yrs',
    tierMix: 'Source tiers',
    pubTypeMix: 'Publication mix',
    noMethodologyNote: 'No methodology note generated.',
    coverageGaps: 'Coverage & gaps',
    lacEvidence: 'LAC coverage',
    coveredCountries: 'Covered',
    uncoveredCountries: 'No coverage',
    noLacCoverage: 'No LAC country in this set.',
    recencyAlert: 'Recency',
    thinEvidenceAreas: 'Coverage gaps',
    zeroResearch: 'No research on',
    weakRigor: 'Weak rigor on',
    lacNeedsRigor: 'LAC needs rigor',
    taggingMethodology: 'Tagging methodology mix...',
    mappingCoverage: 'Mapping coverage gaps...',
  }[key] ?? key;
}

function gapTypeLabel(gapType: string | null | undefined, lang: BriefViewProps['selectedLanguage']): string {
  const normalized = gapType ?? '';
  if (lang === 'es') {
    return ({
      research_gap: 'brecha de investigación',
      retrieval_issue: 'problema de recuperación',
      methodological_gap: 'brecha metodológica',
      regional_gap: 'brecha regional',
    } as Record<string, string>)[normalized] ?? normalized.replace(/_/g, ' ');
  }
  if (lang === 'pt') {
    return ({
      research_gap: 'lacuna de pesquisa',
      retrieval_issue: 'problema de recuperação',
      methodological_gap: 'lacuna metodológica',
      regional_gap: 'lacuna regional',
    } as Record<string, string>)[normalized] ?? normalized.replace(/_/g, ' ');
  }
  return normalized.replace(/_/g, ' ');
}

// SMS distribution bar: slate→teal gradient. SMS 5-4 are strong-design teal,
// 3 is borderline teal, 2-1-0 are slate (correlational/descriptive/non-empirical).
function smsBarColor(level: number): string {
  switch (level) {
    case 5: return 'bg-teal-700';
    case 4: return 'bg-teal-500';
    case 3: return 'bg-teal-300';
    case 2: return 'bg-slate-400';
    case 1: return 'bg-slate-300';
    case 0: return 'bg-slate-200';
    default: return 'bg-slate-100';
  }
}

// Map DB publication_type enum to a short human label, i18n-aware.
function pubTypeLabel(key: string, lang: BriefViewProps['selectedLanguage']): string {
  const labels: Record<string, Record<string, string>> = {
    es: {
      journal_article: 'Revista',
      working_paper: 'Documento de trabajo',
      discussion_paper: 'Documento de discusión',
      report: 'Informe',
      book: 'Libro',
      book_chapter: 'Capítulo',
      conference_paper: 'Conferencia',
      preprint: 'Preimpresión',
      dataset: 'Datos',
      dissertation: 'Tesis',
      other: 'Otro',
    },
    pt: {
      journal_article: 'Periódico',
      working_paper: 'Documento de trabalho',
      discussion_paper: 'Documento de discussão',
      report: 'Relatório',
      book: 'Livro',
      book_chapter: 'Capítulo',
      conference_paper: 'Conferência',
      preprint: 'Pré-publicação',
      dataset: 'Dataset',
      dissertation: 'Tese',
      other: 'Outro',
    },
  };
  const enFallback: Record<string, string> = {
    journal_article: 'Peer-reviewed',
    working_paper: 'Working paper',
    discussion_paper: 'Discussion paper',
    report: 'Report',
    book: 'Book',
    book_chapter: 'Book chapter',
    conference_paper: 'Conference',
    preprint: 'Preprint',
    dataset: 'Dataset',
    dissertation: 'Dissertation',
    other: 'Other',
  };
  return labels[lang ?? 'en']?.[key] ?? enFallback[key] ?? key;
}

// Citation tag patterns Gemini's JEL prompt actually emits:
//   prefixed:   [ss:DOI], [oa:ID], [corpus:ID], [workId:ID], [doi:X], [exa:URL]
//   bare DOI:   [10.1007/s40821-024-00259-6]
//   OpenAlex:   [W1234567890] or [openalex:W1234567890]
//   numeric ID: [12345]  (only when surrounded by alpha context — avoid matching things like [1])
const CITATION_BODY = "(?:(?:ss|oa|openalex|cr|wb|idb|exa|corpus|workId|doi):[^\\]]+|10\\.[0-9]{4,}/[^\\] ]+|W[0-9]{6,})";
const CITATION_TEST = new RegExp(`^\\[${CITATION_BODY}\\]$`); // anchored, non-global, safe for .test()
const TOKEN_RE = new RegExp(`(\\*\\*[^*]+\\*\\*|\\[${CITATION_BODY}\\])`, "g");

/**
 * Resolve a citation key (e.g. "ss:10.1016/...", "W12345", "10.1016/...") to
 * the matching Work in the brief's evidence rows. Returns null if not found.
 */
function resolveCitation(
  inner: string,
  worksById: Record<string, Work> | undefined,
  evidenceRows: EvidenceRow[] | undefined,
): Work | null {
  if (!evidenceRows) return null;
  // Strip prefix like "ss:" or "openalex:"
  const colonIdx = inner.indexOf(':');
  const key = colonIdx >= 0 ? inner.slice(colonIdx + 1).trim() : inner.trim();
  const lower = key.toLowerCase();

  for (const row of evidenceRows) {
    const work = worksById?.[row.workId];

    const matches =
      (work && (work.id === key || work.id === inner)) ||
      (work?.canonicalDoi && work.canonicalDoi.toLowerCase() === lower) ||
      (row.doi && row.doi.toLowerCase() === lower) ||
      row.workId === key ||
      row.workId === inner ||
      (key.startsWith('W') && work?.url && work.url.toLowerCase().includes(lower));

    if (!matches) continue;

    // Full Work record available — return it directly.
    if (work) return work;

    // Work not in worksById (historical brief loaded from sidebar without
    // re-fetching the corpus). Build a minimal Work from the EvidenceRow so
    // the citation popup still shows title / authors / year / finding / link.
    const paperUrl = row.url || (row.doi ? `https://doi.org/${row.doi}` : '');
    return {
      id: row.workId,
      title: row.title || row.workId,
      authors: row.authors ?? [],
      year: row.year ?? 0,
      abstract: row.finding ?? '',
      summary: row.finding ?? '',
      canonicalDoi: row.doi,
      url: paperUrl,
      openAccessPdfUrl: null,
      smsLevel: row.smsLevel ?? null,
      methodologyDesign: row.methodologyBadge && row.methodologyBadge !== 'Unclassified' ? row.methodologyBadge : null,
      geography: row.geography ?? [],
      sourceId: '', sourceType: 'journal', qualityTier: 'Tier A',
      topics: [], institution: '', interventionType: '', citationCount: 0,
      lacRelevance: 0, versions: [], chunks: [],
      methodology: { design: 'observational' as any, causalStrength: 'unknown' as any, confidenceSignals: [], limitations: [] },
    } as unknown as Work;
  }
  return null;
}

/**
 * Inline citation reference. Renders [N] superscript with a hover-preview card
 * showing the matched paper's title, authors, year, SMS, methodology, and a
 * 1-line finding. Card stays open while the cursor is over either the [N] or
 * the card itself (small grace delay) — enough to click into the paper URL.
 */
const CitationRef: React.FC<{
  inner: string;
  number: number;
  worksById?: Record<string, Work>;
  evidenceRows?: EvidenceRow[];
}> = ({ inner, number, worksById, evidenceRows }) => {
  const [open, setOpen] = useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const work = resolveCitation(inner, worksById, evidenceRows);

  const show = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpen(true);
    // PR4 cross-linking: scroll the corresponding table row into view and
    // flash a teal highlight so the user can locate the paper in the table.
    if (work?.id) {
      const row = document.querySelector<HTMLTableRowElement>(`[data-work-id="${work.id}"]`);
      if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        // Flash: set teal-100 immediately, then transition back to transparent.
        row.style.backgroundColor = 'rgb(204, 251, 241)';
        row.style.transition = '';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            row.style.transition = 'background-color 1.2s ease';
            row.style.backgroundColor = '';
          });
        });
        // Clean up the inline transition after it completes.
        const cleanup = setTimeout(() => { row.style.transition = ''; }, 1400);
        (row as any)._citationCleanup = cleanup;
      }
    }
  };
  const scheduleHide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };

  // SMS color for the badge inside the hover card (matches evidence-table stripe scheme)
  const smsLevel = work?.smsLevel ?? null;
  const smsBadgeCls = smsLevel == null
    ? 'bg-slate-100 text-slate-600 border-slate-200'
    : smsLevel >= 5 ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : smsLevel === 4 ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
    : smsLevel === 3 ? 'bg-amber-50 text-amber-700 border-amber-200'
    : smsLevel === 2 ? 'bg-orange-50 text-orange-700 border-orange-200'
    : smsLevel === 1 ? 'bg-rose-50 text-rose-700 border-rose-200'
    : 'bg-slate-100 text-slate-600 border-slate-200';
  const smsBadgeLabel = smsLevel === 0 ? 'Review / Theory' : `SMS ${smsLevel}`;

  const finding = work?.summary || work?.abstract || '';
  const findingShort = finding.length > 200 ? finding.slice(0, 200) + '…' : finding;
  const paperUrl = work?.url || work?.openAccessPdfUrl || (work?.canonicalDoi ? `https://doi.org/${work.canonicalDoi}` : null);

  return (
    <span className="relative inline-block">
      <sup
        className="text-teal-700 font-semibold mx-0.5 cursor-pointer hover:text-teal-900 hover:underline"
        title={work ? `${work.title.slice(0, 80)}${work.title.length > 80 ? '…' : ''}` : inner}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onClick={show}
      >[{number}]</sup>
      {open && work && (
        <span
          className="absolute left-0 top-full mt-1 z-50 w-80 rounded-xl bg-white border border-slate-200 shadow-xl p-3.5 text-xs text-slate-700 normal-case font-normal"
          style={{ verticalAlign: 'baseline' }}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        >
          <div className="font-semibold text-slate-900 leading-snug mb-1.5 text-[13px]">{work.title}</div>
          <div className="text-slate-500 text-[11px] mb-2">
            {toStrArr(work.authors).slice(0, 3).join(', ')}{toStrArr(work.authors).length > 3 ? ' et al.' : ''}
            {work.year ? ` · ${work.year}` : ''}
            {work.venue ? ` · ${work.venue}` : ''}
          </div>
          <div className="flex flex-wrap gap-1 mb-2">
            {smsLevel != null && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${smsBadgeCls}`}>{smsBadgeLabel}</span>
            )}
            {work.methodologyDesign && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md border bg-slate-50 text-slate-700 border-slate-200">{work.methodologyDesign}</span>
            )}
          </div>
          {findingShort && (
            <div className="text-slate-600 leading-relaxed text-[11px] mb-2">{findingShort}</div>
          )}
          {paperUrl && (
            <a href={paperUrl} target="_blank" rel="noreferrer" className="text-teal-700 font-semibold hover:underline text-[11px]">
              Open paper →
            </a>
          )}
        </span>
      )}
    </span>
  );
};

interface RenderContext {
  worksById?: Record<string, Work>;
  evidenceRows?: EvidenceRow[];
  // Shared citation→number map. When provided, footnote numbers are global
  // across the whole brief (abstract + all bullets) instead of restarting at
  // [1] in every bullet. Prebuilt in document order by buildCitationNumbering.
  seen?: Map<string, number>;
}

/**
 * Render a string with markdown bold (**foo**) and inline citation tags
 * ([ss:DOI] etc) converted to small numbered superscript references with
 * hover-preview cards (when a render context with works is provided).
 * Numbering is local to a single bullet/paragraph — that's fine for
 * readability and keeps state simple. The full evidence table below the
 * brief is the real reference list.
 */
/**
 * Strip bracketed citations Gemini sometimes outputs that aren't valid workIds.
 * Targets: comma-separated DOI lists, bracketed Author-Year tags, bracketed
 * URLs. Single-DOI brackets are preserved because the citation regex below
 * matches them and the render path resolves them to evidence rows.
 */
function cleanSynthesisText(text: string): string {
  // Defensive: some briefs stored bullets as { text, citation } objects
  // instead of strings (a synthesis path returned structured bullets that got
  // saved raw). Extract the text so the brief renders instead of showing
  // "[object Object]" or crashing the whole BriefView.
  if (typeof text !== 'string') {
    if (text == null) return '';
    if (typeof text === 'object' && typeof (text as { text?: unknown }).text === 'string') {
      text = (text as { text: string }).text;
    } else {
      text = String(text);
    }
  }
  if (!text) return text;
  let cleaned = text;
  // [doi1, doi2, doi3] — comma-separated DOI lists (definitely not valid workIds)
  cleaned = cleaned.replace(/\[\s*10\.[\w./-]+(?:\s*,\s*10\.[\w./-]+)+\s*\]/g, '');
  // [Author 2024] / [Author and Other 2024] — author-year style
  cleaned = cleaned.replace(/\[\s*[A-Z][a-zA-Z'-]+(?:\s+(?:and|&|et\s+al\.?)\s+[A-Z][a-zA-Z'-]+)?\s+\d{4}[a-z]?\s*\]/g, '');
  // [https://...] / [http://...] — bracketed URLs
  cleaned = cleaned.replace(/\[\s*https?:\/\/[^\]\s]+\s*\]/g, '');
  // Collapse whitespace introduced by removals
  cleaned = cleaned.replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return cleaned;
}

/**
 * Build a global citation→footnote-number map by scanning text blocks in
 * document order (abstract first, then bullets). Ensures each distinct workId
 * gets one stable number used everywhere in the brief, so footnotes don't
 * restart at [1] in every bullet (which made briefs look like they cited only
 * 5 papers when they actually cite far more).
 */
function buildCitationNumbering(texts: (string | undefined | null)[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const t of texts) {
    if (!t) continue;
    const parts = cleanSynthesisText(t).split(TOKEN_RE).filter((p) => p !== undefined && p !== '');
    for (const part of parts) {
      if (CITATION_TEST.test(part)) {
        const inner = part.slice(1, -1);
        if (!seen.has(inner)) seen.set(inner, seen.size + 1);
      }
    }
  }
  return seen;
}

function renderMarkdownBold(text: string, ctx?: RenderContext): React.ReactNode {
  const tokens = cleanSynthesisText(text).split(TOKEN_RE).filter((t) => t !== undefined && t !== '');
  // Use the shared map when provided so numbering is global across the brief;
  // fall back to a local map for standalone callers (chat, previews).
  const seen = ctx?.seen ?? new Map<string, number>();
  return tokens.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-slate-900 font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (CITATION_TEST.test(part)) {
      const inner = part.slice(1, -1);
      let n = seen.get(inner);
      if (!n) { n = seen.size + 1; seen.set(inner, n); }
      return (
        <CitationRef
          key={i}
          inner={inner}
          number={n}
          worksById={ctx?.worksById}
          evidenceRows={ctx?.evidenceRows}
        />
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// Single-expand bullet section: full text per bullet, one "Show all / Collapse"
// toggle at the bottom if there are more than BULLETS_DEFAULT bullets.
const BULLETS_DEFAULT = 4;

function BulletSection({
  bullets,
  persona,
  worksById,
  evidenceRows,
  seen,
}: {
  bullets: string[];
  persona: string;
  worksById: Record<string, Work>;
  evidenceRows: EvidenceRow[];
  seen?: Map<string, number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const ctx: RenderContext = { worksById, evidenceRows, seen };
  const hasMore = bullets.length > BULLETS_DEFAULT;
  const visible = expanded || !hasMore ? bullets : bullets.slice(0, BULLETS_DEFAULT);

  return (
    <div>
      <div className="text-xs uppercase tracking-[0.15em] text-slate-500 font-semibold mb-3">
        {persona === 'jel' ? 'Survey' : 'Detailed findings'}
      </div>
      {persona === 'jel' ? (
        <div className="space-y-5 text-[15px] text-slate-800 leading-relaxed">
          {visible.map((bullet, i) => (
            <p key={i} className="[&>strong]:text-slate-900 [&>strong]:block [&>strong]:mb-1 [&>strong]:text-base">
              {renderMarkdownBold(bullet, ctx)}
            </p>
          ))}
        </div>
      ) : (
        <ul className="space-y-3 text-sm text-slate-700">
          {visible.map((bullet, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 text-teal-600 shrink-0">•</span>
              <span className="flex-1">{renderMarkdownBold(bullet, ctx)}</span>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 text-xs font-semibold text-teal-600 hover:text-teal-800 transition flex items-center gap-1"
        >
          {expanded ? (
            <>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
              Collapse
            </>
          ) : (
            <>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              Show all {bullets.length} findings
            </>
          )}
        </button>
      )}
    </div>
  );
}

function ExpandableText({ text, limit = 300, ctx }: { text: string; limit?: number; ctx?: RenderContext }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= limit) return <span>{renderMarkdownBold(text, ctx)}</span>;
  const displayed = expanded ? text : text.slice(0, limit) + '...';
  return (
    <span>
      {renderMarkdownBold(displayed, ctx)}
      <button
        onClick={() => setExpanded(!expanded)}
        className="ml-1 text-teal-600 hover:text-teal-800 text-xs font-semibold"
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </span>
  );
}

function ExplainableBadge({
  label,
  colorClass,
  explanation,
  paperUrl,
}: {
  label: string;
  colorClass: string;
  explanation: string;
  paperUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-bold cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-cyan-400 transition ${colorClass}`}
        title="Click to see why"
      >
        {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 w-80 rounded-xl bg-white border border-slate-200 shadow-lg p-4 text-xs text-slate-700">
            <p className="leading-relaxed whitespace-pre-line">{explanation}</p>
            {paperUrl && (
              <a href={paperUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-cyan-700 font-semibold hover:underline">
                View paper
              </a>
            )}
            <button
              onClick={() => setOpen(false)}
              className="absolute top-1.5 right-2 text-slate-400 hover:text-slate-600 text-sm"
              aria-label="Close citation preview"
            >×</button>
          </div>
        </>
      )}
    </span>
  );
}

const SMS_SCALE: Record<number, string> = {
  5: 'SMS 5 = Randomized Controlled Trial (RCT). Gold standard for causal inference.',
  4: 'SMS 4 = Strong quasi-experiment (DiD, IV, RDD) with credible identification strategy.',
  3: 'SMS 3 = Quasi-experiment with weaker controls (matching, panel fixed effects).',
  2: 'SMS 2 = Correlational with statistical controls (regression, multivariate).',
  1: 'SMS 1 = Simple correlation or descriptive analysis. No causal claim warranted.',
  0: 'Review / Theory = Literature review or theoretical paper. Not primary empirical research; SMS scale does not apply.',
};

function buildSmsExplanation(work: Work): string {
  const scaleNote = work.smsLevel != null ? SMS_SCALE[work.smsLevel] || '' : '';
  if (work.smsRationale) return `${work.smsRationale}\n\n${scaleNote}`;
  if (work.smsLevel == null) return 'No methodology keywords detected in the abstract. Paper is unclassified — this does not mean low quality, just that the automated keyword scan could not determine the study design.';
  return `Classified SMS ${work.smsLevel} via keyword scan on the abstract.\n\n${scaleNote}`;
}

function buildAbsExplanation(work: Work): string {
  const info = work.journalMatchInfo;
  const venue = work.venue || info?.inputVenue || 'unknown journal';
  const matchDesc = info?.matchType === 'normalized' ? 'normalized name match' : 'exact name match';
  const field = info?.absField ? ` Field: ${info.absField}.` : '';
  const scaleNote = work.absRating === '4*' ? 'ABS 4* = World elite journal (top ~40 globally).'
    : work.absRating === '4' ? 'ABS 4 = Top journal in its field.'
    : work.absRating === '3' ? 'ABS 3 = Highly regarded, well-established journal.'
    : work.absRating === '2' ? 'ABS 2 = Well-regarded journal, publishes original research.'
    : work.absRating === '1' ? 'ABS 1 = Recognized journal in its field.'
    : '';
  return `Journal "${venue}" rated ABS ${work.absRating} in the Academic Journal Guide (${matchDesc}).${field}\n\n${scaleNote}`;
}

function buildRepecExplanation(work: Work): string {
  const info = work.journalMatchInfo;
  const venue = work.venue || info?.inputVenue || 'unknown journal';
  const matchDesc = info?.matchType === 'normalized' ? 'normalized name match' : 'exact name match';
  const total = info?.repecTotalCount ? ` of ${info.repecTotalCount.toLocaleString()}` : '';
  const pct = work.repecPercentile ?? 0;
  const tier = pct >= 95 ? 'Top 5% — elite economics journal.'
    : pct >= 90 ? 'Top 10% — leading economics journal.'
    : pct >= 75 ? 'Top 25% — well-established economics journal.'
    : pct >= 50 ? 'Top 50% — recognized economics journal.'
    : 'Below median in IDEAS/RePEC rankings.';
  return `Journal "${venue}" ranked #${work.repecRank}${total} in IDEAS/RePEC (top ${Math.round(100 - pct)}%, ${matchDesc}).\n\n${tier}`;
}

function buildUnscoredExplanation(work: Work): string {
  const reasons: string[] = [];
  if (work.smsLevel == null) reasons.push('SMS: No methodology keywords found in abstract — automated classification could not determine study design.');
  if (!work.absRating) {
    if (!work.venue) reasons.push('ABS: No journal/venue information available for this paper.');
    else reasons.push(`ABS: Journal "${work.venue}" not found in the Academic Journal Guide database.`);
  }
  if (work.repecPercentile == null) {
    if (!work.venue) reasons.push('RePEC: No journal/venue information available.');
    else reasons.push(`RePEC: Journal "${work.venue}" not found in IDEAS/RePEC rankings.`);
  }
  return reasons.length > 0
    ? reasons.join('\n\n')
    : 'This paper has no quality scores. It may be a working paper, report, or from a source not indexed in ABS/RePEC.';
}

function AuditTraceSection({ auditTrace }: { auditTrace: EvidenceBrief['auditTrace'] }) {
  const [expanded, setExpanded] = useState(false);
  const modelLabel = auditTrace.model === 'deterministic' ? 'Deterministic fallback' : auditTrace.model;
  const dateLabel = auditTrace.generatedAt ? new Date(auditTrace.generatedAt).toLocaleString() : '—';

  return (
    <section className="rounded-xl bg-slate-50 border border-slate-200 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-3 text-left flex items-center justify-between hover:bg-slate-100 transition"
      >
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="uppercase tracking-[0.15em] font-bold text-slate-400">Audit</span>
          <span>{modelLabel}</span>
          <span className="text-slate-300">|</span>
          <span>{dateLabel}</span>
        </div>
        <svg className={`w-4 h-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="px-5 pb-4 space-y-3 text-sm text-slate-700 border-t border-slate-200 pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-slate-500 text-xs">Model</div>
              <div className="font-semibold">{modelLabel}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs">Retrieval policy</div>
              <div className="font-semibold">{auditTrace.retrievalPolicy}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs">Generated at</div>
              <div className="font-semibold">{dateLabel}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs">Prompt versions</div>
              <div className="font-semibold text-xs">
                {auditTrace.promptVersions && Object.keys(auditTrace.promptVersions).length > 0
                  ? Object.entries(auditTrace.promptVersions).map(([k, v]) => `${k}: ${v}`).join(', ')
                  : '—'}
              </div>
            </div>
          </div>
          {auditTrace.notes && auditTrace.notes.length > 0 && (
            <div>
              <div className="text-slate-500 text-xs mb-1">Synthesis notes</div>
              <ul className="space-y-1 text-slate-600">
                {auditTrace.notes.map((note) => (
                  <li key={note} className="text-xs">• {note}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="text-slate-500 text-xs mb-1">Query plan</div>
            <ul className="space-y-1 text-slate-600">
              {auditTrace.queryPlan.map((step) => (
                <li key={step} className="text-xs">• {step}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function getPaperUrl(row: EvidenceRow, work?: Work): string | null {
  if (row.doi) return `https://doi.org/${row.doi}`;
  return row.url || work?.openAccessPdfUrl || null;
}

function getAbstractDisplay(work: Work | undefined): { label: string; note: string | null } {
  const backfill = work?.abstractBackfill;
  if (backfill?.status === 'generated_summary_no_formal_abstract') {
    return {
      label: 'Abstract-like summary',
      note: backfill.provenance_note || 'No formal abstract available; summary generated from title/metadata/first page.',
    };
  }
  return { label: 'Abstract', note: null };
}

type WorkType = 'journal' | 'working_paper' | 'institutional' | 'other';

function classifyWorkType(work: Work | undefined): WorkType {
  if (!work) return 'other';
  const inst = (work.institution || '').toLowerCase();
  const venue = (work.venue || '').toLowerCase();
  const src = (work.source || '').toLowerCase();
  const title = (work.title || '').toLowerCase();

  // 1. Working-paper signals (most specific first — many WPs also list an institution).
  const wpKeys = ['nber', 'ssrn', 'iza', 'cepr', 'working paper', 'discussion paper', 'preprint', 'arxiv', 'mimeo'];
  if (wpKeys.some((k) => venue.includes(k) || src.includes(k) || title.includes('working paper') || title.includes('discussion paper'))) {
    return 'working_paper';
  }

  // 2. Institutional sources — multilateral / IFI / international-org reports.
  // Only flag as institutional when there is NO venue (a journal name), since
  // journal articles co-authored by IFI staff should still classify as 'journal'.
  const instKeys = [
    'inter-american development bank', 'iadb', 'idb',
    'world bank',
    'international monetary fund', 'imf',
    'oecd',
    'world health organization', 'who',
    'pan american health', 'paho',
    'eclac', 'cepal',
    'unicef', 'unesco', 'undp', 'ilo', 'fao', 'unctad',
  ];
  const hasInstSignal = (inst && instKeys.some((k) => inst.includes(k)))
    || src.includes('idb_pubs') || src.includes('worldbank');
  if (hasInstSignal && !venue) return 'institutional';

  // 3. Journal — any paper with a venue (journal name) or an ABS rating.
  // Papers with both a venue AND an institutional affiliation are journal articles.
  if (venue || work.absRating) return 'journal';

  // 4. Institutional fallback — has institutional signal but no venue.
  if (hasInstSignal) return 'institutional';

  return 'other';
}

const TYPE_BADGE: Record<WorkType, { label: string; cls: string }> = {
  journal: { label: 'Journal', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  working_paper: { label: 'Working paper', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  institutional: { label: 'Institutional', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  other: { label: 'Other', cls: 'bg-slate-50 text-slate-600 border-slate-200' },
};

function getDisplaySourceLabel(work: Work | undefined, rowSourceName?: string): string {
  const cleanRowSource = rowSourceName && rowSourceName !== 'Unknown' ? rowSourceName : '';
  if (work?.venue) return work.venue;
  if (cleanRowSource) return cleanRowSource;
  if (work?.institution) return work.institution;
  if (work?.source) return work.source;
  return getSourceLabel(work);
}

function getPublicationTypeBadge(
  work: Work | undefined,
  rowSourceName: string | undefined,
  lang: BriefViewProps['selectedLanguage'],
): { label: string; cls: string } {
  const fallbackType = classifyWorkType(work);
  const fallbackBadge = TYPE_BADGE[fallbackType];
  if (work?.publicationType) {
    return {
      label: pubTypeLabel(work.publicationType, lang),
      cls: fallbackBadge.cls,
    };
  }

  if (!work) {
    const s = (rowSourceName || '').toLowerCase();
    const rowType: WorkType =
      /nber|ssrn|iza|cepr|working paper|discussion paper|preprint/.test(s) ? 'working_paper'
      : /world bank|imf|oecd|iadb|\bidb\b|cepal|paho|who|unicef|unesco|undp|ilo/.test(s) ? 'institutional'
      : s && s !== 'unknown' && s !== 'â€”' ? 'journal'
      : 'other';
    return TYPE_BADGE[rowType];
  }

  return fallbackBadge;
}

function getSourceLabel(work: Work | undefined): string {
  if (!work) return '—';
  if (work.venue) return work.venue;
  if (work.institution) return work.institution;
  // Fallback: working-paper indicators in title
  const title = (work.title || '').toLowerCase();
  if (title.includes('nber working paper')) return 'NBER Working Paper';
  if (title.includes('working paper')) return 'Working Paper';
  if (title.includes('discussion paper')) return 'Discussion Paper';
  return '—';
}

/**
 * Map a paper to its specific source bucket (IDB, World Bank, NBER, etc.) so
 * users can verify at a glance whether a filter is bringing in what they
 * intended. Returns null for journal articles that don't match a named bucket
 * — those just show the venue name.
 */
function getSourceBucket(
  work: Work | undefined,
  rowSourceName?: string,
): { label: string; cls: string } | null {
  const family = work?.sourceFamily?.trim();
  const familyClasses: Record<string, string> = {
    IADB: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    'World Bank': 'bg-blue-100 text-blue-800 border-blue-200',
    IMF: 'bg-cyan-100 text-cyan-800 border-cyan-200',
    OECD: 'bg-purple-100 text-purple-800 border-purple-200',
    ECLAC: 'bg-violet-100 text-violet-800 border-violet-200',
    NBER: 'bg-amber-100 text-amber-800 border-amber-200',
    SSRN: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    IZA: 'bg-orange-100 text-orange-800 border-orange-200',
    CEPR: 'bg-rose-100 text-rose-800 border-rose-200',
    RePEc: 'bg-slate-100 text-slate-700 border-slate-200',
  };
  if (family && familyClasses[family]) return { label: family, cls: familyClasses[family] };

  const haystack = [
    (work?.venue || '').toLowerCase(),
    (work?.institution || '').toLowerCase(),
    (work?.source || '').toLowerCase(),
    (work?.title || '').toLowerCase(),
    (rowSourceName || '').toLowerCase(),
  ].join(' ');
  if (!haystack.trim()) return null;

  const buckets: Array<{ label: string; cls: string; keys: Array<string | RegExp> }> = [
    { label: 'IDB',        cls: 'bg-indigo-100 text-indigo-800 border-indigo-200',  keys: ['inter-american development bank', 'iadb', 'idb publications', 'publications.iadb', 'idb_pubs', /\bidb\b/] },
    { label: 'World Bank', cls: 'bg-blue-100 text-blue-800 border-blue-200',        keys: ['world bank', 'worldbank'] },
    { label: 'IMF',        cls: 'bg-cyan-100 text-cyan-800 border-cyan-200',        keys: ['international monetary fund', /\bimf\b/] },
    { label: 'OECD',       cls: 'bg-purple-100 text-purple-800 border-purple-200',  keys: ['oecd'] },
    { label: 'ECLAC',      cls: 'bg-violet-100 text-violet-800 border-violet-200',  keys: ['eclac', 'cepal'] },
    { label: 'WHO/PAHO',   cls: 'bg-pink-100 text-pink-800 border-pink-200',        keys: ['world health organization', /\bwho\b/, 'pan american health', 'paho'] },
    { label: 'UN agency',  cls: 'bg-sky-100 text-sky-800 border-sky-200',           keys: ['unicef', 'unesco', 'undp', /\bilo\b/, 'fao', 'unctad'] },
    { label: 'NBER',       cls: 'bg-amber-100 text-amber-800 border-amber-200',     keys: ['nber'] },
    { label: 'SSRN',       cls: 'bg-yellow-100 text-yellow-800 border-yellow-200',  keys: ['ssrn'] },
    { label: 'IZA',        cls: 'bg-orange-100 text-orange-800 border-orange-200',  keys: ['iza'] },
    { label: 'CEPR',       cls: 'bg-rose-100 text-rose-800 border-rose-200',        keys: ['cepr'] },
    { label: 'arXiv',      cls: 'bg-slate-100 text-slate-700 border-slate-200',     keys: ['arxiv'] },
  ];

  for (const b of buckets) {
    const hit = b.keys.some((k) =>
      typeof k === 'string' ? haystack.includes(k) : k.test(haystack),
    );
    if (hit) return { label: b.label, cls: b.cls };
  }
  return null;
}

function qualityBadge(work: Work | undefined): { label: string; cls: string } {
  if (!work || work.smsLevel == null) {
    return { label: '—', cls: 'bg-slate-50 text-slate-400 border border-slate-200' };
  }
  if (work.smsLevel >= 4) return { label: 'High', cls: 'bg-emerald-100 text-emerald-800' };
  if (work.smsLevel === 3) return { label: 'Med', cls: 'bg-amber-100 text-amber-800' };
  // SMS 0 = Review/Theory (non-empirical), distinct from low-rigor empirical (1-2).
  if (work.smsLevel === 0) return { label: 'Review / Theory', cls: 'bg-slate-100 text-slate-500' };
  return { label: 'Low', cls: 'bg-slate-100 text-slate-600' };
}

const CHANNEL_COLORS: Record<string, string> = {
  'Causal':    'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Found.':    'bg-indigo-50 text-indigo-700 border-indigo-200',
  'Recent':    'bg-amber-50 text-amber-700 border-amber-200',
  'LAC':       'bg-teal-50 text-teal-700 border-teal-200',
  'Deep scan': 'bg-violet-50 text-violet-700 border-violet-200',
  'General':   'bg-slate-100 text-slate-500 border-slate-200',
};

function tagChannels(row: EvidenceRow, work?: Work): string[] {
  // PREFER the TRUE persisted channel-of-origin when present (set from
  // SearchRun.workChannels). This reflects which channel actually surfaced the
  // paper and supersedes the deterministic recompute below — it's what stops
  // "Found." leaking onto papers a different channel surfaced. The quality tier
  // (Causal > Found. > Recent) is collapsed to ONE pill; LAC stays orthogonal.
  if (Array.isArray(row.retrievalChannels) && row.retrievalChannels.length > 0) {
    const ids = row.retrievalChannels;
    const tags: string[] = [];
    if (ids.includes('causal')) tags.push('Causal');
    else if (ids.includes('foundational')) tags.push('Found.');
    else if (ids.includes('recent')) tags.push('Recent');
    // 'deepscan' is a provenance tag (NOT a retrieval channel — never in
    // VALID_CHANNEL_IDS): the paper was surfaced by the opt-in Deep scan pass.
    else if (ids.includes('deepscan')) tags.push('Deep scan');
    if (ids.includes('lac')) tags.push('LAC');
    if (tags.length === 0 || (tags.length === 1 && tags[0] === 'LAC')) tags.push('General');
    return tags;
  }

  const sms       = row.smsLevel ?? work?.smsLevel ?? 0;
  const year      = row.year ?? work?.year ?? 0;
  const citations = row.citationCount ?? (work as any)?.citationCount ?? 0;
  const design    = (row.methodologyBadge ?? work?.methodologyDesign ?? '').toLowerCase();
  const geo       = [
    ...(row.geography ?? []),
    ...(work?.geography ?? []),
  ].map(g => g.toLowerCase());

  const causalDesigns = ['rct', 'did', 'difference', 'instrumental', 'iv', 'rdd', 'regression discontinuity'];
  const isCausal = sms >= 4 || causalDesigns.some(d => design.includes(d));
  // Found. = pre-2020 with meaningful citation count. Server sets isFoundational
  // based on DB citation_count; client-side check is the fallback.
  const isFoundational = row.isFoundational || (citations >= 75 && year > 0 && year < 2020);
  const isRecent = year >= 2020;

  const lacTerms = [
    'latin america', 'caribbean', 'brazil', 'mexico', 'colombia', 'peru',
    'chile', 'argentina', 'ecuador', 'bolivia', 'costa rica', 'panama',
    'lac', 'south america', 'central america', 'iadb', 'idb',
  ];
  const isLac = geo.some(g => lacTerms.some(t => t && g.includes(t)));

  const tags: string[] = [];
  // ONE quality-tier pill, priority-ordered (Causal > Found. > Recent), so pills
  // are deterministic and never overlap/contradict — this stops "Found." leaking
  // onto papers a different channel actually surfaced. INTERIM: when true
  // channel-of-origin is persisted per search, that supersedes this recompute;
  // this remains the fallback for briefs without stored channel provenance.
  if (isCausal) tags.push('Causal');
  else if (isFoundational) tags.push('Found.');
  else if (isRecent) tags.push('Recent');

  if (isLac) tags.push('LAC'); // geographic, orthogonal to the quality tier

  // If nothing matched (or only LAC), show General so every paper has a tier pill.
  if (tags.length === 0 || (tags.length === 1 && tags[0] === 'LAC')) tags.push('General');
  return tags;
}

// Table: the cosine-relevance floor decides membership (variable size — typically
// well under the EVIDENCE_TABLE_CAP=50 CEILING; trimmed-but-relevant papers go to
// load-more). Brief and table use the SAME pool — synthesis's SYNTHESIS_EVIDENCE_CAP
// is single-sourced from EVIDENCE_TABLE_CAP, so the table IS the source of truth.
// Initial display: 10 rows, +10 per click up to the full cap.
// Default sort: channel-driven (foundational→citations, recent→year, else→sms).
const ROWS_DEFAULT = 10;
const ROWS_PER_LOAD = 10;

// ---------------------------------------------------------------------------
// EvidenceTableRow — memoized so the 50-row table doesn't re-render on every
// parent state change (modal open, toast, sort, etc.).
// ---------------------------------------------------------------------------
interface EvidenceTableRowProps {
  row: EvidenceRow;
  work: Work | undefined;
  index: number;
  isSelected: boolean;
  showDetails: boolean;
  savedWorkIds: Set<string> | undefined;
  dislikePopoverWorkId: string | null;
  setDislikePopoverWorkId: (id: string | null) => void;
  openPaperDetail: (workId: string) => void;
  onFeedback: BriefViewProps['onFeedback'];
  onStarWork?: BriefViewProps['onStarWork'];
  onExcludeWork?: BriefViewProps['onExcludeWork'];
  selectedLanguage: BriefViewProps['selectedLanguage'];
  showToast: (msg: string) => void;
  setModalWorkId: (id: string | null) => void;
  evidenceClassification: BriefViewProps['evidenceClassification'];
  worksById: Record<string, Work>;
  onRemoveManualPaper?: (workId: string) => void;
}

const EvidenceTableRow = React.memo(function EvidenceTableRow({
  row,
  work,
  index,
  isSelected,
  showDetails,
  savedWorkIds,
  dislikePopoverWorkId,
  setDislikePopoverWorkId,
  openPaperDetail,
  onFeedback,
  onStarWork,
  onExcludeWork,
  selectedLanguage,
  showToast,
  setModalWorkId,
  evidenceClassification,
  worksById,
  onRemoveManualPaper,
}: EvidenceTableRowProps) {
  const isStarred = work?.starred === true;
  const isExcluded = work?.excluded === true;

  // Use the same venue-first source label as export; row.sourceName
  // covers older rows that are not present in the snapshot map.
  const sourceLabel = getDisplaySourceLabel(work, row.sourceName);
  const typeBadge = getPublicationTypeBadge(work, row.sourceName, selectedLanguage);
  const rowAuthors = toStrArr(row.authors);
  const resolvedAuthors = rowAuthors.length > 0
    ? rowAuthors
    : toStrArr(work?.authors);
  const authorsLabel = resolvedAuthors.length > 0
    ? `${resolvedAuthors.slice(0, 2).join(', ')}${resolvedAuthors.length > 2 ? ' et al.' : ''}`
    : '—';

  const rowSmsLevel = getRowSmsLevel(row, work);
  const rowGeography = getRowGeography(row, work);
  const designLabel = getRowMethodologyDesign(row, work);
  const sampleInfo = (() => {
    const text = `${work?.smsRationale || ''} ${work?.abstract || ''}`;
    const match = text.match(/(?:n\s*=\s*|sample of\s+|N\s*=\s*)([\d,]{2,})/i);
    return match ? `n = ${match[1]}` : null;
  })();
  const abstractText = work?.summary || work?.abstract || row.finding || '';
  const abstractExcerpt = abstractText.length > 600
    ? abstractText.slice(0, 600).trim() + '…'
    : abstractText;
  const abstractDisplay = getAbstractDisplay(work);
  const paperUrl = getPaperUrl(row, work);

  return (
    <React.Fragment>
    <tr
      data-work-id={row.workId}
      className={`border-t border-slate-100 align-top transition ${
        isSelected
          ? 'bg-cyan-50'
          : isExcluded
          ? 'bg-rose-50/40 opacity-60'
          : 'hover:bg-slate-50/70'
      }`}
    >
      {/* Rank */}
      <td
        className="py-4 pl-6 pr-2 text-slate-400 text-xs tabular-nums cursor-pointer"
        onClick={() => openPaperDetail(row.workId)}
      >
        {index + 1}
      </td>

      {/* Title */}
      <td
        className="py-4 pr-3 cursor-pointer"
        onClick={() => openPaperDetail(row.workId)}
      >
        <div className={`font-semibold leading-snug text-sm ${isSelected ? 'text-teal-700' : 'text-slate-900'} flex items-start gap-1.5`}>
          {/* Topicality (2026-06-25): only OFF-topic is marked — the
              reliable binary signal — with a "*" footnote (see note above
              the table). Core/Context not shown (fuzzy + crowds). OFF rows
              also sink to the bottom of the table via sortedRows. */}
          <span className="flex-1">
            {row.isManualAdd && (
              <span className="flex items-center gap-1.5 mb-0.5">
                <span className="rounded-full bg-violet-100 text-violet-700 border border-violet-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">
                  Added
                </span>
                {onRemoveManualPaper && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveManualPaper(row.workId); }}
                    className="text-slate-400 hover:text-red-500 transition"
                    title="Remove this paper"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                )}
              </span>
            )}
            {row.title}
            {row.isManualAdd && !worksById[row.workId] && (
              <span
                title="This paper was added manually and is not in the verified corpus"
                className="ml-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide align-middle"
              >
                Unverified
              </span>
            )}
            {row.segment === 'off' && (
              <span
                className="text-amber-600 font-bold"
                title="Flagged as likely off-topic for this query — kept for transparency, sorted to the bottom."
              >{' *'}</span>
            )}
          </span>
          {false && (() => {
            const cls = evidenceClassification?.[row.workId];
            if (!cls || cls.evidenceMatch === 'excluded') return null;
            // Prefer the four-bucket `classification` field; fall back to
            // collapsed `evidenceMatch` for legacy runs that lack it.
            const fine = cls.classification ?? cls.evidenceMatch;
            const isDirectLac    = fine === 'direct-lac';
            const isDirectGlobal = fine === 'direct-global' || (fine === 'direct' && !isDirectLac);
            const isDirect = isDirectLac || isDirectGlobal;
            const label = isDirectLac    ? 'DIRECT · LAC'
                        : isDirectGlobal ? 'DIRECT · GLOBAL'
                        : 'INDIRECT';
            const matched = cls.facetsMatched.join(', ') || '—';
            const missed = cls.facetsMissed.join(', ');
            // LLM rationale is the most useful tooltip when present —
            // it's the LLM's own one-sentence explanation of the call.
            const tip = cls.llmRationale
              ? cls.llmRationale
              : isDirect
                ? `Direct match — covers all query facets: ${matched}${isDirectLac ? ' · LAC geography matched' : ' · no LAC geography match'}`
                : `Indirect match — covers: ${matched}${missed ? ` · missing: ${missed}` : ''}`;
            return (
              <span
                className={`flex-shrink-0 mt-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded tracking-wide ${
                  isDirectLac
                    ? 'bg-teal-100 text-teal-800 border border-teal-300'
                    : isDirectGlobal
                      ? 'bg-sky-50 text-sky-700 border border-sky-200'
                      : 'bg-slate-100 text-slate-600 border border-slate-300'
                }`}
                title={tip}
              >
                {label}
              </span>
            );
          })()}
          {row.sourceLanguage === 'es' && (
            <span className="flex-shrink-0 mt-0.5 text-[9px] font-bold px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 tracking-wide" title="Source paper is in Spanish">
              ES
            </span>
          )}
        </div>
        {authorsLabel !== '—' && (
          <div className="mt-0.5 text-[10px] text-slate-500 leading-tight truncate max-w-[280px]">
            {authorsLabel}
          </div>
        )}
        {sourceLabel && (
          <div className="mt-0.5 text-[10px] text-slate-400 italic leading-tight truncate max-w-[280px]">
            {sourceLabel}
          </div>
        )}
        {/* Mobile-only: show year + source under title since those columns are hidden */}
        <div className="md:hidden mt-1 flex items-center gap-1.5 text-[11px] text-slate-400 flex-wrap">
          {row.year && <span className="tabular-nums">{row.year}</span>}
          {row.year && sourceLabel && <span>·</span>}
          {sourceLabel && <span className="italic truncate max-w-[160px]">{sourceLabel}</span>}
        </div>
      </td>

      {/* Year — hidden on mobile */}
      <td className="hidden md:table-cell py-4 pr-3 text-xs text-slate-600 tabular-nums">
        {row.year || '—'}
      </td>

      {/* SMS — hidden on mobile */}
      <td className="hidden md:table-cell py-4 pr-3 text-xs tabular-nums text-center">
        {(() => {
          const sms = getRowSmsLevel(row, work);
          // SMS 0 is a real value (Review / Theory) — use == null, not falsy,
          // so a 0 doesn't collapse to the unscored em-dash.
          if (sms == null) return <span className="text-slate-300">—</span>;
          const cls = sms >= 4 ? 'text-emerald-700 font-semibold' : sms === 3 ? 'text-teal-600' : 'text-slate-400';
          const label = sms === 0 ? 'Review / Theory' : sms === 5 ? 'RCT' : sms === 4 ? 'Quasi-experimental' : sms === 3 ? 'Observational credible' : sms === 2 ? 'Descriptive' : 'Qualitative';
          return <span className={cls} title={`SMS ${sms}: ${label}`}>{sms}</span>;
        })()}
      </td>

      {/* Channel — hidden on mobile */}
      <td className="hidden md:table-cell py-4 pr-3">
        <div className="flex flex-wrap gap-1">
          {tagChannels(row, work).map((ch) => (
            <span
              key={ch}
              className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${CHANNEL_COLORS[ch] ?? CHANNEL_COLORS['General']}`}
              title={
                ch === 'Causal' ? 'Causal: uses RCT, DiD, IV, or RDD; or SMS 4–5' :
                ch === 'Found.' ? 'Foundational: pre-2020 paper with 75+ citations — landmark work' :
                ch === 'Recent' ? 'Recent: published 2020 or later' :
                ch === 'LAC' ? 'LAC: study conducted in Latin America & the Caribbean' :
                ch === 'Deep scan' ? 'Deep scan: surfaced by the follow-up deep-scan pass over literatures the first retrieval missed' :
                'General: no specific channel tag applies'
              }
            >
              {ch}
            </span>
          ))}
        </div>
      </td>

      {/* Actions: Save / 👍 / 👎 */}
      <td className="py-4 pr-6">
        <div className="flex items-center justify-center gap-0 md:gap-1.5">
          {savedWorkIds?.has(row.workId) ? (
            <span
              title="Saved in library"
              className="w-11 h-11 md:w-7 md:h-7 rounded-full bg-teal-50 text-teal-600 flex items-center justify-center"
              aria-label="Saved in library"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onFeedback('save', row.workId); showToast('Paper saved to library'); }}
              title="Save to library"
              className="w-11 h-11 md:w-7 md:h-7 rounded-full hover:bg-teal-50 hover:text-teal-700 text-slate-500 flex items-center justify-center transition"
              aria-label="Save to library"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onStarWork && onStarWork(row.workId, !isStarred); }}
            title={isStarred ? 'Liked — keep similar papers in your feed (click to undo)' : 'Helpful — keep similar papers in your personalized feed'}
            className={`w-11 h-11 md:w-7 md:h-7 rounded-full flex items-center justify-center transition ${
              isStarred ? 'bg-emerald-100 text-emerald-700' : 'hover:bg-emerald-50 hover:text-emerald-700 text-slate-500'
            }`}
            aria-label="Mark as helpful"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isStarred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
            </svg>
          </button>
          {/* 👎 — split popover: "Not relevant" vs "What's wrong?" */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setDislikePopoverWorkId(dislikePopoverWorkId === row.workId ? null : row.workId);
              }}
              title="Not relevant or something wrong with this paper?"
              className={`w-11 h-11 md:w-7 md:h-7 rounded-full flex items-center justify-center transition ${
                isExcluded ? 'bg-rose-100 text-rose-700' : 'hover:bg-rose-50 hover:text-rose-700 text-slate-500'
              }`}
              aria-label="Feedback on this paper"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={isExcluded ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
              </svg>
            </button>
            {dislikePopoverWorkId === row.workId && (
              <div className="absolute right-0 top-9 z-30 w-52 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden text-sm">
                <button
                  className="w-full text-left px-4 py-3 hover:bg-rose-50 transition flex flex-col gap-0.5 border-b border-slate-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExcludeWork && onExcludeWork(row.workId, true);
                    setDislikePopoverWorkId(null);
                    showToast('Paper marked as not relevant');
                  }}
                >
                  <span className="font-semibold text-rose-700">Not relevant</span>
                  <span className="text-xs text-slate-500">Remove from this brief and suppress similar papers.</span>
                </button>
                <button
                  className="w-full text-left px-4 py-3 hover:bg-amber-50 transition flex flex-col gap-0.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDislikePopoverWorkId(null);
                    setModalWorkId(row.workId + '__correction');
                  }}
                >
                  <span className="font-semibold text-amber-700">Something's wrong with this data</span>
                  <span className="text-xs text-slate-500">Flag a data quality issue for admin review.</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
    {showDetails && (
      <tr className="bg-slate-50/60 border-t border-slate-100">
        <td></td>
        <td colSpan={6} className="py-3 pr-6 text-[12px] text-slate-700">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            {rowSmsLevel != null ? (
              <ExplainableBadge
                label={`SMS ${rowSmsLevel} · ${qualityBadge(work ? { ...work, smsLevel: rowSmsLevel } as Work : undefined).label}`}
                colorClass={`${qualityBadge(work ? { ...work, smsLevel: rowSmsLevel } as Work : undefined).cls} text-[10px] font-bold`}
                explanation={work ? buildSmsExplanation({ ...work, smsLevel: rowSmsLevel } as Work) : `SMS ${rowSmsLevel}`}
                paperUrl={paperUrl}
              />
            ) : work ? (
              <ExplainableBadge
                label="SMS —"
                colorClass="bg-slate-100 text-slate-500 border border-slate-200 text-[10px] font-bold"
                explanation={buildUnscoredExplanation(work)}
                paperUrl={paperUrl}
              />
            ) : null}
            {designLabel && (
              <span className="text-[11px] font-medium text-slate-700 bg-white border border-slate-200 px-2 py-0.5 rounded-md">
                {designLabel}
              </span>
            )}
            {sampleInfo && (
              <span className="text-[11px] text-slate-600 tabular-nums bg-white border border-slate-200 px-2 py-0.5 rounded-md">
                {sampleInfo}
              </span>
            )}
            {rowGeography.length > 0 && (
              <span className="text-[11px] text-slate-600 bg-white border border-slate-200 px-2 py-0.5 rounded-md">
                {rowGeography.slice(0, 3).join(', ')}
              </span>
            )}
          </div>
          {abstractExcerpt ? (
            <p className="text-[12px] text-slate-700 leading-relaxed">
              <span className="font-semibold text-slate-500 uppercase tracking-wider text-[10px] mr-1.5">{abstractDisplay.label}</span>
              {abstractExcerpt}
              {abstractDisplay.note && (
                <span className="block mt-1 text-[11px] italic text-slate-500">{abstractDisplay.note}</span>
              )}
              {paperUrl && (
                <>
                  {' '}
                  <a
                    href={paperUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-teal-700 hover:text-teal-900 font-semibold underline"
                  >
                    Read full paper →
                  </a>
                </>
              )}
            </p>
          ) : (
            <p className="text-[11px] italic text-slate-400">No abstract available in corpus.</p>
          )}
        </td>
      </tr>
    )}
    </React.Fragment>
  );
});

const BriefView: React.FC<BriefViewProps> = ({
  brief,
  worksById,
  filters,
  isLoading,
  isSynthesizing,
  streamingText,
  error,
  timeRange,
  onTimeRangeChange,
  onLoadMore,
  isLoadingMore,
  showLoadMoreSuggestion,
  onFeedback,
  isAdmin,
  onExcludeWork,
  onStarWork,
  onVisibleRowsChange,
  onExportJson,
  onExportDocx,
  onCopyBrief,
  onShare,
  onRetry,
  onFollowUpQuestion,
  savedWorkIds,
  evidenceClassification,
  facetCoverage,
  selectedLanguage,
  onLanguageChange,
  activeFilters,
  originalFilters,
  setActiveFilters,
  candidatePool,
  onRegenerateBrief,
  isRegenerating,
  onResolvePaper,
  onWriteSurvey,
  writeSurveyPending,
  onGenerateJelPaper,
  jelPaperStatus,
  jelPaperProgress,
  jelPaperErrorMessage,
  onJelPaperDone,
  layoutMode = 'two-column',
  activeChannels,
}) => {
  // Default sort driven by active channel: causal→sms, foundational→citations,
  // recent→year, lac/default→sms. This aligns the table with the brief's focus.
  const channelDefaultSort = (channels: Set<string> | undefined): SortField => {
    if (!channels || channels.size === 0) return 'sms';
    if (channels.has('foundational') && !channels.has('causal')) return 'citations';
    if (channels.has('recent') && !channels.has('causal') && !channels.has('foundational')) return 'year';
    return 'sms';
  };
  const [sortField, setSortField] = useState<SortField>(() => channelDefaultSort(activeChannels));
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  // Re-sync sort when the active channels change (e.g. new search with different channels).
  // Use a stable string key so the effect fires on content change, not Set identity.
  const channelKey = [...(activeChannels ?? [])].sort().join(',');
  useEffect(() => {
    setSortField(channelDefaultSort(activeChannels));
    setSortDirection('desc');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey]);
  const [showLegend, setShowLegend] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [queryExpanded, setQueryExpanded] = useState(false);
  // Mobile view toggle — Brief or Evidence table. Desktop always shows both.
  const [mobileView, setMobileView] = useState<'brief' | 'evidence'>('brief');
  // Mobile filter sheet
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Resizable brief/table split (desktop only). Persisted brief-column width %.
  const [briefPct, setBriefPct] = useState<number>(() => {
    const v = Number(localStorage.getItem('briefSplitPct'));
    return v >= 25 && v <= 75 ? v : 55;
  });
  const [isDesktopSplit, setIsDesktopSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setIsDesktopSplit(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  const startSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setBriefPct(Math.min(75, Math.max(25, pct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      setBriefPct((p) => { try { localStorage.setItem('briefSplitPct', String(Math.round(p))); } catch { /* ignore */ } return p; });
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  // Mobile overflow menu (Export + Generate Paper)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  // Paper detail modal — replaces the PaperSidePanel that fought for space
  // in the 45% table column. Click any row → full-screen overlay card.
  const [modalWorkId, setModalWorkId] = useState<string | null>(null);
  // Open the paper-detail modal AND emit a paper_detail.opened usage event
  // (target = the work). High-volume but acceptable per the telemetry spec.
  const openPaperDetail = useCallback((workId: string) => {
    logEvent({ eventType: 'paper_detail.opened', targetType: 'work', targetId: workId, status: 'completed', payload: { briefId: brief?.id } });
    setModalWorkId(workId);
  }, [brief?.id]);
  // Thumbs-down popover: track which row is showing the split popover
  const [dislikePopoverWorkId, setDislikePopoverWorkId] = useState<string | null>(null);
  // Data-quality correction form state — previously uncontrolled inputs whose
  // values were silently discarded on "Submit for review".
  const [correctionChecked, setCorrectionChecked] = useState<Record<string, boolean>>({});
  const [correctionValues, setCorrectionValues] = useState<Record<string, string>>({});
  const [correctionNotes, setCorrectionNotes] = useState('');
  useEffect(() => { setCorrectionChecked({}); setCorrectionValues({}); setCorrectionNotes(''); }, [modalWorkId]);
  // Expanded state for the strongest-evidence finding — when truncated, the
  // user can click "Show more" to read the full abstract inline.
  const [strongestFindingExpanded, setStrongestFindingExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState<number>(ROWS_DEFAULT);
  const [showDetails, setShowDetails] = useState<boolean>(false);
  // Evidence table is now stacked inside the left column under the synthesis
  // (Option A). Defaulting to expanded since it's in the natural reading
  // position. The toggle still lets users collapse to save vertical space.
  const [showEvidenceTable, setShowEvidenceTable] = useState(true);
  // § 2 Methodology — inline in synthesis column, open by default so the
  // SMS bar + methods mix are visible without an extra click.
  const [showMethodology, setShowMethodology] = useState(true);
  // § 3 Coverage — collapsible expander at bottom of synthesis column.
  // Starts collapsed (user can expand when they want the detailed breakdown).
  const [showCoverage, setShowCoverage] = useState(false);
  // Work IDs from candidatePool that the user has loaded past the brief's
  // evidence rows. These render as shell rows in the table and, when present,
  // surface the "Regenerate brief with N papers" button.
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [manualPapers, setManualPapers] = useState<PaperPlanUpload[]>([]);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addInputMode, setAddInputMode] = useState<'doi' | 'paste' | 'pdf'>('pdf');
  const [addDoiInput, setAddDoiInput] = useState('');
  const [addPastedText, setAddPastedText] = useState('');
  const [addPdfFile, setAddPdfFile] = useState<File | null>(null);
  const [addStatus, setAddStatus] = useState<'idle' | 'resolving' | 'preview' | 'error'>('idle');
  const [addPreview, setAddPreview] = useState<PaperPlanUpload | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  // POLICY-ONLY: new briefs are always 'policy'. We still read the STORED
  // persona so old briefs (technical/jel/twitter/etc.) keep their display
  // affordances (e.g. the 'jel' "Survey" header); the fallback is now 'policy'.
  const currentPersona: PersonaId = (brief?.auditTrace?.persona as PersonaId) || 'policy';

  // Reset selected paper, pagination, and details panel when brief changes
  useEffect(() => {
    setSelectedWorkId(null);
    setModalWorkId(null);
    setDislikePopoverWorkId(null);
    setVisibleCount(ROWS_DEFAULT);
    setShowDetails(false);
    setExtraIds([]);
    setShowMethodology(true);
    setShowCoverage(false);
    setManualPapers([]);
    setShowAddPanel(false);
  }, [brief?.id]);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2000);
  }, []);

  function handleSortClick(field: SortField) {
    if (field === 'relevance') {
      setSortField('relevance');
      setSortDirection('desc');
      return;
    }
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  }

  async function handleAddPaper() {
    if (!onResolvePaper) return;
    setAddStatus('resolving');
    setAddError(null);
    setAddPreview(null);
    try {
      let pastedText: string | undefined;
      let doiOrUrl: string | undefined;

      if (addInputMode === 'doi') {
        doiOrUrl = addDoiInput.trim();
        if (!doiOrUrl) { setAddError('Enter a DOI or URL.'); setAddStatus('error'); return; }
      } else if (addInputMode === 'paste') {
        pastedText = addPastedText.trim();
        if (!pastedText) { setAddError('Paste some text first.'); setAddStatus('error'); return; }
      } else {
        pastedText = addPastedText.trim();
        if (!pastedText) { setAddError('Could not read the PDF.'); setAddStatus('error'); return; }
      }

      const result = await onResolvePaper({ doiOrUrl, pastedText });
      const existingIds = new Set([
        ...((brief?.sections.evidenceRows ?? []).map((r) => r.workId)),
        ...manualPapers.map((p) => p.matchedWorkId ?? p.doi ?? p.uploadId),
      ]);
      const incomingId = result.matchedWorkId ?? result.doi ?? result.uploadId;
      if (existingIds.has(incomingId)) {
        setAddError('This paper is already in the brief.');
        setAddStatus('error');
        return;
      }
      setAddPreview(result);
      setAddStatus('preview');
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not resolve paper.');
      setAddStatus('error');
    }
  }

  function handleConfirmAdd() {
    if (!addPreview) return;
    setManualPapers((prev) => [...prev, addPreview!]);
    setAddPreview(null);
    setAddStatus('idle');
    setAddDoiInput('');
    setAddPastedText('');
    setAddPdfFile(null);
    setShowAddPanel(false);
  }

  async function handlePdfFile(file: File) {
    setAddPdfFile(file);
    try {
      const { extractDocText } = await import('../services/extractDocText');
      const { text } = await extractDocText(file);
      setAddPastedText(text);
    } catch {
      setAddError('Could not extract text from PDF.');
    }
  }

  // Filter predicate is rebuilt only when filters change. Mirrors backend
  // retrieval.ts post-filter logic — see services/filterPredicate.ts.
  const filterPredicate = useMemo(
    () => buildFilterPredicate(filters, resolveYearBounds(filters)),
    [filters],
  );

  const qualityFilteredRows = useMemo<EvidenceRow[]>(() => {
    if (!brief) return [];
    const base = (brief.sections.evidenceRows ?? []).filter((row) =>
      filterPredicate(worksById[row.workId], row),
    );
    // Append shell rows for IDs the user loaded from the broader admissible
    // pool. These don't have a synthesized `finding` field yet — that fills in
    // when the user regenerates the brief. Same quality filter applies.
    if (extraIds.length === 0) return base;
    const existingIds = new Set(base.map((r) => r.workId));
    const extras: EvidenceRow[] = [];
    for (const id of extraIds) {
      if (existingIds.has(id)) continue;
      const w = worksById[id];
      if (!w) continue;
      const shell: EvidenceRow = {
        workId: w.id,
        title: w.title,
        authors: w.authors || [],
        sourceName: w.venue || w.institution || w.source || 'Unknown',
        year: w.year ?? 0,
        methodologyBadge: w.methodologyDesign || 'Unclassified',
        causalStrength: w.causalStrength || 'signal',
        smsLevel: w.smsLevel ?? null,
        geography: w.geography || [],
        doi: w.canonicalDoi,
        url: w.url || w.openAccessPdfUrl || '',
        finding: w.summary || w.abstract || '',
      };
      if (filterPredicate(w, shell)) extras.push(shell);
    }
    return [...base, ...extras];
  }, [brief, worksById, filterPredicate, extraIds]);

  // Pool of work IDs from the broader admissible set the user can still load.
  // Excludes anything already in the brief's evidence rows and anything the
  // user has already pulled in via extraIds.
  const remainingPool = useMemo<string[]>(() => {
    if (!candidatePool || candidatePool.length === 0) return [];
    const seen = new Set<string>([
      ...(brief?.sections.evidenceRows ?? []).map((r) => r.workId),
      ...extraIds,
    ]);
    return candidatePool.filter((id) => !seen.has(id) && !!worksById[id]);
  }, [candidatePool, brief, extraIds, worksById]);

  // Methods mix computed deterministically from the full evidence table the
  // user actually sees. Previously came from Gemini's free-text methodologyNote
  // (computed over the synthesis-cap'd 150 rows), so counts could disagree
  // with the table. Now: counts always match.
  const methodsMix = useMemo<{ label: string; count: number; smsLevel: number | null }[]>(() => {
    if (!brief) return [];
    const buckets = new Map<string, { count: number; smsLevel: number | null }>();
    let nonEmpiricalCount = 0;
    for (const row of qualityFilteredRows) {
      const work = worksById[row.workId];
      const design = getRowMethodologyDesign(row, work) || 'Unclassified';
      const sms = getRowSmsLevel(row, work);
      // Roll up Review / Theoretical (SMS 0) into a single Non-empirical row.
      if (sms === 0 || design === 'Review' || design === 'Theoretical') {
        nonEmpiricalCount += 1;
        continue;
      }
      const key = design;
      const existing = buckets.get(key);
      if (existing) existing.count += 1;
      else buckets.set(key, { count: 1, smsLevel: sms });
    }
    // Include Unclassified as its own bucket — every row in the table should
    // be accounted for in the mix so totals match what the user sees.
    const rows = [...buckets.entries()]
      .map(([label, v]) => ({ label, count: v.count, smsLevel: v.smsLevel }))
      .sort((a, b) => {
        // Unclassified sinks to bottom (above Non-empirical which is pushed below).
        if (a.label === 'Unclassified' && b.label !== 'Unclassified') return 1;
        if (b.label === 'Unclassified' && a.label !== 'Unclassified') return -1;
        return (b.smsLevel ?? -1) - (a.smsLevel ?? -1);
      });
    if (nonEmpiricalCount > 0) {
      rows.push({ label: 'Non-empirical', count: nonEmpiricalCount, smsLevel: 0 });
    }
    return rows;
  }, [brief, qualityFilteredRows, worksById]);

  const _baseSortedRows = useMemo<EvidenceRow[]>(() => {
    const rows = [...qualityFilteredRows];
    if (sortField === 'relevance') return rows;
    if (sortField === 'sms') {
      // Rank by methodological rigor (SMS desc by default). Unclassified
      // (null SMS) sinks to the bottom regardless of direction.
      return rows.sort((a, b) => {
        const aSms = getRowSmsLevel(a, worksById[a.workId]) ?? -1;
        const bSms = getRowSmsLevel(b, worksById[b.workId]) ?? -1;
        if (aSms === bSms) {
          // Tiebreak by year (newer first)
          return (b.year ?? 0) - (a.year ?? 0);
        }
        return sortDirection === 'asc' ? aSms - bSms : bSms - aSms;
      });
    }
    if (sortField === 'year') {
      return rows.sort((a, b) => {
        const aVal = a.year ?? 0;
        const bVal = b.year ?? 0;
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      });
    }
    if (sortField === 'citations') {
      return rows.sort((a, b) => {
        // citationCount is now stored on EvidenceRow directly; fall back to worksById
        const aCit = a.citationCount ?? worksById[a.workId]?.citationCount ?? 0;
        const bCit = b.citationCount ?? worksById[b.workId]?.citationCount ?? 0;
        if (aCit === bCit) return (b.year ?? 0) - (a.year ?? 0);
        return sortDirection === 'asc' ? aCit - bCit : bCit - aCit;
      });
    }
    if (sortField === 'authors') {
      return rows.sort((a, b) => {
        const aAuthor = ((a.authors[0] || (worksById[a.workId]?.authors as string[] | undefined)?.[0]) ?? '').toLowerCase();
        const bAuthor = ((b.authors[0] || (worksById[b.workId]?.authors as string[] | undefined)?.[0]) ?? '').toLowerCase();
        const cmp = aAuthor.localeCompare(bAuthor);
        return sortDirection === 'asc' ? cmp : -cmp;
      });
    }
    if (sortField === 'title') {
      return rows.sort((a, b) => {
        const aTitle = (a.title || worksById[a.workId]?.title || '').toLowerCase();
        const bTitle = (b.title || worksById[b.workId]?.title || '').toLowerCase();
        const cmp = aTitle.localeCompare(bTitle);
        return sortDirection === 'asc' ? cmp : -cmp;
      });
    }
    if (sortField === 'channel') {
      const channelRank = (row: EvidenceRow) => {
        const work = worksById[row.workId];
        const tags = tagChannels(row, work);
        if (tags.includes('Causal')) return 0;
        if (tags.includes('Found.')) return 1;
        if (tags.includes('Recent')) return 2;
        if (tags.includes('LAC')) return 3;
        return 4;
      };
      return rows.sort((a, b) => {
        const cmp = channelRank(a) - channelRank(b);
        return sortDirection === 'asc' ? cmp : -cmp;
      });
    }
    if (sortField === 'source') {
      return rows.sort((a, b) => {
        const aSource = (a.sourceName || '').toLowerCase();
        const bSource = (b.sourceName || '').toLowerCase();
        const cmp = aSource.localeCompare(bSource);
        return sortDirection === 'asc' ? cmp : -cmp;
      });
    }
    return rows.sort((a, b) => {
      const aVal = a.year ?? 0;
      const bVal = b.year ?? 0;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }, [qualityFilteredRows, sortField, sortDirection, worksById, evidenceClassification]);

  // OFF-topic rows ALWAYS sink to the bottom, regardless of the active sort.
  // Stable partition (V8 Array.sort is stable) preserves in-group order.
  const sortedRows = useMemo<EvidenceRow[]>(
    () => [..._baseSortedRows].sort((a, b) => (a.segment === 'off' ? 1 : 0) - (b.segment === 'off' ? 1 : 0)),
    [_baseSortedRows],
  );
  const hasOffRows = useMemo(() => sortedRows.some((r) => r.segment === 'off'), [sortedRows]);

  const manualRows: EvidenceRow[] = React.useMemo(() => manualPapers.map((p) => ({
    workId: p.matchedWorkId ?? p.doi ?? p.uploadId,
    title: p.title,
    authors: p.authors ?? [],
    sourceName: p.venue ?? '',
    year: p.year ?? 0,
    methodologyBadge: p.card?.design ?? '',
    causalStrength: 'signal' as const,
    smsLevel: p.smsLevel ?? null,
    citationCount: null,
    geography: [],
    doi: p.doi ?? undefined,
    url: '',
    finding: p.card?.findingShort ?? (p.abstract ? p.abstract.slice(0, 300) : ''),
    retrievalChannels: ['manual'],
    isManualAdd: true,
  })), [manualPapers]);

  const allSortedRows = React.useMemo(() => [...manualRows, ...sortedRows], [sortedRows, manualRows]);

  const displayedRows = allSortedRows.slice(0, visibleCount);
  const selectedRow = selectedWorkId ? (allSortedRows.find((r) => r.workId === selectedWorkId) ?? null) : null;

  // Notify parent (App.tsx) of currently visible work IDs whenever the table
  // changes. App uses this to detect when the brief is stale relative to the
  // visible set and to offer a "Regenerate brief" prompt.
  const visibleIdsKey = displayedRows.map((r) => r.workId).join(',');
  useEffect(() => {
    if (!onVisibleRowsChange) return;
    onVisibleRowsChange(displayedRows.map((r) => r.workId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey]);
  const selectedPaper = selectedWorkId ? (worksById[selectedWorkId] ?? null) : null;

  // Helper: structured paper-card data for a single row. Used by §2 strongest
  // evidence (top row only) and §3 thin-evidence list (low-rigor papers).
  // Returns null when row is missing. Decision-use fluff phrases removed —
  // the chip row (region · design · SMS) carries the same signal. SMS is
  // looked up via worksById since EvidenceRow on the frontend doesn't expose
  // it directly (same pattern as methodsMix and sortedRows).
  const buildPaperCard = (row: EvidenceRow | undefined) => {
    if (!row) return null;
    const firstAuthorRaw = (row.authors?.[0] || '').trim();
    const firstAuthorLast = firstAuthorRaw ? (firstAuthorRaw.split(' ').pop() || firstAuthorRaw) : 'Unknown';
    const authorTag = (row.authors?.length ?? 0) > 1 ? `${firstAuthorLast} et al.` : firstAuthorLast;
    const work = worksById[row.workId];
    const sms = getRowSmsLevel(row, work);
    return {
      workId: row.workId,
      authorTag,
      year: row.year ?? null,
      title: row.title || '',
      design: getRowMethodologyDesign(row, work),
      smsLevel: sms,
      geography: getRowGeography(row, work).slice(0, 2),
      finding: (row.finding || '').replace(/\s+/g, ' ').trim(),
    };
  };

  // Strongest-evidence callout — top-1 only (was top-2; second card dropped
  // per UX feedback). Always agrees with sortedRows[0] in the visible table.
  const strongestEvidence = useMemo(
    () => buildPaperCard(sortedRows[0]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedRows, worksById],
  );

  // Show the "sharper results" tip when the brief looks like it came from a
  // broad query — heuristic: retrieval got close to its cap (~500), or the
  // query itself is very short (≤ 3 words). Pure UX nudge — no implementation
  // detail is exposed to the user.
  const shouldShowSharperTip = useMemo(() => {
    const retrieved = brief?.sections?.coverageCard?.retrievedCount ?? 0;
    const queryWords = (brief?.query || '').trim().split(/\s+/).filter(Boolean).length;
    return retrieved >= 400 || (queryWords > 0 && queryWords <= 3);
  }, [brief]);

  // Thin-evidence — three specific gap categories surfaced as labeled text:
  //   1. Topics with zero research (no admissible papers on the topic)
  //   2. Topics with ≤1 SMS 4–5 paper (no rigorous evidence-base on the topic)
  //   3. LAC countries with 0 papers OR ≤1 SMS 4–5 paper
  // Topic + country detection uses the same regex patterns as the backend
  // buildCoverageProfile, ported client-side so we don't depend on the brief
  // shape and can compute directly from the visible rows.
  const thinEvidence = useMemo(() => {
    if (!brief) return null;
    const TOPIC_PATTERNS: [string, RegExp][] = [
      ['AI adoption', /\b(ai|artificial intelligence|automation|algorithm|machine learning|digital technolog)/i],
      ['firm productivity', /\b(firm|productivity|technology adoption|innovation|smes?|enterprise)/i],
      ['employment & jobs', /\b(employment|job|occupation|worker|labor demand|labour demand|displacement)/i],
      ['wages & income', /\b(wage|earnings|income|salary|compensation)/i],
      ['skills & training', /\b(skill|training|reskilling|upskilling|education|human capital)/i],
      ['informality', /\b(informal|informality|self-employ|low-skill|low skill|vulnerable)/i],
      ['gender & inclusion', /\b(gender|women|female|youth|inequality|inclusion)/i],
      ['platform work', /\b(platform|gig|freelance|ride-hailing|delivery worker)/i],
      ['public sector', /\b(public sector|government|civil service|public administration)/i],
      ['social protection', /\b(social protection|cash transfer|labor supply|labour supply|welfare|benefit)/i],
    ];
    const LAC_PATTERNS: [string, RegExp][] = [
      ['Brazil', /\b(brazil|brasil)\b/i],
      ['Mexico', /\b(mexico|mexican)\b/i],
      ['Colombia', /\b(colombia|colombian)\b/i],
      ['Argentina', /\b(argentina|argentine)\b/i],
      ['Chile', /\b(chile|chilean)\b/i],
      ['Peru', /\b(peru|peruvian)\b/i],
      ['Ecuador', /\becuador\b/i],
      ['Bolivia', /\bbolivia\b/i],
      ['Uruguay', /\buruguay\b/i],
      ['Paraguay', /\bparaguay\b/i],
      ['Costa Rica', /\bcosta rica\b/i],
      ['Panama', /\bpanama\b/i],
    ];

    // Use only topics relevant to the query when possible; fall back to a
    // sensible default subset when the query doesn't match any topic.
    const queryText = (brief.query || '').toLowerCase();
    const queryIsAiLabor = /\b(ai|artificial intelligence|automation|algorithm|machine learning)\b/.test(queryText) &&
      /\b(labor|labour|employment|job|worker|work|wage|skill)\b/.test(queryText);
    const matched = TOPIC_PATTERNS.filter(([, p]) => p.test(queryText));
    const topicSet = queryIsAiLabor
      ? TOPIC_PATTERNS.slice(0, 9)
      : matched.length > 0
      ? matched
      : TOPIC_PATTERNS.slice(0, 6);

    const topicStats = new Map<string, { total: number; strong: number }>();
    const countryStats = new Map<string, { total: number; strong: number }>();
    for (const row of qualityFilteredRows) {
      const sms = getRowSmsLevel(row, worksById[row.workId]);
      const isStrong = sms != null && sms >= 4;
      const text = `${row.title || ''} ${row.finding || ''} ${(row.geography || []).join(' ')}`;
      for (const [label, pattern] of topicSet) {
        if (pattern.test(text)) {
          const c = topicStats.get(label) || { total: 0, strong: 0 };
          c.total += 1;
          if (isStrong) c.strong += 1;
          topicStats.set(label, c);
        }
      }
      for (const [label, pattern] of LAC_PATTERNS) {
        if (pattern.test(text)) {
          const c = countryStats.get(label) || { total: 0, strong: 0 };
          c.total += 1;
          if (isStrong) c.strong += 1;
          countryStats.set(label, c);
        }
      }
    }

    const zeroResearchTopics = topicSet
      .map(([label]) => label)
      .filter((label) => !topicStats.has(label));
    // Weak rigor on a topic = ≥1 paper retrieved but ≤1 SMS 4–5. Carries
    // counts inline so the analyst sees why each topic is flagged.
    const weakRigorTopics = topicSet
      .map(([label]) => label)
      .filter((label) => {
        const c = topicStats.get(label);
        return !!c && c.total >= 1 && c.strong <= 1;
      })
      .map((label) => ({ label, ...topicStats.get(label)! }));
    // LAC few-rigorous = country has ≥1 paper but ≤1 SMS 4–5. Drops the
    // "unstudied" (0-paper) case — those countries already show in the
    // gray pills of the LAC sub-region grid above.
    const lacFewRigorous = LAC_PATTERNS
      .map(([label]) => label)
      .filter((label) => {
        const c = countryStats.get(label);
        return !!c && c.total >= 1 && c.strong <= 1;
      })
      .map((label) => ({ label, ...countryStats.get(label)! }));

    return { zeroResearchTopics, weakRigorTopics, lacFewRigorous };
  }, [brief, qualityFilteredRows, worksById]);

  // SMS distribution over the user-visible (quality-filtered) rows. Drives
  // the horizontal stacked bar in the §2 Methodology box — single-glance
  // answer to "is this rigor-heavy or correlational?". Rows with null SMS
  // (no methodology keywords detected) are excluded; the bar shows shape
  // only over classified papers.
  const smsDistribution = useMemo<{
    buckets: { level: number; count: number; pct: number }[];
    total: number;
    strongPct: number;
  }>(() => {
    const counts = new Map<number, number>();
    for (const row of qualityFilteredRows) {
      const sms = getRowSmsLevel(row, worksById[row.workId]);
      if (sms == null) continue;
      counts.set(sms, (counts.get(sms) || 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const buckets = [5, 4, 3, 2, 1, 0].map((level) => {
      const count = counts.get(level) || 0;
      return { level, count, pct: total > 0 ? count / total : 0 };
    });
    const strongCount = (counts.get(5) || 0) + (counts.get(4) || 0);
    const strongPct = total > 0 ? Math.round((strongCount / total) * 100) : 0;
    return { buckets, total, strongPct };
  }, [qualityFilteredRows, worksById]);

  // Recency band — answers "is this evidence base recent?". Min/max/median
  // year plus a count of papers published in the last 3 years. Important
  // for post-AI-shock and post-pandemic queries.
  const recencyBand = useMemo<{
    min: number;
    max: number;
    median: number;
    recent: number;
    recentYears: number;
  } | null>(() => {
    const years = qualityFilteredRows
      .map((r) => r.year)
      .filter((y): y is number => typeof y === 'number' && y > 1900);
    if (years.length === 0) return null;
    const sorted = [...years].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const recentYears = 3;
    const cutoff = new Date().getFullYear() - recentYears;
    const recent = years.filter((y) => y >= cutoff).length;
    return { min, max, median, recent, recentYears };
  }, [qualityFilteredRows]);

  // Source quality — tier mix (A/B/C admitted) and publication-type mix
  // (peer-reviewed vs working paper vs report). Adds source-quality signal
  // next to the method-quality signals above.
  const sourceQuality = useMemo<{
    tierCounts: { label: string; count: number }[];
    pubTypeCounts: { label: string; count: number }[];
  }>(() => {
    const tierBuckets = new Map<string, number>();
    const pubBuckets = new Map<string, number>();
    for (const row of qualityFilteredRows) {
      const work = worksById[row.workId];
      if (!work) continue;
      const tier = work.qualityTier;
      if (tier) tierBuckets.set(tier, (tierBuckets.get(tier) || 0) + 1);
      const pubType = work.publicationType;
      if (pubType) pubBuckets.set(pubType, (pubBuckets.get(pubType) || 0) + 1);
    }
    const tierCounts = ['Tier A', 'Tier B', 'Tier C']
      .map((label) => ({ label, count: tierBuckets.get(label) || 0 }))
      .filter((t) => t.count > 0);
    const pubOrder = ['journal_article', 'working_paper', 'discussion_paper', 'preprint', 'report', 'conference_paper', 'book', 'book_chapter', 'dataset', 'dissertation', 'other'];
    const pubTypeCounts = pubOrder
      .filter((key) => pubBuckets.has(key))
      .map((key) => ({ label: pubTypeLabel(key, selectedLanguage), count: pubBuckets.get(key) || 0 }));
    return { tierCounts, pubTypeCounts };
  }, [qualityFilteredRows, worksById, selectedLanguage]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl bg-[#0f1d35] p-8 animate-pulse">
          <div className="h-3 w-24 bg-white/20 rounded-md mb-3" />
          <div className="h-7 w-3/4 bg-white/20 rounded-md mb-3" />
          <div className="h-4 w-1/2 bg-white/10 rounded-md" />
        </div>
        <div className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
          <div className="h-3 w-32 bg-slate-200 rounded-md mb-5" />
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex gap-4 animate-pulse">
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-slate-200 rounded-md w-5/6" />
                  <div className="h-3 bg-slate-100 rounded-md w-2/3" />
                </div>
                <div className="h-4 w-10 bg-slate-100 rounded-md" />
                <div className="h-4 w-10 bg-slate-100 rounded-md" />
                <div className="flex gap-1">
                  <div className="h-5 w-14 bg-slate-100 rounded-md" />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-center gap-2 text-slate-500 text-sm font-medium">
            <Spinner size="sm" />
            Searching academic databases...
          </div>
        </div>
      </div>
    );
  }

  if (error && !brief) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-10 shadow-sm flex flex-col items-center justify-center gap-4 text-center">
        <p className="text-rose-700 font-semibold">Unable to retrieve papers right now. Please try again in a moment.</p>
        <p className="text-rose-500 text-sm">{error}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded-full bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 transition"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (!brief) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 shadow-sm flex flex-col items-center text-center">
        <svg className="w-12 h-12 text-slate-300 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
          <path d="M16 13H8" /><path d="M16 17H8" /><path d="M10 9H8" />
        </svg>
        <p className="text-slate-500 font-medium">No evidence brief yet</p>
        <p className="text-slate-400 text-sm mt-1">Enter a policy question above and click Search to generate a structured, citation-grounded brief.</p>
      </div>
    );
  }

  const { sections } = brief;
  // Global citation numbering across the whole brief (abstract + bullets), in
  // document order, so footnotes are unique and sequential instead of
  // restarting at [1] per bullet.
  const citationNumbering = useMemo(
    () => buildCitationNumbering([sections.abstractSummary, ...(sections.summaryBullets ?? [])]),
    [sections.abstractSummary, sections.summaryBullets],
  );
  // Defensive: synthesis fallback paths (Ollama / deterministic / error) sometimes
  // return briefs without a fully-shaped coverageCard. Default to an empty object
  // so missing fields render as '—' instead of crashing the whole view.
  const coverageCard = sections.coverageCard ?? ({} as Partial<NonNullable<typeof sections.coverageCard>>);
  const hasCoverageContent = !!(
    sections.coverageCard && (
      coverageCard.gapType ||
      coverageCard.lacCoverage ||
      (coverageCard as any).thinEvidenceAreas?.length ||
      (coverageCard as any).recencyAlert ||
      (coverageCard as any).weakRigor?.length ||
      (coverageCard as any).zeroResearch?.length
    )
  );
  const isTwitterView = currentPersona === 'twitter' && Array.isArray(sections.threadTweets) && sections.threadTweets.length > 0;

  // First sentence of abstractSummary — used as TL;DR strip's 2-line synth.
  const tldrSynth = (() => {
    const srcRaw = sections.abstractSummary || sections.summaryBullets?.[0] || '';
    const src = typeof srcRaw === 'string' ? srcRaw : '';
    if (!src) return '';
    // Strip markdown bold and citation tags for the strip preview
    const cleaned = src.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[[^\]]+\]/g, '').trim();
    // Take first 1-2 sentences, cap at ~220 chars
    const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
    return firstSentence.length > 220 ? firstSentence.slice(0, 220) + '…' : firstSentence;
  })();

  const evidenceCount = sections.evidenceRows?.length ?? 0;

  // Direct/Indirect breakdown computed over the brief's actual evidence rows
  // (from per-row evidenceMatch) — "of these 50, how many direct / indirect."
  const briefFacetMix = useMemo<{ direct: number; indirect: number; excluded: number } | null>(() => {
    if (!evidenceClassification || evidenceCount === 0) return null;
    let direct = 0, indirect = 0, excluded = 0;
    for (const row of sections.evidenceRows ?? []) {
      const cls = evidenceClassification[row.workId];
      if (!cls) { excluded++; continue; } // unclassified = effectively excluded from facet match
      const fine = cls.classification ?? cls.evidenceMatch;
      if (fine === 'direct-lac' || fine === 'direct-global' || fine === 'direct') direct++;
      else if (fine === 'indirect') indirect++;
      else excluded++;
    }
    return { direct, indirect, excluded };
  }, [evidenceClassification, sections.evidenceRows, evidenceCount]);

  return (
    <div className="space-y-4">
      {/* ── Mobile compact header (2 rows) ─────────────────────────────── */}
      <section data-print-hide className="md:hidden sticky top-0 z-30 bg-white border-b border-slate-200">
        {/* Row 1: query (tap to expand) + export menu */}
        <div className="flex items-start gap-2 px-4 pt-2 pb-1.5">
          <button
            onClick={() => setMobileMenuOpen(v => !v)}
            className="flex-1 min-w-0 text-left"
            aria-label="Toggle query and options"
          >
            <span className={`text-sm font-medium text-slate-800 block ${mobileMenuOpen ? 'whitespace-normal' : 'truncate'}`}>
              {brief.query}
            </span>
            <span className="text-[10px] text-slate-400 mt-0.5 block">
              {mobileMenuOpen ? 'Tap to collapse ↑' : 'Tap to expand ↓'}
            </span>
          </button>
          {/* Export menu (⋮) */}
          <div className="relative shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setMobileMenuOpen(v => !v); }}
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-500 transition"
              aria-label="Export options"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
              </svg>
            </button>
            {mobileMenuOpen && (
              <div className="absolute right-0 top-10 z-50 w-52 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden text-sm">
                {onCopyBrief && (
                  <button onClick={() => { onCopyBrief(allSortedRows); showToast('Brief copied'); setMobileMenuOpen(false); }} className="w-full text-left px-4 py-3 hover:bg-slate-50 transition text-slate-700 border-b border-slate-100">Copy brief text</button>
                )}
                <button onClick={() => { onExportDocx(allSortedRows); setMobileMenuOpen(false); }} className="w-full text-left px-4 py-3 hover:bg-slate-50 transition text-slate-700 border-b border-slate-100">Download Word (.docx)</button>
                {/* Evidence-Table CSV — was desktop-only; mirrors the desktop ExportMenu call. */}
                <button
                  onClick={() => { logEvent({ eventType: 'brief.table_downloaded', targetType: 'brief', targetId: brief.id, status: 'completed', payload: { format: 'csv', rowCount: allSortedRows.length } }); exportEvidenceTableAsCsv(brief, worksById, allSortedRows, evidenceClassification); showToast('Evidence table CSV downloaded'); setMobileMenuOpen(false); }}
                  disabled={allSortedRows.length === 0}
                  className="w-full text-left px-4 py-3 hover:bg-slate-50 transition text-slate-700 border-b border-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >Download evidence table (.csv)</button>
                <button onClick={() => { onExportJson(allSortedRows); setMobileMenuOpen(false); }} className="w-full text-left px-4 py-3 hover:bg-slate-50 transition text-slate-700">Download JSON</button>
              </div>
            )}
          </div>
        </div>

        {/* Row 2: Brief/Evidence toggle + Filters */}
        <div className="flex items-center gap-2 px-4 pb-2.5">
          {/* View toggle — larger pills */}
          <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1 flex-1">
            <button
              onClick={() => setMobileView('brief')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${mobileView === 'brief' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'}`}
            >
              Brief
            </button>
            <button
              onClick={() => setMobileView('evidence')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${mobileView === 'evidence' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'}`}
            >
              Evidence ({allSortedRows.length})
            </button>
          </div>

          {/* Filters */}
          {activeFilters && setActiveFilters && (
            <button
              onClick={() => setFilterSheetOpen(true)}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:border-teal-400 hover:text-teal-700 transition shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="11" y1="18" x2="13" y2="18" />
              </svg>
              Filters
              {filterSummaryParts(activeFilters).length > 0 && (
                <span className="rounded-full bg-teal-600 text-white text-[10px] w-4 h-4 flex items-center justify-center font-bold">
                  {filterSummaryParts(activeFilters).length}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Filter bottom sheet — z-[60] clears the bottom nav (z-50); anchored at
            bottom-14 so the sheet sits entirely above the 56px nav bar. */}
        {filterSheetOpen && activeFilters && setActiveFilters && (
          <>
            <div className="fixed inset-0 z-[60] bg-black/40" onClick={() => setFilterSheetOpen(false)} />
            <div className="fixed bottom-14 left-0 right-0 z-[60] bg-white rounded-t-2xl shadow-2xl flex flex-col max-h-[75vh]">
              {/* Handle */}
              <div className="flex justify-center pt-3 pb-1 shrink-0">
                <div className="w-10 h-1 rounded-full bg-slate-300" />
              </div>
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 shrink-0">
                <span className="text-sm font-bold text-slate-800">Filters</span>
                <button onClick={() => setFilterSheetOpen(false)} className="text-slate-400 hover:text-slate-600 p-1.5 rounded-full hover:bg-slate-100 transition">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
              {/* Scrollable filter content */}
              <div className="flex-1 overflow-y-auto px-4 py-4">
                <TopFilterBar filters={activeFilters} setFilters={setActiveFilters} />
              </div>
              {/* Apply button */}
              <div className="shrink-0 px-4 py-4 border-t border-slate-100">
                <button onClick={() => setFilterSheetOpen(false)} className="w-full rounded-xl bg-teal-600 text-white py-3 text-sm font-semibold hover:bg-teal-700 transition">
                  Apply filters
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Desktop full header ───────────────────────────────────────────── */}
      <section
        data-print-hide
        className="hidden md:block sticky top-0 z-30 bg-white/90 backdrop-blur-sm border-b border-slate-200 px-5 py-2.5"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[10px] uppercase tracking-[0.15em] text-slate-400 font-bold shrink-0">Question</span>
              <span className={`text-sm text-slate-800 ${queryExpanded ? 'whitespace-normal' : 'line-clamp-2'}`}>
                {brief.query}
                {!queryExpanded && brief.query.length > 120 && (
                  <button
                    onClick={() => setQueryExpanded(true)}
                    className="ml-1 text-teal-600 hover:text-teal-800 text-xs font-semibold"
                    title="Show full question"
                  >
                    ...
                  </button>
                )}
              </span>
              {queryExpanded && (
                <button
                  onClick={() => setQueryExpanded(false)}
                  className="ml-1 text-teal-600 hover:text-teal-800 text-xs font-semibold shrink-0"
                >
                  Show less
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {(() => {
                // POLICY-ONLY: new briefs are always 'policy'. The label map is a
                // guarded lookup that shows "Policy brief" for policy and a safe
                // fallback for any stored retired persona (technical/jel/twitter/
                // etc.) so old DB briefs still render their pill without crashing.
                const RETIRED_LABELS: Record<string, string> = {
                  technical: 'Technical review',
                  research: 'Research agenda',
                  'non-technical': 'Plain language',
                  twitter: 'X Thread',
                  'talking-points': 'Talking Points',
                  jel: 'JEL',
                };
                const p = brief.auditTrace?.persona;
                const label = p === 'policy'
                  ? 'Policy brief'
                  : (p ? (RETIRED_LABELS[p] ?? 'Brief') : null);
                return label ? (
                  <span className="rounded-full bg-teal-100 text-teal-800 px-2.5 py-0.5 font-semibold border border-teal-200">{label}</span>
                ) : null;
              })()}
              {/* Channel pills — derived from THIS brief's own papers' channel-of-origin
                  (row.retrievalChannels, persisted per search_run via work_channels), NOT
                  the live search selection. Using the live `activeChannels` prop here
                  leaked the current channel selection onto every past brief. Deriving from
                  the brief's rows makes each brief show the channels actually used for it. */}
              {(() => {
                const briefChannels = new Set<string>();
                for (const r of (sections.evidenceRows ?? [])) {
                  for (const ch of (r.retrievalChannels ?? [])) briefChannels.add(ch);
                }
                if (manualPapers.length > 0) briefChannels.add('manual');
                if (briefChannels.size === 0) return null;
                const CHANNEL_PILL: Record<string, string> = {
                  causal:        'rounded-full bg-emerald-50 text-emerald-800 px-2.5 py-0.5 font-semibold border border-emerald-200',
                  foundational:  'rounded-full bg-amber-50 text-amber-800 px-2.5 py-0.5 font-semibold border border-amber-200',
                  recent:        'rounded-full bg-blue-50 text-blue-800 px-2.5 py-0.5 font-semibold border border-blue-200',
                  lac:           'rounded-full bg-teal-50 text-teal-800 px-2.5 py-0.5 font-semibold border border-teal-200',
                  // Provenance tag (not a retrieval channel): papers added by Deep scan.
                  deepscan:      'rounded-full bg-violet-50 text-violet-800 px-2.5 py-0.5 font-semibold border border-violet-200',
                  manual:        'rounded-full bg-violet-100 text-violet-900 px-2.5 py-0.5 font-semibold border border-violet-300',
                };
                const CHANNEL_LABEL: Record<string, string> = {
                  causal: 'Causal', foundational: 'Foundational', recent: 'Recent', lac: 'LAC', deepscan: 'Deep scan', manual: 'Added',
                };
                return (
                  <>
                    {['causal','foundational','recent','lac','deepscan','manual'].filter(ch => briefChannels.has(ch)).map(ch => (
                      <span key={ch} className={CHANNEL_PILL[ch]}>{CHANNEL_LABEL[ch]}</span>
                    ))}
                  </>
                );
              })()}
              {selectedLanguage && (
                onLanguageChange ? (
                  <button
                    type="button"
                    onClick={() => {
                      const cycle: Record<string, 'en' | 'es' | 'pt'> = { en: 'es', es: 'pt', pt: 'en' };
                      onLanguageChange(cycle[selectedLanguage] ?? 'en');
                    }}
                    className="rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-0.5 font-semibold border border-slate-200 transition"
                    title="Switch output language — click to cycle EN → ES → PT"
                  >
                    {selectedLanguage === 'en' ? 'English' : selectedLanguage === 'es' ? 'Spanish' : 'Portuguese'}
                  </button>
                ) : (
                  <span className="rounded-full bg-slate-100 text-slate-700 px-2.5 py-0.5 font-semibold border border-slate-200">
                    {selectedLanguage === 'en' ? 'English' : selectedLanguage === 'es' ? 'Spanish' : 'Portuguese'}
                  </span>
                )
              )}
              <span className="text-slate-300">·</span>
              <span
                className="inline-flex items-center gap-1.5 text-slate-500"
                title={
                  `Pipeline:\n` +
                  `• Searched — ${coverageCard.retrievedCount ?? '—'} papers found across sources for this query\n` +
                  `• Filtered — ${coverageCard.admissibleCount ?? '—'} passed retrieval-time quality + relevance gates\n` +
                  `• In brief — ${evidenceCount} top-ranked papers used for synthesis` +
                  (allSortedRows.length !== evidenceCount + extraIds.length + manualPapers.length
                    ? `\n• Visible — ${allSortedRows.length} after your current filter chips`
                    : '') +
                  (facetCoverage?.facetLabels && facetCoverage.facetLabels.length > 0
                    ? `\n\nQuery facets: ${facetCoverage.facetLabels.join(' · ')}`
                    : '')
                }
              >
                <span className="tabular-nums"><strong className="font-semibold text-slate-700">{coverageCard.retrievedCount ?? '—'}</strong> searched</span>
                <span className="text-slate-300">→</span>
                <span className="tabular-nums"><strong className="font-semibold text-slate-700">{coverageCard.admissibleCount ?? '—'}</strong> filtered</span>
                <span className="text-slate-300">→</span>
                <span className="tabular-nums"><strong className="font-semibold text-teal-700">{evidenceCount}</strong> in brief</span>
                {allSortedRows.length !== evidenceCount + extraIds.length + manualPapers.length && (
                  <>
                    <span className="text-slate-300">→</span>
                    <span className="tabular-nums"><strong className="font-semibold text-amber-700">{allSortedRows.length}</strong> visible</span>
                  </>
                )}
              </span>
              {briefFacetMix && (briefFacetMix.direct > 0 || briefFacetMix.indirect > 0) && (
                <span
                  className="text-slate-500"
                  title={
                    `Of the ${evidenceCount} papers in this brief:\n` +
                    `• ${briefFacetMix.direct} direct (match every query facet)\n` +
                    `• ${briefFacetMix.indirect} indirect (match some facets)\n` +
                    `• ${briefFacetMix.excluded} contextual (in table by relevance rank, below facet threshold)`
                  }
                >
                  · <strong className="font-semibold text-teal-700 tabular-nums">{briefFacetMix.direct}</strong> direct{' '}
                  <strong className="font-semibold text-slate-700 tabular-nums">{briefFacetMix.indirect}</strong> indirect
                  {briefFacetMix.excluded > 0 && (
                    <span className="text-slate-400 tabular-nums"> {briefFacetMix.excluded} contextual</span>
                  )}
                </span>
              )}
            </div>
            {/* Filter summary row — shows chosen filters, clickable to edit */}
            {activeFilters && setActiveFilters && (
              <div className="mt-2 pt-2 border-t border-slate-100">
                <ActiveFilterSummary filters={activeFilters} originalFilters={originalFilters} setFilters={setActiveFilters} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {(onWriteSurvey || onGenerateJelPaper || jelPaperStatus) && (
              jelPaperStatus === 'done' ? (
                <button
                  onClick={onJelPaperDone}
                  className="flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-100 transition"
                  title="Your JEL survey paper is ready — click to open Library"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Paper ready → Library
                </button>
              ) : jelPaperStatus === 'error' ? (
                <span
                  className="flex items-center gap-1.5 rounded-full bg-red-50 border border-red-200 text-red-700 px-3 py-1.5 text-xs font-semibold"
                  title={jelPaperErrorMessage ?? 'Generation failed'}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  Failed — try again
                </span>
              ) : jelPaperStatus === 'generating' ? (
                <span className="flex items-center gap-2 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 px-3 py-1.5 text-xs font-semibold">
                  <span className="w-3 h-3 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin shrink-0" />
                  {jelPaperProgress && jelPaperProgress.total > 0
                    ? `Drafting §${jelPaperProgress.done + 1}/${jelPaperProgress.total}…`
                    : 'Crafting your survey…'}
                </span>
              ) : onWriteSurvey ? (
                <button
                  onClick={() => { if (!writeSurveyPending) onWriteSurvey(allSortedRows.map((r) => r.workId)); }}
                  disabled={writeSurveyPending}
                  className="rounded-full bg-indigo-600 text-white px-3 md:px-4 py-1.5 text-xs font-semibold hover:bg-indigo-700 transition flex items-center gap-1.5 min-h-[36px] disabled:opacity-60 disabled:cursor-not-allowed"
                  title="Open Paper Studio — frame the question, curate evidence, and confirm the sections before generating a JEL-style survey."
                >
                  {writeSurveyPending ? (
                    <>
                      <span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin shrink-0" aria-hidden />
                      <span className="hidden md:inline">Opening…</span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden>✍</span>
                      <span className="hidden md:inline">Write survey paper →</span>
                    </>
                  )}
                </button>
              ) : onGenerateJelPaper ? (
                <button
                  onClick={() => { onGenerateJelPaper(); }}
                  className="rounded-full bg-indigo-600 text-white px-3 md:px-4 py-1.5 text-xs font-semibold hover:bg-indigo-700 transition flex items-center gap-1.5 min-h-[36px]"
                  title="Generate a 12,000–20,000 word JEL-style survey article from this evidence set. Runs in the background — you'll see it in Library when done."
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  <span className="hidden md:inline">Generate Paper</span>
                </button>
              ) : null
            )}
            <ExportMenu
              brief={brief}
              worksById={worksById}
              rowsForExport={allSortedRows}
              evidenceClassification={evidenceClassification}
              onCopyBrief={onCopyBrief ? () => { onCopyBrief(allSortedRows); showToast('Brief copied to clipboard'); } : undefined}
              onExportJson={() => onExportJson(allSortedRows)}
              onExportDocx={() => onExportDocx(allSortedRows)}
              onToast={showToast}
            />
          </div>
        </div>
      </section>

      {/* Broad-query nudge — sits between the sticky header and the brief
          body. Only fires when retrieval looks broad OR the query is short. */}
      {shouldShowSharperTip && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-2.5 mx-0">
          <p className="text-xs text-slate-600 leading-relaxed">
            {briefLabel(selectedLanguage, 'sharperResultsTip')}
          </p>
        </div>
      )}

      {isTwitterView ? (
        <div>
          <TwitterThreadView
            tweets={sections.threadTweets!}
            citations={sections.citations || []}
            worksById={worksById}
            query={brief.query}
          />
        </div>
      ) : (
        <div>

          {/* PR3: in table-focus mode a banner sits above the evidence table. */}
          {layoutMode === 'table-focus' && (
            <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-teal-50 border border-teal-200 px-4 py-2.5 text-sm text-teal-700 font-medium">
              <Spinner size="sm" />
              <span>
                {allSortedRows.length} papers retrieved · choose your audience above to generate the synthesis
              </span>
            </div>
          )}

          {/* ─────────────────────────────────────────────────────────
              PR2/PR3 layout switch:
              table-focus → single column (only table, full width, max-w-4xl)
              two-column  → 55% synthesis / 45% table, independent scroll
              ───────────────────────────────────────────────────────── */}
          <div ref={splitContainerRef} className={layoutMode === 'table-focus'
            ? 'flex flex-col'
            : 'flex flex-col lg:flex-row max-h-[calc(100vh-9rem)]'}>

            {/* SYNTHESIS COLUMN (55%) — slides in from left when brief appears.
                Hidden in table-focus mode (user hasn't chosen persona yet).
                On mobile: hidden when user has switched to Evidence tab. */}
            <div data-print-synthesis
              className={layoutMode === 'table-focus'
                ? 'hidden'
                : `w-full max-h-[50%] overflow-y-auto border-b border-slate-200 lg:max-h-none lg:border-b-0 lg:border-r lg:border-slate-200 min-w-0 ${isDesktopSplit ? '' : 'lg:w-[55%]'} ${mobileView === 'evidence' ? 'hidden md:flex md:flex-col' : ''}`}
              style={layoutMode !== 'table-focus' ? { animation: 'slideInLeft 0.5s ease-out', ...(isDesktopSplit ? { width: `${briefPct}%` } : {}) } : undefined}>

            {/* § 1 — Executive synthesis (flat — card chrome stripped) */}
            <section className="p-6">
              <div className="flex items-baseline justify-between mb-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-teal-700 font-bold">§ 1</div>
                  <h3 className="text-lg font-semibold text-slate-900 mt-0.5">Executive synthesis</h3>
                </div>
              </div>
              {isSynthesizing && streamingText ? (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Spinner size="sm" />
                    <span className="text-sm text-teal-600 font-medium">Synthesizing with Gemini...</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-teal-500 rounded-full animate-pulse" style={{ width: `${Math.min(95, Math.max(10, streamingText.length / 40))}%` }} />
                    </div>
                    <span className="text-xs text-slate-400 tabular-nums">{Math.round(streamingText.length / 40)}%</span>
                  </div>
                </div>
              ) : isSynthesizing ? (
                // Staged reveal: while Gemini is working (Phase 1 deterministic
                // brief has landed but no streaming chunks yet), hide the seed
                // bullets behind a skeleton. The TABLE stays visible below this
                // section, so the user sees "table → brief → boxes" stages.
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <Spinner size="sm" />
                    <span className="text-sm text-teal-700 font-medium">
                      Horizon scanning · reading {sections.evidenceRows?.length ?? '…'} papers · synthesizing brief
                    </span>
                  </div>
                  <SynthesisSkeleton />
                </div>
              ) : (
                <div className="space-y-5">
                  {sections.abstractSummary && (
                    <p className="text-slate-800 leading-relaxed text-[15px] font-medium">
                      {renderMarkdownBold(sections.abstractSummary, { worksById, evidenceRows: sections.evidenceRows, seen: citationNumbering })}
                    </p>
                  )}
                  {(sections.summaryBullets?.length ?? 0) > 0 && (
                    <BulletSection
                      bullets={sections.summaryBullets ?? []}
                      persona={currentPersona}
                      worksById={worksById}
                      evidenceRows={sections.evidenceRows}
                      seen={citationNumbering}
                    />
                  )}
                </div>
              )}
            </section>

            {/* ── § 2 Methodology (inline, after synthesis) ── */}
            <div className="border-t border-slate-100 mx-6">
              <button
                type="button"
                onClick={() => setShowMethodology((v) => !v)}
                className="w-full flex items-center justify-between py-3 text-left group"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-[0.18em] text-teal-700 font-bold">§ 2</span>
                  <span className="text-sm font-semibold text-slate-900">{briefLabel(selectedLanguage, 'methodology')}</span>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  className={`text-slate-400 transition-transform ${showMethodology ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {showMethodology && (
                <div className="pb-5 space-y-3 text-slate-700">
                  {isSynthesizing ? (
                    <>
                      <div className="flex items-center gap-2 mb-3">
                        <Spinner size="sm" />
                        <span className="text-xs text-teal-700 font-medium">{briefLabel(selectedLanguage, 'taggingMethodology')}</span>
                      </div>
                      <SynthesisSkeleton />
                    </>
                  ) : (
                    <>
                      {smsDistribution.total > 0 && (
                        <div>
                          <div className="flex items-baseline justify-between mb-1.5">
                            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{briefLabel(selectedLanguage, 'smsDistribution')}</div>
                            <div className="text-[10px] text-slate-500">
                              <strong className="text-teal-700 font-semibold tabular-nums">{smsDistribution.strongPct}%</strong> {briefLabel(selectedLanguage, 'atSMSStrong')}
                            </div>
                          </div>
                          <div className="flex h-5 w-full rounded-md overflow-hidden border border-slate-200">
                            {smsDistribution.buckets.map(({ level, count, pct }) =>
                              count > 0 ? (
                                <div
                                  key={level}
                                  className={`${smsBarColor(level)} flex items-center justify-center text-[10px] font-semibold ${level >= 4 ? 'text-white' : level === 3 ? 'text-teal-900' : 'text-slate-700'}`}
                                  style={{ width: `${pct * 100}%`, minWidth: '14px' }}
                                  title={`SMS ${level}: ${count} paper${count > 1 ? 's' : ''}`}
                                >
                                  {pct >= 0.1 ? count : ''}
                                </div>
                              ) : null
                            )}
                          </div>
                          <div className="flex justify-between text-[9px] text-slate-400 mt-1 leading-none">
                            <span>← SMS 5</span>
                            <span>SMS 0 →</span>
                          </div>
                        </div>
                      )}
                      {methodsMix.length > 0 && (
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-1.5">{briefLabel(selectedLanguage, 'methodsMix')}</div>
                          <ul className="space-y-1 text-xs columns-2 gap-3">
                            {methodsMix.map((m) => (
                              <li key={m.label} className="flex gap-1.5 leading-relaxed break-inside-avoid">
                                <span className="text-slate-400 shrink-0">•</span>
                                <span className="flex-1 text-slate-700">
                                  <strong className="text-slate-900 font-semibold">{m.count}</strong>{' '}
                                  {m.label}
                                  {m.smsLevel != null && m.smsLevel > 0 && (
                                    <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-slate-50 text-slate-600 border-slate-200">SMS {m.smsLevel}</span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {recencyBand && (
                        <p className="text-xs text-slate-600 leading-relaxed">
                          <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{briefLabel(selectedLanguage, 'evidenceSpan')}:</span>{' '}
                          <span className="tabular-nums text-slate-700">{recencyBand.min}–{recencyBand.max}</span>
                          {' · '}<span className="text-slate-500">{briefLabel(selectedLanguage, 'medianYear')}</span>{' '}
                          <span className="tabular-nums text-slate-700">{recencyBand.median}</span>
                          {' · '}<strong className="text-teal-700 font-semibold tabular-nums">{recencyBand.recent}</strong>{' '}
                          <span className="text-slate-500">{briefLabel(selectedLanguage, 'inLastYears')}</span>
                        </p>
                      )}
                      {strongestEvidence && (
                        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                          <div className="text-[10px] uppercase tracking-widest text-emerald-700 font-bold mb-1.5">{briefLabel(selectedLanguage, 'evidenceStrength')}</div>
                          <div className="text-xs text-emerald-900 leading-snug">
                            <span className="font-semibold">{strongestEvidence.authorTag} ({strongestEvidence.year ?? 'n.d.'})</span>
                            {strongestEvidence.title && <span>, &ldquo;{strongestEvidence.title}&rdquo;</span>}
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
                            {strongestEvidence.geography.map((g) => (
                              <span key={g} className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">{g}</span>
                            ))}
                            {strongestEvidence.design && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">{strongestEvidence.design}</span>
                            )}
                            {strongestEvidence.smsLevel != null && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium tabular-nums">SMS {strongestEvidence.smsLevel}</span>
                            )}
                          </div>
                        </div>
                      )}
                      {smsDistribution.total === 0 && methodsMix.length === 0 && !strongestEvidence && !recencyBand && (
                        <p className="text-slate-400 text-xs italic">{briefLabel(selectedLanguage, 'noMethodologyNote')}</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ── § 3 Coverage — collapsible expander at bottom of synthesis column ── */}
            {hasCoverageContent && <div className="border-t border-slate-100 mx-6">
              <button
                type="button"
                onClick={() => setShowCoverage((v) => !v)}
                className="w-full flex items-center justify-between py-3 text-left"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-[0.18em] text-teal-700 font-bold">§ 3</span>
                  <span className="text-sm font-semibold text-slate-900">{briefLabel(selectedLanguage, 'coverageGaps')}</span>
                  {coverageCard.gapType && (
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                      coverageCard.gapType === 'research_gap' ? 'bg-red-100 text-red-700' :
                      coverageCard.gapType === 'retrieval_issue' ? 'bg-amber-100 text-amber-700' :
                      coverageCard.gapType === 'methodological_gap' ? 'bg-orange-100 text-orange-700' :
                      coverageCard.gapType === 'regional_gap' ? 'bg-violet-100 text-violet-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>{gapTypeLabel(coverageCard.gapType, selectedLanguage)}</span>
                  )}
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  className={`text-slate-400 transition-transform shrink-0 ${showCoverage ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {showCoverage && (
                <div className="pb-5 space-y-2.5">
                  {isSynthesizing ? (
                    <>
                      <div className="flex items-center gap-2 mb-3">
                        <Spinner size="sm" />
                        <span className="text-xs text-teal-700 font-medium">{briefLabel(selectedLanguage, 'mappingCoverage')}</span>
                      </div>
                      <div className="space-y-2 animate-pulse">
                        <div className="h-3 bg-slate-200 rounded-md w-full" />
                        <div className="h-3 bg-slate-200 rounded-md w-4/5" />
                      </div>
                    </>
                  ) : (
                    <>
                      {coverageCard.lacCoverage ? (
                        (coverageCard.lacCoverage.covered.length > 0 || coverageCard.lacCoverage.uncovered.length > 0) && (
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.12em] text-violet-700 font-bold mb-1.5">{briefLabel(selectedLanguage, 'lacEvidence')}</div>
                            {coverageCard.lacCoverage.covered.length > 0 ? (
                              <div className="space-y-1">
                                <div className="flex flex-wrap gap-1">
                                  {coverageCard.lacCoverage.covered.slice(0, 8).map((c) => (
                                    <span key={c.country} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-medium text-emerald-800 tabular-nums">
                                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                      {c.country} <span className="text-emerald-700 font-semibold">{c.count}</span>
                                    </span>
                                  ))}
                                </div>
                                {coverageCard.lacCoverage.uncovered.length > 0 && (
                                  <div className="flex flex-wrap gap-1 pt-0.5">
                                    {coverageCard.lacCoverage.uncovered.slice(0, 8).map((country) => (
                                      <span key={country} className="inline-flex items-center gap-1 rounded-full bg-slate-50 border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                                        <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                                        {country}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs leading-relaxed text-slate-600 italic">{briefLabel(selectedLanguage, 'noLacCoverage')}</p>
                            )}
                          </div>
                        )
                      ) : coverageCard.regionalGap && (
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.12em] text-violet-700 font-bold mb-1">{briefLabel(selectedLanguage, 'lacEvidence')}</div>
                          <p className="text-xs leading-relaxed text-slate-700">{coverageCard.regionalGap}</p>
                        </div>
                      )}
                      {coverageCard.recencyGap && (
                        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5">
                          <div className="text-[10px] uppercase tracking-[0.12em] text-amber-700 font-bold mb-1">{briefLabel(selectedLanguage, 'recencyAlert')}</div>
                          <p className="text-xs leading-relaxed text-amber-900">{coverageCard.recencyGap}</p>
                        </div>
                      )}
                      {thinEvidence && (thinEvidence.zeroResearchTopics.length > 0 || thinEvidence.weakRigorTopics.length > 0 || thinEvidence.lacFewRigorous.length > 0) && (
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.12em] text-rose-700 font-bold mb-1.5">{briefLabel(selectedLanguage, 'thinEvidenceAreas')}</div>
                          <div className="space-y-1.5 text-xs text-slate-700 leading-snug">
                            {thinEvidence.zeroResearchTopics.length > 0 && (
                              <div><span className="font-semibold text-slate-900">{briefLabel(selectedLanguage, 'zeroResearch')}:</span>{' '}{thinEvidence.zeroResearchTopics.join(', ')}.</div>
                            )}
                            {thinEvidence.weakRigorTopics.length > 0 && (
                              <div><span className="font-semibold text-slate-900">{briefLabel(selectedLanguage, 'weakRigor')}:</span>{' '}{thinEvidence.weakRigorTopics.map((t) => `${t.label} (${t.total} paper${t.total === 1 ? '' : 's'}, ${t.strong} SMS 4–5)`).join(', ')}.</div>
                            )}
                            {thinEvidence.lacFewRigorous.length > 0 && (
                              <div><span className="font-semibold text-slate-900">{briefLabel(selectedLanguage, 'lacNeedsRigor')}:</span>{' '}{thinEvidence.lacFewRigorous.map((c) => `${c.label} (${c.total} paper${c.total === 1 ? '' : 's'}, ${c.strong} SMS 4–5)`).join(', ')}.</div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>}

            {/* ── § 5 Follow-up questions (chips, bottom of synthesis column) ── */}
            {sections.followUpQuestions && sections.followUpQuestions.length > 0 && (
              <div className="border-t border-slate-100 mx-6 py-4 pb-6">
                <div className="flex items-baseline gap-2 mb-3">
                  <span className="text-[10px] uppercase tracking-[0.18em] text-teal-700 font-bold">§ 5</span>
                  <span className="text-sm font-semibold text-slate-900">Suggested follow-ups</span>
                </div>
                <ol className="space-y-1.5 text-xs text-slate-700">
                  {sections.followUpQuestions.map((q, i) => (
                    <li key={i} className="flex gap-2 leading-relaxed">
                      <span className="text-teal-600 font-semibold shrink-0 tabular-nums">{i + 1}.</span>
                      <span className="flex-1">{q}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            </div> {/* end synthesis column */}

            {/* Drag-to-resize divider — desktop, two-column only. */}
            {layoutMode !== 'table-focus' && (
              <div
                onMouseDown={startSplitDrag}
                className="hidden lg:block w-1.5 shrink-0 cursor-col-resize bg-slate-100 hover:bg-teal-400 active:bg-teal-500 transition"
                title="Drag to resize brief / table"
              />
            )}

            {/* TABLE COLUMN — resizable in two-column, full width in table-focus.
                On mobile: hidden when user is on the Brief tab. */}
            <div data-print-hide
              className={layoutMode === 'table-focus'
                ? 'w-full max-w-4xl mx-auto'
                : `w-full max-h-[50%] overflow-y-auto lg:max-h-none min-w-0 ${isDesktopSplit ? '' : 'lg:w-[45%]'} ${mobileView === 'brief' ? 'hidden md:block' : ''}`}
              style={layoutMode !== 'table-focus' && isDesktopSplit ? { width: `${100 - briefPct}%` } : undefined}>
            {/* § 4 — Evidence table (flat — card chrome stripped, column is the container) */}
            <section className="overflow-visible">
              {/* Clickable header — toggles the table body */}
              <button
                type="button"
                onClick={() => setShowEvidenceTable((v) => !v)}
                className="w-full px-6 py-4 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50 transition text-left"
                aria-expanded={showEvidenceTable}
              >
                <div className="flex items-baseline gap-3 flex-wrap">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-teal-700 font-bold">§ 4</div>
                    <h3 className="text-lg font-semibold text-slate-900 mt-0.5">
                      {(() => {
                        const briefBasis = (brief?.sections.evidenceRows?.length ?? 0) + extraIds.length + manualPapers.length;
                        const visibleAfterFilters = allSortedRows.length;
                        const filtersHide = briefBasis - visibleAfterFilters;
                        const topShown = Math.min(visibleCount, visibleAfterFilters);
                        return (
                          <>
                            All {briefBasis} paper{briefBasis === 1 ? '' : 's'} behind this brief
                            {filtersHide > 0 && (
                              <span className="font-normal text-amber-700">
                                {' '}— {filtersHide} outside current year/scope filter
                              </span>
                            )}
                            {showEvidenceTable && visibleAfterFilters > 0 && (
                              <span className="font-normal text-slate-500"> — showing top {topShown}{filtersHide === 0 ? '' : ` of ${visibleAfterFilters}`}</span>
                            )}
                          </>
                        );
                      })()}
                    </h3>
                    <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-2">
                      <span>
                        Sorted by{' '}
                        {sortField === 'sms' ? `rigor (SMS) ${sortDirection === 'desc' ? '↓ strongest' : '↑ weakest'}` :
                         sortField === 'citations' ? `most cited ${sortDirection === 'desc' ? '↓' : '↑'}` :
                         sortField === 'year' ? `year ${sortDirection === 'desc' ? '↓ newest' : '↑ oldest'}` :
                         sortField === 'title' ? `title ${sortDirection === 'asc' ? 'A→Z' : 'Z→A'}` :
                         sortField === 'channel' ? `channel ${sortDirection === 'asc' ? '(Causal first)' : '(General first)'}` :
                         sortField === 'relevance' ? 'relevance' :
                         sortField}
                        {' '}— click a column header to change
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="font-medium text-slate-600">
                        {timeRange === 'recent-2020' ? '2020-present' : timeRange === 'all' ? 'All years (1961+)' : timeRange === 'last-5' ? 'Last 5 years' : timeRange === 'last-10' ? 'Last 10 years' : 'Last 20 years'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500 font-medium">
                  {showEvidenceTable ? 'Hide' : 'View'}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${showEvidenceTable ? 'rotate-180' : ''}`}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </button>


              {showEvidenceTable && (
              <>

              {/* Off-topic footnote legend — only when some rows are flagged. */}
              {hasOffRows && (
                <div className="px-6 pt-3 text-[11px] text-amber-700 leading-relaxed">
                  <span className="font-bold">*</span> = flagged as likely <strong>off-topic</strong> for this query — kept for transparency and sorted to the bottom. All other papers are on-topic.
                </div>
              )}

              {/* Show / Hide Additional details — controls the in-line expand sub-rows below */}
              {allSortedRows.length > 0 && (
                <div className="px-6 py-3 border-t border-slate-100 flex flex-wrap items-center gap-3 justify-between">
                  <button
                    onClick={() => setShowDetails((v) => !v)}
                    className={`rounded-full border-2 px-4 py-1.5 text-xs font-semibold transition ${
                      showDetails
                        ? 'bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-teal-300 hover:text-teal-700'
                    }`}
                    title="Click to reveal methodology, SMS, and abstracts in-line."
                  >
                    {showDetails ? '− Hide Additional details' : '+ Show Additional details'}
                  </button>
                  <span className="text-[11px] text-slate-400 italic">
                    {showDetails ? 'Showing SMS · design · sample · abstract for each row below.' : 'Click to reveal methodology, SMS, and abstracts in-line.'}
                  </span>
                </div>
              )}

              {/* ── Add paper panel ── */}
              {onResolvePaper && !isSynthesizing && (
                <div className="px-6 py-3 border-t border-slate-100">
                  {manualPapers.length < 3 ? (
                    !showAddPanel ? (
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-[11px] text-slate-400 mb-1">Add papers you think are relevant and are not in the Table of Evidence · max 3</p>
                          <button
                            onClick={() => setShowAddPanel(true)}
                            className="text-xs font-semibold text-violet-700 hover:text-violet-900 transition flex items-center gap-1"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Add paper {manualPapers.length > 0 ? `(${manualPapers.length} of 3)` : ''}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <input
                            type="file"
                            accept="application/pdf"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handlePdfFile(f); }}
                            className="text-xs text-slate-600"
                          />
                          {addPdfFile && <span className="text-xs text-slate-500 mt-1 block">{addPdfFile.name}</span>}
                        </div>

                        {addStatus === 'error' && addError && (
                          <p className="text-xs text-red-600">{addError}</p>
                        )}

                        {addStatus === 'preview' && addPreview && (
                          <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-semibold text-slate-900 leading-snug">{addPreview.title}</p>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  {(addPreview.authors ?? []).slice(0, 3).join(', ')}{(addPreview.authors?.length ?? 0) > 3 ? ' et al.' : ''}{addPreview.year ? ` · ${addPreview.year}` : ''}
                                </p>
                                {addPreview.card?.findingShort && (
                                  <p className="text-[11px] text-slate-600 mt-1 italic leading-snug">{addPreview.card.findingShort}</p>
                                )}
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                {addPreview.smsLevel != null && (
                                  <span className="rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">SMS {addPreview.smsLevel}</span>
                                )}
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold border ${addPreview.matchedWorkId ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                                  {addPreview.matchedWorkId ? 'In corpus' : 'External'}
                                </span>
                              </div>
                            </div>
                            <div className="flex gap-2 pt-1">
                              <button onClick={handleConfirmAdd} className="rounded-full bg-violet-600 hover:bg-violet-700 text-white px-3 py-1 text-xs font-semibold transition">
                                Add to brief
                              </button>
                              <button onClick={() => { setAddStatus('idle'); setAddPreview(null); }} className="rounded-full border border-slate-200 text-slate-600 px-3 py-1 text-xs font-semibold hover:border-slate-300 transition">
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {addStatus !== 'preview' && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => void handleAddPaper()}
                              disabled={addStatus === 'resolving'}
                              className="rounded-full bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white px-4 py-1.5 text-xs font-semibold transition flex items-center gap-1.5"
                            >
                              {addStatus === 'resolving' && <Spinner size="sm" />}
                              {addStatus === 'resolving' ? 'Uploading…' : 'Confirm Upload paper'}
                            </button>
                            <button
                              onClick={() => { setShowAddPanel(false); setAddStatus('idle'); setAddError(null); setAddPreview(null); }}
                              className="rounded-full border border-slate-200 text-slate-600 px-4 py-1.5 text-xs font-semibold hover:border-slate-300 transition"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  ) : (
                    <p className="text-xs text-slate-400">3 / 3 papers added — maximum reached.</p>
                  )}
                </div>
              )}

              {/* Table — click any row to open the paper detail modal */}
              <div className="flex border-t border-slate-100">
                <div className="w-full overflow-x-auto">
                  {allSortedRows.length === 0 ? (
                    <div className="py-12 px-6 text-center">
                      <div className="text-slate-500 text-sm font-medium mb-2">No papers matched.</div>
                      <ul className="text-slate-400 text-xs space-y-1 max-w-md mx-auto text-left list-disc list-inside">
                        <li>Try broader terms (e.g. "labor informality" instead of "informal labor markets in Argentina 2024").</li>
                        <li>Drop quality filters in the sidebar — by default all 5 SMS tiers are on, but you may have narrowed.</li>
                        <li>Widen the time window (top-right). "All years (1961+)" reveals the full corpus.</li>
                        <li>Topic may be understudied in LAC — the corpus skews to economics, health policy, education, social protection.</li>
                      </ul>
                    </div>
                  ) : (
                    <table className="min-w-full text-sm table-fixed">
                      <thead className="text-left text-slate-500 border-b border-slate-100">
                        <tr>
                          <th className="pb-3 pl-6 pr-2 pt-4 font-semibold w-10">#</th>

                          {/* Title — sortable */}
                          <th className="pb-3 pr-3 pt-4 font-semibold cursor-pointer select-none hover:text-cyan-700 transition" onClick={() => handleSortClick('title')}>
                            <span className="inline-flex items-center gap-0.5">
                              Title
                              <SortArrow field="title" activeField={sortField} direction={sortDirection} />
                            </span>
                          </th>

                          {/* Year — sortable */}
                          <th className="hidden md:table-cell pb-3 pr-3 pt-4 font-semibold w-16 whitespace-nowrap cursor-pointer select-none hover:text-cyan-700 transition" onClick={() => handleSortClick('year')}>
                            <span className="inline-flex items-center gap-0.5">
                              Year
                              <SortArrow field="year" activeField={sortField} direction={sortDirection} />
                            </span>
                          </th>

                          {/* Rigor — sortable + hover popup (replaces ℹ icon) */}
                          <th className="hidden md:table-cell pb-3 pr-3 pt-4 font-semibold w-20 whitespace-nowrap cursor-pointer select-none hover:text-cyan-700 transition" onClick={() => handleSortClick('sms')}>
                            <span className="relative group/sms inline-flex items-center gap-0.5">
                              Rigor
                              <SortArrow field="sms" activeField={sortField} direction={sortDirection} />
                              <div className="hidden group-hover/sms:block absolute left-0 top-full mt-1 z-[100] w-72 rounded-lg border border-slate-200 bg-white shadow-xl p-3 text-left font-normal cursor-default pointer-events-auto" onClick={e => e.stopPropagation()}>
                                <div className="text-[11px] font-bold text-slate-800 mb-0.5">Rigor — Scientific Methods Scale</div>
                                <div className="text-[9px] text-slate-400 mb-2">Based on White &amp; Sabarwal (2014) · 3ie</div>
                                <div className="space-y-1.5">
                                  {([
                                    { n: 5, label: 'RCT', desc: 'Randomised Controlled Trial — gold standard for causal inference', cls: 'bg-emerald-100 text-emerald-800' },
                                    { n: 4, label: 'Quasi-experiment', desc: 'DiD, IV, RDD — strong identification strategy', cls: 'bg-emerald-50 text-emerald-700' },
                                    { n: 3, label: 'Observational', desc: 'Fixed effects, matching — credible but not quasi-experimental', cls: 'bg-teal-50 text-teal-700' },
                                    { n: 2, label: 'Correlational', desc: 'Regression with controls — association, not causation', cls: 'bg-slate-100 text-slate-600' },
                                    { n: 1, label: 'Descriptive', desc: 'Simple correlation — no causal claim warranted', cls: 'bg-slate-50 text-slate-500' },
                                  ] as const).map(({ n, label, desc, cls }) => (
                                    <div key={n} className="flex items-start gap-1.5">
                                      <span className={`text-[9px] font-bold px-1 py-0.5 rounded shrink-0 ${cls}`}>{n}</span>
                                      <span className="text-[10px] text-slate-600 leading-tight"><strong className="text-slate-700">{label}</strong> — {desc}</span>
                                    </div>
                                  ))}
                                </div>
                                <div className="mt-2 pt-2 border-t border-slate-100">
                                  <div className="flex items-start gap-1.5">
                                    <span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-slate-50 text-slate-400">—</span>
                                    <span className="text-[10px] text-slate-600 leading-tight"><strong className="text-slate-700">Non-empirical</strong> — Theoretical, literature reviews, qualitative commentary, policy briefs with no primary data or statistical analysis</span>
                                  </div>
                                </div>
                                <a href="https://www.3ieimpact.org/evidence-hub/methods-and-guidance" target="_blank" rel="noreferrer" className="mt-2 block text-[10px] text-teal-600 hover:underline" onClick={e => e.stopPropagation()}>Learn more at 3ie ↗</a>
                              </div>
                            </span>
                          </th>

                          {/* Channel — sortable + hover popup */}
                          <th className="hidden md:table-cell pb-3 pr-3 pt-4 font-semibold w-28 whitespace-nowrap cursor-pointer select-none hover:text-cyan-700 transition" onClick={() => handleSortClick('channel')}>
                            <span className="relative group/channel inline-flex items-center gap-0.5">
                              Channel
                              <SortArrow field="channel" activeField={sortField} direction={sortDirection} />
                              <div className="hidden group-hover/channel:block absolute right-0 top-full mt-1 z-[100] w-72 rounded-lg border border-slate-200 bg-white shadow-xl p-3 text-left font-normal cursor-default pointer-events-auto" onClick={e => e.stopPropagation()}>
                                <div className="text-[11px] font-bold text-slate-800 mb-2">Channel — why this paper was prioritised</div>
                                <div className="space-y-1.5">
                                  <div className="flex items-start gap-1.5"><span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-emerald-50 text-emerald-700">Causal</span><span className="text-[10px] text-slate-600 leading-tight">Uses RCT, DiD, IV, or RDD; or SMS 4–5</span></div>
                                  <div className="flex items-start gap-1.5"><span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-indigo-50 text-indigo-700">Found.</span><span className="text-[10px] text-slate-600 leading-tight">Pre-2020, 75+ citations — landmark work in the field</span></div>
                                  <div className="flex items-start gap-1.5"><span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-amber-50 text-amber-700">Recent</span><span className="text-[10px] text-slate-600 leading-tight">Published 2020 or later</span></div>
                                  <div className="flex items-start gap-1.5"><span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-teal-50 text-teal-700">LAC</span><span className="text-[10px] text-slate-600 leading-tight">Study conducted in Latin America &amp; the Caribbean</span></div>
                                  <div className="flex items-start gap-1.5"><span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0 bg-slate-100 text-slate-500">General</span><span className="text-[10px] text-slate-600 leading-tight">No specific channel tag applies</span></div>
                                </div>
                              </div>
                            </span>
                          </th>
                          <th
                            className="pb-3 pr-6 pt-4 font-semibold w-24 whitespace-nowrap text-center"
                            title="💾 Save to library  ·  👍 Helpful — keep similar in your feed  ·  👎 Not useful — don't recommend like this"
                          >
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedRows.map((row, index) => (
                          <EvidenceTableRow
                            key={row.workId}
                            row={row}
                            work={worksById[row.workId]}
                            index={index}
                            isSelected={row.workId === selectedWorkId}
                            showDetails={showDetails}
                            savedWorkIds={savedWorkIds}
                            dislikePopoverWorkId={dislikePopoverWorkId}
                            setDislikePopoverWorkId={setDislikePopoverWorkId}
                            openPaperDetail={openPaperDetail}
                            onFeedback={onFeedback}
                            onStarWork={onStarWork}
                            onExcludeWork={onExcludeWork}
                            selectedLanguage={selectedLanguage}
                            showToast={showToast}
                            setModalWorkId={setModalWorkId}
                            evidenceClassification={evidenceClassification}
                            worksById={worksById}
                            onRemoveManualPaper={row.isManualAdd ? (id) => setManualPapers((prev) => prev.filter((p) => (p.matchedWorkId ?? p.doi ?? p.uploadId) !== id)) : undefined}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}

                  {visibleCount < allSortedRows.length && (
                    <div className="px-6 py-4 border-t border-slate-100 flex flex-wrap items-center gap-3">
                      <button
                        onClick={() => setVisibleCount((n) => Math.min(n + ROWS_PER_LOAD, allSortedRows.length))}
                        className="rounded-full border-2 border-teal-200 bg-teal-50 hover:bg-teal-100 hover:border-teal-300 px-5 py-2 text-sm font-semibold text-teal-700 transition"
                      >
                        See {Math.min(ROWS_PER_LOAD, allSortedRows.length - visibleCount)} more papers in Table
                      </button>
                      {visibleCount > ROWS_DEFAULT && (
                        <button
                          onClick={() => setVisibleCount(ROWS_DEFAULT)}
                          className="text-sm font-medium text-slate-500 hover:text-slate-700 transition"
                        >
                          Collapse to top {ROWS_DEFAULT}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Server-side load-more: pull the pre-ranked extended pool
                      (papers 51–200) stored at search time. Shown once the user
                      has expanded to the end of the currently-loaded rows and the
                      run reported more evidence available. Previously the props
                      were passed in but no button ever rendered them. */}
                  {showLoadMoreSuggestion && onLoadMore && visibleCount >= allSortedRows.length && (
                    <div className="px-6 py-4 border-t border-slate-100">
                      <button
                        onClick={() => void onLoadMore()}
                        disabled={isLoadingMore}
                        className="rounded-full border-2 border-teal-200 bg-teal-50 hover:bg-teal-100 hover:border-teal-300 px-5 py-2 text-sm font-semibold text-teal-700 transition disabled:opacity-60 flex items-center gap-2"
                      >
                        {isLoadingMore && <Spinner size="sm" />}
                        {isLoadingMore ? 'Loading more papers…' : 'Load more papers from the extended pool'}
                      </button>
                    </div>
                  )}

                  {manualPapers.length > 0 && onRegenerateBrief && brief && (
                    <div className="px-6 py-3 border-t border-slate-100">
                      <button
                        onClick={() => void onRegenerateBrief(
                          (brief.sections.evidenceRows ?? []).map((r) => r.workId),
                          manualPapers,
                        )}
                        disabled={isRegenerating}
                        className="rounded-full bg-teal-600 hover:bg-teal-700 px-5 py-2 text-sm font-semibold text-white transition disabled:opacity-60 flex items-center gap-2"
                      >
                        {isRegenerating && <Spinner size="sm" />}
                        {isRegenerating ? 'Regenerating…' : `Regenerate brief with ${(brief.sections.evidenceRows?.length ?? 0) + manualPapers.length} papers`}
                      </button>
                    </div>
                  )}
                </div>

                {/* PaperSidePanel removed — paper detail is now a modal overlay.
                    See the portal-rendered PaperDetailModal below. */}
              </div>
              </>
              )}
            </section>

            </div> {/* end table column */}

          </div> {/* end outer two-column flex */}

          {/* Audit trace — bottom of brief, collapsed by default */}
          {!isSynthesizing && (
            <div className="mt-4">
              <AuditTraceSection auditTrace={brief.auditTrace} />
            </div>
          )}

        </div>
      )}

      {/* ── Paper detail modal — fixed overlay, replaces PaperSidePanel ── */}
      {(() => {
        const isCorrectionMode = typeof modalWorkId === 'string' && modalWorkId.endsWith('__correction');
        const effectiveId = isCorrectionMode ? modalWorkId.replace('__correction', '') : modalWorkId;
        const modalWork = effectiveId ? worksById[effectiveId] ?? null : null;
        const modalRow = effectiveId ? (allSortedRows.find((r) => r.workId === effectiveId) ?? null) : null;
        if (!effectiveId || (!modalWork && !modalRow)) return null;
        const title = modalRow?.title ?? modalWork?.title ?? '';
        const authors = (modalRow?.authors ?? modalWork?.authors ?? []).join(', ');
        const year = modalRow?.year || modalWork?.year || null;
        const venue = modalWork?.venue || modalRow?.sourceName || '';
        const abstract = modalWork?.abstract || modalWork?.summary || modalRow?.finding || '';
        const paperUrl = modalRow?.doi ? `https://doi.org/${modalRow.doi}` : (modalRow?.url || modalWork?.openAccessPdfUrl || null);
        const sms = (modalRow ? getRowSmsLevel(modalRow, modalWork) : modalWork?.smsLevel) ?? null;
        const design = getRowMethodologyDesign(modalRow as EvidenceRow, modalWork) ?? null;
        const geo = regionsFromGeography(modalWork?.geography?.length ? modalWork.geography : (modalRow?.geography ?? []));

        const SMS_LABEL: Record<number,string> = { 5:'RCT — Gold standard', 4:'Strong quasi-experiment (DiD/IV/RDD)', 3:'Quasi-experimental', 2:'Correlational', 1:'Descriptive', 0:'Review / Theory (non-empirical)' };
        const smsCls = sms == null ? 'bg-slate-100 text-slate-600' : sms >= 4 ? 'bg-emerald-100 text-emerald-800' : sms === 3 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600';

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={() => setModalWorkId(null)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-slate-100 shrink-0">
                <h2 className="text-base font-semibold text-slate-900 leading-snug">{title}</h2>
                <button onClick={() => setModalWorkId(null)} className="shrink-0 p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition" aria-label="Close">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
              </div>

              {/* Modal body */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {/* Authors + year + journal */}
                <div className="text-sm text-slate-500 space-y-0.5">
                  {authors && <div className="text-slate-700 font-medium">{authors}</div>}
                  <div className="flex flex-wrap items-center gap-2">
                    {year && year > 0 && <span className="tabular-nums">{year}</span>}
                    {venue && <span className="font-medium text-slate-700">{venue}</span>}
                    {modalWork?.citationCount != null && modalWork.citationCount > 0 && (
                      <span className="text-slate-400">{modalWork.citationCount.toLocaleString()} citations</span>
                    )}
                  </div>
                </div>

                {/* SMS + design + geography chips */}
                <div className="flex flex-wrap gap-2">
                  {sms != null && (
                    <span className={`inline-flex flex-col items-start px-3 py-1.5 rounded-lg text-xs font-bold ${smsCls}`}>
                      <span>SMS {sms}</span>
                      <span className="font-normal text-[10px] opacity-80">{SMS_LABEL[sms] ?? ''}</span>
                    </span>
                  )}
                  {design && <span className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700">{design}</span>}
                  {geo.slice(0, 5).map((g) => (
                    <span key={g} className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600">{g}</span>
                  ))}
                  {modalWork?.absRating && (
                    <span className={`px-3 py-1.5 rounded-lg text-xs font-bold ${modalWork.absRating === '4*' || modalWork.absRating === '4' ? 'bg-violet-100 text-violet-800' : 'bg-blue-50 text-blue-700'}`}>
                      ABS {modalWork.absRating}
                    </span>
                  )}
                </div>

                {/* Abstract */}
                {!isCorrectionMode && (
                  abstract ? (
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.15em] text-slate-400 font-bold mb-2">Abstract</div>
                      <p className="text-sm text-slate-700 leading-relaxed">{abstract}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 italic">No abstract available in corpus.</p>
                  )
                )}

                {/* Correction form — only in correction mode */}
                {isCorrectionMode && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.15em] text-amber-700 font-bold mb-3">Data quality correction — for admin review</div>
                    <p className="text-xs text-slate-500 mb-4">Flag what looks wrong. All corrections go to a review queue — nothing changes automatically.</p>
                    <div className="space-y-3">
                      {(['Year', 'Journal / source', 'Geography (countries)', 'SMS / rigor level'] as const).map((field) => (
                        <div key={field} className="flex items-center gap-3 text-sm">
                          <input
                            type="checkbox"
                            id={`cf-${field}`}
                            className="accent-amber-600 shrink-0"
                            checked={!!correctionChecked[field]}
                            onChange={(e) => setCorrectionChecked((s) => ({ ...s, [field]: e.target.checked }))}
                          />
                          <label htmlFor={`cf-${field}`} className="text-slate-700 font-medium w-52 shrink-0">{field}</label>
                          <input
                            type="text"
                            placeholder="Correct value…"
                            className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400"
                            value={correctionValues[field] ?? ''}
                            onChange={(e) => setCorrectionValues((s) => ({ ...s, [field]: e.target.value }))}
                          />
                        </div>
                      ))}
                      <div>
                        <label className="text-sm font-medium text-slate-700 block mb-1">Other / notes</label>
                        <textarea
                          placeholder="Describe what's wrong…"
                          rows={2}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
                          value={correctionNotes}
                          onChange={(e) => setCorrectionNotes(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Modal footer */}
              <div className="px-6 py-4 border-t border-slate-100 flex items-center gap-3 shrink-0">
                {paperUrl && !isCorrectionMode && (
                  <a href={paperUrl} target="_blank" rel="noreferrer" className="flex-1 rounded-full bg-teal-700 text-white text-sm font-semibold px-4 py-2.5 text-center hover:bg-teal-800 transition">
                    Open paper ↗
                  </a>
                )}
                {isCorrectionMode && (
                  <button
                    className="flex-1 rounded-full bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2.5 transition"
                    onClick={async () => {
                      // Actually persist the correction (the old handler toasted
                      // success and threw the user's input away). Stored as a
                      // dislike-with-reason on /api/feedback — the admin review
                      // queue reads reasons from feedback rows.
                      const parts = (['Year', 'Journal / source', 'Geography (countries)', 'SMS / rigor level'] as const)
                        .filter((f) => correctionChecked[f] || (correctionValues[f] ?? '').trim())
                        .map((f) => `${f}: ${(correctionValues[f] ?? '').trim() || '(flagged, no corrected value given)'}`);
                      if (correctionNotes.trim()) parts.push(`Notes: ${correctionNotes.trim()}`);
                      if (parts.length === 0) { showToast('Nothing to submit — flag a field or add a note first'); return; }
                      try {
                        await apiClient.submitFeedback({
                          workId: effectiveId,
                          briefId: brief?.id,
                          type: 'dislike',
                          reason: `correction: ${parts.join(' | ')}`.slice(0, 2000),
                        });
                        showToast('Correction submitted for admin review');
                      } catch {
                        showToast('Could not submit the correction — please try again');
                        return;
                      }
                      setModalWorkId(null);
                    }}
                  >
                    Submit for review
                  </button>
                )}
                {!isCorrectionMode && modalRow && onFeedback && (
                  <>
                    <button onClick={() => { onFeedback('save', effectiveId); showToast('Paper saved'); }} className="rounded-full border border-slate-200 p-2.5 text-slate-400 hover:text-teal-600 hover:border-teal-300 hover:bg-teal-50 transition" title="Save to library" aria-label="Save">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
                    </button>
                    <button onClick={() => { onFeedback('like', effectiveId); showToast('Marked as helpful'); setModalWorkId(null); }} className="rounded-full border border-slate-200 p-2.5 text-slate-400 hover:text-emerald-600 hover:border-emerald-300 hover:bg-emerald-50 transition" title="Helpful" aria-label="Helpful">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
                    </button>
                  </>
                )}
                <button onClick={() => setModalWorkId(null)} className="rounded-full border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 transition">
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-full bg-slate-900 text-white px-5 py-2.5 text-sm font-medium shadow-lg">
          {toastMessage}
        </div>
      )}
    </div>
  );
};

export default BriefView;
