import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Session } from '@supabase/supabase-js';
import TopFilterBar from './components/TopFilterBar';
import SynthesisModelBadge from './components/SynthesisModelBadge';
import BriefView from './components/BriefView';
import FollowDigestPanel from './components/FollowDigestPanel';
import LibraryPanel from './components/LibraryPanel';
import AccountPanel from './components/AccountPanel';
import ClaudeCodeSetup from './components/ClaudeCodeSetup';
import ChatPanel from './components/ChatPanel';
import SignalsPanel from './components/SignalsPanel';
import WorkspaceNotes from './components/WorkspaceNotes';
import PaperBuildFork from './components/PaperBuildFork';
import AuthGate from './components/AuthGate';
import PasswordResetPanel from './components/PasswordResetPanel';
import ErrorBoundary from './components/ErrorBoundary';
import SearchClarifier from './components/SearchClarifier';
import FollowUpChatBar from './components/FollowUpChatBar';
import { supabase } from './services/supabaseClient';
import { apiClient } from './services/apiClient';
import { copyShareLink, copyBriefAsText, exportBriefAsJson, exportBriefAsDocx } from './services/exportService';
import { AppStateSnapshot, CausalStrength, ChatMessage, DEFAULT_PERSONA, DeepScanResponse, EvidenceBrief, EvidenceRow, JelPaper, normalizePopulationFocus, PaperPlanUpload, PersonaId, SearchFilters, SearchPurpose, SearchRun, SignalItem, Work } from './types';
import { identify, resetAnalytics, track, logEvent } from './services/analytics';
import { detectQueryIntent } from './utils/queryIntent';

// Code-split the heavy, OFF-core-path screens so they aren't in the initial
// bundle the mobile search flow downloads (~2MB → smaller first paint). Each is
// rendered behind a <Suspense> below. BriefView is deliberately NOT lazy — it's
// on the core search→brief path, so a fetch-on-first-brief flash isn't worth it.
const PaperStudio = lazy(() => import('./components/PaperStudio'));
const JelPaperView = lazy(() => import('./components/JelPaperView'));
const RetrievalAuditPanel = lazy(() => import('./components/RetrievalAuditPanel'));
const WeightPanel = lazy(() => import('./components/WeightPanel'));
const PilotMonitor = lazy(() => import('./components/PilotMonitor').then((m) => ({ default: m.PilotMonitor })));
const GrantAccessPanel = lazy(() => import('./components/GrantAccessPanel'));

const LazyFallback = () => (
  <div className="flex items-center justify-center py-16 text-slate-400" role="status" aria-label="Loading">
    <svg className="animate-spin h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  </div>
);

type AppTab = 'search' | 'library' | 'follow' | 'notes' | 'admin' | 'paper-studio' | 'grant-access' | 'pilot-monitor';
type SearchStatus = 'idle' | 'retrieving' | 'synthesizing' | 'error';
type TimeRange = 'recent-2020' | 'all' | 'last-5' | 'last-10' | 'last-20';
// EvidenceScope (direct-only/balanced/broader) removed 2026-06-17 — the
// direct/indirect classifier it drove is gone; the cosine relevance floor
// decides the evidence set now (no breadth/scope choice).

// Admin status is set via Supabase Auth app_metadata.is_admin — not hardcoded here.

// The channel ids the 6-step clarifier (SearchClarifier) can assemble from its
// UI questions. MUST be a subset of types.ts VALID_CHANNEL_IDS — enforced by
// scripts/check-invariants.mjs (the UI decomposition never invents a channel id).
export const QUESTION_CHANNELS_VALUES = ['causal', 'foundational', 'recent', 'lac'];

function formatJournalRatingGroups(groups: number[] = [1, 2, 3]): string {
  if (groups.length === 0) return 'No journals';
  if (groups.length === 5) return 'All journals';
  const has = (t: number) => groups.includes(t);
  if (has(1) && has(2) && has(3) && !has(4) && !has(5)) return 'Top journals';
  if (has(1) && has(2) && !has(3)) return 'Elite journals';
  if (!has(1) && !has(2) && has(3)) return 'Strong journals';
  if (has(1) && has(2) && has(3) && has(4)) return 'Top + wider journals';
  const parts = [];
  if (has(1) || has(2)) parts.push('Top');
  if (has(3)) parts.push('Strong');
  if (has(4)) parts.push('Wider');
  if (has(5)) parts.push('Unranked');
  return parts.join(' + ') || 'No journals';
}


/** Compact clickable chip used in State B — opens full TopFilterBar in a popover */
function FilterChipInline({ filters, setFilters }: { filters: SearchFilters; setFilters: React.Dispatch<React.SetStateAction<SearchFilters>> }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const sms = filters.smsLevels ?? [];
  const tiers = filters.journalTiers ?? [1, 2, 3];
  const inst = (filters.institutionalSources ?? []).join('+') || '—';
  const wp = (filters.workingPaperSources ?? []).join('+') || '—';
  const region = (filters.regions ?? []).length ? filters.regions.join(', ') : 'Global';
  const years = (() => {
    if (filters.timePeriod !== 'custom' || (!filters.startDate && !filters.endDate)) return 'All years (1961+)';
    const s = filters.startDate?.slice(0, 4) ?? '';
    const e = filters.endDate?.slice(0, 4) ?? '';
    if (s === '1961' && !e) return 'All years (1961+)';
    if (s && e) return `${s}–${e}`;
    if (s) return `${s}+`;
    if (e) return `≤${e}`;
    return 'Custom';
  })();
  const match = filters.evidenceMatch === 'direct' ? 'Direct' : filters.evidenceMatch === 'all' ? 'All' : 'Both';
  const rigorSummary = sms.length > 0 && sms.length < 6 ? `SMS ${sms.join('+')}` : 'All rigor levels';
  const filterSummary = [rigorSummary, formatJournalRatingGroups(tiers), inst || '—', wp || 'No WP', years].join(' · ');
  return (
    <div className="relative min-w-0" ref={ref} data-print-hide>
      <button
        onClick={() => setOpen(v => !v)}
        className="text-[11px] text-slate-600 flex items-center gap-1.5 hover:text-teal-700 transition group max-w-full min-w-0"
      >
        <span className="font-semibold shrink-0">Filters:</span>
        <span className="group-hover:underline truncate min-w-0" title={filterSummary}>{filterSummary}</span>
        <span className="text-slate-400 shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-max max-w-[90vw] rounded-xl bg-white border border-slate-200 shadow-xl p-4">
          <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold mb-3">Search Filters</div>
          <TopFilterBar filters={filters} setFilters={setFilters} />
          <div className="mt-3 pt-3 border-t border-slate-100 flex justify-end">
            <button onClick={() => setOpen(false)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-700 hover:bg-slate-50 transition">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}


function formatSearchSetup(filters: SearchFilters): string {
  // Sources — journals + working papers + institutional, all under one "Sources" label
  const journalLabel = formatJournalRatingGroups(filters.journalTiers ?? [1, 2, 3]);
  const inst = (filters.institutionalSources ?? []).join(', ');
  const wp = (filters.workingPaperSources ?? [])
    .map((id) => (id === 'CEPR_REPEC' ? 'CEPR/RePEC' : id))
    .join(', ');
  const sourceParts = [journalLabel, inst, wp].filter(Boolean);
  const sources = sourceParts.length ? `Sources: ${sourceParts.join(' · ')}` : 'No sources';

  // Years
  const years = (() => {
    if (filters.timePeriod !== 'custom' || (!filters.startDate && !filters.endDate)) return 'All years (1961+)';
    const s = filters.startDate?.slice(0, 4) ?? '';
    const e = filters.endDate?.slice(0, 4) ?? '';
    if (s === '1961' && !e) return 'All years (1961+)';
    if (s && e) return `${s}–${e}`;
    if (s) return `${s}+`;
    if (e) return `≤${e}`;
    return 'Custom range';
  })();

  // Rigor
  const rigor = filters.smsLevels?.length
    ? `SMS ${filters.smsLevels.join(', ')}`
    : 'All rigor levels, stronger designs ranked higher';

  return [sources, years, rigor].join(' · ');
}

/**
 * Build a partial brief from search run data (SYNTH-03).
 * Shows coverage card + evidence table immediately while synthesis loads.
 */
const SPANISH_DIACRITICS_QUICK = /[áéíóúñ¿¡]/;
const SPANISH_STOPWORDS_QUICK = new Set(['el','la','los','las','de','del','y','que','en','por','con','un','una','es','son','fue','para','sobre','como','si','no','más','se','al','lo','su','sus','está','han','hay','tiene','tienen','ser','estar']);

function guessWorkLanguage(text: string): 'en' | 'es' | undefined {
  if (!text) return undefined;
  if (SPANISH_DIACRITICS_QUICK.test(text)) return 'es';
  const tokens = text.toLowerCase().split(/[^a-záéíóúñ]+/).filter(Boolean);
  let hits = 0;
  for (const tok of tokens) if (SPANISH_STOPWORDS_QUICK.has(tok)) hits++;
  return hits >= 3 ? 'es' : undefined;
}

function buildPartialBrief(searchRun: SearchRun, worksMap: Record<string, Work>): EvidenceBrief {
  const evidenceWorks = searchRun.evidenceWorkIds
    .map((id) => worksMap[id])
    .filter((w): w is Work => w != null);

  const evidenceRows: EvidenceRow[] = evidenceWorks.map((work) => {
    const cit = work.citationCount ?? 0;
    const yr = work.year ?? 0;
    return {
      workId: work.id,
      title: work.title,
      authors: work.authors || [],
      sourceName: work.venue || work.institution || (work.source === 'semantic_scholar' ? 'Semantic Scholar' : work.source) || 'Unknown',
      year: work.year,
      methodologyBadge: work.methodologyDesign || work.methodology?.design || 'Unclassified',
      causalStrength: (work.causalStrength || work.methodology?.causalStrength || 'signal') as CausalStrength,
      smsLevel: work.smsLevel ?? null,
      citationCount: work.citationCount ?? null,
      isFoundational: cit >= 75 && yr > 0 && yr < 2020,
      geography: work.geography || [],
      doi: work.canonicalDoi,
      url: work.url || work.openAccessPdfUrl || '',
      finding: work.summary || work.abstract || '',
      sourceLanguage: guessWorkLanguage(work.abstract || work.summary || work.title || ''),
      // True channel-of-origin from the persisted map (additive). Undefined for
      // legacy runs → BriefView falls back to the deterministic recompute.
      retrievalChannels: searchRun.workChannels?.[work.id],
      segment: searchRun.workSegments?.[work.id] as ('core' | 'context' | 'off' | undefined),
    };
  });

  return {
    id: 'partial',
    tenantId: searchRun.tenantId,
    searchRunId: searchRun.id,
    status: 'draft',
    query: searchRun.query,
    sections: {
      summaryBullets: [],
      evidenceRows,
      methodologyNote: '',
      coverageCard: {
        universeCount: searchRun.coverage.universeCount,
        retrievedCount: searchRun.coverage.retrievedCount,
        admissibleCount: searchRun.coverage.admissibleCount,
        evidenceCount: searchRun.coverage.evidenceCount,
        signalCount: searchRun.coverage.signalCount,
        gapSummary: '',
        regionalGap: '',
        methodologicalGap: '',
      },
      followUpQuestions: [],
      citations: searchRun.evidenceWorkIds,
      warnings: [],
    },
    auditTrace: {
      model: 'pending',
      promptVersions: {},
      retrievalPolicy: 'hybrid-curated-rag-v1',
      queryPlan: [],
      generatedAt: new Date().toISOString(),
      notes: ['Synthesis in progress...'],
    },
    createdAt: new Date().toISOString(),
    sharePath: '',
  };
}

/**
 * Re-apply a run's persisted workChannels onto its brief's evidence rows so
 * that channel pills are correct when loading a past brief (the server stores
 * workChannels on the search_run row, not on the brief's evidenceRows).
 * Only fills rows whose retrievalChannels is missing/empty — live briefs that
 * already have channels set (from buildPartialBrief) are left untouched.
 * Runs predating v89 have workChannels==null → brief falls back to BriefView's
 * deterministic recompute, which is the acceptable legacy behaviour.
 */
function applyRunChannels(brief: EvidenceBrief, run?: SearchRun | null): EvidenceBrief {
  const wc = run?.workChannels;
  const ws = run?.workSegments;
  if ((!wc && !ws) || !brief?.sections?.evidenceRows) return brief;
  return {
    ...brief,
    sections: {
      ...brief.sections,
      evidenceRows: brief.sections.evidenceRows.map((r) => {
        const channels = (r.retrievalChannels && r.retrievalChannels.length > 0) || !wc ? r.retrievalChannels : wc[r.workId];
        const segment = r.segment ?? (ws?.[r.workId] as ('core' | 'context' | 'off' | undefined));
        return { ...r, retrievalChannels: channels, segment };
      }),
    },
  };
}

const defaultFilters: SearchFilters = {
  // Was ['AI','Labor'] — a leftover demo default that, with no UI to change it,
  // was injected into EVERY search's intent entities + synonyms (retrieval.ts
  // planSearchIntent), silently polluting unrelated queries with AI/labor/
  // automation/employment expansions. Default to none (2026-06-03).
  topics: [],
  // Default: Global (no region restriction). Picker treats [] as "Global" and
  // shows it as the active preset; users can pick LAC, OECD, individual
  // countries, etc. Previously we shipped 'Latin America' as a default — but
  // that string didn't match any picker option, so it was a phantom selection
  // (count showed +1 region than what the user could see checked).
  regions: [],
  timePeriod: 'all',
  startDate: '',
  endDate: '',
  allSources: false,
  // Empty = "no explicit filter; apply server defaults." The TS post-retrieval
  // layer treats empty the same as all-options (both are inactive). The SQL
  // pre-filter (match_works_v2) uses DEFAULT_PRE_FILTERS unless the caller
  // explicitly passes a non-empty selection. This distinction matters when
  // user-selected filters are wired down to SQL predicates.
  smsLevels: [],
  absRatings: [],
  repecBands: [],
  // Journals: ABS 3+ default — ABS 4★ (tier 1), ABS 4 (tier 2), ABS 3 (tier 3).
  // Tier 4 (ABS 1–2 + LAC/development journals) is available as an opt-in.
  journalTiers: [1, 2, 3],
  excludedJournalsByTier: {},
  // Working papers: pure academic WP repos. WB and OECD outputs covered by institutional.
  workingPaperSources: ['NBER', 'IZA', 'CEPR_REPEC', 'SSRN'],
  // Institutional sources: IADB, World Bank, IMF, OECD (all their outputs unified here).
  institutionalSources: ['IADB', 'WB', 'IMF', 'OECD'],
  // Quality-by-default: unranked-venue journal articles are excluded unless the
  // user opts in via the source picker. Default false.
  includeUnranked: false,
  // NOTE: active retrieval channels are tracked in the `searchChannels` Set and
  // sent as the top-level `channels` request field (channelsOverride), NOT via
  // filters.channels. `channels?` exists on the SearchFilters type for contract
  // hygiene (legacy saved runs may carry it); it is intentionally not defaulted
  // here so there is no second, divergent source of channel state.
  // (evidenceMatch DROPPED from defaults 2026-06-17 — classifier removed; the
  //  server treats absent as 'both' and no longer runs the classification filter.)
  // Empty = no document-type filter = ALL publication types (server treats
  // empty/undefined the same — see buildPreFiltersFromSearchFilters). The UI
  // selects GROUPS via PUBLICATION_TYPE_GROUPS (types.ts) and stores the unioned
  // flat enum values here.
  publicationTypes: [],
};

function applyTimeRangeToFilters(base: SearchFilters, timeRange: TimeRange): SearchFilters {
  switch (timeRange) {
    case 'recent-2020':
      return { ...base, timePeriod: 'custom', startDate: '2020-01-01', endDate: '' };
    case 'last-5':
      return { ...base, timePeriod: 'custom', startDate: '2021-01-01', endDate: '' };
    case 'last-10':
      return { ...base, timePeriod: 'custom', startDate: '2016-01-01', endDate: '' };
    case 'last-20':
      return { ...base, timePeriod: 'custom', startDate: '2006-01-01', endDate: '' };
    case 'all':
    default:
      // timePeriod: 'all' = no year filter — label shows (1961+) but no date restriction
      // so papers with null year are NOT excluded from the evidence table
      return { ...base, timePeriod: 'all', startDate: '', endDate: '' };
  }
}

function buildFiltersForTimeRange(base: SearchFilters, _timeRange: TimeRange): SearchFilters {
  return base;
}

/** Decode JWT payload without a library (base64url → JSON). */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

const SPANISH_STOPWORDS = new Set(['el','la','los','las','de','del','y','que','en','por','con','un','una','es','son','fue','para','sobre','como','si','no','más','se','al','lo','su','sus','está','han','hay','tiene','tienen','ser','estar','evidencia','estudio','investigación','análisis','resultados','efecto','impacto','política','hogares','países','qué','cómo','cuál','cuáles']);
const SPANISH_DIACRITICS = /[áéíóúñ¿¡]/;

function detectQueryLanguage(text: string): 'en' | 'es' {
  if (SPANISH_DIACRITICS.test(text)) return 'es';
  const tokens = text.toLowerCase().split(/[^a-záéíóúñ]+/).filter(Boolean);
  let hits = 0;
  for (const tok of tokens) if (SPANISH_STOPWORDS.has(tok)) hits++;
  return hits >= 3 ? 'es' : 'en';
}

// Curated IADB-relevant policy questions for autocomplete + Examples popover.
// Grouped by theme for the popover; flattened for fuzzy matching.
const CURATED_QUESTIONS_BY_THEME: { theme: string; questions: string[] }[] = [
  {
    theme: 'Education & learning',
    questions: [
      'What does evidence say about conditional cash transfers and school attendance in Latin America?',
      'What works to improve learning outcomes in primary schools in low- and middle-income countries?',
      'How effective are tutoring programs for closing learning gaps after COVID-19?',
      'What is the evidence on early childhood education programs in Latin America?',
      'Do school feeding programs improve learning and attendance?',
    ],
  },
  {
    theme: 'Labor, jobs & AI',
    questions: [
      'What does high-quality evidence say about AI and labor productivity in Latin America?',
      'How does automation affect employment in middle-income economies?',
      'What active labor market programs work for youth unemployment?',
      'What is the evidence on minimum wage effects on employment in Latin America?',
      'Do vocational training programs increase formal employment?',
    ],
  },
  {
    theme: 'Health',
    questions: [
      'What works to reduce maternal mortality in Latin America?',
      'How effective are conditional cash transfers for improving child nutrition?',
      'What is the evidence on telemedicine effectiveness in rural areas?',
      'What policies reduce teenage pregnancy in Latin America?',
      'What works to expand health insurance coverage in low- and middle-income countries?',
    ],
  },
  {
    theme: 'Climate & agriculture',
    questions: [
      'What works for climate adaptation among smallholder farmers in Latin America?',
      'How effective are payments for ecosystem services for forest conservation?',
      'What is the evidence on weather index insurance for smallholder farmers?',
      'Do agricultural extension programs increase yields and incomes?',
    ],
  },
  {
    theme: 'Gender & violence',
    questions: [
      'What policies reduce intimate partner violence in Latin America?',
      'What is the evidence on cash transfers for women’s economic empowerment?',
      'Do safe-cities interventions reduce gender-based violence?',
    ],
  },
  {
    theme: 'Crime & security',
    questions: [
      'What works to reduce homicide rates in Latin America?',
      'How effective are hot-spots policing programs?',
      'What is the evidence on rehabilitation programs for at-risk youth?',
    ],
  },
  {
    theme: 'Infrastructure & cities',
    questions: [
      'What is the evidence on bus rapid transit and urban mobility?',
      'How does road infrastructure affect rural economic development?',
      'What works to improve access to clean water and sanitation?',
    ],
  },
  {
    theme: 'Governance & fiscal',
    questions: [
      'What is the evidence on tax compliance interventions in Latin America?',
      'Do anti-corruption audits change government spending?',
      'How effective are e-government platforms for public service delivery?',
    ],
  },
  {
    theme: 'Financial inclusion & migration',
    questions: [
      'What is the evidence on mobile money and poverty reduction?',
      'Do microcredit programs reduce poverty?',
      'What does evidence say about the labor market impact of Venezuelan migration on host countries?',
      'How do remittances affect economic development in Latin America?',
    ],
  },
];
const CURATED_QUESTIONS: string[] = CURATED_QUESTIONS_BY_THEME.flatMap((g) => g.questions);

function matchCuratedQuestions(query: string, limit = 5): string[] {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return [];
  const scored = CURATED_QUESTIONS
    .map((question) => {
      const lower = question.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (lower.includes(token)) score += token.length;
      }
      return { question, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.question.length - b.question.length)
    .slice(0, limit);
  return scored.map((s) => s.question);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Horizon Retrieving Spinner — shown in the content area while retrieval runs
// ---------------------------------------------------------------------------
const HORIZON_MESSAGES = [
  'Horizon scanning 500,000+ papers…',
  'Horizon retrieving evidence…',
  'Identifying causal designs…',
  'Ranking by methodological rigor…',
  'Building your evidence set…',
  'Cross-referencing sources…',
  'Filtering for relevance…',
];

function HorizonRetrievingSpinner() {
  const [msgIdx, setMsgIdx] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setMsgIdx(i => (i + 1) % HORIZON_MESSAGES.length), 2200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center py-24 select-none">
      {/* Animated ring */}
      <div className="relative w-16 h-16 mb-6">
        <div className="absolute inset-0 rounded-full border-4 border-teal-100" />
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-teal-500 animate-spin" />
        <div className="absolute inset-[6px] rounded-full border-2 border-transparent border-t-teal-300 animate-spin" style={{ animationDuration: '1.4s', animationDirection: 'reverse' }} />
      </div>
      {/* Cycling message — fade in/out via CSS keyframes */}
      <p key={msgIdx} className="text-sm font-semibold text-teal-700 text-center horizon-msg">
        {HORIZON_MESSAGES[msgIdx]}
      </p>
      <p className="text-xs text-slate-400 mt-1">Typically 20–60 seconds depending on your search</p>
    </div>
  );
}

const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  const [tab, setTab] = useState<AppTab>('search');
  const [snapshot, setSnapshot] = useState<AppStateSnapshot | null>(null);
  const [filters, setFilters] = useState<SearchFilters>(defaultFilters);
  const [query, setQuery] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedSuggestionIdx, setHighlightedSuggestionIdx] = useState(0);
  const [examplesPopoverOpen, setExamplesPopoverOpen] = useState(false);
  const [currentRun, setCurrentRun] = useState<SearchRun | null>(null);
  const [currentBrief, setCurrentBrief] = useState<EvidenceBrief | null>(null);
  const [currentJelPaper, setCurrentJelPaper] = useState<JelPaper | null>(null);
  // ID of the jel paper queued from the current brief — drives the header spinner.
  // Paper Studio — the active planning-status jel_papers row (carries `.plan`).
  const [activePlan, setActivePlan] = useState<JelPaper | null>(null);
  const [activeJelJobId, setActiveJelJobId] = useState<string | null>(null);
  // Fingerprint of evidence rows when job was queued — unlock button if evidence changes.
  const [jelJobFingerprint, setJelJobFingerprint] = useState<string | null>(null);
  // Live progress from polling (updated every 8s while running).
  const [jelPaperProgress, setJelPaperProgress] = useState<{
    done: number; total: number; status: string; errorMessage?: string | null;
  } | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [clarifyingPhase, setClarifyingPhase] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [lastRunNextToken, setLastRunNextToken] = useState<string | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  // Deep scan (2026-06-10): opt-in second retrieval round over the current
  // brief's search run. State lives here (not BriefView) so the panel survives
  // table collapse/re-render. Reset whenever the active search run changes.
  const [deepScanStatus, setDeepScanStatus] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [deepScanResult, setDeepScanResult] = useState<DeepScanResponse | null>(null);
  const [deepScanNotice, setDeepScanNotice] = useState<string | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const [showClaudeSetup, setShowClaudeSetup] = useState(false);
  // Signals — Exa-backed off-corpus inputs, two profiles, default OFF.
  // Never enter the evidence table or synthesis prompt; rendered separately.
  const [signalProfiles, setSignalProfiles] = useState<{ policy: boolean; buzz: boolean }>({ policy: false, buzz: false });
  const [signalsResult, setSignalsResult] = useState<{ policy: SignalItem[]; buzz: SignalItem[] }>({ policy: [], buzz: [] });
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [signalsError, setSignalsError] = useState<string | null>(null);
  const [signalsFetchedFor, setSignalsFetchedFor] = useState<string | null>(null); // "query|policy,buzz"
  const [showMobileHistory, setShowMobileHistory] = useState(false);
  const [streamingText, setStreamingText] = useState<string>('');
  // POLICY-ONLY: briefs are always the policy register; the persona picker /
  // persona-swap UI was removed 2026-06-03. This constant is threaded into the
  // brief-generation calls only for telemetry/back-compat — the server ignores
  // it and always synthesizes a policy brief (resolvePersona → 'policy').
  const selectedPersona: PersonaId = DEFAULT_PERSONA;
  const [pendingSynthesis, setPendingSynthesis] = useState(false);
  // Post-retrieval fork (2026-06-12): after retrieval completes the user chooses
  // a door before synthesis runs — 'brief' (generate the 5-section brief, the
  // original flow) or 'paper' (open Paper Studio to write a survey paper). null =
  // not yet chosen → the PaperBuildFork is shown. Reset on every new search.
  const [postRetrievalChoice, setPostRetrievalChoice] = useState<'brief' | 'paper' | null>(null);
  // Shown after the 6 clarifier questions (before retrieval): the "what next" fork.
  const [awaitingForkChoice, setAwaitingForkChoice] = useState(false);
  // Model chosen on the Generate Now fork ('deep'=Gemini, 'standard'=Qwen). Reset on every new search.
  const [pendingGenerateMode, setPendingGenerateMode] = useState<'deep' | 'standard' | null>(null);
  // Pre-search intent configuration — set before retrieval fires.
  // (evidenceScope / breadth Q5 DROPPED 2026-06-17 — classifier removed; the
  //  cosine relevance floor decides evidence-table size now.)
  // searchChannels: drives rerankWeights override.
  // sourceMode: 'default' uses current filters; 'custom' shows source picker.
  const [searchChannels, setSearchChannels] = useState<Set<string>>(
    new Set(['causal', 'foundational', 'recent'])
  );
  const [sourceMode, setSourceMode] = useState<'default' | 'custom'>('default');
  // Query-aware clarifying questions (SearchIntentCard, 2026-06-10).
  // Deterministic detectors over the query text; the questions' radios DERIVE
  // their value from searchChannels / filters.populationFocus (no second state).
  const queryIntentSignals = useMemo(() => detectQueryIntent(query), [query]);
  // First-appearance defaults — applied ONCE per detector "episode" (the ref
  // resets when the detector stops firing), so re-renders / continued typing /
  // a manual uncheck are never re-forced:
  //  - geography default "Focus on LAC studies" → ADD 'lac' when the question
  //    first appears for a query mentioning LAC.
  //  - recency default "No — balance with foundational classics" → REMOVE
  //    'recent' when the question first appears (eval 2026-06-10: recency
  //    nudging tested slightly negative; the radio derives from the set, so
  //    the default-No selection must be reflected in the set itself).
  const lacDefaultAppliedRef = React.useRef(false);
  const recencyDefaultAppliedRef = React.useRef(false);
  useEffect(() => {
    if (queryIntentSignals.mentionsLac) {
      if (!lacDefaultAppliedRef.current) {
        lacDefaultAppliedRef.current = true;
        // LAC is a REGION FILTER now (2026-06-12), not the `lac` channel — add it
        // to filters.regions so it gets the uniform region treatment.
        setFilters(prev => (prev.regions ?? []).includes('LAC')
          ? prev
          : { ...prev, regions: [...(prev.regions ?? []), 'LAC'] });
      }
    } else {
      lacDefaultAppliedRef.current = false;
    }
  }, [queryIntentSignals.mentionsLac]);
  useEffect(() => {
    if (queryIntentSignals.mentionsRecency) {
      if (!recencyDefaultAppliedRef.current) {
        recencyDefaultAppliedRef.current = true;
        setSearchChannels(prev => {
          if (!prev.has('recent')) return prev;
          const next = new Set(prev);
          next.delete('recent');
          return next;
        });
      }
    } else {
      recencyDefaultAppliedRef.current = false;
    }
  }, [queryIntentSignals.mentionsRecency]);
  // Safety: if a chosen population focus entry is no longer detected in the
  // query (question hidden / chip gone), drop that entry — a hidden control
  // must never silently shape synthesis. populationFocus is synthesis-emphasis ONLY.
  useEffect(() => {
    const labels = new Set(queryIntentSignals.populations.map(g => g.label));
    setFilters(f => {
      const kept = normalizePopulationFocus(f.populationFocus).filter(v => labels.has(v));
      const current = normalizePopulationFocus(f.populationFocus);
      if (current.length === kept.length) return f;
      return { ...f, populationFocus: kept.length > 0 ? kept : undefined };
    });
  }, [queryIntentSignals]);
  // Tracks which request is "current" — incremented on each retrieval start so stale
  // responses from a previous run don't overwrite the results of a newer one.
  const retrievalGenRef = React.useRef(0);
  // Guards the paper-route effect so it seeds Paper Studio once per run.
  const paperRouteStartedRef = React.useRef<string | null>(null);
  const [regenCount, setRegenCount] = useState<number>(0);
  const REGEN_LIMIT = 2;
  const [responseLanguage, setResponseLanguage] = useState<'en' | 'es' | 'pt'>('en');
  const [languageManuallySet, setLanguageManuallySet] = useState(false);
  const [historySidebarOpen, setHistorySidebarOpen] = useState(true);
  // Chat state (previously owned by ChatPanel; lifted here so the unified top input can send follow-ups)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatIsLoading, setChatIsLoading] = useState(false);
  const [chatStreamingText, setChatStreamingText] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  // Seed text for the follow-up chat bar (its live text is LOCAL to that
  // component now — see FollowUpChatBar — so typing no longer re-renders App).
  const [followUpDraft, setFollowUpDraft] = useState('');
  // which are research-agenda items shown in §5.

  // Derived status text for the status badge.
  // Honest about what's happening: we're corpus-only now, no live "academic
  // databases" being scraped per query.
  const statusText = (() => {
    switch (searchStatus) {
      case 'retrieving': return 'Searching curated corpus…';
      case 'synthesizing': return 'Drafting your brief…';
      case 'error': return errorMessage || 'Search failed';
      default: return snapshot ? 'Ready' : 'Loading…';
    }
  })();
  const isAdmin = session?.access_token
    ? (decodeJwtPayload(session.access_token) as { app_metadata?: { is_admin?: boolean } }).app_metadata?.is_admin === true
    : false;
  // Narrow capability for BYOK key/grant management ONLY (the "Grant access" tab).
  // A byok_admin (e.g. rafaelde) gets Grant access but NOT the full Admin Audit suite.
  const isByokAdmin = isAdmin || (session?.access_token
    ? (decodeJwtPayload(session.access_token) as { app_metadata?: { byok_admin?: boolean } }).app_metadata?.byok_admin === true
    : false);
  // Admin-gated destinations, single source of truth for BOTH the desktop top
  // tab bar and the mobile Account panel (the mobile bottom nav only carries
  // the 3 primary tabs). Without surfacing these on mobile, a byok_admin can't
  // reach Grant access on a phone.
  const adminNavItems: { key: AppTab; label: string }[] = [
    ...(isAdmin ? [{ key: 'admin' as AppTab, label: 'Admin Audit' }] : []),
    ...(isAdmin ? [{ key: 'pilot-monitor' as AppTab, label: 'Pilot Monitor' }] : []),
    ...(isByokAdmin ? [{ key: 'grant-access' as AppTab, label: 'Grant access' }] : []),
  ];

  const isBusy = searchStatus === 'retrieving' || searchStatus === 'synthesizing';
  // Incremented every time a search is started or cancelled. Callbacks
  // capture the gen at call time and bail if it has since changed, so
  // in-flight responses from an abandoned search don't corrupt state.
  const searchGenRef = React.useRef(0);
  const suggestionMatches = useMemo(() => matchCuratedQuestions(query), [query]);
  useEffect(() => {
    if (highlightedSuggestionIdx >= suggestionMatches.length) {
      setHighlightedSuggestionIdx(0);
    }
  }, [suggestionMatches.length, highlightedSuggestionIdx]);
  // Show load more button when the extended ranked pool was stored at search time
  const showLoadMoreSuggestion =
    !isBusy &&
    currentRun !== null &&
    currentRun.hasMoreEvidence === true &&
    currentBrief !== null;

  // Check for existing session on mount and subscribe to auth changes
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: existingSession } }) => {
      setSession(existingSession);
      setSessionLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsPasswordRecovery(true);
        setSession(newSession);
        setSessionLoading(false);
        return;
      }
      setIsPasswordRecovery(false);
      setSession(newSession);
      setSessionLoading(false);
      if (newSession?.user) {
        identify(newSession.user.id, newSession.user.email ?? undefined);
      } else {
        resetAnalytics();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Load snapshot whenever session becomes available
  useEffect(() => {
    if (session) {
      void refreshSnapshot();
    }
  }, [session]);

  const worksById = useMemo<Record<string, Work>>(() => {
    return (snapshot?.works || []).reduce<Record<string, Work>>((acc, work) => {
      acc[work.id] = work;
      return acc;
    }, {});
    // Dep is snapshot.works, NOT the whole snapshot: the 8s JEL-progress polls
    // (App.tsx ~900/1867/2060) replace `snapshot` identity every tick, which
    // otherwise rebuilt this whole map + re-rendered the brief/table every 8s
    // during generation (a big mobile lag source). works rarely changes.
  }, [snapshot?.works]);

  // Keep a ref so the effect below can read worksById without adding it as a
  // dependency (which would cause a re-run on every snapshot update).
  const worksByIdRef = useRef<Record<string, Work>>(worksById);
  useEffect(() => { worksByIdRef.current = worksById; });

  // When a stored brief is loaded (from history sidebar or LibraryPanel), its
  // evidence works may not be in the snapshot (capped at 100 most-recent). Fetch
  // them from GET /api/briefs/:id (which now embeds works) and merge into the
  // snapshot so worksById is complete for this brief.
  useEffect(() => {
    if (!currentBrief || currentBrief.id === 'partial') return;
    const evidenceIds = (currentBrief.sections.evidenceRows ?? []).map((r) => r.workId).filter(Boolean);
    const missingIds = evidenceIds.filter((id) => !worksByIdRef.current[id]);
    if (missingIds.length === 0) return;
    let cancelled = false;
    apiClient.getBrief(currentBrief.id).then((res: any) => {
      if (cancelled || !Array.isArray(res.works) || res.works.length === 0) return;
      setSnapshot((s) => {
        if (!s) return s;
        const known = new Set(s.works.map((w) => w.id));
        const additions = (res.works as Work[]).filter((w) => w?.id && !known.has(w.id));
        return additions.length > 0 ? { ...s, works: [...s.works, ...additions] } : s;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentBrief?.id]);

  // Excluded work IDs that appear in the current brief's evidence — drives the
  // "Regenerate brief" banner. Recomputes when the user 👎s a paper or the
  // snapshot refreshes after exclude/star toggles.
  const excludedInBrief = useMemo<string[]>(() => {
    if (!currentBrief) return [];
    const rows = currentBrief.sections.evidenceRows ?? [];
    return rows
      .map((r) => r.workId)
      .filter((id) => worksById[id]?.excluded === true);
  }, [currentBrief, worksById]);

  // Currently visible work IDs in the table (top-N reveal). Set by BriefView
  // via the onVisibleRowsChange callback. Used to detect when the brief is
  // stale — i.e. user has loaded more papers but brief is still based on the
  // smaller set Gemini saw originally.
  const [currentVisibleState, setCurrentVisibleState] = useState<{ briefId: string | null; ids: string[] }>({
    briefId: null,
    ids: [],
  });
  const currentVisibleIds =
    currentVisibleState.briefId === (currentBrief?.id ?? null) ? currentVisibleState.ids : [];
  // Snapshot of visible IDs taken the FIRST time the table renders for a
  // given brief. Captured via the effect below, not at onDone — onDone fires
  // before BriefView mounts its table, so currentVisibleIds is still empty
  // at that point (or stale from a prior brief). The effect waits for the
  // table to stabilize, then snaps the baseline.
  const [briefBasisIds, setBriefBasisIds] = useState<string[]>([]);
  const [seedingPaper, setSeedingPaper] = useState(false);
  const lastSnapshottedBriefIdRef = useRef<string | null>(null);
  // Abort controller for the active streamBrief SSE connection. Aborted when a
  // new synthesis starts so stale connections don't hold Gemini slots.
  const streamBriefAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!currentBrief || currentBrief.id === 'partial') return;
    if (lastSnapshottedBriefIdRef.current === currentBrief.id) return;
    if (currentVisibleIds.length === 0) return;
    setBriefBasisIds(currentVisibleIds);
    lastSnapshottedBriefIdRef.current = currentBrief.id;
  }, [currentBrief, currentVisibleIds]);
  // "Stale" = the user has loaded papers into the table that are NOT in the
  // brief's evidence set (i.e., extras pulled from the broader admissible
  // pool past the 50-paper cap). When that happens, BriefView's own
  // "Regenerate brief with N papers" button handles it; this app-level
  // staleness flag is kept to drive the exclusion banner only.
  const briefIsStale = useMemo(() => {
    if (!currentBrief || currentVisibleIds.length === 0) return false;
    const briefIds = new Set((currentBrief.sections.evidenceRows ?? []).map((r) => r.workId));
    return currentVisibleIds.some((id) => !briefIds.has(id));
  }, [currentBrief, currentVisibleIds]);

  async function refreshSnapshot(): Promise<AppStateSnapshot | null> {
    try {
      const next = await apiClient.getSnapshot();
      setSnapshot(next);
      return next;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load workspace');
      return null;
    }
  }

  // Hydrate chat thread when the viewed brief changes
  useEffect(() => {
    if (!currentBrief?.id || currentBrief.id === 'partial') {
      setChatMessages([]);
      setChatStreamingText('');
      setChatError(null);
      return;
    }
    let cancelled = false;
    apiClient.getChatMessages(currentBrief.id).then((msgs) => {
      if (cancelled) return;
      setChatMessages(msgs);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentBrief?.id]);

  // Auto-detect response language from query unless user has manually toggled.
  useEffect(() => {
    if (!languageManuallySet) {
      setResponseLanguage(detectQueryLanguage(query));
    }
  }, [query, languageManuallySet]);

  // Auto-fetch signals when a brief is loaded and at least one profile is on.
  // Stays at the top with the other hooks — must run on every render.
  useEffect(() => {
    if (!currentBrief?.query) return;
    const profiles: ('policy' | 'buzz')[] = [];
    if (signalProfiles.policy) profiles.push('policy');
    if (signalProfiles.buzz) profiles.push('buzz');
    if (profiles.length === 0) return;
    void fetchSignalsForCurrentQuery(currentBrief.query, profiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBrief?.query, signalProfiles.policy, signalProfiles.buzz]);

  // Collapse history sidebar when a brief loads to give the table more space;
  // re-expand when returning to the empty search state.
  useEffect(() => {
    if (currentBrief) {
      setHistorySidebarOpen(false);
    } else {
      setHistorySidebarOpen(true);
    }
  }, [!!currentBrief]);

  // Restore activeJelJobId from snapshot when user navigates to a brief.
  // Runs on every brief change so stale job state from a different brief is
  // always cleared — prevents cross-contamination between briefs.
  useEffect(() => {
    if (!currentBrief?.searchRunId || !snapshot) return;
    const existingJob = (snapshot.jelPapers ?? [])
      // Exclude 'planning' (a Paper Studio draft that was opened but not generated)
      // and 'error' — neither is an active/finished generation for this brief.
      .filter(p => p.searchRunId === currentBrief.searchRunId && p.status !== 'error' && p.status !== 'planning')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (existingJob) {
      setActiveJelJobId(existingJob.id);
      setJelPaperProgress({
        done: (existingJob.sections ?? []).filter((s: any) => !isNaN(Number(s.number))).length,
        // +1 counts the Devil's Advocate critique section appended after the outline sections.
        total: ((n: number) => (n > 0 ? n + 1 : 0))((existingJob.outline as any)?.sections?.length ?? 0),
        status: existingJob.status,
        errorMessage: existingJob.errorMessage,
      });
      // No fingerprint set: null means "lock unconditionally" (paper already generated)
    } else {
      // This brief has no paper — clear any job state left over from a previous brief
      setActiveJelJobId(null);
      setJelPaperProgress(null);
    }
  }, [currentBrief?.searchRunId, snapshot]);

  // Poll active JEL paper job every 8s while running
  useEffect(() => {
    if (!activeJelJobId) return;
    if (jelPaperProgress?.status === 'done' || jelPaperProgress?.status === 'error') return;
    let isFetching = false;
    const interval = setInterval(async () => {
      if (isFetching) return;
      isFetching = true;
      try {
        const paper = await apiClient.getJelPaper(activeJelJobId);
        setJelPaperProgress({
          done: (paper.sections ?? []).filter((s: any) => !isNaN(Number(s.number))).length,
          // +1 counts the Devil's Advocate critique section appended after the outline sections.
          total: ((n: number) => (n > 0 ? n + 1 : 0))(paper.outline?.sections?.length ?? 0),
          status: paper.status,
          errorMessage: paper.errorMessage,
        });
        setSnapshot((s) => s ? {
          ...s,
          jelPapers: (s.jelPapers ?? []).map((p) => p.id === activeJelJobId ? paper : p),
        } : s);
      } catch {
        // ignore transient poll errors
      } finally {
        isFetching = false;
      }
    }, 8000);
    return () => clearInterval(interval);
  }, [activeJelJobId, jelPaperProgress?.status]);

  async function handleSendFollowUp(text: string) {
    if (!text.trim() || chatIsLoading || !currentBrief || currentBrief.id === 'partial') return;

    const userMsg: ChatMessage = {
      id: `pending-${Date.now()}`,
      briefId: currentBrief.id,
      role: 'user',
      content: text.trim(),
      citations: [],
      createdAt: new Date().toISOString(),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setChatIsLoading(true);
    setChatStreamingText('');
    setChatError(null);

    const history = chatMessages.map((m) => ({ role: m.role, content: m.content }));
    let finalCitations: string[] = [];
    let finalText = '';

    try {
      await apiClient.streamChatMessage(currentBrief.id, text.trim(), history, {
        onChunk: (chunk) => {
          finalText += chunk;
          setChatStreamingText((prev) => prev + chunk);
        },
        // Verifier (Qwen) cross-checks Gemini's draft against the evidence
        // table. When it returns a corrected version, swap the streamed text
        // silently — the user reads the table-grounded answer, not the draft.
        onCorrection: (corrected) => {
          finalText = corrected;
          setChatStreamingText(corrected);
        },
        onCitations: (workIds) => { finalCitations = workIds; },
        onDone: (messageId) => {
          const modelMsg: ChatMessage = {
            id: messageId || `model-${Date.now()}`,
            briefId: currentBrief.id,
            role: 'model',
            content: finalText,
            citations: finalCitations,
            createdAt: new Date().toISOString(),
          };
          setChatMessages((prev) => [...prev, modelMsg]);
          setChatStreamingText('');
          setChatIsLoading(false);
        },
        onError: (err) => {
          track('chat.error', { severity: 'critical', error_message: err, phase: 'stream' });
          setChatError(err);
          setChatStreamingText('');
          setChatIsLoading(false);
        },
      });
    } catch {
      track('chat.error', { severity: 'critical', error_message: 'Failed to send message', phase: 'send' });
      setChatError('Failed to send message');
      setChatStreamingText('');
      setChatIsLoading(false);
    }
  }

  async function handleDeleteChatMessage(messageId: string) {
    if (!currentBrief) return;
    try {
      await apiClient.deleteChatMessage(currentBrief.id, messageId);
      setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch {
      track('chat.delete_error', { severity: 'warning' });
      setChatError('Failed to delete message');
    }
  }

  /**
   * Regenerate the current brief with excluded papers filtered out.
   * Capped at REGEN_LIMIT (2) per brief — avoids runaway Gemini cost from
   * users repeatedly toggling exclusions and re-running synthesis.
   */
  async function handleRegenerateBrief() {
    if (!currentRun || regenCount >= REGEN_LIMIT) return;
    if (isBusy || chatIsLoading) return;
    setRegenCount((n) => n + 1);
    setSearchStatus('synthesizing');
    setStreamingText('');
    setErrorMessage(null);
    streamBriefAbortRef.current?.abort();
    streamBriefAbortRef.current = new AbortController();
    try {
      await apiClient.streamBrief(
        currentRun.id,
        {
          onPhase1: (phase1Brief) => setCurrentBrief(phase1Brief),
          onChunk: (text) => setStreamingText((prev) => prev + text),
          onDone: (finalBrief) => {
            setCurrentBrief(finalBrief);
            setStreamingText('');
            setSearchStatus('idle');
            // briefBasisIds is captured by the effect once the table actually
            // renders for this brief (avoids the race where onDone fires
            // before BriefView's onVisibleRowsChange).
          },
          onVerified: ({ sections, methodologyNote, gapSummary }) => {
            setCurrentBrief((prev) => {
              if (!prev) return prev;
              if (sections) return { ...prev, sections };
              return {
                ...prev,
                sections: {
                  ...prev.sections,
                  methodologyNote: methodologyNote ?? prev.sections.methodologyNote,
                  coverageCard: {
                    ...prev.sections.coverageCard,
                    gapSummary: gapSummary ?? prev.sections.coverageCard.gapSummary,
                  },
                },
              };
            });
          },
          onError: (err) => {
            track('brief.regenerate_error', { severity: 'warning', error_message: err, search_run_id: currentRun?.id });
            setErrorMessage(err);
            setStreamingText('');
            setSearchStatus('idle');
          },
        },
        selectedPersona,
        undefined,
        // Send both: exclusions stripped from evidence; visible set is the
        // exact list of papers user can currently see in the table. Backend
        // intersects so brief + boxes match the visible table.
        { excludedWorkIds: excludedInBrief, visibleWorkIds: currentVisibleIds, signal: streamBriefAbortRef.current?.signal },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Regenerate failed';
      track('brief.regenerate_error', { severity: 'warning', error_message: msg, search_run_id: currentRun?.id });
      setErrorMessage(msg);
      setStreamingText('');
      setSearchStatus('idle');
    }
  }

  /**
   * Retry the original search query — pulls the previous query back into the
   * input, clears the brief and follow-up chat. User can edit and re-submit.
   */
  function handleRetryQuery() {
    if (isBusy || chatIsLoading) return;
    const previous = currentBrief?.query || query;
    setQuery(previous);
    setCurrentBrief(null);
    setCurrentRun(null);
    setStreamingText('');
    setSearchStatus('idle');
    setPendingSynthesis(false);
    setActiveJelJobId(null);
    setJelJobFingerprint(null);
    setJelPaperProgress(null);
    setErrorMessage(null);
    setChatMessages([]);
    setChatStreamingText('');
    setChatError(null);
    setFollowUpDraft('');
    setSignalsResult({ policy: [], buzz: [] });
    setSignalsFetchedFor(null);
  }

  // SINGLE SOURCE OF TRUTH for "a fresh search starts from clean config."
  // Every piece of search-INTENT state (anything that changes what gets
  // retrieved or how the brief is synthesized) MUST reset here, so adding new
  // search state forces a reset decision instead of silently leaking into the
  // next query. Incident 2026-06-12: `filters.regions` (a hard
  // ['Sub-Saharan Africa'] filter) leaked from a prior search and gutted an
  // unrelated LAC info-on-returns query (Jensen 2010 dropped, all-Africa table)
  // because the old hand-maintained reset list omitted it. CONVENTION: any new
  // search-config useState belongs here (or is a deliberate cross-search
  // preserve). A check-invariants guard asserting this is a planned follow-up.
  // The clarifier re-derives LAC/population/recency from the new query text, so
  // resetting here is safe.
  function resetSearchConfig() {
    setFilters(defaultFilters);
    setSearchChannels(new Set(['causal', 'foundational', 'recent']));
    setSourceMode('default');
    setTimeRange('all');
    setResponseLanguage('en');
    setLanguageManuallySet(false);
    setSignalProfiles({ policy: false, buzz: false });
    // "apply default once per query" guards — clear so the next query re-derives.
    lacDefaultAppliedRef.current = false;
    recencyDefaultAppliedRef.current = false;
  }

  // Blank-slate new search — clears the query input so the user starts fresh.
  // Distinct from handleRetryQuery which re-populates the input with the
  // previous query for editing. All "New search" buttons use this.
  function handleNewSearch() {
    if (isBusy || chatIsLoading) return;
    setClarifyingPhase(false);
    setQuery('');
    resetSearchConfig();
    setCurrentBrief(null);
    setCurrentRun(null);
    setStreamingText('');
    setSearchStatus('idle');
    setPendingSynthesis(false);
    setPostRetrievalChoice(null);
    setAwaitingForkChoice(false);
    setPendingGenerateMode(null);
    paperRouteStartedRef.current = null;
    setActiveJelJobId(null);
    setJelJobFingerprint(null);
    setJelPaperProgress(null);
    setErrorMessage(null);
    setChatMessages([]);
    setChatStreamingText('');
    setChatError(null);
    setFollowUpDraft('');
    setSignalsResult({ policy: [], buzz: [] });
    setSignalsFetchedFor(null);
  }

  /**
   * Back-to-Step-1 from Step 2 (Box 2). Preserves user state — query,
   * filters, scope, pending audience — so the user can tweak Step 1
   * without re-entering everything. Distinct from handleRetryQuery,
   * which is a full restart.
   *
   * Cancels any in-flight retrieval since Step 1 is interactive again
   * and the user may change parameters before resubmitting.
   */
  function handleBackToStep1() {
    if (chatIsLoading) return;
    // Telemetry: if the user backs out while a search/synthesis is in flight,
    // that's an abandonment — capture it (target = the in-flight run if any).
    if (searchStatus === 'retrieving' || (!currentBrief && searchStatus !== 'idle')) {
      logEvent({ eventType: 'search.abandoned', targetType: 'search_run', targetId: currentRun?.id, status: 'completed', payload: { phase: searchStatus } });
    }
    // Invalidate any in-flight retrieval/synthesis so stale callbacks don't
    // update state after the user has returned to Step 1.
    searchGenRef.current++;
    retrievalGenRef.current++; // causes executeRetrieval gen check to discard response
    setClarifyingPhase(false);
    setPendingSynthesis(false);
    setPostRetrievalChoice(null);
    setAwaitingForkChoice(false);
    setPendingGenerateMode(null);
    paperRouteStartedRef.current = null;
    setCurrentBrief(null);
    setCurrentRun(null);
    setStreamingText('');
    setSearchStatus('idle');
    setErrorMessage(null);
    // Keep: query, filters, searchPurpose, searchChannels so the
    // user can edit or resubmit unchanged.
  }

  /**
   * Retry a follow-up chat exchange — drops the user message and the next
   * assistant response from the thread (best-effort persistence) and stuffs
   * the question text back into the unified input for editing.
   */
  async function handleRetryChatMessage(messageId: string) {
    if (!currentBrief) return;
    const idx = chatMessages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const userMsg = chatMessages[idx];
    if (userMsg.role !== 'user') return;
    const nextMsg = chatMessages[idx + 1];
    const assistantMsg = nextMsg && nextMsg.role === 'model' ? nextMsg : null;

    // Stuff the question back into the input for editing.
    setQuery(userMsg.content);

    // Drop locally first so the thread updates immediately.
    setChatMessages((prev) =>
      prev.filter((m) => m.id !== userMsg.id && (!assistantMsg || m.id !== assistantMsg.id))
    );

    // Persist deletions — best-effort, ignore errors so the UI stays responsive.
    try {
      await apiClient.deleteChatMessage(currentBrief.id, userMsg.id);
      if (assistantMsg) {
        await apiClient.deleteChatMessage(currentBrief.id, assistantMsg.id);
      }
    } catch {
      // Swallow — local thread is already updated; persistence will reconcile on refresh.
    }
  }

  /**
   * Unified submit — if a brief is already loaded, send as a follow-up chat.
   * Otherwise run a new search.
   */
  async function handleUnifiedSubmit() {
    const text = query.trim();
    if (!text || isBusy || chatIsLoading) return;
    if (currentBrief && currentBrief.id !== 'partial') {
      await handleSendFollowUp(text);
      setQuery(''); // clear after follow-up; user will type next question
    } else if (!clarifyingPhase) {
      // Enter clarifying phase — questions asked before search fires. Reset the
      // post-question fork state for this fresh search.
      setPostRetrievalChoice(null);
      setAwaitingForkChoice(false);
      setPendingGenerateMode(null);
      paperRouteStartedRef.current = null;
      setClarifyingPhase(true);
    } else {
      // Already clarifying — no-op (Search button inside clarifier fires runSearch)
      void 0;
      // don't clear on search — user might want to edit + retry
    }
  }

  async function handleDeleteRun(run: SearchRun) {
    const confirmed = window.confirm(
      `Delete "${run.query}"?\n\nThis permanently removes the search run and all saved briefs, chat messages, and feedback tied to it.`
    );
    if (!confirmed) return;
    try {
      await apiClient.deleteSearchRun(run.id);
      if (currentRun?.id === run.id) {
        setCurrentRun(null);
        setCurrentBrief(null);
      }
      await refreshSnapshot();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  /** Shared retrieval core — fires a search run and wires the result into state.
   *  Used by both the initial runSearch() and re-retrievals triggered by scope changes.
   *  Returns false if the response was stale (a newer retrieval already completed). */
  async function executeRetrieval(
    q: string,
    effectiveFilters: SearchFilters,
    gen: number,
    rerankWeights?: Record<string, number> | null,
    channels?: string[] | null,
  ): Promise<boolean> {
    const retrievalStart = Date.now();
    // Phase 3 visibility — scrubbed search_submitted event (NO query text).
    track('search_submitted', {
      severity: 'info',
      channels: channels ?? undefined,
      queryLength: q.length,
      hasSourceFilter:
        (effectiveFilters?.workingPaperSources?.length ?? 0) > 0 ||
        (effectiveFilters?.institutionalSources?.length ?? 0) > 0,
    });
    try {
      const searchRun = await apiClient.createSearchRun(q, effectiveFilters, rerankWeights, channels);

      // Discard if a newer retrieval already finished.
      if (gen !== retrievalGenRef.current) return false;

      // Phase 1: Build partial brief (table appears immediately).
      // The /api/snapshot endpoint caps at the 100 most-recent works, so a
      // freshly retrieved paper from older corpus ingestion can be missing
      // from worksById. The /api/search-runs endpoint now embeds the retrieved
      // works in the response — merge them into worksById so the table can
      // resolve venue + type correctly.
      const newSnapshot = await refreshSnapshot();
      const baseWorks = (newSnapshot?.works ?? []).reduce<Record<string, Work>>((acc, w) => {
        acc[w.id] = w;
        return acc;
      }, {});
      const embeddedWorks: Work[] = (searchRun as unknown as { works?: Work[] }).works ?? [];
      for (const w of embeddedWorks) {
        if (w?.id) baseWorks[w.id] = { ...baseWorks[w.id], ...w };
      }
      if (newSnapshot && embeddedWorks.length > 0) {
        const existingIds = new Set((newSnapshot.works ?? []).map((w) => w.id));
        const additions = embeddedWorks.filter((w) => !existingIds.has(w.id));
        if (additions.length > 0) {
          setSnapshot({ ...newSnapshot, works: [...(newSnapshot.works ?? []), ...additions] });
        }
      }
      setCurrentBrief(buildPartialBrief(searchRun, baseWorks));
      // Setting currentRun last triggers the synthesis-launch effect if the
      // user already confirmed an audience while retrieval was running.
      track('search.completed', {
        severity: 'info',
        search_run_id: searchRun.id,
        duration_ms: Date.now() - retrievalStart,
        candidate_count: searchRun.candidateWorkIds?.length ?? 0,
        evidence_count: searchRun.evidenceWorkIds?.length ?? 0,
      });
      setSearchStatus('idle');
      setCurrentRun(searchRun);
      return true;
    } catch (error) {
      if (gen !== retrievalGenRef.current) return false;
      const errorMessage = error instanceof Error ? error.message : 'Search failed';
      track('search.error', {
        severity: 'critical',
        error_message: errorMessage,
        duration_ms: Date.now() - retrievalStart,
      });
      setSearchStatus('error');
      setErrorMessage(errorMessage);
      setPendingSynthesis(false);
      return false;
    }
  }

  /** Compute rerankWeights override from channel selection.
   *
   *  Single channel → return BO-optimised weights for that channel.
   *  Multi-channel  → return null. The server detects multiple channels in
   *                   channelsOverride and calls rerankHybrid() instead,
   *                   using CHANNEL_RERANK_WEIGHTS defined in rerank.ts.
   *                   Averaged weights are no longer used — they compress the
   *                   distinct character of each channel into a compromise.
   *
   *  Returns null when no override is needed (default weights apply). */
  function channelsToRerankWeights(channels: Set<string>): Record<string, number> | null {
    const causal       = channels.has('causal');
    const foundational = channels.has('foundational');
    const recent       = channels.has('recent');
    const lac          = channels.has('lac');

    if (!causal && !foundational && !recent && !lac) return null;

    // BO-optimised single-channel weights (2026-05-29, base embed)
    const W = {
      causal:        { similarity:0.282, citation:0.046, rigor:0.400, recency:0.021, region:0.146, fts:0.105 }, // variant C: rigor↑ from citation, 2026-06-02 (cosine-relevance eval; sync w/ rerank.ts)
      foundational:  { similarity:0.213, citation:0.633, rigor:0.080, recency:0.000, region:0.023, fts:0.071 },
      recent:        { similarity:0.496, citation:0.217, rigor:0.031, recency:0.203, region:0.030, fts:0.023 },
      lac:           { similarity:0.223, citation:0.079, rigor:0.024, recency:0.023, region:0.600, fts:0.051 },
    } as const;

    const nonLacActive = [causal && 'causal', foundational && 'foundational', recent && 'recent']
      .filter((c): c is 'causal' | 'foundational' | 'recent' => !!c);

    // Single channel (or lac-only): send specific weights as override
    if (nonLacActive.length === 1) return { ...W[nonLacActive[0]] };
    if (nonLacActive.length === 0 && lac) return { ...W.lac };

    // Multi-channel: return null — server uses rerankHybrid() with per-channel weights
    return null;
  }

  /** Persona defaults to policy — can be swapped post-generation in brief header. */
  function defaultPersona(): PersonaId { return 'policy'; }

  // (scopeToEvidenceMatch / breadth Q5 removed 2026-06-17 — classifier gone.
  //  New runs leave evidenceMatch unset; the cosine relevance floor decides size.)

  async function runSearch() {
    track('search.submitted', {
      severity: 'info',
      query_length: query.trim().length,
      time_period: filters.timePeriod,
      sms_levels: filters.smsLevels ?? [],
    });
    setSearchStatus('retrieving');
    setErrorMessage(null);
    setCurrentBrief(null);
    setCurrentRun(null);
    setStreamingText('');
    setRegenCount(0);
    setActiveJelJobId(null);
    setJelJobFingerprint(null);
    setJelPaperProgress(null);
    setLanguageManuallySet(false);
    setSignalsResult({ policy: [], buzz: [] });
    setSignalsFetchedFor(null);
    setLastRunNextToken(undefined);
    const effectiveFilters: SearchFilters = {
      ...buildFiltersForTimeRange(filters, timeRange),
    };
    const gen = ++retrievalGenRef.current;
    const weights = channelsToRerankWeights(searchChannels);
    // NOTE: postRetrievalChoice is set by the fork (forkToBrief/forkToPaper) BEFORE
    // runSearch — do not reset it here or the chosen door would be wiped.
    setPendingSynthesis(true); // still used as "retrieval running, synthesis queued" flag
    await executeRetrieval(query, effectiveFilters, gen, weights, [...searchChannels]);
  }

  // (retrieveWithScope removed 2026-06-17 — the in-brief direct/balanced/broader
  // scope re-run drove evidenceMatch, which the server no longer honors.)

  // Auto-fire synthesis as soon as retrieval completes. Persona defaults to policy.
  // Dual trigger: pendingSynthesis (primary) OR currentBrief.id==='partial' (fallback
  // — fires even if pendingSynthesis was reset before the effect ran).
  useEffect(() => {
    // Synthesis only fires once the user picks the "Create Brief" door in the
    // post-retrieval fork (postRetrievalChoice === 'brief'). Until then the fork
    // is shown; 'paper' routes to Paper Studio instead.
    const shouldSynthesize = currentRun && searchStatus === 'idle' &&
      postRetrievalChoice === 'brief' &&
      (pendingSynthesis || currentBrief?.id === 'partial');
    if (shouldSynthesize) {
      setPendingSynthesis(false);
      void startSynthesis(defaultPersona());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRun, pendingSynthesis, searchStatus, currentBrief?.id, postRetrievalChoice]);

  // Paper route: once retrieval completes with the 'paper' door chosen, seed a
  // plan from the run and open Paper Studio. Ref-guarded so it fires once per run.
  useEffect(() => {
    if (currentRun && searchStatus === 'idle' && postRetrievalChoice === 'paper'
        && currentBrief?.id === 'partial'
        && paperRouteStartedRef.current !== currentRun.id) {
      paperRouteStartedRef.current = currentRun.id;
      void openPaperStudioFromRun(currentRun);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRun, searchStatus, postRetrievalChoice, currentBrief?.id]);

  async function startSynthesis(persona: PersonaId) {
    if (!currentRun) return;
    const runId = currentRun.id;
    const synthStart = Date.now();
    track('brief.generate_started', {
      severity: 'info',
      search_run_id: runId,
      persona,
      language: responseLanguage,
    });
    setPendingSynthesis(false);
    setSearchStatus('synthesizing');
    setStreamingText('');

    // Table-first reveal: construct a partial brief from currentRun + worksById
    // RIGHT NOW (client-side, instant) so BriefView can mount and render the
    // evidence table immediately. SSE Phase 1 replaces this with the real
    // deterministic brief a few seconds later; Gemini fills in the rest.
    const partialEvidenceRows: EvidenceRow[] = (currentRun.evidenceWorkIds || [])
      .map((id) => worksById[id])
      .filter((w): w is Work => !!w)
      .map((w) => ({
        workId: w.id,
        title: w.title,
        authors: w.authors || [],
        sourceName: w.venue || w.institution || w.source || 'Unknown',
        year: w.year ?? null,
        methodologyBadge: w.methodologyDesign || 'Unclassified',
        causalStrength: w.causalStrength || 'signal',
        smsLevel: w.smsLevel ?? null,
        geography: w.geography || [],
        doi: w.canonicalDoi,
        url: w.url || w.openAccessPdfUrl || '',
        finding: w.summary || w.abstract || '',
        // True channel-of-origin from the persisted map (additive). Undefined
        // for legacy runs → BriefView falls back to the deterministic recompute.
        retrievalChannels: currentRun.workChannels?.[w.id],
        segment: currentRun.workSegments?.[w.id] as ('core' | 'context' | 'off' | undefined),
      }));
    const partialBrief: EvidenceBrief = {
      id: 'partial',
      tenantId: currentRun.tenantId,
      searchRunId: currentRun.id,
      status: 'draft',
      query: currentRun.query,
      sections: {
        summaryBullets: [],
        evidenceRows: partialEvidenceRows,
        methodologyNote: '',
        coverageCard: {
          universeCount: currentRun.coverage?.universeCount ?? 0,
          retrievedCount: currentRun.coverage?.retrievedCount ?? 0,
          admissibleCount: currentRun.coverage?.admissibleCount ?? 0,
          evidenceCount: currentRun.coverage?.evidenceCount ?? 0,
          signalCount: currentRun.coverage?.signalCount ?? 0,
          gapSummary: '',
          regionalGap: '',
          methodologicalGap: '',
        },
        followUpQuestions: [],
        citations: [],
        warnings: [],
      },
      auditTrace: {
        model: 'partial',
        promptVersions: {},
        retrievalPolicy: 'hybrid-curated-rag-v1',
        queryPlan: [],
        generatedAt: new Date().toISOString(),
        notes: ['Partial brief — synthesis in progress.'],
      },
      createdAt: new Date().toISOString(),
      sharePath: `/briefs/${currentRun.id}`,
    };
    setCurrentBrief(partialBrief);

    const synthGen = ++searchGenRef.current;
    streamBriefAbortRef.current?.abort();
    streamBriefAbortRef.current = new AbortController();
    try {
      await apiClient.streamBrief(currentRun.id, {
        onPhase1: (phase1Brief) => {
          if (searchGenRef.current !== synthGen) return;
          setCurrentBrief(phase1Brief);
        },
        onChunk: (text) => {
          if (searchGenRef.current !== synthGen) return;
          setStreamingText((prev) => prev + text);
        },
        onDone: (finalBrief) => {
          if (searchGenRef.current !== synthGen) return;
          track('brief.generate_completed', {
            severity: 'info',
            search_run_id: runId,
            duration_ms: Date.now() - synthStart,
            persona,
          });
          // Phase 3 visibility — scrubbed brief_generated event (no query text).
          // fallback=true when the deterministic model shipped instead of Gemini.
          track('brief_generated', {
            severity: 'info',
            persona,
            latencyMs: Date.now() - synthStart,
            evidenceCount: finalBrief?.sections?.evidenceRows?.length ?? 0,
            fallback: (finalBrief?.auditTrace?.model ?? '') === 'deterministic',
          });
          setCurrentBrief(finalBrief);
          setQuery('');
          setStreamingText('');
          setSearchStatus('idle');
          // briefBasisIds is captured by the effect once the table renders
          // (see the useEffect tracking lastSnapshottedBriefIdRef).
        },
        // Post-done verifier corrected brief prose — silently patch the
        // current brief without blocking the first render.
        onVerified: ({ sections, methodologyNote, gapSummary }) => {
          if (searchGenRef.current !== synthGen) return;
          setCurrentBrief((prev) => {
            if (!prev) return prev;
            if (sections) return { ...prev, sections };
            return {
              ...prev,
              sections: {
                ...prev.sections,
                methodologyNote: methodologyNote ?? prev.sections.methodologyNote,
                coverageCard: {
                  ...prev.sections.coverageCard,
                  gapSummary: gapSummary ?? prev.sections.coverageCard.gapSummary,
                },
              },
            };
          });
        },
        onError: (error) => {
          // Gen guard (same as the other callbacks): a late error event from an
          // abandoned stream must not clobber the state of a NEW in-flight search.
          if (searchGenRef.current !== synthGen) return;
          track('brief.generate_error', {
            severity: 'critical',
            search_run_id: runId,
            error_message: error,
            duration_ms: Date.now() - synthStart,
            phase: 'stream',
          });
          setErrorMessage(error);
          setStreamingText('');
          setSearchStatus('idle');
        },
      }, persona, responseLanguage, { signal: streamBriefAbortRef.current?.signal });
    } catch (synthErr) {
      if ((synthErr as any)?.name === 'AbortError') return; // intentional cancel — no fallback
      try {
        const brief = await apiClient.createBrief(currentRun.id, persona, responseLanguage);
        track('brief.generate_completed', {
          severity: 'info',
          search_run_id: runId,
          duration_ms: Date.now() - synthStart,
          persona,
          via_fallback: true,
        });
        setCurrentBrief(brief);
        setQuery('');
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : 'Synthesis failed';
        track('brief.generate_error', {
          severity: 'critical',
          search_run_id: runId,
          error_message: msg,
          duration_ms: Date.now() - synthStart,
          phase: 'fallback',
        });
        setErrorMessage(msg);
      }
      setStreamingText('');
      setSearchStatus('idle');
    }
  }

  // Reset deep-scan state whenever the active search run changes (new search,
  // past brief loaded, back to step 1). Keyed on the run id, not the brief id,
  // so a regenerate over the SAME run doesn't wipe the notice mid-flow.
  const deepScanRunId = currentRun?.id ?? currentBrief?.searchRunId ?? null;
  useEffect(() => {
    setDeepScanStatus('idle');
    setDeepScanResult(null);
    setDeepScanNotice(null);
  }, [deepScanRunId]);

  async function handleDeepScan() {
    const runId = currentBrief?.searchRunId;
    if (!runId || deepScanStatus === 'scanning') return;
    setDeepScanStatus('scanning');
    setDeepScanNotice(null);
    setDeepScanResult(null);
    const startedAt = Date.now();
    try {
      const res = await apiClient.deepScanSearchRun(runId);
      track('search.deep_scan_completed', {
        severity: 'info',
        search_run_id: runId,
        duration_ms: Date.now() - startedAt,
        new_work_count: res.newWorks.length,
      });
      if (res.newWorks.length > 0) {
        // Merge the new papers into the snapshot's works so worksById can
        // resolve them (paper modal, exports, shell rows). Client-side cache
        // only — nothing is written back to the corpus.
        setSnapshot((s) => {
          if (!s) return s;
          const known = new Set(s.works.map((w) => w.id));
          const additions = res.newWorks
            .filter((w) => !known.has(w.id))
            .map((w) => ({
              id: w.id,
              title: w.title,
              authors: w.authors ?? [],
              year: w.year ?? 0,
              venue: w.venue,
              abstract: w.abstract ?? '',
              citationCount: w.citationCount ?? 0,
              smsLevel: w.smsLevel,
              geography: [],
              topics: [],
              url: '',
            } as unknown as Work));
          return additions.length > 0 ? { ...s, works: [...additions, ...s.works] } : s;
        });
        // Mirror the server-side work_channels update locally so channel pills
        // show "Deep scan" provenance without a run re-fetch.
        setCurrentRun((run) => {
          if (!run) return run;
          const merged: Record<string, string[]> = { ...(run.workChannels ?? {}) };
          for (const w of res.newWorks) {
            const existing = merged[w.id] ?? [];
            merged[w.id] = existing.includes('deepscan') ? existing : [...existing, 'deepscan'];
          }
          return { ...run, workChannels: merged };
        });
        setDeepScanResult(res);
      } else {
        setDeepScanResult(res);
        setDeepScanNotice('Deep scan found no additional literatures.');
      }
      setDeepScanStatus('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Deep scan failed';
      if (/already run/i.test(msg)) {
        setDeepScanNotice('Deep scan already run for this search.');
      } else {
        track('search.deep_scan_error', { severity: 'warning', error_message: msg, search_run_id: runId });
        setDeepScanNotice('Deep scan unavailable right now — your brief is unchanged.');
      }
      setDeepScanStatus('done');
    }
  }

  async function handleResolvePaper(
    input: { doiOrUrl?: string; pastedText?: string },
  ): Promise<PaperPlanUpload> {
    return apiClient.resolvePaper(input);
  }

  // "Add to evidence & regenerate" — reuses the EXISTING evidenceWorkIdsOverride
  // regenerate path (handleRegenerateWithExtras → POST /api/briefs). No new
  // synthesis path. The server already persisted 'deepscan' into the run's
  // work_channels, so the regenerated brief's rows carry the provenance pill.
  async function handleAddDeepScanWorks() {
    if (!currentBrief || !deepScanResult || deepScanResult.newWorks.length === 0 || isRegenerating) return;
    const current = (currentBrief.sections.evidenceRows ?? []).map((r) => r.workId);
    const currentSet = new Set(current);
    const all = [...current, ...deepScanResult.newWorks.map((w) => w.id).filter((id) => !currentSet.has(id))];
    await handleRegenerateWithExtras(all);
    // Panel served its purpose; the notice records that the scan was used.
    setDeepScanResult(null);
    setDeepScanNotice('Deep scan papers added to the evidence set.');
  }

  async function handleRegenerateWithExtras(
    evidenceWorkIds: string[],
    extraPapers?: PaperPlanUpload[],
  ) {
    if (!currentBrief?.searchRunId || isRegenerating) return;
    setIsRegenerating(true);
    try {
      // POLICY-ONLY: regeneration is always a policy brief. The server coerces
      // any persona to 'policy'; we pass 'policy' explicitly for clarity.
      const persona: PersonaId = 'policy';
      const fresh = await apiClient.createBrief(
        currentBrief.searchRunId,
        persona,
        responseLanguage,
        evidenceWorkIds,
        extraPapers,
      );
      setCurrentBrief(fresh);
      await refreshSnapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Regenerate failed';
      track('brief.regenerate_error', { severity: 'warning', error_message: msg, search_run_id: currentBrief.searchRunId });
      setErrorMessage(msg);
    } finally {
      setIsRegenerating(false);
    }
  }

  async function handleGenerateJelPaper() {
    if (!currentBrief?.searchRunId) return;
    // Fingerprint the current evidence set — button locks until this changes
    const fingerprint = (currentBrief.sections.evidenceRows ?? [])
      .map((r) => r.workId).sort().join(',');
    try {
      const job = await apiClient.createJelPaper(currentBrief.searchRunId, currentBrief.id);
      track('paper.generate_started', { severity: 'info', search_run_id: currentBrief.searchRunId, job_id: job.id });
      setSnapshot((s) => s ? { ...s, jelPapers: [job, ...(s.jelPapers ?? [])] } : s);
      setActiveJelJobId(job.id);
      setJelJobFingerprint(fingerprint);
      // Seed progress so spinner shows immediately without waiting for first poll
      setJelPaperProgress({ done: 0, total: 0, status: 'queued' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start paper generation';
      track('paper.generate_error', { severity: 'critical', error_message: msg, search_run_id: currentBrief.searchRunId });
      setErrorMessage(msg);
    }
  }

  // Paper Studio: open the prep cockpit by seeding a plan from the current brief.
  async function handleWriteSurvey(orderedWorkIds: string[]) {
    if (!currentBrief?.searchRunId) return;
    setSeedingPaper(true);
    try {
      const plan = await apiClient.createPaperPlan(currentBrief.searchRunId, currentBrief.id, orderedWorkIds);
      track('paper.studio_opened', { severity: 'info', search_run_id: currentBrief.searchRunId, plan_id: plan.id });
      setActivePlan(plan);
      setTab('paper-studio');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to open Paper Studio');
    } finally {
      setSeedingPaper(false);
    }
  }

  // ── "What next" fork (shown after the 6 questions, BEFORE retrieval) ──
  // Both doors run the SAME retrieval; the chosen door decides what happens once
  // it completes (auto-synthesis effect for 'brief', paper-route effect for 'paper').
  function forkToBrief() { setAwaitingForkChoice(false); setPostRetrievalChoice('brief'); void runSearch(); }
  function forkToPaper(mode: 'deep' | 'standard') { setPendingGenerateMode(mode); setAwaitingForkChoice(false); setPostRetrievalChoice('paper'); void runSearch(); }
  function forkBackToQuestions() { setAwaitingForkChoice(false); setClarifyingPhase(true); }

  // Seed a 10-page plan from the completed run's evidence, then open the
  // streamlined "generate-now" evidence GATE (curate → Generate). It no longer
  // auto-generates — the user reviews/edits the evidence pool first, then the
  // gate's Generate button kicks off the job. The creative-planner expansion
  // (LLM-brought "Discovered" papers) runs INSIDE the gate on open, so the
  // planner rows render with their metadata via Paper Studio's libraryRows path.
  // `plan.generateMode` set here both selects the gate (vs the manual prep
  // wizard) AND drives the planner + drafting model.
  // Fired by the paper-route effect once retrieval completes with choice 'paper'.
  async function openPaperStudioFromRun(run: SearchRun) {
    setSeedingPaper(true);
    setPendingSynthesis(false);
    try {
      const mode = pendingGenerateMode ?? 'standard';
      const seeded = await apiClient.createPaperPlan(run.id, null, run.evidenceWorkIds ?? undefined);
      let planRow = seeded;
      // Pin 10 pages + record the chosen model on the plan. NON-FATAL — a patch
      // failure must not block the gate; it just falls back to defaults.
      try {
        const baseEmphasis = seeded.plan?.emphasis;
        const WORDS_PER_PAGE = 500;            // must match server-side WORDS_PER_PAGE
        const emphasis = {
          themes: baseEmphasis?.themes ?? [],
          audience: (baseEmphasis?.audience ?? 'technical') as 'policy' | 'technical',
          targetWords: 10 * WORDS_PER_PAGE,
        };
        planRow = await apiClient.patchPaperPlan(seeded.id, { emphasis, generateMode: mode });
      } catch (patchErr) {
        console.warn('[generate-now] plan pin failed; using defaults:', patchErr);
      }
      track('paper.generate_now_gate', { severity: 'info', search_run_id: run.id, plan_id: seeded.id, mode });
      setActivePlan(planRow);
      setTab('paper-studio');
    } catch (err) {
      // Surface the REAL failure instead of a silent bounce. Reverting to the
      // brief UI is fine (the evidence is still useful) but the user must see why.
      const msg = err instanceof Error ? err.message : 'Failed to open the paper builder';
      setErrorMessage(`Couldn't open the paper builder: ${msg}`);
      setPostRetrievalChoice(null);          // failure → fall back to the brief UI
      paperRouteStartedRef.current = null;
    } finally {
      setSeedingPaper(false);
    }
  }

  // Studio kicked off generation — route to Library, where the existing
  // activeJelJobId polling + JelPaperView render the live draft.
  function handleStudioGenerated(paper: JelPaper) {
    setSnapshot((s) => s ? { ...s, jelPapers: [paper, ...(s.jelPapers ?? []).filter((p) => p.id !== paper.id)] } : s);
    setActiveJelJobId(paper.id);
    setJelPaperProgress({ done: 0, total: 0, status: paper.status ?? 'queued' });
    setActivePlan(null);
    setTab('library');
  }

  async function handleRefreshJelPaper(paperId: string) {
    try {
      const updated = await apiClient.getJelPaper(paperId);
      setCurrentJelPaper(updated);
      setSnapshot((s) => {
        if (!s) return s;
        return { ...s, jelPapers: (s.jelPapers ?? []).map((p) => p.id === paperId ? updated : p) };
      });
    } catch {
      // ignore
    }
  }

  // Talk-to-the-draft: revise the open paper (re-draft targeted sections over its
  // existing evidence). Returns the paper flipped to 'running'; the poll effect
  // below refreshes the view until it's done. Errors propagate to JelPaperView.
  async function handleReviseJelPaper(instruction: string) {
    if (!currentJelPaper) return;
    const updated = await apiClient.reviseJelPaper(currentJelPaper.id, instruction);
    setCurrentJelPaper(updated);
  }

  // Poll an open JEL paper while it's running (revision in progress, or opened
  // mid-generation) so the view updates to the finished draft on its own.
  useEffect(() => {
    if (currentJelPaper?.status !== 'running') return;
    const id = currentJelPaper.id;
    let isFetching = false;
    const t = setInterval(async () => {
      if (isFetching) return;
      isFetching = true;
      try { await handleRefreshJelPaper(id); } catch { /* ignore */ } finally { isFetching = false; }
    }, 8000);
    return () => clearInterval(t);
  }, [currentJelPaper?.status, currentJelPaper?.id]);

  async function handleRenameJelPaper(paperId: string, newTitle: string) {
    try {
      const updated = await apiClient.renameJelPaper(paperId, newTitle);
      setSnapshot((s) => s ? {
        ...s,
        jelPapers: (s.jelPapers ?? []).map((p) => p.id === paperId ? updated : p),
      } : s);
      if (currentJelPaper?.id === paperId) setCurrentJelPaper(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Rename failed';
      track('paper.rename_error', { severity: 'warning', error_message: msg, paper_id: paperId });
      setErrorMessage(msg);
    }
  }

  async function handleDeleteJelPaper(paperId: string) {
    const removeLocally = () => {
      setSnapshot((s) => s ? {
        ...s,
        jelPapers: (s.jelPapers ?? []).filter((p) => p.id !== paperId),
      } : s);
      if (currentJelPaper?.id === paperId) setCurrentJelPaper(null);
      if (activeJelJobId === paperId) {
        setActiveJelJobId(null);
        setJelJobFingerprint(null);
        setJelPaperProgress(null);
      }
    };
    try {
      await apiClient.deleteJelPaper(paperId);
      removeLocally();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      // The row is already gone server-side — drop the phantom card instead of
      // leaving an undeletable entry the user keeps clicking.
      if (/not found/i.test(msg)) {
        removeLocally();
        return;
      }
      track('paper.delete_error', { severity: 'warning', error_message: msg, paper_id: paperId });
      setErrorMessage(msg);
    }
  }

  async function handleLoadMore() {
    if (!currentRun || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      // Cheap load-more: fetch the pre-ranked extended pool stored at search time.
      // No re-retrieval — one DB read + works fetch (~200ms vs ~30s).
      const { works: moreWorks } = await apiClient.loadMoreEvidence(currentRun.id);
      if (moreWorks.length === 0) {
        setCurrentRun((r) => r ? { ...r, hasMoreEvidence: false } : r);
        return;
      }
      // Merge new work IDs into the run and add works to the snapshot
      const newIds = moreWorks.map((w) => w.id).filter((id) => !currentRun.evidenceWorkIds.includes(id));
      setCurrentRun((r) => r ? {
        ...r,
        evidenceWorkIds: [...r.evidenceWorkIds, ...newIds],
        hasMoreEvidence: false, // one batch only — all extended papers loaded
      } : r);
      // Merge new works into the snapshot so worksById resolves them in the table
      setSnapshot((s) => {
        if (!s) return s;
        const known = new Set(s.works.map((w) => w.id));
        const additions = moreWorks.filter((w) => !known.has(w.id)) as unknown as Work[];
        return additions.length > 0 ? { ...s, works: [...additions, ...s.works] } : s;
      });
      // Append the loaded papers to the BRIEF's evidence rows — the table renders
      // from brief.sections.evidenceRows, so updating only the run (as before)
      // loaded the papers into state but never showed them. Shell rows carry the
      // paper's own metadata; `finding` uses the abstract (no synthesis until the
      // user regenerates). Dedup against rows already present.
      setCurrentBrief((b) => {
        if (!b) return b;
        const existing = new Set((b.sections.evidenceRows ?? []).map((r) => r.workId));
        const shells: EvidenceRow[] = moreWorks
          .filter((w) => !existing.has(w.id))
          .map((w: any) => ({
            workId: w.id,
            title: w.title,
            authors: Array.isArray(w.authors) ? w.authors : [],
            sourceName: w.venue || w.institution || w.source || 'Unknown',
            year: w.year ?? 0,
            methodologyBadge: w.methodology_design || w.methodologyDesign || 'Unclassified',
            causalStrength: w.causal_strength || w.causalStrength || 'signal',
            smsLevel: w.sms_level ?? w.smsLevel ?? null,
            geography: Array.isArray(w.geography) ? w.geography : [],
            doi: w.canonical_doi ?? w.canonicalDoi,
            url: w.url || w.open_access_pdf_url || w.openAccessPdfUrl || '',
            finding: w.abstract || '',
          }));
        if (shells.length === 0) return b;
        return { ...b, sections: { ...b.sections, evidenceRows: [...(b.sections.evidenceRows ?? []), ...shells] } };
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Load more failed');
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function handleFeedback(type: 'like' | 'dislike' | 'save' | 'dismiss', workId?: string) {
    if (!currentBrief) return;
    try {
      const fb = await apiClient.submitFeedback({ briefId: currentBrief.id, workId, type });
      track(`feedback.${type}`, { severity: 'info', work_id: workId, brief_id: currentBrief.id });
      // Optimistically add to snapshot so saved-state icons update immediately
      if (type === 'save' && workId) {
        setSnapshot((s) => s ? { ...s, feedback: [fb, ...(s.feedback ?? [])] } : s);
      }
      await refreshSnapshot();
    } catch (err) {
      track('feedback.submit_error', { severity: 'warning', type, work_id: workId, error_message: err instanceof Error ? err.message : 'Feedback failed' });
    }
  }

  async function handleCreateSubscription(payload: { label: string; type: 'topic' | 'author' | 'search'; cadence: 'daily' | 'weekly'; topic?: string; query?: string }) {
    try {
      await apiClient.createSubscription(payload);
      await refreshSnapshot();
    } catch (err) {
      track('library.subscription_create_error', { severity: 'warning', error_message: err instanceof Error ? err.message : 'Subscription failed' });
    }
  }

  // Star/exclude hit ADMIN-gated works routes — for non-admin pilot users they
  // 403'd as unhandled rejections while the UI toasted success, so no signal
  // was ever recorded. Non-admins now record the signal through the
  // all-users /api/feedback path instead.
  async function handleExcludeWork(workId: string, excluded: boolean) {
    if (!isAdmin) {
      if (excluded) await handleFeedback('dislike', workId);
      return;
    }
    try {
      await apiClient.excludeWork(workId, excluded);
      await refreshSnapshot();
    } catch (err) {
      track('works.exclude_error', { severity: 'warning', work_id: workId, error_message: err instanceof Error ? err.message : 'Exclude failed' });
    }
  }

  async function handleStarWork(workId: string, starred: boolean) {
    if (!isAdmin) {
      if (starred) await handleFeedback('like', workId);
      return;
    }
    try {
      await apiClient.starWork(workId, starred);
      await refreshSnapshot();
    } catch (err) {
      track('works.star_error', { severity: 'warning', work_id: workId, error_message: err instanceof Error ? err.message : 'Star failed' });
    }
  }

  function handleFollowUpQuestion(question: string) {
    // Prefill the follow-up chat bar so the user can edit before sending.
    // (This fires only from BriefView, i.e. a brief is loaded → the follow-up
    // bar is the active input, not the Step-1 search box.)
    setFollowUpDraft(question);
  }

  // Stable onSubmit for the follow-up bar: a ref-to-latest keeps the callback
  // identity constant (so React.memo(FollowUpChatBar) isn't defeated by App
  // re-renders during chat streaming), while always running the current
  // handleSendFollowUp closure.
  const followUpSubmitRef = useRef<(t: string) => void>(() => {});
  followUpSubmitRef.current = (t: string) => { void handleSendFollowUp(t); setFollowUpDraft(''); };
  const handleFollowUpSubmit = useCallback((t: string) => followUpSubmitRef.current(t), []);

  async function handleSourceReview(sourceId: string, approved: boolean, note: string) {
    await apiClient.reviewSource({ sourceId, approved, note });
    await refreshSnapshot();
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setSnapshot(null);
    setCurrentRun(null);
    setCurrentBrief(null);
    setSearchStatus('idle');
    setErrorMessage(null);
  }

  // Poll activePlan while the user is in Studio and a paper is generating/running.
  // MUST be above every conditional return below (sessionLoading, paper-studio) —
  // all hooks run before any early return, or React throws #310 (hook-count change).
  useEffect(() => {
    if (tab !== 'paper-studio' || !activePlan) return;
    const { status } = activePlan;
    if (status !== 'running' && status !== 'queued') return;
    const id = activePlan.id;
    let isFetching = false;
    const t = setInterval(async () => {
      if (isFetching) return;
      isFetching = true;
      try {
        const updated = await apiClient.getJelPaper(id);
        setActivePlan(updated);
      } catch {
        // ignore transient fetch errors
      } finally {
        isFetching = false;
      }
    }, 8000);
    return () => clearInterval(t);
  }, [tab, activePlan?.id, activePlan?.status]);

  // --- Loading state (checking session) ---
  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-[linear-gradient(135deg,#0f7b86,#0f1d35)] flex flex-col items-center justify-center gap-4">
        <svg className="animate-spin h-6 w-6 text-cyan-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <div className="text-white text-sm font-medium">Loading Horizon Scanner...</div>
      </div>
    );
  }

  // --- Password recovery — user clicked reset link in email ---
  if (isPasswordRecovery) {
    return <PasswordResetPanel onComplete={() => { setIsPasswordRecovery(false); void refreshSnapshot(); }} />;
  }

  // --- No session — show auth gate ---
  if (!session) {
    return <AuthGate onAuthenticated={() => void refreshSnapshot()} />;
  }

  // --- Authenticated — show main app ---
  async function fetchSignalsForCurrentQuery(query: string, profiles: ('policy' | 'buzz')[]) {
    if (!query.trim() || profiles.length === 0) return;
    const cacheKey = `${query}|${[...profiles].sort().join(',')}`;
    if (signalsFetchedFor === cacheKey) return;
    setSignalsLoading(true);
    setSignalsError(null);
    try {
      const result = await apiClient.fetchSignals(query, profiles);
      setSignalsResult(result);
      setSignalsFetchedFor(cacheKey);
    } catch {
      setSignalsError('Could not load signals. Try again.');
    } finally {
      setSignalsLoading(false);
    }
  }


  // Paper Studio takes over the full screen (its own cockpit layout).
  if (tab === 'paper-studio' && activePlan) {
    // planning + generateMode set ⇒ the write-first "Generate Now" streamlined
    // gate (curate → Generate). planning without it ⇒ the manual prep wizard.
    const studioMode = activePlan.status !== 'planning'
      ? 'review'
      : (activePlan.plan?.generateMode ? 'generate-now' : 'prep');
    return (
      <Suspense fallback={<LazyFallback />}>
      <PaperStudio
        plan={activePlan}
        evidenceRows={currentBrief?.sections.evidenceRows ?? []}
        onBack={() => { setActivePlan(null); setTab('search'); }}
        onGenerated={handleStudioGenerated}
        mode={studioMode}
        // Generate Now gate: stay in Studio and show live progress (review mode
        // renders GenerationProgress once status flips to queued/running) instead
        // of bouncing to Library like the manual prep wizard's Generate does.
        onGenerateNow={(paper) => setActivePlan(paper)}
        onRevise={async (instruction) => {
          const updated = await apiClient.reviseJelPaper(activePlan.id, instruction);
          setActivePlan(updated);
        }}
      />
      </Suspense>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f7fb] text-slate-900">
      <div className="flex min-h-screen flex-col">
        <main className="flex-1 min-w-0">
          {/* Compact header */}
          <section className="bg-[linear-gradient(135deg,#0f7b86,#0f1d35)] px-6 py-2.5 md:py-5 text-white lg:px-10">
            <div className="max-w-6xl flex items-center justify-between gap-4">
              <div>
                <h1 className="text-lg md:text-2xl font-black leading-tight">Horizon Scanner</h1>
                <p className="text-xs text-cyan-200 hidden md:block mt-0.5">Evidence intelligence for IADB policy research</p>
              </div>
              <div className="flex items-center gap-4">
                {isBusy && (
                  <div className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium">
                    <svg className="animate-spin h-3.5 w-3.5 text-cyan-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    {statusText}
                  </div>
                )}
                <span className="text-xs text-cyan-200 hidden sm:inline">{session.user?.email}</span>
                {isAdmin && (
                  <button
                    onClick={() => setTab('admin')}
                    className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20 transition"
                  >
                    Admin
                  </button>
                )}
                <div className="relative">
                  <button
                    onClick={() => setShowAccount(v => !v)}
                    className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20 transition"
                  >
                    <div className="w-5 h-5 rounded-full bg-teal-400 flex items-center justify-center text-[11px] font-bold text-teal-900 shrink-0">
                      {(session?.user?.email ?? '?')[0].toUpperCase()}
                    </div>
                    <span className="hidden sm:inline">{session?.user?.email?.split('@')[0] ?? 'Account'}</span>
                  </button>
                  {showAccount && (
                    <AccountPanel
                      email={session?.user?.email ?? ''}
                      onClose={() => setShowAccount(false)}
                      // Also fed here (not just the mobile bottom-nav panel): this
                      // header avatar button is visible on mobile too, so a
                      // byok_admin tapping it must still reach Grant access. On
                      // desktop this is a harmless shortcut alongside the top tab.
                      navItems={adminNavItems}
                      onNavigate={(key) => setTab(key as AppTab)}
                    />
                  )}
                </div>
                <button
                  onClick={() => void handleSignOut()}
                  className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20 transition"
                >
                  Sign out
                </button>
              </div>
            </div>
          </section>

          {/* Sticky tab bar — desktop only. Mobile uses the bottom nav below. */}
          <nav className="sticky top-0 z-30 bg-white border-b border-slate-200 px-6 lg:px-10">
            {/* Desktop tabs */}
            <div className="max-w-6xl hidden md:flex items-center gap-1 -mb-px">
              {([
                { key: 'search', label: 'Evidence Briefs' },
                { key: 'library', label: 'My Library' },
                { key: 'follow', label: 'Follow' },
                ...adminNavItems,
              ] as { key: AppTab; label: string }[]).map((item) => (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  className={`px-4 py-3 text-sm font-semibold border-b-2 transition ${
                    tab === item.key
                      ? 'border-teal-600 text-teal-700'
                      : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {/* Mobile top bar — shows current section label + history drawer trigger */}
            <div className="md:hidden flex items-center gap-2 h-11 px-2">
              {tab === 'search' && (
                <button
                  onClick={() => setShowMobileHistory(true)}
                  className="p-2 rounded-md text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition shrink-0"
                  aria-label="Search history"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                </button>
              )}
              <span className="text-sm font-bold text-slate-800 flex-1">
                {tab === 'search' ? 'Past Queries'
                  : tab === 'library' ? 'My Library'
                  : tab === 'follow' ? 'Follow'
                  : tab === 'grant-access' ? 'Grant access'
                  : tab === 'pilot-monitor' ? 'Pilot Monitor'
                  : tab === 'notes' ? 'Notes'
                  : 'Admin'}
              </span>
              {/* Generate Paper — in top bar when a brief is loaded */}
              {tab === 'search' && currentBrief && currentBrief.id !== 'partial' && (
                (() => {
                  const status = !activeJelJobId || !jelPaperProgress ? undefined
                    : jelPaperProgress.status === 'done' ? 'done'
                    : jelPaperProgress.status === 'error' ? 'error'
                    : 'generating';
                  if (status === 'done') return (
                    <button onClick={() => setTab('library')} className="flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 px-2.5 py-1 text-[11px] font-semibold shrink-0">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      Paper ready → Library
                    </button>
                  );
                  if (status === 'generating') return (
                    <span className="flex items-center gap-1.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-600 px-2.5 py-1 text-[11px] font-semibold shrink-0">
                      <span className="w-2.5 h-2.5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
                      {jelPaperProgress && jelPaperProgress.total > 0 ? `§${jelPaperProgress.done + 1}/${jelPaperProgress.total}` : '…'}
                    </span>
                  );
                  const canGenerate = !activeJelJobId || status === 'error';
                  if (!canGenerate) return null;
                  return (
                    <button
                      onClick={() => void handleGenerateJelPaper()}
                      className="flex items-center gap-1 rounded-full bg-indigo-600 text-white px-2.5 py-1 text-[11px] font-semibold hover:bg-indigo-700 transition shrink-0"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                      </svg>
                      Generate Paper
                    </button>
                  );
                })()
              )}
            </div>
          </nav>

          {/* Mobile bottom navigation bar */}
          <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-slate-200 flex items-stretch h-14" data-print-hide>
            {([
              {
                key: 'search' as AppTab, label: 'Search',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
              },
              {
                key: 'library' as AppTab, label: 'Library',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
              },
              {
                key: 'follow' as AppTab, label: 'Follow',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>,
              },
            ]).map((item) => (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition ${
                  tab === item.key ? 'text-teal-600' : 'text-slate-400'
                }`}
                aria-label={item.label}
              >
                {item.icon}
                <span className="text-[10px] font-semibold">{item.label}</span>
              </button>
            ))}
            {/* Account button — mobile */}
            <div className="relative flex-1 flex flex-col items-center justify-center">
              <button
                onClick={() => setShowAccount(v => !v)}
                className="flex flex-col items-center justify-center gap-0.5 w-full h-full text-slate-400"
                aria-label="Account"
              >
                <div className="w-5 h-5 rounded-full bg-teal-600 flex items-center justify-center text-white text-[11px] font-bold">
                  {(session?.user?.email ?? '?')[0].toUpperCase()}
                </div>
                <span className="text-[10px] font-semibold">Account</span>
              </button>
              {showAccount && (
                <div className="absolute bottom-full right-0 mb-2 z-50">
                  <AccountPanel
                    email={session?.user?.email ?? ''}
                    onClose={() => setShowAccount(false)}
                    navItems={adminNavItems}
                    onNavigate={(key) => setTab(key as AppTab)}
                  />
                </div>
              )}
            </div>
          </nav>

          {/* Examples popover — full curated question list, grouped by theme */}
          {examplesPopoverOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center px-4" data-print-hide>
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setExamplesPopoverOpen(false)}
              />
              <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
                  <div>
                    <h3 className="text-base font-bold text-slate-900">Example policy questions</h3>
                    <p className="text-xs text-slate-500 mt-0.5">Click any question to use it as your starting point.</p>
                  </div>
                  <button
                    onClick={() => setExamplesPopoverOpen(false)}
                    aria-label="Close"
                    className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <div className="overflow-y-auto px-6 py-4 space-y-5">
                  {CURATED_QUESTIONS_BY_THEME.map((group) => (
                    <div key={group.theme}>
                      <div className="text-[10px] uppercase tracking-[0.15em] text-teal-700 font-bold mb-2">{group.theme}</div>
                      <ul className="space-y-1">
                        {group.questions.map((q) => (
                          <li key={q}>
                            <button
                              type="button"
                              onClick={() => {
                                setQuery(q);
                                setExamplesPopoverOpen(false);
                                setSuggestionsOpen(false);
                              }}
                              className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-teal-50 hover:text-teal-900 transition leading-snug"
                            >
                              {q}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Mobile history drawer overlay */}
          {showMobileHistory && (
            <div className="fixed inset-0 z-50 sm:hidden" data-print-hide>
              {/* Backdrop */}
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setShowMobileHistory(false)}
              />
              {/* Drawer */}
              <aside className="absolute left-0 top-0 bottom-0 w-72 bg-white flex flex-col shadow-xl">
                <div className="px-3 py-3 border-b border-slate-100 shrink-0">
                  <button
                    onClick={() => { handleNewSearch(); setShowMobileHistory(false); }}
                    disabled={isBusy || chatIsLoading}
                    className="w-full flex items-center gap-2 rounded-lg border border-slate-200 bg-white hover:bg-teal-50 hover:border-teal-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:text-teal-700 transition disabled:opacity-40"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New search
                  </button>
                </div>
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
                  <span className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">Search History</span>
                  <div className="flex items-center gap-3">
                    {snapshot && snapshot.searchRuns.length > 0 && (
                      <button
                        onClick={async () => {
                          if (!window.confirm('Clear all search history? This cannot be undone.')) return;
                          // Track failures so user sees what went wrong instead
                          // of silent no-op. Was: `catch { /* continue */ }`
                          // — masked all errors, made "delete doesn't work"
                          // invisible to user.
                          const failures: Array<{ id: string; query: string; msg: string }> = [];
                          for (const run of snapshot.searchRuns) {
                            try {
                              await apiClient.deleteSearchRun(run.id);
                            } catch (err) {
                              failures.push({
                                id: run.id,
                                query: run.query,
                                msg: err instanceof Error ? err.message : String(err),
                              });
                              console.error('[Clear all] delete failed:', run.id, err);
                            }
                          }
                          setCurrentRun(null);
                          setCurrentBrief(null);
                          await refreshSnapshot();
                          if (failures.length > 0) {
                            setErrorMessage(
                              `Clear all: ${failures.length} of ${snapshot.searchRuns.length} deletes failed. ` +
                              `First error: ${failures[0].msg}. Check console for details.`,
                            );
                          }
                        }}
                        className="text-[10px] text-slate-400 hover:text-rose-600 transition"
                      >
                        Clear all
                      </button>
                    )}
                    <button
                      onClick={() => setShowMobileHistory(false)}
                      className="text-slate-400 hover:text-slate-600 transition rounded-md p-1"
                      aria-label="Close history"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {!snapshot || snapshot.searchRuns.length === 0 ? (
                    <p className="text-xs text-slate-400 px-4 py-4">No searches yet.</p>
                  ) : (
                    snapshot.searchRuns.slice(0, 20).map((run) => (
                      <div key={run.id} className="group relative border-b border-slate-100 last:border-0">
                        <button
                          onClick={() => {
                            // Abandon any in-flight brief stream FIRST: bumping the
                            // gen + aborting means a late onDone from the old stream
                            // can't overwrite the past brief we're opening here.
                            searchGenRef.current += 1;
                            streamBriefAbortRef.current?.abort();
                            setCurrentRun(run);
                            setQuery(run.query);
                            setTab('search');
                            const matchingBrief = snapshot.briefs.find((b) => b.searchRunId === run.id);
                            setCurrentBrief(matchingBrief ? applyRunChannels(matchingBrief, run) : null);
                            setSearchStatus('idle');
                            setPendingSynthesis(false);
                            setShowMobileHistory(false);
                          }}
                          className={`w-full text-left px-4 py-3 pr-8 hover:bg-slate-50 transition ${
                            currentRun?.id === run.id ? 'text-teal-700' : 'text-slate-700'
                          }`}
                        >
                          <div className={`text-xs line-clamp-2 leading-snug ${currentRun?.id === run.id ? 'font-semibold' : ''}`}>
                            {run.query}
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5" title={new Date(run.createdAt).toLocaleString()}>
                            {formatRelativeTime(run.createdAt)}
                          </div>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); void handleDeleteRun(run); }}
                          // Always visible here — this is the MOBILE history drawer,
                          // and touch devices have no hover, so opacity-0/group-hover
                          // (kept on the desktop sidebar below) left mobile users unable
                          // to delete a single past search (only "Clear all").
                          className="absolute top-3 right-2 rounded-md p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                          aria-label="Delete search"
                          title="Delete"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </aside>
            </div>
          )}

          <div className="flex flex-1 min-h-0">
            {/* History sidebar — left rail, ChatGPT-style. Hidden entirely
                on Follow and Library tabs (search history is irrelevant
                in those workflows). */}
            {tab !== 'follow' && tab !== 'library' && (historySidebarOpen ? (
              <aside className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col hidden sm:flex" data-print-hide>
                {/* New search button — returns to State A (full filters visible) */}
                <div className="px-3 py-3 border-b border-slate-100 shrink-0">
                  <button
                    onClick={handleNewSearch}
                    disabled={isBusy || chatIsLoading}
                    className="w-full flex items-center gap-2 rounded-lg border border-slate-200 bg-white hover:bg-teal-50 hover:border-teal-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:text-teal-700 transition disabled:opacity-40"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New search
                  </button>
                </div>
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
                  <span className="text-[10px] uppercase tracking-[0.15em] text-slate-500 font-bold">Search History</span>
                  <div className="flex items-center gap-3">
                    {snapshot && snapshot.searchRuns.length > 0 && (
                      <button
                        onClick={async () => {
                          if (!window.confirm('Clear all search history? This cannot be undone.')) return;
                          // Track failures so user sees what went wrong instead
                          // of silent no-op. Was: `catch { /* continue */ }`
                          // — masked all errors, made "delete doesn't work"
                          // invisible to user.
                          const failures: Array<{ id: string; query: string; msg: string }> = [];
                          for (const run of snapshot.searchRuns) {
                            try {
                              await apiClient.deleteSearchRun(run.id);
                            } catch (err) {
                              failures.push({
                                id: run.id,
                                query: run.query,
                                msg: err instanceof Error ? err.message : String(err),
                              });
                              console.error('[Clear all] delete failed:', run.id, err);
                            }
                          }
                          setCurrentRun(null);
                          setCurrentBrief(null);
                          await refreshSnapshot();
                          if (failures.length > 0) {
                            setErrorMessage(
                              `Clear all: ${failures.length} of ${snapshot.searchRuns.length} deletes failed. ` +
                              `First error: ${failures[0].msg}. Check console for details.`,
                            );
                          }
                        }}
                        className="text-[10px] text-slate-400 hover:text-rose-600 transition"
                      >
                        Clear all
                      </button>
                    )}
                    <button
                      onClick={() => setHistorySidebarOpen(false)}
                      className="text-slate-400 hover:text-slate-600 transition rounded-md p-0.5"
                      title="Collapse history"
                      aria-label="Collapse search history sidebar"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {!snapshot || snapshot.searchRuns.length === 0 ? (
                    <p className="text-xs text-slate-400 px-4 py-4">No searches yet.</p>
                  ) : (
                    snapshot.searchRuns.slice(0, 20).map((run) => (
                      <div key={run.id} className="group relative border-b border-slate-100 last:border-0">
                        <button
                          onClick={() => {
                            // Abandon any in-flight brief stream FIRST: bumping the
                            // gen + aborting means a late onDone from the old stream
                            // can't overwrite the past brief we're opening here.
                            searchGenRef.current += 1;
                            streamBriefAbortRef.current?.abort();
                            setCurrentRun(run);
                            setQuery(run.query);
                            setTab('search');
                            const matchingBrief = snapshot.briefs.find((b) => b.searchRunId === run.id);
                            setCurrentBrief(matchingBrief ? applyRunChannels(matchingBrief, run) : null);
                            setSearchStatus('idle');
                            setPendingSynthesis(false);
                          }}
                          className={`w-full text-left px-4 py-3 pr-8 hover:bg-slate-50 transition ${
                            currentRun?.id === run.id ? 'text-teal-700' : 'text-slate-700'
                          }`}
                        >
                          <div className={`text-xs line-clamp-2 leading-snug ${currentRun?.id === run.id ? 'font-semibold' : ''}`}>
                            {run.query}
                          </div>
                          <div
                            className="text-[10px] text-slate-400 mt-0.5"
                            title={new Date(run.createdAt).toLocaleString()}
                          >
                            {formatRelativeTime(run.createdAt)}
                          </div>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); void handleDeleteRun(run); }}
                          className="absolute top-3 right-2 rounded-md p-1 text-slate-300 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100 transition"
                          aria-label="Delete search"
                          title="Delete"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </aside>
            ) : (
              <div className="w-8 shrink-0 border-r border-slate-200 bg-white flex flex-col items-center py-3 gap-3 hidden sm:flex" data-print-hide>
                <button
                  onClick={handleNewSearch}
                  className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center hover:bg-teal-700 transition shrink-0"
                  title="New search"
                  aria-label="New search"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  onClick={() => setHistorySidebarOpen(true)}
                  className="w-7 h-7 rounded-md text-slate-400 flex items-center justify-center hover:bg-slate-100 hover:text-slate-600 transition"
                  title="Show search history"
                  aria-label="Show search history"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            ))}

            {/* Main content */}
            <div className="flex-1 min-w-0 px-4 pt-0 md:px-6 md:py-8 lg:px-10 overflow-y-auto pb-20 md:pb-8">
            <ErrorBoundary key={tab}>
            {tab === 'search' && (
              <div className="space-y-4 md:space-y-6 pb-32">

                {/* ── BOX 1 (Step 1) — "What evidence?"
                    Merged: query + filters + evidence scope, in one prominent
                    card. Submit kicks off retrieval and reveals Box 2 below. ── */}
                {(!currentBrief && !pendingSynthesis && !isBusy && !clarifyingPhase && !awaitingForkChoice) && (
                <section data-print-hide className="rounded-2xl bg-gradient-to-br from-teal-50 to-white p-6 border-4 border-teal-500 shadow-xl ring-4 ring-teal-100">
                  <div className="mb-5">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-teal-700 font-bold mb-1">Step 1</p>
                    <h3 className="text-lg font-bold text-slate-900">What evidence are we looking for?</h3>
                  </div>

                  {/* Query */}
                  <div className="mb-5">
                    <div className="flex items-baseline justify-between mb-2">
                      <label className="text-xs font-semibold text-slate-700 block">Your policy question</label>
                      <button
                        type="button"
                        onClick={() => setExamplesPopoverOpen(true)}
                        className="text-[11px] font-medium text-teal-700 hover:text-teal-900 hover:underline transition"
                      >
                        Examples
                      </button>
                    </div>
                    <div className="relative">
                      <textarea
                        value={query}
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setSuggestionsOpen(true);
                          setHighlightedSuggestionIdx(0);
                        }}
                        onFocus={() => setSuggestionsOpen(true)}
                        onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
                        onKeyDown={(e) => {
                          const dropdownOpen = suggestionsOpen && suggestionMatches.length > 0;
                          if (dropdownOpen && e.key === 'ArrowDown') {
                            e.preventDefault();
                            setHighlightedSuggestionIdx((i) => (i + 1) % suggestionMatches.length);
                            return;
                          }
                          if (dropdownOpen && e.key === 'ArrowUp') {
                            e.preventDefault();
                            setHighlightedSuggestionIdx((i) => (i - 1 + suggestionMatches.length) % suggestionMatches.length);
                            return;
                          }
                          if (dropdownOpen && e.key === 'Escape') {
                            e.preventDefault();
                            setSuggestionsOpen(false);
                            return;
                          }
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (dropdownOpen) {
                              const pick = suggestionMatches[highlightedSuggestionIdx];
                              if (pick) {
                                setQuery(pick);
                                setSuggestionsOpen(false);
                                return;
                              }
                            }
                            void handleUnifiedSubmit();
                          }
                        }}
                        className="w-full rounded-xl border-2 border-slate-200 bg-white px-4 py-3 min-h-20 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition resize-none"
                        placeholder="e.g. What does high-quality evidence say about conditional cash transfers in Latin America?"
                      />
                      {suggestionsOpen && suggestionMatches.length > 0 && (
                        <ul
                          role="listbox"
                          className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg py-1"
                        >
                          {suggestionMatches.map((s, idx) => (
                            <li
                              key={s}
                              role="option"
                              aria-selected={idx === highlightedSuggestionIdx}
                              onMouseDown={(event) => event.preventDefault()}
                              onMouseEnter={() => setHighlightedSuggestionIdx(idx)}
                              onClick={() => {
                                setQuery(s);
                                setSuggestionsOpen(false);
                              }}
                              className={`px-4 py-2 text-[13px] leading-snug cursor-pointer ${
                                idx === highlightedSuggestionIdx
                                  ? 'bg-teal-50 text-teal-900'
                                  : 'text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {s}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {/* Synthesis model badge — which model this generation will use */}
                  <div className="mt-3"><SynthesisModelBadge /></div>

                  {/* Submit */}
                  <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-slate-200">
                    <button
                      onClick={() => void handleUnifiedSubmit()}
                      disabled={isBusy || chatIsLoading || !query.trim()}
                      className="rounded-full bg-teal-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50 transition shadow-md"
                    >
                      Ask →
                    </button>
                    {searchStatus === 'error' && (
                      <button
                        onClick={() => void runSearch()}
                        className="rounded-full border border-rose-300 px-5 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 transition"
                      >
                        Retry
                      </button>
                    )}
                    {/* Retry button — shown when a previous search exists and user is back at Step 1.
                        Must route through the brief fork: calling runSearch() with
                        postRetrievalChoice=null left the run in a dead-end "choose your
                        audience" spinner (the persona picker it referenced was removed 2026-06-03). */}
                    {searchStatus === 'idle' && searchStatus !== 'error' && currentRun === null && query.trim() && (
                      <button
                        onClick={() => forkToBrief()}
                        disabled={!query.trim()}
                        className="rounded-full border border-teal-300 px-5 py-2 text-sm font-semibold text-teal-700 hover:bg-teal-50 transition"
                        title="Re-run the same search"
                      >
                        ↩ Retry
                      </button>
                    )}
                  </div>
                </section>
                )}

                {/* Set up Claude Code — prominent entry point right below the query */}
                {!currentBrief && !clarifyingPhase && (
                  <button
                    type="button"
                    onClick={() => setShowClaudeSetup(true)}
                    className="w-full text-left rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-sm hover:border-teal-300 hover:bg-teal-50/40 transition flex items-center gap-3"
                  >
                    <span className="text-lg shrink-0">✍</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-semibold text-slate-800">Write papers in Claude Code</span>
                      <span className="block text-[11px] text-slate-500">Generate full survey papers from your own terminal, on your Claude subscription. Set up once →</span>
                    </span>
                  </button>
                )}

                {showClaudeSetup && createPortal(
                  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={() => setShowClaudeSetup(false)}>
                    <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 sticky top-0 bg-white">
                        <h2 className="text-[14px] font-bold text-slate-800">Set up Claude Code</h2>
                        <button type="button" onClick={() => setShowClaudeSetup(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
                      </div>
                      <div className="px-5 py-4">
                        <ClaudeCodeSetup />
                      </div>
                    </div>
                  </div>,
                  document.body,
                )}

                {/* Clarifying phase — chat questions after query submitted, before search fires */}
                {(clarifyingPhase && !isBusy && !currentBrief) && (
                <section data-print-hide className="rounded-2xl bg-white p-5 border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-teal-700 font-bold">Focusing your search</p>
                    <button
                      type="button"
                      onClick={() => setClarifyingPhase(false)}
                      className="text-[11px] text-slate-400 hover:text-slate-600 transition"
                    >
                      ← Edit query
                    </button>
                  </div>
                  <SearchClarifier
                    query={query}
                    channels={searchChannels}
                    setChannels={setSearchChannels}
                    sourceMode={sourceMode}
                    setSourceMode={setSourceMode}
                    filters={filters}
                    setFilters={setFilters}
                    onSubmit={() => { setClarifyingPhase(false); setAwaitingForkChoice(true); }}
                  />
                </section>
                )}

                {/* ── "What next" fork — shown right after the 6 questions, before retrieval ── */}
                {(awaitingForkChoice && !isBusy && !currentBrief) && (
                  <PaperBuildFork
                    onGenerateNow={(mode) => forkToPaper(mode)}
                    onCreateBrief={forkToBrief}
                    onBack={forkBackToQuestions}
                    generating={seedingPaper}
                  />
                )}

                {/* Cancel / back-to-step-1 — always enabled during search so user can stop */}
                {(isBusy || pendingSynthesis) && (
                  <div className="flex items-center justify-between gap-2" data-print-hide>
                    <button
                      type="button"
                      onClick={handleBackToStep1}
                      disabled={chatIsLoading}
                      className="text-[11px] font-semibold text-teal-700 hover:text-teal-900 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-1 px-2.5 py-1 rounded-full border border-teal-200 hover:border-teal-400 bg-white"
                      title={isBusy ? "Stop retrieval and return to Step 1" : "Return to Step 1 to edit your question"}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                      Back to Step 1
                    </button>
                    <button
                      type="button"
                      onClick={handleNewSearch}
                      disabled={chatIsLoading}
                      className="text-[11px] font-semibold text-slate-500 hover:text-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-1 px-2.5 py-1 rounded-full border border-slate-200 hover:border-teal-300 bg-white"
                      title="Cancel and start a completely new search"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                      New search
                    </button>
                  </div>
                )}


                {/* ── Regenerate banner — fires only when the user has EXCLUDED
                      papers from the brief (the synthesis still cites them).
                      The "loaded extras past the cap" case is handled inline by
                      BriefView's own "Regenerate brief with N papers" button,
                      right next to the evidence table — no need for a duplicate
                      app-level banner. Capped at REGEN_LIMIT per brief. ── */}
                {currentBrief && currentBrief.id !== 'partial' && excludedInBrief.length > 0 && (
                  <div
                    data-print-hide
                    className="rounded-xl border-2 border-amber-200 bg-amber-50 px-5 py-4 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-amber-600 mt-0.5">⚠</span>
                      <div>
                        <p className="text-sm font-semibold text-amber-900">
                          {`${excludedInBrief.length} paper${excludedInBrief.length === 1 ? '' : 's'} excluded from this brief`}
                        </p>
                        <p className="text-xs text-amber-800 mt-0.5">
                          {`The synthesis above still references the excluded paper${excludedInBrief.length === 1 ? '' : 's'}. Regenerate to refresh the summary, methodology mix, and gap analysis without ${excludedInBrief.length === 1 ? 'it' : 'them'}.`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {regenCount < REGEN_LIMIT ? (
                        <button
                          type="button"
                          onClick={() => void handleRegenerateBrief()}
                          disabled={isBusy || chatIsLoading}
                          className="rounded-full bg-amber-600 hover:bg-amber-700 text-white px-5 py-2 text-sm font-semibold transition disabled:opacity-50 flex items-center gap-2"
                          title={`Regenerate brief excluding ${excludedInBrief.length} paper${excludedInBrief.length === 1 ? '' : 's'}. ${REGEN_LIMIT - regenCount} regeneration${REGEN_LIMIT - regenCount === 1 ? '' : 's'} left for this brief.`}
                        >
                          {searchStatus === 'synthesizing' ? 'Regenerating…' : 'Regenerate brief →'}
                        </button>
                      ) : (
                        <span className="text-xs text-amber-800 italic">
                          Regeneration limit reached ({REGEN_LIMIT}/{REGEN_LIMIT}) — start a new search to reset.
                        </span>
                      )}
                      {regenCount > 0 && regenCount < REGEN_LIMIT && (
                        <span className="text-[11px] text-amber-700">
                          {REGEN_LIMIT - regenCount} regeneration{REGEN_LIMIT - regenCount === 1 ? '' : 's'} left
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Past Queries — mobile only, shown below Step 1 when no brief is active ── */}
                {!currentBrief && !pendingSynthesis && !isBusy && snapshot && snapshot.searchRuns.length > 0 && (
                  <div className="md:hidden">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] uppercase tracking-[0.15em] text-slate-500 font-bold">Past Queries</span>
                    </div>
                    <div className="space-y-1">
                      {snapshot.searchRuns.slice(0, 8).map((run) => {
                        const matchingBrief = snapshot.briefs.find((b) => b.searchRunId === run.id);
                        return (
                          <button
                            key={run.id}
                            onClick={() => {
                              // Same in-flight-stream guard as the history sidebars.
                              searchGenRef.current += 1;
                              streamBriefAbortRef.current?.abort();
                              setCurrentRun(run);
                              setQuery(run.query);
                              setCurrentBrief(matchingBrief ? applyRunChannels(matchingBrief, run) : null);
                              setSearchStatus('idle');
                            }}
                            className={`w-full text-left rounded-xl border px-4 py-3 transition ${
                              currentRun?.id === run.id
                                ? 'border-teal-300 bg-teal-50'
                                : 'border-slate-200 bg-white hover:border-teal-200 hover:bg-teal-50'
                            }`}
                          >
                            <div className={`text-sm line-clamp-2 leading-snug ${currentRun?.id === run.id ? 'text-teal-800 font-semibold' : 'text-slate-700'}`}>
                              {run.query}
                            </div>
                            <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-2">
                              {formatRelativeTime(run.createdAt)}
                              {matchingBrief && <span className="rounded-full bg-teal-100 text-teal-700 px-1.5 py-0.5 font-semibold">Brief saved</span>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Error banner — errorMessage is set on every failure path
                       (retrieval, synthesis stream, delete, regenerate, load
                       more) but previously had NO render site, so all of those
                       failures were silent. Cleared automatically at the start
                       of the next action, or manually via Dismiss. ── */}
                {errorMessage && !isBusy && (
                  <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
                    <div className="min-w-0">
                      <span className="font-semibold">Something went wrong. </span>
                      <span className="break-words">{errorMessage}</span>
                    </div>
                    <button
                      onClick={() => setErrorMessage(null)}
                      className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* ── Horizon spinner — shown while retrieval is running before table exists ── */}
                {searchStatus === 'retrieving' && !currentBrief && (
                  <HorizonRetrievingSpinner />
                )}

                {/* ── Seeding gap (paper door): retrieval done, opening Paper Studio.
                       Fills the few seconds between createPaperPlan/generate and the
                       Studio progress panel so the screen is never blank. ── */}
                {seedingPaper && postRetrievalChoice === 'paper' && searchStatus !== 'retrieving' && (
                  <div className="flex flex-col items-center justify-center py-24 gap-3">
                    <span className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm font-semibold text-teal-700">Preparing your paper…</p>
                  </div>
                )}

                {/* ── Brief ── (hidden on the 'paper' route — we're opening Paper Studio) */}
                {currentBrief && postRetrievalChoice !== 'paper' && !(currentBrief.id === 'partial' && searchStatus === 'retrieving') && (<BriefView
                  brief={currentBrief}
                  worksById={worksById}
                  filters={filters}
                  evidenceClassification={currentRun?.evidenceClassification ?? null}
                  facetCoverage={currentRun ? {
                    excludedByFacets: currentRun.coverage?.excludedByFacets,
                    facetLabels: currentRun.coverage?.facetLabels,
                  } : null}
                  isLoading={searchStatus === 'retrieving'}
                  isSynthesizing={searchStatus === 'synthesizing'}
                  streamingText={streamingText}
                  error={searchStatus === 'error' ? errorMessage : null}
                  timeRange={timeRange}
                  onTimeRangeChange={(range) => {
                    const next = range as TimeRange;
                    setTimeRange(next);
                    setFilters((f) => applyTimeRangeToFilters(f, next));
                  }}
                  onLoadMore={() => void handleLoadMore()}
                  isLoadingMore={isLoadingMore}
                  showLoadMoreSuggestion={showLoadMoreSuggestion}
                  onFeedback={handleFeedback}
                  isAdmin={isAdmin}
                  onExcludeWork={(workId, excluded) => void handleExcludeWork(workId, excluded)}
                  onStarWork={(workId, starred) => void handleStarWork(workId, starred)}
                  onVisibleRowsChange={(ids) => {
                    setCurrentVisibleState({ briefId: currentBrief?.id ?? null, ids });
                  }}
                  onExportJson={(rowsForExport) => { if (!currentBrief) return; logEvent({ eventType: 'brief.downloaded', targetType: 'brief', targetId: currentBrief.id, status: 'completed', payload: { format: 'json' } }); exportBriefAsJson(currentBrief, worksById, rowsForExport); }}
                  onExportDocx={(rowsForExport) => { if (!currentBrief) return; logEvent({ eventType: 'brief.downloaded', targetType: 'brief', targetId: currentBrief.id, status: 'completed', payload: { format: 'docx' } }); void exportBriefAsDocx(currentBrief, worksById, rowsForExport); }}
                  onCopyBrief={(rowsForExport) => { if (!currentBrief) return; logEvent({ eventType: 'brief.copied', targetType: 'brief', targetId: currentBrief.id, status: 'completed', payload: { mode: 'text' } }); void copyBriefAsText(currentBrief, worksById, rowsForExport); }}
                  onShare={() => { if (!currentBrief) return; logEvent({ eventType: 'brief.copied', targetType: 'brief', targetId: currentBrief.id, status: 'completed', payload: { mode: 'share_link' } }); void copyShareLink(currentBrief); }}
                  onRetry={() => void runSearch()}
                  onFollowUpQuestion={handleFollowUpQuestion}
                  savedWorkIds={new Set((snapshot?.feedback ?? []).filter((f) => f.type === 'save' && f.workId).map((f) => f.workId as string))}
                  selectedLanguage={currentBrief?.id !== 'partial' ? responseLanguage : undefined}
                  onLanguageChange={currentBrief?.id !== 'partial' ? (lang) => { logEvent({ eventType: 'brief.language_switched', targetType: 'brief', targetId: currentBrief?.id, status: 'completed', payload: { from: responseLanguage, to: lang } }); setResponseLanguage(lang); setLanguageManuallySet(true); } : undefined}
                  activeFilters={filters}
                  originalFilters={currentRun?.filters ?? null}
                  setActiveFilters={setFilters}
                  candidatePool={currentRun ? (() => {
                    const inBrief = new Set((currentBrief?.sections.evidenceRows ?? []).map((r) => r.workId));
                    return (currentRun.candidateWorkIds || []).filter((id) => !inBrief.has(id));
                  })() : undefined}
                  onRegenerateBrief={handleRegenerateWithExtras}
                  onResolvePaper={handleResolvePaper}
                  isRegenerating={isRegenerating}
                  onGenerateJelPaper={(() => {
                    if (currentBrief?.id === 'partial') return undefined;
                    // Always lock if job exists and isn't done/error
                    if (activeJelJobId &&
                        jelPaperProgress?.status !== 'done' &&
                        jelPaperProgress?.status !== 'error') return undefined;
                    // Unlock if evidence changed since job was queued (fingerprint mismatch)
                    if (activeJelJobId && jelJobFingerprint &&
                        jelPaperProgress?.status !== 'done') {
                      const currentFp = (currentBrief?.sections.evidenceRows ?? [])
                        .map((r) => r.workId).sort().join(',');
                      if (currentFp === jelJobFingerprint) return undefined;
                    }
                    return handleGenerateJelPaper;
                  })()}
                  jelPaperStatus={(() => {
                    if (!activeJelJobId || !jelPaperProgress) return undefined;
                    if (jelPaperProgress.status === 'done') return 'done';
                    if (jelPaperProgress.status === 'error') return 'error';
                    return 'generating';
                  })()}
                  jelPaperProgress={jelPaperProgress?.status === 'running' || jelPaperProgress?.status === 'queued'
                    ? { done: jelPaperProgress.done, total: jelPaperProgress.total }
                    : undefined}
                  jelPaperErrorMessage={jelPaperProgress?.status === 'error' ? jelPaperProgress.errorMessage ?? 'Generation failed' : undefined}
                  onJelPaperDone={() => setTab('library')}
                  onWriteSurvey={(orderedWorkIds) => void handleWriteSurvey(orderedWorkIds)}
                  writeSurveyPending={seedingPaper}
                  // PR3: show table-focus layout while user is in Step 2
                  // picking persona/language (retrieval done, synthesis not yet
                  // started). Transitions to two-column once synthesis begins.
                  layoutMode={
                    pendingSynthesis && currentBrief?.id === 'partial'
                      ? 'table-focus'
                      : 'two-column'
                  }
                  activeChannels={searchChannels}
                />)}

                {/* ── Signals panel (off-corpus, off-evidence) ──
                    Only renders when at least one profile pill is on. */}
                {currentBrief && (signalProfiles.policy || signalProfiles.buzz) && (
                  <SignalsPanel
                    policy={signalsResult.policy}
                    buzz={signalsResult.buzz}
                    policyEnabled={signalProfiles.policy}
                    buzzEnabled={signalProfiles.buzz}
                    isLoading={signalsLoading}
                    error={signalsError}
                  />
                )}

                {/* ── Chat thread — appears AFTER the brief sections.
                    Single continuous conversation; suggested-question chips
                    above the docked input prefill it (no separate Q&A surface). ── */}
                {currentBrief && currentBrief.id !== 'partial' && searchStatus === 'idle' && chatMessages.length > 0 && (
                  <ChatPanel
                    messages={chatMessages}
                    isLoading={chatIsLoading}
                    streamingText={chatStreamingText}
                    error={chatError}
                    onDeleteMessage={(id) => void handleDeleteChatMessage(id)}
                    onRetryMessage={(id) => void handleRetryChatMessage(id)}
                    evidenceRows={currentBrief.sections?.evidenceRows ?? []}
                  />
                )}
              </div>
            )}

            {/* ── Bottom-docked chat input — sticky at the bottom of the viewport
                while a brief is loaded. The brief is a document; chat is a
                conversation about that document. Different shapes, different
                layouts. ── */}
            {tab === 'search' && currentBrief && currentBrief.id !== 'partial' && (
              <div
                data-print-hide
                className="fixed bottom-14 md:bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-[#f4f7fb] from-70% to-transparent px-4 sm:px-6 lg:px-10 pt-6 pb-4"
              >
                <div className="max-w-3xl mx-auto">
                  <FollowUpChatBar
                    prefill={followUpDraft}
                    isLoading={chatIsLoading}
                    onSubmit={handleFollowUpSubmit}
                  />
                </div>
              </div>
            )}

            {tab === 'library' && snapshot && (
              <LibraryPanel
                briefs={snapshot.briefs}
                onOpenBrief={(brief) => {
                  setCurrentBrief(brief);
                  setTab('search');
                }}
                jelPapers={(snapshot.jelPapers ?? []).filter((p) => p.status !== 'planning')}
                onOpenJelPaper={(paper) => setCurrentJelPaper(paper)}
                onRenameJelPaper={handleRenameJelPaper}
                onDeleteJelPaper={handleDeleteJelPaper}
              />
            )}

            {tab === 'follow' && (
              <FollowDigestPanel
                subscriptions={snapshot?.subscriptions ?? []}
                onCreateSubscription={handleCreateSubscription}
                onDeleteSubscription={async (id) => {
                  try {
                    await apiClient.deleteSubscription(id);
                    setSnapshot((prev) => prev
                      ? { ...prev, subscriptions: prev.subscriptions.filter((s) => s.id !== id) }
                      : prev);
                  } catch (err) {
                    console.error('Failed to delete subscription', err);
                  }
                }}
              />
            )}

            {tab === 'notes' && <WorkspaceNotes notes={notes} setNotes={setNotes} />}

            {tab === 'admin' && isAdmin && snapshot && (
              <Suspense fallback={<LazyFallback />}>
                <div className="space-y-6">
                  <RetrievalAuditPanel searchRuns={snapshot.searchRuns} />
                  <WeightPanel isAdmin={isAdmin} />
                </div>
              </Suspense>
            )}

            {tab === 'pilot-monitor' && isAdmin && (
              <Suspense fallback={<LazyFallback />}><PilotMonitor /></Suspense>
            )}

            {tab === 'grant-access' && isByokAdmin && (
              <Suspense fallback={<LazyFallback />}><GrantAccessPanel /></Suspense>
            )}
            </ErrorBoundary>
            </div>{/* end main content */}
          </div>{/* end flex row */}
        </main>
      </div>


      {/* JEL Paper full-screen overlay */}
      {currentJelPaper && (
        <Suspense fallback={<LazyFallback />}>
        <JelPaperView
          paper={currentJelPaper}
          onClose={() => setCurrentJelPaper(null)}
          onRefresh={() => void handleRefreshJelPaper(currentJelPaper.id)}
          onRevise={handleReviseJelPaper}
          onLoadEvidenceWorks={async () => {
            const full = await apiClient.getJelPaper(currentJelPaper.id);
            // Cache the enriched paper (with evidenceWorks) so a second export is instant.
            setCurrentJelPaper(full);
            return full.evidenceWorks ?? [];
          }}
        />
        </Suspense>
      )}
    </div>
  );
};

export default App;
