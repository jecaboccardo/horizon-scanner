// components/SearchClarifier.tsx
//
// Post-submit conversational clarifier (2026-06-11).
// Shown AFTER the user submits their query — the query appears as a sent bubble,
// then Horizon asks the 6 questions one at a time with animated typing indicators.
// Search fires only after all questions are answered.
//
//   step 0 → EvidenceTypeQuestion    (channels: causal / foundational)
//   step 1 → RegionQuestion          (channels: lac / filters.regions)
//   step 2 → RecencyQuestion         (channels: recent)
//   step 3 → SourcesQuestion         (sourceMode + source filters)
//   step 4 → PopulationQuestion      (filters.populationFocus)
//   step 5 → Confirmation            (pills + "Search →")
// (BreadthQuestion / evidenceScope DROPPED 2026-06-17 — the direct/indirect
//  classifier was removed; the cosine relevance floor decides table size now.)
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SearchFilters } from '../types';
import { normalizePopulationFocus } from '../types';
import { detectQueryIntent } from '../utils/queryIntent';
import { selectionToPills } from '../utils/selectionToPills';
import {
  PopulationQuestion,
  EvidenceTypeQuestion,
  RegionQuestion,
  RecencyQuestion,
  SourcesQuestion,
} from './search';
import type { RecencyChoice } from './search/RecencyQuestion';

export interface SearchClarifierProps {
  query: string;
  channels: Set<string>;
  setChannels: (c: Set<string>) => void;
  sourceMode: 'default' | 'custom';
  setSourceMode: (m: 'default' | 'custom') => void;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
  onSubmit: () => void;
}

const TOTAL_STEPS = 5;
const TYPING_DELAY = 850;
const NEXT_TYPING_DELAY = 650;

export default function SearchClarifier({
  query,
  channels,
  setChannels,
  sourceMode,
  setSourceMode,
  filters,
  setFilters,
  onSubmit,
}: SearchClarifierProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isTyping, setIsTyping] = useState(true);
  const [questionVisible, setQuestionVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  function setChannelPresence(id: string, on: boolean) {
    if (channels.has(id) === on) return;
    const next = new Set(channels);
    if (on) next.add(id); else next.delete(id);
    setChannels(next);
  }

  const queryIntent = useMemo(() => detectQueryIntent(query), [query]);

  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === query) return;
    seededFor.current = query;
    // LAC is a REGION FILTER now (2026-06-12), not the `lac` channel.
    if (queryIntent.mentionsLac) {
      setFilters((f) => (f.regions ?? []).includes('LAC') ? f : { ...f, regions: [...(f.regions ?? []), 'LAC'] });
    }
    if (queryIntent.mentionsRecency) setChannelPresence('recent', true);
    const detectedPop = queryIntent.populations.map((p) => p.label);
    if (detectedPop.length > 0 && normalizePopulationFocus(filters.populationFocus).length === 0) {
      setFilters((f) => ({ ...f, populationFocus: detectedPop }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, queryIntent]);

  const detectedPopLabels = useMemo(
    () => queryIntent.populations.map((p) => p.label),
    [queryIntent],
  );

  const pills = useMemo(() => selectionToPills(filters, channels), [filters, channels]);

  // Show typing indicator, then reveal question after delay
  const startTyping = useCallback((delay = TYPING_DELAY) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsTyping(true);
    setQuestionVisible(false);
    timerRef.current = setTimeout(() => {
      setIsTyping(false);
      setQuestionVisible(true);
    }, delay);
  }, []);

  // On mount: typing indicator → Q0
  useEffect(() => {
    startTyping();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to bottom as conversation grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [currentStep, isTyping, questionVisible]);

  function handleNext() {
    setCurrentStep((s) => s + 1);
    startTyping(NEXT_TYPING_DELAY);
  }

  function handleStartOver() {
    setCurrentStep(0);
    startTyping();
  }

  // ── Opening message ────────────────────────────────────────────────────────
  function buildOpeningMessage(): string {
    const detected: string[] = [];
    if (queryIntent.mentionsLac && queryIntent.lacMatch) {
      detected.push('Latin America & Caribbean');
    }
    if (queryIntent.populations.length > 0) {
      detected.push(queryIntent.populations.map((p) => p.label.toLowerCase()).join(', '));
    }
    if (queryIntent.mentionsRecency) {
      detected.push('recent evidence (2020+)');
    }
    if (detected.length > 0) {
      return `I can see you're focused on ${detected.join(' · ')}. Quick questions before I run this.`;
    }
    return 'Before I search — a few quick questions.';
  }

  // ── Detection-aware question headers ──────────────────────────────────────
  function questionHeader(step: number): string {
    switch (step) {
      case 0:
        return 'What type of evidence matters most for your question?';
      case 1:
        if (queryIntent.mentionsLac && queryIntent.lacMatch) {
          const label = queryIntent.lacMatch.toLowerCase() === 'lac'
            ? 'Latin America & Caribbean'
            : queryIntent.lacMatch;
          return `Your query mentions ${label} — confirming your region focus?`;
        }
        return 'Is this question specific to a region?';
      case 2:
        if (queryIntent.mentionsRecency) {
          return 'Your query signals recency — confirming you want the latest evidence (2020+)?';
        }
        return 'How recent should the evidence be?';
      case 3:
        return 'Any specific source preferences?';
      case 4:
        if (queryIntent.populations.length > 0) {
          const names = queryIntent.populations.map((p) => p.label).join(', ');
          return `Your query mentions ${names} — confirming the population focus?`;
        }
        return 'Who is the target population?';
      default:
        return '';
    }
  }

  function isConfirmStep(step: number): boolean {
    if (step === 1) return queryIntent.mentionsLac;
    if (step === 2) return queryIntent.mentionsRecency;
    if (step === 4) return queryIntent.populations.length > 0;
    return false;
  }

  // ── Collapsed answer summary ───────────────────────────────────────────────
  function answerSummary(step: number): string {
    switch (step) {
      case 0: {
        const active = ['causal', 'foundational'].filter((c) => channels.has(c));
        if (active.length === 0) return 'No specific type';
        return active.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(' + ');
      }
      case 1: {
        const regs = filters.regions ?? [];
        if (regs.length === 0) return 'No preference';
        return regs.map((r) => r === 'LAC' ? 'Latin America & Caribbean' : r.replace(/_/g, ' ')).join(', ');
      }
      case 2:
        if (filters.timePeriod === 'recent' || channels.has('recent')) return 'Recent frontier (2020+)';
        if (filters.timePeriod === '2000+') return 'From 2000 onwards';
        return 'All years (1961+)';
      case 3:
        return sourceMode === 'custom' ? 'Custom sources' : 'Default sources';
      case 4: {
        const pop = normalizePopulationFocus(filters.populationFocus);
        return pop.length > 0 ? pop.join(', ') : 'No specific focus';
      }
      default:
        return '';
    }
  }

  // ── Question forms ─────────────────────────────────────────────────────────
  function renderQuestion(step: number) {
    switch (step) {
      case 0:
        return (
          <EvidenceTypeQuestion
            channels={channels}
            setChannel={(id, on) => setChannelPresence(id, on)}
          />
        );
      case 1:
        return (
          <RegionQuestion
            regions={filters.regions ?? []}
            setRegions={(r) => setFilters((f) => ({ ...f, regions: r }))}
          />
        );
      case 2: {
        const recencyChoice: RecencyChoice =
          filters.timePeriod === 'recent' || channels.has('recent') ? 'recent' :
          filters.timePeriod === '2000+' ? '2000plus' :
          'all';
        return (
          <RecencyQuestion
            choice={recencyChoice}
            onChange={(c) => {
              // Recency is a HARD year filter (2026-06-17): 'recent' → timePeriod
              // 'recent' (backend floors year>=2020), not just the soft channel.
              setChannelPresence('recent', c === 'recent');
              setFilters((f) => ({
                ...f,
                timePeriod: c === '2000plus' ? '2000+' : c === 'recent' ? 'recent' : 'all',
                startDate: '',
              }));
            }}
          />
        );
      }
      case 3:
        return (
          <SourcesQuestion
            sourceMode={sourceMode}
            setSourceMode={setSourceMode}
            filters={filters}
            setFilters={setFilters}
          />
        );
      case 4:
        return (
          <PopulationQuestion
            // Pass the RAW value (string→array, NO trim) — normalizePopulationFocus
            // .trim()s every element, and running it on a controlled input's value
            // strips the trailing space on each keystroke, so you can never type a
            // space between words. Trimming/dedup still happens where it's used
            // (pills, submit, server). See normalizePopulationFocus in types.ts.
            value={Array.isArray(filters.populationFocus)
              ? filters.populationFocus
              : filters.populationFocus ? [filters.populationFocus] : []}
            onChange={(v) => setFilters((f) => ({ ...f, populationFocus: v }))}
            detected={detectedPopLabels}
          />
        );
      default:
        return null;
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-0 pb-2">

      {/* User's submitted query */}
      <UserBubble>{query}</UserBubble>

      {/* Opening assistant message — instant, no typing indicator */}
      <AssistantBubble isOpening>
        <p className="text-[13px] text-slate-700 leading-snug">{buildOpeningMessage()}</p>
      </AssistantBubble>

      {/* Answered steps — question header + user answer bubble */}
      {Array.from({ length: currentStep }, (_, i) => (
        <React.Fragment key={i}>
          <AssistantBubble>
            <p className="text-[12px] font-semibold text-slate-500 leading-snug">{questionHeader(i)}</p>
          </AssistantBubble>
          <UserBubble>{answerSummary(i)}</UserBubble>
        </React.Fragment>
      ))}

      {/* Animated: typing indicator → question form */}
      {isTyping ? (
        <TypingIndicator />
      ) : questionVisible && currentStep < TOTAL_STEPS ? (
        <AssistantBubble>
          <p className="text-[13px] font-semibold text-slate-700 mb-3 leading-snug">
            {questionHeader(currentStep)}
          </p>
          <div className="mb-3">{renderQuestion(currentStep)}</div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleNext}
              className="rounded-full bg-teal-600 px-5 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 transition"
            >
              {isConfirmStep(currentStep) ? 'Confirm →' : 'Next →'}
            </button>
          </div>
        </AssistantBubble>
      ) : questionVisible && currentStep >= TOTAL_STEPS ? (
        <AssistantBubble>
          {/* Query summary */}
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Your question</p>
          <p className="text-[13px] text-slate-700 leading-snug mb-3">{query}</p>

          {/* Choices summary pills */}
          {pills.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {pills.map((p, i) => (
                <span
                  key={`${p.source}-${p.label}-${i}`}
                  className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2.5 py-0.5 text-[11px] font-semibold text-teal-800"
                >
                  {p.label}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleStartOver}
              className="text-[11px] font-semibold text-slate-400 hover:text-teal-700 transition"
            >
              ← Start over
            </button>
            <button
              type="button"
              onClick={() => onSubmit()}
              className="rounded-full bg-teal-600 px-6 py-2 text-sm font-semibold text-white hover:bg-teal-700 transition shadow-sm"
            >
              Search →
            </button>
          </div>
        </AssistantBubble>
      ) : null}

      <div ref={bottomRef} />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2 mt-3">
      <div className="shrink-0 mt-0.5 h-6 w-6 rounded-full bg-gradient-to-br from-teal-500 to-teal-700 flex items-center justify-center">
        <span className="text-[10px] text-white font-bold">H</span>
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-white border border-slate-200 shadow-sm px-4 py-3 h-10">
        <span className="inline-block w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
        <span className="inline-block w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
        <span className="inline-block w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function AssistantBubble({
  children,
  isOpening = false,
}: {
  children: React.ReactNode;
  isOpening?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 mt-3">
      <div className="shrink-0 mt-0.5 h-6 w-6 rounded-full bg-gradient-to-br from-teal-500 to-teal-700 flex items-center justify-center">
        <span className="text-[10px] text-white font-bold">H</span>
      </div>
      <div
        className={`flex-1 rounded-2xl rounded-tl-sm px-4 py-3 text-sm ${
          isOpening
            ? 'bg-slate-50 border border-slate-100'
            : 'bg-white border border-slate-200 shadow-sm'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end mt-2">
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-teal-600 px-4 py-2 text-sm font-medium text-white">
        {children}
      </div>
    </div>
  );
}
