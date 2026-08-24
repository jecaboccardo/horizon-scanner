// components/search/SourcesQuestion.tsx
// Sources question — "Specific sources you care about?" — extracted from
// SearchIntentCard.tsx (~lines 751-772).
//
// SourcePicker and DefaultSourceSummary have been MOVED here from
// SearchIntentCard.tsx.  SearchIntentCard.tsx now imports them from this file.
import React, { useState } from 'react';
import type { SearchFilters } from '../../types';
import {
  PUBLICATION_TYPE_GROUPS,
  documentTypeGroupsToPublicationTypes,
  publicationTypesToDocumentTypeGroups,
} from '../../types';
import { getJournalsInTier } from '../../services/journalTiers';

export interface SourcesQuestionProps {
  sourceMode: 'default' | 'custom';
  setSourceMode: (m: 'default' | 'custom') => void;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
}

// ── Source data ───────────────────────────────────────────────────────────────

interface PolicySource {
  id: string;
  label: string;
  detail: string;
  instId: string;
  wpId: string | null;
}

const POLICY_SOURCES: PolicySource[] = [
  { id: 'IADB',  label: 'IADB',        detail: 'IDB reports, books, technical notes, policy papers.',                   instId: 'IADB',  wpId: null },
  { id: 'WB',    label: 'World Bank',  detail: 'World Bank reports and Policy Research Working Papers.',                instId: 'WB',    wpId: null },
  { id: 'IMF',   label: 'IMF',         detail: 'IMF working papers and research output.',                               instId: 'IMF',   wpId: null },
  { id: 'OECD',  label: 'OECD',        detail: 'OECD reports and working paper series.',                                instId: 'OECD',  wpId: null },
  { id: 'OTHER', label: 'CEPAL / UN',  detail: 'Screened institutional publications from CEPAL and UN agencies.',       instId: 'OTHER', wpId: null },
  { id: 'CGD',   label: 'CGD',         detail: 'Center for Global Development working papers (add-on, not default).',    instId: 'CGD',   wpId: null },
  { id: 'JPAL',  label: 'J-PAL',       detail: 'Abdul Latif Jameel Poverty Action Lab papers (add-on, not default).',    instId: 'JPAL',  wpId: null },
  { id: 'IPA',   label: 'IPA',         detail: 'Innovations for Poverty Action papers (add-on, not default).',           instId: 'IPA',   wpId: null },
];

const WORKING_PAPER_SOURCES = [
  { id: 'NBER',       label: 'NBER',          detail: 'National Bureau of Economic Research working papers.' },
  { id: 'IZA',        label: 'IZA',           detail: 'Labor and development economics discussion papers.' },
  { id: 'CEPR_REPEC', label: 'CEPR / RePEcc', detail: 'Discussion papers indexed through CEPR and RePEcc.' },
  { id: 'SSRN',       label: 'SSRN',          detail: 'Preprints and working papers across disciplines.' },
];

const TOP_TIERS  = [1, 2, 3];
const WIDE_TIERS = [4, 5];

const JOURNAL_TIER_DETAILS = [
  {
    label: 'ABS 4★ — World elite journals',
    examples: ['American Economic Review', 'Econometrica', 'Journal of Political Economy'],
    tiers: [1],
  },
  {
    label: 'ABS 4 — Top field journals',
    examples: ['Journal of Development Economics', 'Journal of Public Economics', 'Journal of Human Resources'],
    tiers: [2],
  },
  {
    label: 'ABS 3 — Strong mainstream journals',
    examples: ['World Development', 'The World Bank Economic Review', 'Health Economics'],
    tiers: [3],
  },
];

const WIDE_TIER_DETAILS = [
  {
    label: 'ABS 1–2 + LAC/development journals',
    examples: ['CEPAL Review', 'Economía (LACEA)', 'Latin American Research Review', 'Latin American Economic Review'],
    tiers: [4],
  },
  {
    label: 'Unranked but vetted venues',
    examples: ['Screened regional and field-specific journals without an ABS rating'],
    tiers: [5],
  },
];

// These must match App.tsx defaultFilters exactly.
// Default = ABS 3+ (tiers 1–3). Tier 4 (ABS 1–2 + LAC/dev journals) is opt-in.
export const DEFAULT_JOURNAL_TIERS = [1, 2, 3];
export const DEFAULT_INST_SOURCES  = ['IADB', 'WB', 'IMF', 'OECD'];
export const DEFAULT_WP_SOURCES    = ['NBER', 'IZA', 'CEPR_REPEC', 'SSRN'];

// ── SourcePicker ─────────────────────────────────────────────────────────────

export interface SourcePickerProps {
  filters: SearchFilters;
  onApply: (patch: Partial<SearchFilters>) => void;
  onClose: () => void;
}

export function SourcePicker({ filters, onApply, onClose }: SourcePickerProps) {
  const [tiers, setTiers] = useState<number[]>(filters.journalTiers          ?? DEFAULT_JOURNAL_TIERS);
  const [inst,  setInst]  = useState<string[]>(filters.institutionalSources  ?? DEFAULT_INST_SOURCES);
  const [wp,    setWp]    = useState<string[]>(filters.workingPaperSources    ?? DEFAULT_WP_SOURCES);
  const [docTypeGroups, setDocTypeGroups] = useState<string[]>(
    publicationTypesToDocumentTypeGroups(filters.publicationTypes),
  );
  const [journalExpanded, setJournalExpanded] = useState(false);
  const [wideExpanded,    setWideExpanded]    = useState(false);
  const [includeUnranked, setIncludeUnranked] = useState<boolean>(filters.includeUnranked ?? false);
  // Which ABS tier's full journal list is expanded inside the picker ("see all").
  const [expandedTier,    setExpandedTier]    = useState<number | null>(null);

  const hasTopJournals  = TOP_TIERS.some(t  => tiers.includes(t));
  const hasWideJournals = WIDE_TIERS.some(t => tiers.includes(t));
  const hasPolicy       = inst.length > 0;
  const hasWp           = wp.filter(id => WORKING_PAPER_SOURCES.map(s => s.id).includes(id)).length > 0;

  function isPolicyOn(src: PolicySource) {
    return inst.includes(src.instId);
  }

  function togglePolicy(src: PolicySource) {
    const on = isPolicyOn(src);
    setInst(on ? inst.filter(x => x !== src.instId) : [...inst, src.instId]);
  }

  function toggleTopJournals() {
    if (hasTopJournals) setTiers(tiers.filter(t => !TOP_TIERS.includes(t)));
    else setTiers([...new Set([...tiers, ...TOP_TIERS])]);
  }

  function toggleWideJournals() {
    if (hasWideJournals) setTiers(tiers.filter(t => !WIDE_TIERS.includes(t)));
    else setTiers([...new Set([...tiers, ...WIDE_TIERS])]);
  }

  function toggleWpGroup() {
    const academicWps = WORKING_PAPER_SOURCES.map(s => s.id);
    const hasAny = academicWps.some(id => wp.includes(id));
    if (hasAny) setWp(wp.filter(id => !academicWps.includes(id)));
    else setWp([...new Set([...wp, ...DEFAULT_WP_SOURCES])]);
  }

  function toggleWp(id: string) {
    setWp(wp.includes(id) ? wp.filter(x => x !== id) : [...wp, id]);
  }

  function toggleDocType(id: string) {
    setDocTypeGroups(docTypeGroups.includes(id) ? docTypeGroups.filter(x => x !== id) : [...docTypeGroups, id]);
  }

  function handleApply() {
    onApply({
      journalTiers: tiers,
      institutionalSources: inst,
      workingPaperSources: wp,
      publicationTypes: documentTypeGroupsToPublicationTypes(docTypeGroups),
      includeUnranked,
    });
    onClose();
  }

  const groupRow = (_on: boolean) =>
    `flex items-start gap-3 px-3 py-2.5 w-full text-left transition`;

  const groupWrap = (on: boolean) =>
    `rounded-lg border-2 transition overflow-hidden ${on ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'}`;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50">
        <span className="text-xs font-semibold text-slate-700">Search in</span>
        <button type="button" onClick={onClose} className="text-[11px] text-slate-400 hover:text-slate-700 transition">✕ Close</button>
      </div>

      <div className="p-3 space-y-2">

        {/* ── Document type ── */}
        <div className="rounded-lg border-2 border-slate-200 bg-white overflow-hidden">
          <div className="flex items-start gap-3 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-[12px] leading-tight text-slate-700">Document type</div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                {docTypeGroups.length === 0
                  ? 'All document types (no filter).'
                  : 'Limit to the selected document types.'}
              </div>
            </div>
            <span className="text-[9px] text-slate-400 shrink-0 mt-0.5">publication type</span>
          </div>
          <div className="px-3 pb-2.5 pt-0 border-t border-slate-100 space-y-1.5">
            {PUBLICATION_TYPE_GROUPS.map(grp => (
              <label key={grp.id} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={docTypeGroups.includes(grp.id)}
                  onChange={() => toggleDocType(grp.id)}
                  className="mt-0.5 h-3 w-3 rounded accent-teal-600 shrink-0"
                />
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold text-slate-700">{grp.label}</span>
                  <span className="text-[10px] text-slate-400 ml-1.5">{grp.detail}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* ── Top journals ── */}
        <div className={groupWrap(hasTopJournals)}>
          <button type="button" className={groupRow(hasTopJournals)} onClick={toggleTopJournals}>
            <input type="checkbox" readOnly checked={hasTopJournals} className="mt-0.5 h-3.5 w-3.5 rounded accent-teal-600 shrink-0 pointer-events-none" />
            <div className="flex-1 min-w-0">
              <div className={`font-semibold text-[12px] leading-tight ${hasTopJournals ? 'text-teal-800' : 'text-slate-700'}`}>
                ABS 3+ journals <span className="font-normal text-[10px] text-slate-400 ml-1">(default)</span>
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                ABS 4★, ABS 4, and ABS 3 — the three highest tiers.
                {hasTopJournals && <span className="ml-1 text-slate-400">e.g. {JOURNAL_TIER_DETAILS[0].examples[0]}, {JOURNAL_TIER_DETAILS[1].examples[0]}, {JOURNAL_TIER_DETAILS[2].examples[0]}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[9px] text-slate-400">journals</span>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setJournalExpanded(v => !v); }}
                className="text-[10px] text-teal-600 hover:text-teal-800 font-semibold transition"
                title="See categories"
              >
                {journalExpanded ? '▲' : '▼'}
              </button>
            </div>
          </button>
          {journalExpanded && (
            <div className="px-3 pb-3 pt-1 border-t border-teal-100 space-y-1.5">
              {JOURNAL_TIER_DETAILS.map(detail => {
                const tierNum = detail.tiers[0];
                const journals = getJournalsInTier(tierNum as 1 | 2 | 3 | 4 | 5);
                const open = expandedTier === tierNum;
                return (
                  <div key={detail.label} className="rounded border border-slate-200 bg-white overflow-hidden">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setExpandedTier(open ? null : tierNum); }}
                      className="flex items-center justify-between w-full px-2 py-1.5 text-left hover:bg-slate-50 transition"
                    >
                      <div className="min-w-0">
                        <span className="text-[10px] font-semibold text-slate-700">{detail.label}</span>
                        <span className="text-[9px] text-slate-400 ml-1.5">{journals.length} journals</span>
                      </div>
                      <span className="text-[9px] text-teal-600 shrink-0 ml-2">{open ? '▲ hide' : '▼ see all'}</span>
                    </button>
                    {open && (
                      <div className="px-2 pb-2 border-t border-slate-100">
                        <div className="mt-1.5 columns-2 gap-2">
                          {journals.map(j => (
                            <div key={j} className="text-[9px] text-slate-500 leading-snug break-inside-avoid py-0.5 border-b border-slate-50">
                              {j}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="text-[9px] text-slate-400 pt-1 border-t border-slate-100 leading-snug">
                Ratings from the{' '}
                <a href="https://charteredabs.org/academic-journal-guide" target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline">ABS Academic Journal Guide ↗</a>.
                ABS 1–2 and LAC/development journals available as an add-on below; journals with no ABS rating can be included with the toggle at the bottom.
              </div>
            </div>
          )}
        </div>

        {/* ── Policy institutions ── */}
        <div className={groupWrap(hasPolicy)}>
          <button type="button" className={groupRow(hasPolicy)} onClick={() => {
            if (hasPolicy) setInst([]);
            else setInst(DEFAULT_INST_SOURCES);
          }}>
            <input type="checkbox" readOnly checked={hasPolicy} className="mt-0.5 h-3.5 w-3.5 rounded accent-teal-600 shrink-0 pointer-events-none" />
            <div className="flex-1 min-w-0">
              <div className={`font-semibold text-[12px] leading-tight ${hasPolicy ? 'text-teal-800' : 'text-slate-700'}`}>Policy institutions</div>
              <div className="text-[10px] text-slate-500 mt-0.5">IADB, World Bank, IMF and OECD by default. CEPAL/UN, CGD, J-PAL and IPA available as add-ons below.</div>
            </div>
            <span className="text-[9px] text-slate-400 shrink-0 mt-0.5">sources</span>
          </button>
          <div className="px-3 pb-2.5 pt-0 border-t border-teal-100 space-y-1.5">
            {POLICY_SOURCES.map(src => (
              <label key={src.id} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isPolicyOn(src)}
                  onChange={() => togglePolicy(src)}
                  className="mt-0.5 h-3 w-3 rounded accent-teal-600 shrink-0"
                />
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold text-slate-700">{src.label}</span>
                  <span className="text-[10px] text-slate-400 ml-1.5">{src.detail}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* ── Working and discussion papers ── */}
        <div className={groupWrap(hasWp)}>
          <button type="button" className={groupRow(hasWp)} onClick={toggleWpGroup}>
            <input type="checkbox" readOnly checked={hasWp} className="mt-0.5 h-3.5 w-3.5 rounded accent-teal-600 shrink-0 pointer-events-none" />
            <div className="flex-1 min-w-0">
              <div className={`font-semibold text-[12px] leading-tight ${hasWp ? 'text-teal-800' : 'text-slate-700'}`}>Working and discussion papers</div>
              <div className="text-[10px] text-slate-500 mt-0.5">NBER, IZA, CEPR/RePEc and SSRN all included by default; uncheck any you don't want.</div>
            </div>
            <span className="text-[9px] text-slate-400 shrink-0 mt-0.5">sources</span>
          </button>
          <div className="px-3 pb-2.5 pt-0 border-t border-teal-100 space-y-1.5">
            {WORKING_PAPER_SOURCES.map(src => (
              <label key={src.id} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wp.includes(src.id)}
                  onChange={() => toggleWp(src.id)}
                  className="mt-0.5 h-3 w-3 rounded accent-teal-600 shrink-0"
                />
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold text-slate-700">{src.label}</span>
                  <span className="text-[10px] text-slate-400 ml-1.5">{src.detail}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* ── Wider screened journals ── */}
        <div className={groupWrap(hasWideJournals)}>
          <button type="button" className={groupRow(hasWideJournals)} onClick={toggleWideJournals}>
            <input type="checkbox" readOnly checked={hasWideJournals} className="mt-0.5 h-3.5 w-3.5 rounded accent-teal-600 shrink-0 pointer-events-none" />
            <div className="flex-1 min-w-0">
              <div className={`font-semibold text-[12px] leading-tight ${hasWideJournals ? 'text-teal-800' : 'text-slate-700'}`}>ABS 1–2 + LAC/development journals</div>
              <div className="text-[10px] text-slate-500 mt-0.5">CEPAL Review, Economía (LACEA), Latin American Research Review, and other regional/specialist journals below ABS 3.</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[9px] text-slate-400">journals</span>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setWideExpanded(v => !v); }}
                className="text-[10px] text-teal-600 hover:text-teal-800 font-semibold transition"
              >
                {wideExpanded ? '▲' : '▼'}
              </button>
            </div>
          </button>
          {wideExpanded && (
            <div className="px-3 pb-3 pt-1 border-t border-teal-100 space-y-1.5">
              {WIDE_TIER_DETAILS.map(detail => {
                const tierNum = detail.tiers[0];
                const journals = getJournalsInTier(tierNum as 1 | 2 | 3 | 4 | 5);
                const open = expandedTier === tierNum;
                // Tier 5 ("unranked but vetted") has no fixed list — it's "any other
                // indexed venue", so show the descriptive example instead of a list.
                if (journals.length === 0) {
                  return (
                    <div key={detail.label} className="rounded border border-slate-200 bg-white px-2 py-1.5">
                      <div className="text-[10px] font-semibold text-slate-700">{detail.label}</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">{detail.examples.join(' · ')}</div>
                    </div>
                  );
                }
                return (
                  <div key={detail.label} className="rounded border border-slate-200 bg-white overflow-hidden">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setExpandedTier(open ? null : tierNum); }}
                      className="flex items-center justify-between w-full px-2 py-1.5 text-left hover:bg-slate-50 transition"
                    >
                      <div className="min-w-0">
                        <span className="text-[10px] font-semibold text-slate-700">{detail.label}</span>
                        <span className="text-[9px] text-slate-400 ml-1.5">{journals.length} journals</span>
                      </div>
                      <span className="text-[9px] text-teal-600 shrink-0 ml-2">{open ? '▲ hide' : '▼ see all'}</span>
                    </button>
                    {open && (
                      <div className="px-2 pb-2 border-t border-slate-100">
                        <div className="mt-1.5 columns-2 gap-2">
                          {journals.map(j => (
                            <div key={j} className="text-[9px] text-slate-500 leading-snug break-inside-avoid py-0.5 border-b border-slate-50">
                              {j}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="text-[9px] text-slate-400 pt-1 border-t border-slate-100 leading-snug">
                ABS 1–2 + LAC/development journals are in the default scan and are particularly relevant for IADB policy work.
              </div>
            </div>
          )}
        </div>

        {/* ── Include journals with no ABS ranking ── */}
        <label className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border-2 cursor-pointer transition ${includeUnranked ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
          <input
            type="checkbox"
            checked={includeUnranked}
            onChange={() => setIncludeUnranked(v => !v)}
            className="mt-0.5 h-3.5 w-3.5 rounded accent-teal-600 shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className={`font-semibold text-[12px] leading-tight ${includeUnranked ? 'text-teal-800' : 'text-slate-700'}`}>
              Include journals with no ABS ranking
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              Off by default. When on, relevant journal articles published in venues that aren&apos;t on the ABS list
              (regional, specialist, or newly indexed) are also searched — ranked by relevance, not dropped for lacking a tier.
            </div>
          </div>
          <span className="text-[9px] text-slate-400 shrink-0 mt-0.5">unranked</span>
        </label>

      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50">
        <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-xs font-semibold border border-slate-200 bg-white text-slate-600 hover:border-slate-300 transition">
          Cancel
        </button>
        <button type="button" onClick={handleApply} className="rounded-full px-4 py-1 text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 transition">
          Apply
        </button>
      </div>
    </div>
  );
}

// ── DefaultSourceSummary ──────────────────────────────────────────────────────

const TIER_INFO = [
  { tier: 1 as const, label: 'ABS 4★ — World elite journals',       count: 5,  desc: 'AER, QJE, Econometrica, JPE, Review of Economic Studies.' },
  { tier: 2 as const, label: 'ABS 4 — Leading field journals',      count: 42, desc: 'JDE, JPublicEcon, JHR, JHE, JLE, JIE, Economic History Review…' },
  { tier: 3 as const, label: 'ABS 3 — Strong mainstream journals',  count: 58, desc: 'World Development, WBER, Health Economics, Labour Econ, IMF Economic Review…' },
  { tier: 4 as const, label: 'ABS 1–2 + LAC/development journals',  count: 26, desc: 'CEPAL Review, Economía (LACEA), Latin American Research Review.' },
];

export function DefaultSourceSummary({ filters }: { filters: SearchFilters }) {
  const [expanded,     setExpanded]     = useState(false);
  const [expandedTier, setExpandedTier] = useState<number | null>(null);

  const tiers = filters.journalTiers         ?? DEFAULT_JOURNAL_TIERS;
  const inst  = filters.institutionalSources ?? DEFAULT_INST_SOURCES;
  const wp    = filters.workingPaperSources  ?? DEFAULT_WP_SOURCES;

  const activePolicySources = POLICY_SOURCES.filter(s => inst.includes(s.instId));
  const academicWps         = WORKING_PAPER_SOURCES.filter(s => wp.includes(s.id)).map(s => s.label);
  const hasTop  = TOP_TIERS.some(t => tiers.includes(t));
  const hasWide = WIDE_TIERS.some(t => tiers.includes(t));

  const abbrev = (j: string) => j
    .replace('American Economic Review', 'AER')
    .replace('Journal of Labor Economics', 'JLE')
    .replace('Journal of Development Economics', 'J. Dev. Econ.')
    .replace('Review of Economic Studies', 'RestUD')
    .replace('Journal of Political Economy', 'JPE');

  const hasIADB = inst.includes('IADB');
  const otherPolicySources = activePolicySources.filter(s => s.instId !== 'IADB');

  let primaryPhrase = '';
  if (hasTop) {
    const topExamples = JOURNAL_TIER_DETAILS
      .filter(t => t.tiers.some(tier => tiers.includes(tier)))
      .map(t => t.examples[0])
      .slice(0, 3);
    const exStr = topExamples.length ? ` (e.g. ${topExamples.map(abbrev).join(', ')})` : '';
    primaryPhrase = hasIADB
      ? `IADB papers + Top journals${exStr}`
      : `Top journals${exStr}`;
  } else if (hasIADB) {
    primaryPhrase = 'IADB papers';
  }

  const extraParts: string[] = [];
  if (hasWide) extraParts.push('Wider screened journals');
  if (filters.includeUnranked) extraParts.push('+ unranked journals');
  otherPolicySources.forEach(s => extraParts.push(s.label));
  if (academicWps.length) extraParts.push(academicWps.join(', '));
  const docTypeGroupLabels = publicationTypesToDocumentTypeGroups(filters.publicationTypes)
    .map(id => PUBLICATION_TYPE_GROUPS.find(g => g.id === id)?.label)
    .filter((l): l is string => !!l);
  if (docTypeGroupLabels.length) extraParts.push(`Type: ${docTypeGroupLabels.join(', ')}`);

  const summaryText = [primaryPhrase, ...extraParts].filter(Boolean).join(', ') || 'All sources';

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-slate-600 leading-snug font-medium">
          {summaryText}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="text-[10px] text-teal-600 hover:text-teal-800 font-semibold shrink-0 transition whitespace-nowrap"
        >
          {expanded ? '▲ Hide' : '▼ Details'}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-slate-200 space-y-2">

          {hasTop && (
            <div>
              <div className="flex items-baseline gap-1.5 mb-1">
                <span className="text-[10px] font-semibold text-slate-700">Top journals</span>
                <a
                  href="https://charteredabs.org/academic-journal-guide"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[9px] text-teal-600 hover:text-teal-800 hover:underline transition"
                  onClick={e => e.stopPropagation()}
                >
                  ABS ranking ↗
                </a>
              </div>
              <div className="space-y-1">
                {TIER_INFO.filter(t => tiers.includes(t.tier)).map(t => {
                  const journals = getJournalsInTier(t.tier);
                  const open = expandedTier === t.tier;
                  return (
                    <div key={t.tier} className="rounded border border-slate-200 bg-white overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setExpandedTier(open ? null : t.tier)}
                        className="flex items-center justify-between w-full px-2 py-1.5 text-left hover:bg-slate-50 transition"
                      >
                        <div>
                          <span className="text-[10px] font-semibold text-slate-700">{t.label}</span>
                          <span className="text-[9px] text-slate-400 ml-1.5">{t.count} journals · {t.desc}</span>
                        </div>
                        <span className="text-[9px] text-teal-600 shrink-0 ml-2">{open ? '▲' : '▼ see all'}</span>
                      </button>
                      {open && (
                        <div className="px-2 pb-2 border-t border-slate-100">
                          <div className="mt-1.5 columns-2 gap-2">
                            {journals.map(j => (
                              <div key={j} className="text-[9px] text-slate-500 leading-snug break-inside-avoid py-0.5 border-b border-slate-50">
                                {j}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {hasWide && (
            <div>
              <span className="text-[10px] font-semibold text-slate-700">Wider screened journals</span>
              <span className="text-[10px] text-slate-500 ml-1">— ABS 1–2 and vetted unranked venues</span>
            </div>
          )}

          {activePolicySources.map(src => (
            <div key={src.id} className="text-[10px] text-slate-500">
              <span className="font-semibold text-slate-600">{src.label}</span>
              <span className="ml-1">— {src.detail}</span>
            </div>
          ))}

          {academicWps.length > 0 && (
            <div className="text-[10px] text-slate-500">
              <span className="font-semibold text-slate-600">Working papers</span>
              <span className="ml-1">— {academicWps.join(', ')}</span>
            </div>
          )}

          <div className="text-[9px] text-slate-400 pt-1 border-t border-slate-200 leading-snug">
            Journal categories follow the{' '}
            <a href="https://charteredabs.org/academic-journal-guide" target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline">
              ABS Academic Journal Guide
            </a>
            . Tiers shown reflect Horizon Scanner's Economics + Public Policy scope.
          </div>
        </div>
      )}
    </div>
  );
}

// ── SourcesQuestion ───────────────────────────────────────────────────────────

export function SourcesQuestion({
  sourceMode,
  setSourceMode,
  filters,
  setFilters,
}: SourcesQuestionProps) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-700 mb-2">
        Specific sources you care about?
      </p>
      <div className="flex items-center gap-2 mb-2">
        {(['default', 'custom'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setSourceMode(mode)}
            className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${
              sourceMode === mode
                ? 'border-teal-600 bg-teal-100 text-teal-800'
                : 'border-slate-200 bg-white text-slate-600 hover:border-teal-300'
            }`}
          >
            {mode === 'default' ? 'No — use defaults' : 'Yes — let me choose'}
          </button>
        ))}
      </div>
      {sourceMode === 'default' ? (
        <DefaultSourceSummary filters={filters} />
      ) : (
        <SourcePicker
          filters={filters}
          onApply={(patch) => setFilters(f => ({ ...f, ...patch }))}
          onClose={() => setSourceMode('default')}
        />
      )}
    </div>
  );
}
