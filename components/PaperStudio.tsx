import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  JelPaper, PaperPlan, PaperPlanEmphasis, PaperPlanUpload, PaperPlanOutline, ClarifyingQuestion, EvidenceRow,
  SavedPaper, UploadPreview, WORDS_PER_PAGE, PAGE_PRESETS, ExpandEvidenceResponse,
} from '../types';
import { apiClient } from '../services/apiClient';
import { extractDocText } from '../services/extractDocText';
import { logEvent } from '../services/analytics';
import EvidenceExpansionReview from './EvidenceExpansionReview';
import SynthesisModelBadge from './SynthesisModelBadge';

interface PaperStudioProps {
  plan: JelPaper;
  evidenceRows: EvidenceRow[];
  onBack: () => void;
  onGenerated: (paper: JelPaper) => void;
  // 'generate-now' = the write-first streamlined evidence gate (curate → Generate),
  // distinct from the manual 4-step prep wizard ('prep') and the post-gen 'review'.
  mode?: 'prep' | 'review' | 'generate-now';
  onRevise?: (instruction: string) => Promise<void>;
  // Generate Now gate's Generate button routes here (stay in Studio for live
  // progress) instead of onGenerated (which bounces the prep wizard to Library).
  onGenerateNow?: (paper: JelPaper) => void;
}

const EMPTY_EMPHASIS: PaperPlanEmphasis = { themes: [], audience: 'technical', targetWords: 5000 };
const Spin = () => <span className="inline-block w-4 h-4 border-2 border-teal-600 border-t-transparent rounded-full animate-spin align-[-2px]" />;

// Rotating reassurance shown before the outline lands (~first 1-2 min).
const PLANNING_MESSAGES = [
  'Reading your evidence papers…',
  'Mapping the literature…',
  'Structuring the argument…',
  'Building the section outline…',
];

/**
 * Live generation progress for the write-first "Generate Now" flow. The JEL
 * pipeline persists the outline early and writes each section to the row as it
 * finishes (App polls every 8s), so we can show REAL progress — outline checklist
 * with sections ticking off — instead of an opaque "sit tight" spinner.
 *
 *   Phase 1 (no outline yet):    "Planning your paper" + rotating messages
 *   Phase 2 (outline, drafting): progress bar + "Drafting section X of N" + checklist
 *   Phase 3 (all drafted):       "Fact-checking & polishing" (DA/coherence/audit/corrector)
 *
 * Own hooks, defined outside PaperStudio → no hook-ordering risk.
 */
function GenerationProgress({ row }: { row: JelPaper }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((i) => i + 1), 2500);
    return () => clearInterval(t);
  }, []);

  const outlineSections = row.outline?.sections ?? [];
  const draftedNums = new Set((row.sections ?? []).map((s) => String(s.number)));
  const total = outlineSections.length;
  const drafted = outlineSections.filter((s) => draftedNums.has(String(s.number))).length;
  const hasOutline = total > 0;
  const allDrafted = hasOutline && drafted >= total;
  const pct = hasOutline ? Math.max(6, Math.round((drafted / total) * 100)) : 6;
  const inProgressNum = hasOutline && !allDrafted
    ? outlineSections.find((s) => !draftedNums.has(String(s.number)))?.number
    : undefined;

  const phaseLabel = !hasOutline
    ? PLANNING_MESSAGES[tick % PLANNING_MESSAGES.length]
    : !allDrafted
      ? `Drafting section ${Math.min(drafted + 1, total)} of ${total}…`
      : 'Fact-checking citations & polishing the prose…';

  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-5">
      <div className="flex items-center gap-3 mb-1">
        <Spin />
        <h2 className="text-base font-semibold text-[#0f1d35]">Writing your survey paper</h2>
      </div>
      <p className="text-sm text-teal-700 font-medium mb-4 min-h-[1.25rem]">{phaseLabel}</p>

      {/* Progress bar */}
      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden mb-2">
        <div
          className={`h-full rounded-full bg-teal-500 transition-[width] duration-700 ease-out ${hasOutline ? '' : 'animate-pulse'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500 mb-4">
        <span>{hasOutline ? `${drafted} of ${total} sections drafted` : 'Planning the outline…'}</span>
        {allDrafted && <span className="text-amber-600 font-medium">final review</span>}
      </div>

      {/* Outline checklist — appears once the outline lands */}
      {hasOutline && (
        <ol className="space-y-1.5 mb-4">
          {outlineSections.map((s) => {
            const done = draftedNums.has(String(s.number));
            const active = String(s.number) === String(inProgressNum);
            return (
              <li key={s.number} className="flex items-start gap-2.5 text-sm">
                <span className="shrink-0 mt-0.5 w-4 text-center">
                  {done ? <span className="text-teal-600 font-semibold">✓</span>
                    : active ? <Spin />
                    : <span className="text-slate-300">○</span>}
                </span>
                <span className={done ? 'text-slate-700' : active ? 'text-[#0f1d35] font-medium' : 'text-slate-400'}>
                  {s.heading}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {/* Reassurance / safe-to-leave note */}
      <div className="rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-3 text-xs text-slate-500 leading-relaxed">
        This usually takes <span className="font-medium text-slate-600">5–10 minutes</span>. You can leave this
        page — generation continues in the background and the finished paper will be waiting in your{' '}
        <span className="font-medium text-slate-600">Library</span>.
      </div>
    </section>
  );
}

/**
 * Paper Studio — Prep cockpit. Question on top, then a 4-step wizard rail
 * (Evidence · Sharpen · Outline · Generate), one panel visible at a time.
 * "Plan is the contract": every control routes through mutate() → server → state.
 */
export default function PaperStudio({ plan: initialPlan, evidenceRows, onBack, onGenerated, mode, onRevise, onGenerateNow }: PaperStudioProps) {
  const [row, setRow] = useState<JelPaper>(initialPlan);
  const [step, setStep] = useState<'evidence' | 'sharpen' | 'outline' | 'generate'>('evidence');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [clarifyQs, setClarifyQs] = useState<ClarifyingQuestion[]>([]);
  const [clarifyLoading, setClarifyLoading] = useState(true);
  const [outlineDraft, setOutlineDraft] = useState<PaperPlanOutline | null>(initialPlan.plan?.outlinePreview ?? null);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<(UploadPreview & { attached?: boolean }) | null>(null);
  const [expandedUploadId, setExpandedUploadId] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [savedPapers, setSavedPapers] = useState<SavedPaper[]>([]);
  const [priorUploads, setPriorUploads] = useState<PaperPlanUpload[]>([]);
  const [libraryRows, setLibraryRows] = useState<EvidenceRow[]>([]);
  const [synthAccess, setSynthAccess] = useState<{ status: 'granted' | 'default'; model?: string } | null>(null);
  useEffect(() => {
    apiClient.getSynthesisAccess().then(setSynthAccess).catch(() => {});
  }, []);
  const hasClaudeAccess = synthAccess?.status === 'granted' && (synthAccess.model ?? '').startsWith('claude');
  const [plannerKind, setPlannerKind] = useState<'claude' | 'gemini' | 'qwen'>(
    initialPlan.plan?.generateMode === 'deep' ? 'gemini' : initialPlan.plan?.generateMode === 'standard' ? 'qwen' : 'gemini',
  );
  // Auto-upgrade to Claude once we know access is granted (runs once when access loads)
  useEffect(() => {
    if (hasClaudeAccess) setPlannerKind((k) => k === 'gemini' ? 'claude' : k);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasClaudeAccess]);
  const [expanding, setExpanding] = useState(false);
  const [expansion, setExpansion] = useState<ExpandEvidenceResponse | null>(null);
  // Clarify answers — keyed by question text, persisted to plan.clarifyAnswers
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const stored = initialPlan.plan?.clarifyAnswers ?? [];
    return Object.fromEntries(stored.map((a) => [a.question, a.answer]));
  });
  const plan: PaperPlan | null = row.plan ?? null;

  // ── Review mode ──
  const reviewMode = mode === 'review';
  const [reviseInstruction, setReviseInstruction] = useState('');
  const [reviseBusy, setReviseBusy] = useState(false);

  // Keep row in sync when the parent refreshes activePlan (e.g. poll during generation).
  // Only update in review mode to avoid clobbering local prep-wizard edits.
  useEffect(() => {
    if (reviewMode) setRow(initialPlan);
  }, [initialPlan, reviewMode]);

  const mutate = useCallback(async (apply: () => Promise<JelPaper>) => {
    setBusy(true);
    try { setRow(await apply()); } finally { setBusy(false); }
  }, []);

  const runExpand = async () => {
    setExpanding(true);
    // 'claude' routes through the BYOK provider on the backend — send as 'gemini'
    const apiKind: 'gemini' | 'qwen' = plannerKind === 'qwen' ? 'qwen' : 'gemini';
    try { setExpansion(await apiClient.expandEvidence(row.id, apiKind, 15)); }
    catch (e) { console.error('[expand-evidence]', e); }
    finally { setExpanding(false); }
  };
  const acceptExpansion = (ids: string[]) => {
    const curated = plan?.curatedWorkIds ?? [];
    const next = [...curated, ...ids.filter((id) => !curated.includes(id))];
    const prevDiscovered = plan?.discoveredWorkIds ?? [];
    const discovered = [...prevDiscovered, ...ids.filter((id) => !prevDiscovered.includes(id))];
    // Make accepted corpus papers immediately visible in the evidence list.
    // They exist only in the planner response — not in evidenceRows or libraryRows —
    // so orderedCorpus would silently drop them until a full page reload. We add them
    // to libraryRows (local state) here, mirroring the shape addSavedPaper uses.
    const accepted = (expansion?.added ?? []).filter((p) => ids.includes(p.id));
    const newRows: EvidenceRow[] = accepted
      .filter((p) => !byId.has(p.id))
      .map((p) => ({
        workId: p.id,
        title: p.title,
        authors: p.authors,
        sourceName: p.venue ?? '',
        year: p.year ?? 0,
        methodologyBadge: '',
        causalStrength: 'signal' as const,
        smsLevel: p.smsLevel,
        citationCount: p.citationCount,
        geography: [],
        url: '',
        finding: '',
      }));
    if (newRows.length) setLibraryRows((prev) => [...prev, ...newRows]);
    void mutate(() => apiClient.patchPaperPlan(row.id, { curatedWorkIds: next, discoveredWorkIds: discovered }));
    setExpansion(null);
  };

  useEffect(() => {
    // Only the manual prep wizard has a Sharpen step — skip the clarify LLM call
    // in the streamlined generate-now gate and in post-gen review mode.
    if (mode !== 'prep') { setClarifyLoading(false); return; }
    let cancelled = false;
    setClarifyLoading(true);
    void apiClient.clarifyPlan(initialPlan.id).then((res) => {
      if (cancelled) return;
      setClarifyQs(res.clarifyingQuestions ?? []);
      if (res.draftOutline) setOutlineDraft((cur) => cur ?? res.draftOutline);
    }).catch(() => {}).finally(() => { if (!cancelled) setClarifyLoading(false); });
    return () => { cancelled = true; };
  }, [initialPlan.id, mode]);

  const removedIds = new Set(plan?.removedWorkIds ?? []);
  const uploads = plan?.uploads ?? [];
  const emphasis = plan?.emphasis ?? EMPTY_EMPHASIS;
  const scope = plan?.scope ?? { include: [], exclude: [] };
  const targetWords = emphasis.targetWords ?? 5000;
  const currentPages = Math.round(targetWords / WORDS_PER_PAGE);
  const byId = new Map([...evidenceRows, ...libraryRows].map((r) => [r.workId, r]));
  const orderedCorpus = (plan?.curatedWorkIds ?? []).map((id) => byId.get(id)).filter((r): r is EvidenceRow => r !== undefined);
  const extra = [...evidenceRows, ...libraryRows].filter((r) => !(plan?.curatedWorkIds ?? []).includes(r.workId));
  const allRows = [...orderedCorpus, ...extra];
  const activeRows = allRows.filter((r) => !removedIds.has(r.workId));
  const evidenceTotal = activeRows.length + uploads.length;

  // Generate-now gate: auto-run the creative planner ONCE on open and auto-merge
  // its adds so the LLM-brought "Discovered" papers are already in the pool (the
  // user can still remove them). Mirrors acceptExpansion's display path — adds the
  // rows to libraryRows so they render + persists curated/discovered to the plan.
  // Read-only + soft-fail. Guarded by a ref (run once) and by an existing
  // discoveredWorkIds (so a re-open / poll-refresh never re-expands).
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (mode !== 'generate-now' || autoExpandedRef.current) return;
    autoExpandedRef.current = true; // ref guard: run once per plan, even if id changes
    if ((initialPlan.plan?.discoveredWorkIds?.length ?? 0) > 0) return; // already expanded
    const kind: 'gemini' | 'qwen' = initialPlan.plan?.generateMode === 'deep' ? 'gemini' : 'qwen';
    setExpanding(true);
    void (async () => {
      try {
        const res = await apiClient.expandEvidence(initialPlan.id, kind, 15);
        const added = res.added ?? [];
        if (!added.length) return;
        const curated = initialPlan.plan?.curatedWorkIds ?? [];
        const discovered = initialPlan.plan?.discoveredWorkIds ?? [];
        const ids = added.map((p) => p.id);
        const newRows: EvidenceRow[] = added
          .filter((p) => !byId.has(p.id))
          .map((p) => ({
            workId: p.id, title: p.title, authors: p.authors, sourceName: p.venue ?? '',
            year: p.year ?? 0, methodologyBadge: '', causalStrength: 'signal' as const,
            smsLevel: p.smsLevel, citationCount: p.citationCount, geography: [], url: '', finding: '',
          }));
        if (newRows.length) setLibraryRows((prev) => [...prev, ...newRows]);
        setRow(await apiClient.patchPaperPlan(initialPlan.id, {
          curatedWorkIds: [...curated, ...ids.filter((id) => !curated.includes(id))],
          discoveredWorkIds: [...discovered, ...ids.filter((id) => !discovered.includes(id))],
        }));
      } catch (e) {
        console.warn('[generate-now auto-expand]', e);
      } finally {
        setExpanding(false);
      }
    })();
    // initialPlan.id intentionally omitted: autoExpandedRef.current=true on first run
    // means a plan-id change won't re-expand even if deps include it — ref is the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initialPlan.id]);

  // Canonical, key-order-insensitive comparison: Postgres jsonb reorders object
  // keys on round-trip, so a raw JSON.stringify of the saved (DB) outline never
  // equalled the local draft's — leaving the outline permanently "not confirmed"
  // even after the user accepted it. Compare only the meaningful fields, in a
  // fixed order, so an accepted outline reads as confirmed in steps 3 and 4.
  const canonOutline = (o: PaperPlanOutline | null | undefined): string => {
    if (!o || !Array.isArray(o.sections) || o.sections.length === 0) return 'null';
    return JSON.stringify({
      title: o.title ?? '',
      sections: o.sections.map((s) => ({
        number: Number(s.number) || 0,
        heading: (s.heading ?? '').trim(),
        scope: (s.scope ?? '').trim(),
      })),
    });
  };
  const savedStr = canonOutline(plan?.outlinePreview);
  const draftStr = canonOutline(outlineDraft);
  const outlineConfirmed = !!(outlineDraft?.sections?.length) && savedStr !== 'null' && savedStr === draftStr;
  const outlineDirty = !!(outlineDraft?.sections?.length) && savedStr !== draftStr;

  const patchEmphasis = (p: Partial<PaperPlanEmphasis>) => mutate(() => apiClient.patchPaperPlan(row.id, { emphasis: { ...emphasis, ...p } }));
  const patchScope = (p: Partial<{ include: string[]; exclude: string[] }>) => mutate(() => apiClient.patchPaperPlan(row.id, { scope: { ...scope, ...p } }));
  const setQuestion = (q: string) => { if (q && q !== plan?.workingQuestion) void mutate(() => apiClient.patchPaperPlan(row.id, { workingQuestion: q })); };
  const persistAnswers = (next: Record<string, string>) => {
    const clarifyAnswers = Object.entries(next)
      .filter(([, a]) => a && a.trim())
      .map(([question, answer]) => ({ question, answer: answer.trim() }));
    void mutate(() => apiClient.patchPaperPlan(row.id, { clarifyAnswers }));
  };

  const toggleRemoved = (workId: string, removed: boolean) => {
    const next = new Set(removedIds); if (removed) next.add(workId); else next.delete(workId);
    void mutate(() => apiClient.patchPaperPlan(row.id, { removedWorkIds: [...next] }));
  };
  // Drop a paper from THIS plan only (default) vs. also suppress it for similar
  // future searches (records a dislike with the plan's query → the always-on
  // dislike filter hides it on cosine-similar queries, same as a thumbs-down in
  // the evidence table). See _shared/dislikeFilter.ts.
  const dropPaper = (workId: string, alsoSuppress: boolean) => {
    toggleRemoved(workId, true);
    if (alsoSuppress) {
      const queryText = (plan?.workingQuestion || row.query || '').trim();
      if (queryText) void apiClient.submitFeedback({ workId, type: 'dislike', queryText }).catch(() => {});
    }
    setPendingRemove(null);
  };
  const removeUpload = (uploadId: string) => void mutate(() => apiClient.patchPaperPlan(row.id, { uploads: uploads.filter((u) => u.uploadId !== uploadId) }));

  // ── Outline editing (local draft) ──
  const editSection = (idx: number, p: Partial<{ heading: string; scope: string }>) =>
    setOutlineDraft((o) => o ? { ...o, sections: o.sections.map((s, i) => i === idx ? { ...s, ...p } : s) } : o);
  const removeSectionAt = (idx: number) => setOutlineDraft((o) => o ? { ...o, sections: o.sections.filter((_, i) => i !== idx) } : o);
  const moveSection = (idx: number, dir: -1 | 1) => setOutlineDraft((o) => {
    if (!o) return o; const s = [...o.sections]; const j = idx + dir; if (j < 0 || j >= s.length) return o;
    [s[idx], s[j]] = [s[j], s[idx]]; return { ...o, sections: s };
  });
  const addSection = () => setOutlineDraft((o) => {
    const base = o ?? { title: plan?.workingQuestion || row.query, sections: [] };
    return { ...base, sections: [...base.sections, { number: base.sections.length + 1, heading: 'New section', scope: '' }] };
  });
  const renumber = (o: PaperPlanOutline): PaperPlanOutline => ({ ...o, sections: o.sections.map((s, i) => ({ ...s, number: i + 1 })) });
  const useThisOutline = () => {
    if (!outlineDraft) return;
    // Set the renumbered draft FIRST (optimistic), then persist the SAME object.
    // This guarantees canonOutline(outlineDraft) === canonOutline(saved outlinePreview)
    // on every render — so "confirmed" shows instantly and stays, with no window where
    // a reordered/removed-section draft (non-sequential numbers) reads as unconfirmed
    // while the save round-trips.
    const renumbered = renumber(outlineDraft);
    setOutlineDraft(renumbered);
    logEvent({ eventType: 'paper.outline_accepted', targetType: 'plan', targetId: row.id, status: 'completed', payload: { sectionCount: renumbered.sections?.length ?? 0 } });
    void mutate(() => apiClient.patchPaperPlan(row.id, { outlinePreview: renumbered }));
  };
  const regenerateOutline = async () => {
    setOutlineBusy(true);
    try { const res = await apiClient.refreshOutlinePreview(row.id); if (res?.outlinePreview) setOutlineDraft(res.outlinePreview); }
    finally { setOutlineBusy(false); }
  };

  // ── Upload (DOI / paste / PDF or Word file) ──
  const uploadBody = (text: string, confirm?: boolean, uploadId?: string) => {
    const v = text.trim(); const looksLink = /10\.\d{4,}/.test(v) || /^https?:\/\//i.test(v);
    return { ...(looksLink ? { doiOrUrl: v } : { pastedText: v }), confirm, uploadId };
  };
  const previewFromText = async (text: string) => {
    const v = text.trim(); if (!v || uploadBusy) return;
    setPendingText(v); setUploadError(''); setUploadBusy(true);
    try {
      const preview = await apiClient.uploadToPlan(row.id, uploadBody(v));
      setUploadPreview(preview);
    }
    catch (e) { setUploadError('Could not resolve that — try a different file or paste the title + abstract.'); console.error(e); }
    finally { setUploadBusy(false); }
  };
  const handleFile = async (file: File | undefined) => {
    if (!file || uploadBusy) return;
    setUploadFileName(file.name); setUploadError(''); setUploadPreview(null);
    let text = '';
    try { text = (await extractDocText(file)).text; }
    catch (e) { setUploadError((e as Error).message); return; }
    await previewFromText(text);
  };
  const confirmUpload = async () => {
    if (!uploadPreview || uploadBusy) return; setUploadBusy(true);
    try {
      await apiClient.uploadToPlan(row.id, uploadBody(pendingText, true, uploadPreview.upload.uploadId));
      setRow(await apiClient.getPaperPlan(row.id));
      setUploadPreview(null); setPendingText(''); setUploadFileName('');
    }
    catch (e) { console.error(e); } finally { setUploadBusy(false); }
  };

  // ── From your library: saved corpus papers + prior uploads ──
  const openLibrary = async () => {
    setLibraryOpen((v) => !v);
    if (savedPapers.length || priorUploads.length || libraryLoading) return;
    setLibraryLoading(true);
    try {
      const [saved, ups] = await Promise.all([
        apiClient.getSavedPapers().catch(() => []),
        apiClient.listPaperUploads().catch(() => ({ uploads: [] })),
      ]);
      setSavedPapers(saved);
      setPriorUploads(ups.uploads ?? []);
    } finally { setLibraryLoading(false); }
  };
  const addSavedPaper = (sp: SavedPaper) => {
    const curated = plan?.curatedWorkIds ?? [];
    if (!curated.includes(sp.workId)) void mutate(() => apiClient.patchPaperPlan(row.id, { curatedWorkIds: [...curated, sp.workId], removedWorkIds: (plan?.removedWorkIds ?? []).filter((id) => id !== sp.workId) }));
    setLibraryRows((rows) => rows.some((r) => r.workId === sp.workId) ? rows : [...rows, {
      workId: sp.workId, title: sp.title, authors: [], sourceName: sp.venue ?? '', year: sp.year ?? 0,
      methodologyBadge: '', causalStrength: 'signal', smsLevel: sp.smsLevel, geography: [], url: sp.url ?? '', finding: '',
    } as EvidenceRow]);
  };
  const addPriorUpload = (u: PaperPlanUpload) => {
    if (uploads.some((x) => x.uploadId === u.uploadId)) return;
    void mutate(() => apiClient.patchPaperPlan(row.id, { uploads: [...uploads, u] }));
  };

  const handleGenerate = async () => {
    if (evidenceTotal === 0 || generating) return; setGenerating(true);
    try {
      // Honor the Deep/Standard model the user picked at the fork (persisted on the
      // plan). autoExpand is omitted (false): the gate already merged the planner's
      // adds into curatedWorkIds, so generation reads exactly the curated pool.
      const opts = plan?.generateMode ? { generateMode: plan.generateMode } : undefined;
      const paper = await apiClient.generateFromPlan(row.id, opts);
      // Generate Now gate → stay in Studio (live progress); prep wizard → onGenerated.
      if (mode === 'generate-now' && onGenerateNow) onGenerateNow(paper);
      else onGenerated(paper);
    } catch (e) { console.error(e); setGenerating(false); }
  };

  // ── Review mode render ──
  if (reviewMode) {
    const bib = row.bibliography ?? [];
    const outlineSections = row.outline?.sections ?? [];
    const revisionsUsed = row.regenerationsUsed ?? 0;
    const isRunning = row.status === 'running' || row.status === 'queued';
    const reviseDisabled = revisionsUsed >= 2 || isRunning || reviseBusy;

    const handleRevise = async () => {
      const instruction = reviseInstruction.trim();
      if (!instruction || reviseDisabled || !onRevise) return;
      setReviseBusy(true);
      try {
        await onRevise(instruction);
        setReviseInstruction('');
      } catch (e) {
        console.error('[studio-revise]', e);
      } finally {
        setReviseBusy(false);
      }
    };

    return (
      <div className="flex flex-col h-[calc(100vh-3.5rem)] md:h-screen bg-[#f4f7fb]">
        {/* Top bar */}
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 md:px-6 py-3 shrink-0">
          <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-800" title="Back to brief">← Back</button>
          <div className="text-[11px] uppercase tracking-[0.2em] text-teal-700 font-semibold flex-1">Paper Studio · Review</div>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            row.status === 'done' ? 'bg-teal-100 text-teal-700' :
            row.status === 'error' ? 'bg-rose-100 text-rose-700' :
            'bg-amber-100 text-amber-700'
          }`}>
            {row.status === 'done' ? 'Done' : row.status === 'error' ? 'Error' : 'Generating…'}
          </span>
        </header>

        {/* Research question — read-only in review mode */}
        <div className="border-b border-slate-200 bg-white px-4 md:px-6 py-3 shrink-0">
          <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500 font-semibold mb-1">Research question</div>
          <div className="text-sm text-[#0f1d35]">{plan?.workingQuestion || row.query}</div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 space-y-4">

          {isRunning ? (
          <GenerationProgress row={row} />
          ) : (
          <>
          {/* ① Papers used */}
          <section className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <h2 className="text-sm font-semibold text-[#0f1d35] mb-3">① Papers used ({bib.length})</h2>
            {bib.length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isRunning ? 'Generating… papers will appear when the draft is ready.' : 'No bibliography available.'}
              </p>
            ) : (
              <ol className="space-y-1.5 text-sm">
                {bib.map((entry) => (
                  <li key={entry.number} className="flex items-start gap-2">
                    <span className="text-xs text-slate-400 w-6 text-right shrink-0 mt-0.5">{entry.number}.</span>
                    <span className="min-w-0 text-slate-700">
                      {entry.authors}{entry.year ? ` (${entry.year})` : ''}. <span className="text-[#0f1d35] font-medium">{entry.title}</span>
                      {entry.venue ? <span className="text-slate-500"> — {entry.venue}</span> : null}
                    </span>
                    {entry.cited && (
                      <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700 self-start">cited</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* ② Outline */}
          <section className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <h2 className="text-sm font-semibold text-[#0f1d35] mb-3">② Outline ({outlineSections.length} sections)</h2>
            {outlineSections.length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isRunning ? 'Outline will appear when the draft is ready.' : 'No outline available.'}
              </p>
            ) : (
              <ol className="space-y-1.5">
                {outlineSections.map((s) => (
                  <li key={s.number} className="flex items-start gap-2 text-sm">
                    <span className="text-xs text-slate-400 w-6 text-right shrink-0 mt-0.5">{s.number}.</span>
                    <div>
                      <span className="font-medium text-[#0f1d35]">{s.heading}</span>
                      {s.scope && <span className="text-slate-500"> — {s.scope}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* ③ Revise */}
          <section className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-[#0f1d35]">③ Revise</h2>
              <span className={`text-xs ${revisionsUsed >= 2 ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>
                {revisionsUsed} / 2 revisions used
              </span>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              Describe what to change — the model will re-draft only the targeted section(s) over the same evidence set.
            </p>
            {revisionsUsed >= 2 ? (
              <p className="text-sm text-rose-600 font-medium">Revision limit reached (2/2).</p>
            ) : isRunning ? (
              <div className="flex items-center gap-2 text-sm text-amber-700">
                <Spin /> <span>Working… please wait for generation to complete.</span>
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  rows={3}
                  value={reviseInstruction}
                  onChange={(e) => setReviseInstruction(e.target.value)}
                  disabled={reviseDisabled}
                  placeholder="e.g. Strengthen the evidence in section 2 on early childhood interventions…"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none resize-none disabled:opacity-50 disabled:bg-slate-50"
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void handleRevise()}
                    disabled={!reviseInstruction.trim() || reviseDisabled}
                    className="rounded-full bg-indigo-600 text-white px-4 py-1.5 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {reviseBusy ? 'Submitting…' : 'Revise →'}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* View full paper */}
          {row.status === 'done' && (
            <div className="pb-4">
              <button
                onClick={() => onGenerated(row)}
                className="w-full rounded-xl border border-teal-300 bg-teal-50 text-teal-800 px-4 py-3 text-sm font-semibold hover:bg-teal-100 transition"
              >
                View full paper →
              </button>
            </div>
          )}
          </>
          )}

        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] md:h-screen bg-[#f4f7fb]">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 md:px-6 py-3 shrink-0">
        <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-800" title="Back to brief">← Back</button>
        <div className="text-[11px] uppercase tracking-[0.2em] text-teal-700 font-semibold flex-1">{mode === 'generate-now' ? 'Paper Studio · Evidence' : 'Paper Studio · JEL survey'}</div>
        <span className="text-xs text-slate-400 hidden md:inline">{currentPages} pages · {evidenceTotal} papers{outlineConfirmed ? ' · outline ✓' : ''}</span>
      </header>

      {/* Research question — full width, top */}
      <div className="border-b border-slate-200 bg-white px-4 md:px-6 py-3 shrink-0">
        <label className="block text-[11px] uppercase tracking-[0.12em] text-slate-500 font-semibold mb-1">Research question</label>
        <textarea defaultValue={plan?.workingQuestion ?? ''} onBlur={(e) => setQuestion(e.target.value.trim())} rows={2}
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none resize-none"
          placeholder="The question this survey answers…" />
      </div>

      {/* Generate Now gate: explain the evidence pool (used vs cited) */}
      {mode === 'generate-now' && (
        <div className="border-b border-slate-200 bg-teal-50/60 px-4 md:px-6 py-2.5 shrink-0">
          <p className="text-xs text-teal-800">
            <span className="font-semibold">Review the evidence pool.</span> Not every paper will be cited, but your paper is generated from this pool. Edit or add papers before generating.
          </p>
        </div>
      )}

      {/* Wizard rail + active panel */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">

        {/* Progress stepper — hidden in the streamlined generate-now gate */}
        {mode !== 'generate-now' && (() => {
          const stepsDone: Record<string, boolean> = {
            evidence: evidenceTotal > 0,
            sharpen: (plan?.clarifyAnswers?.length ?? 0) > 0,
            outline: outlineConfirmed,
            generate: false,
          };
          const WIZARD_STEPS = [
            { key: 'evidence' as const, num: 1, label: 'Evidence'  },
            { key: 'sharpen'  as const, num: 2, label: 'Sharpen'   },
            { key: 'outline'  as const, num: 3, label: 'Outline'   },
            { key: 'generate' as const, num: 4, label: 'Generate'  },
          ];
          return (
            <nav className="flex items-center mb-6 min-w-0 overflow-x-auto" aria-label="Wizard steps">
              {WIZARD_STEPS.map(({ key, num, label }, idx) => {
                const isCurrent = step === key;
                const isDone    = stepsDone[key];
                return (
                  <React.Fragment key={key}>
                    {/* Step node */}
                    <button
                      onClick={() => setStep(key)}
                      className="flex flex-col items-center gap-1 group shrink-0"
                      aria-current={isCurrent ? 'step' : undefined}
                    >
                      {/* Circle */}
                      <span className={`
                        w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors
                        ${isDone
                          ? 'bg-teal-600 text-white'
                          : isCurrent
                            ? 'bg-white border-2 border-teal-600 text-teal-700'
                            : 'bg-white border-2 border-slate-300 text-slate-400 group-hover:border-teal-400 group-hover:text-teal-600'
                        }
                      `}>
                        {isDone ? '✓' : num}
                      </span>
                      {/* Label */}
                      <span className={`text-[11px] font-semibold transition-colors whitespace-nowrap
                        ${isDone
                          ? 'text-teal-700'
                          : isCurrent
                            ? 'text-[#0f1d35]'
                            : 'text-slate-400 group-hover:text-teal-600'
                        }
                      `}>
                        {label}
                      </span>
                    </button>
                    {/* Connector line between steps */}
                    {idx < WIZARD_STEPS.length - 1 && (
                      <div className={`h-0.5 flex-1 mx-1 mb-5 min-w-[1rem] transition-colors ${
                        stepsDone[key] ? 'bg-teal-400' : 'bg-slate-200'
                      }`} />
                    )}
                  </React.Fragment>
                );
              })}
            </nav>
          );
        })()}

        {/* ① Evidence */}
        {step === 'evidence' && (
          <section className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <h2 className="text-sm font-semibold text-[#0f1d35] mb-1">① Evidence ({evidenceTotal})</h2>
            <p className="text-xs text-slate-500 mb-3">Review the papers, remove any that don't belong, or add your own.</p>

            {/* Always-on research agent notice + manual preview panel — prep wizard only */}
            {mode !== 'generate-now' && (
            <div className="mb-5 rounded-lg border border-teal-200 bg-teal-50/40 p-4">
              <div className="text-sm font-semibold text-slate-800">Our research agent will scan for additional evidence</div>
              <div className="text-xs text-slate-500 mt-1 leading-relaxed">
                At generation time, a specialist model automatically searches the literature for the strongest and most comprehensive evidence for this paper — you don't need to do anything.
              </div>
              <div className="mt-3 border-t border-teal-100 pt-3">
                <div className="text-xs font-semibold text-slate-600">Preview what it will find</div>
                <div className="text-xs text-slate-400 mt-0.5">Run this now to review and curate its proposals before generating.</div>
              {!expansion && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {([
                      { kind: 'claude' as const, label: 'Claude', locked: !hasClaudeAccess, lockTitle: 'Requires Claude access from your admin' },
                      { kind: 'gemini' as const, label: 'Gemini', locked: false, lockTitle: '' },
                      { kind: 'qwen' as const, label: 'Qwen (in-house)', locked: false, lockTitle: '' },
                    ]).map(({ kind, label, locked, lockTitle }) => (
                      <button
                        key={kind}
                        disabled={locked}
                        title={locked ? lockTitle : undefined}
                        onClick={() => !locked && setPlannerKind(kind)}
                        className={`px-3 py-1 text-xs rounded-full border font-medium transition
                          ${locked ? 'border-slate-200 text-slate-300 bg-white cursor-not-allowed' :
                            plannerKind === kind ? 'border-teal-600 bg-teal-600 text-white' :
                            'border-slate-300 text-slate-600 bg-white hover:bg-slate-50'}`}
                      >
                        {locked ? `${label} 🔒` : label}
                      </button>
                    ))}
                  </div>
                  <button disabled={expanding} onClick={() => void runExpand()} className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-sm disabled:opacity-50">
                    {expanding ? 'Searching the literature…' : 'Preview evidence scan'}
                  </button>
                </div>
              )}
              {expansion && (
                <div className="mt-3">
                  <EvidenceExpansionReview added={expansion.added} dropped={expansion.dropped} model={expansion.model} onAccept={acceptExpansion} onCancel={() => setExpansion(null)} />
                </div>
              )}
              </div>
            </div>
            )}

            {mode === 'generate-now' && expanding && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
                <Spin /> Finding additional relevant papers from the corpus…
              </div>
            )}

            {/* + Add a paper (PDF / Word / DOI / paste) */}
            <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-3 mb-3">
              <div className="text-sm font-semibold text-teal-900 mb-1">+ Add a paper</div>
              <p className="text-xs text-slate-500 mb-2">Upload a PDF or Word file — we extract the title, authors & abstract, check if it's already in the corpus, and add it if not.</p>
              <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" className="hidden" onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }} />
              <div className="flex items-center gap-2">
                <button onClick={() => fileRef.current?.click()} disabled={uploadBusy}
                  className="rounded-full bg-white border border-teal-300 text-teal-700 px-3 py-1 text-xs font-semibold hover:bg-teal-100 disabled:opacity-50">
                  {uploadBusy && !uploadPreview ? 'Reading…' : '📄 Upload PDF / Word'}
                </button>
                {uploadFileName && <span className="text-xs text-slate-500 truncate max-w-[160px]">{uploadFileName}</span>}
              </div>
              {uploadError && <p className="text-xs text-rose-600 mt-1.5">{uploadError}</p>}
              {uploadPreview && (
                uploadPreview.alreadyInPlan
                  ? (
                    /* Already in evidence table — no card, just a prominent message */
                    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4">
                      <p className="text-sm font-semibold text-amber-800">⚠ This paper is already in your evidence table.</p>
                      <p className="text-xs text-amber-700 mt-1">No action needed — it will be included in the survey.</p>
                      <button
                        onClick={() => { setUploadPreview(null); setUploadFileName(''); setPendingText(''); }}
                        className="mt-3 text-xs font-medium text-amber-700 hover:text-amber-900 underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  )
                  : (
                    /* Read-only extracted metadata — user sees what was found, then clicks Add */
                    <div className="mt-3 rounded-lg bg-white border border-slate-200 px-3 py-3 space-y-2">
                      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Extracted from document</div>
                      {/* Title */}
                      <div>
                        <div className="text-[11px] text-slate-400 mb-0.5">Title</div>
                        <div className="text-sm font-medium text-[#0f1d35]">{uploadPreview.upload.title || <span className="text-slate-400 italic">Not detected</span>}</div>
                      </div>
                      {/* Authors */}
                      {(uploadPreview.upload.authors ?? []).length > 0 && (
                        <div>
                          <div className="text-[11px] text-slate-400 mb-0.5">Authors</div>
                          <div className="text-sm text-slate-700">{uploadPreview.upload.authors.join(', ')}</div>
                        </div>
                      )}
                      {/* Journal / Year */}
                      {(uploadPreview.upload.venue || uploadPreview.upload.year) && (
                        <div className="flex gap-4">
                          {uploadPreview.upload.venue && (
                            <div>
                              <div className="text-[11px] text-slate-400 mb-0.5">Journal / venue</div>
                              <div className="text-sm text-slate-700">{uploadPreview.upload.venue}</div>
                            </div>
                          )}
                          {uploadPreview.upload.year && (
                            <div>
                              <div className="text-[11px] text-slate-400 mb-0.5">Year</div>
                              <div className="text-sm text-slate-700">{uploadPreview.upload.year}</div>
                            </div>
                          )}
                        </div>
                      )}
                      {/* Abstract */}
                      {uploadPreview.upload.abstract
                        ? (
                          <div>
                            <div className="text-[11px] text-slate-400 mb-0.5">Abstract</div>
                            <div className="max-h-28 overflow-y-auto text-xs text-slate-600 leading-relaxed border border-slate-200 rounded px-2 py-1.5 bg-slate-50">
                              {uploadPreview.upload.abstract}
                            </div>
                          </div>
                        )
                        : <div className="text-xs text-slate-400 italic">Abstract not detected.</div>
                      }
                      {/* Corpus note */}
                      <div className="text-xs text-slate-400">{uploadPreview.inCorpus ? '✓ Already in corpus' : 'New — will be added as user-supplied · unverified'}</div>
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => void confirmUpload()} disabled={uploadBusy} className="rounded-full bg-teal-600 text-white px-3 py-1 text-xs font-semibold hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed">{uploadBusy ? 'Adding…' : 'Add to paper'}</button>
                        <button onClick={() => { setUploadPreview(null); setUploadFileName(''); setPendingText(''); }} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                      </div>
                    </div>
                  )
              )}
            </div>

            {/* From your library */}
            <div className="rounded-xl border border-slate-200 px-3 py-2.5 mb-3">
              <button onClick={() => void openLibrary()} className="text-sm font-semibold text-[#0f1d35] flex items-center gap-1">
                {libraryOpen ? '▾' : '▸'} From your library
              </button>
              {libraryOpen && (
                <div className="mt-3 space-y-3">
                  {libraryLoading ? <p className="text-xs text-slate-400">Loading…</p> : (
                    <>
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.12em] text-slate-400 font-semibold mb-1">Saved papers ({savedPapers.length})</div>
                        {savedPapers.length === 0 ? <p className="text-xs text-slate-400">None saved yet.</p> : (
                          <ul className="space-y-1">
                            {savedPapers.slice(0, 30).map((sp) => {
                              const added = (plan?.curatedWorkIds ?? []).includes(sp.workId) && !removedIds.has(sp.workId);
                              return (
                                <li key={sp.feedbackId} className="flex items-start justify-between gap-3 text-xs">
                                  <span className="min-w-0 text-slate-600 truncate">{sp.title}{sp.year ? ` · ${sp.year}` : ''}</span>
                                  {added
                                    ? <span className="shrink-0 text-slate-400 italic">already in your table</span>
                                    : <button onClick={() => addSavedPaper(sp)} className="shrink-0 font-medium text-teal-700 hover:text-teal-900">+ add</button>}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.12em] text-slate-400 font-semibold mb-1">Previously uploaded ({priorUploads.length})</div>
                        {priorUploads.length === 0 ? <p className="text-xs text-slate-400">No prior uploads.</p> : (
                          <ul className="space-y-1">
                            {priorUploads.slice(0, 30).map((u) => {
                              const added = uploads.some((x) => x.uploadId === u.uploadId);
                              return (
                                <li key={u.uploadId} className="flex items-start justify-between gap-3 text-xs">
                                  <span className="min-w-0 text-slate-600 truncate">{u.title}{u.year ? ` · ${u.year}` : ''}</span>
                                  <button onClick={() => addPriorUpload(u)} disabled={added} className="shrink-0 font-medium text-teal-700 hover:text-teal-900 disabled:text-slate-300">{added ? '✓ added' : '+ add'}</button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Uploaded papers — expandable */}
            {uploads.map((u: PaperPlanUpload) => {
              const isExpanded = expandedUploadId === u.uploadId;
              return (
                <div key={u.uploadId} className="rounded-lg border border-teal-200 bg-teal-50/40 px-3 py-2 mb-1.5">
                  {/* Header row — click to expand/collapse */}
                  <div className="flex items-start justify-between gap-3">
                    <button
                      onClick={() => setExpandedUploadId(isExpanded ? null : u.uploadId)}
                      className="flex items-start gap-1.5 min-w-0 text-left group"
                    >
                      <span className="shrink-0 text-xs text-teal-600 mt-0.5">{isExpanded ? '▾' : '▸'}</span>
                      <div className="min-w-0">
                        <div className="text-sm text-[#0f1d35] group-hover:text-teal-700">
                          {u.title} <span className="text-[10px] uppercase tracking-wide text-teal-600 font-semibold">· uploaded</span>
                        </div>
                        {!isExpanded && (
                          <div className="text-xs text-slate-400 mt-0.5 truncate">
                            {(u.authors ?? []).slice(0, 3).join(', ')}{(u.authors?.length ?? 0) > 3 ? ' et al.' : ''}{u.year ? ` · ${u.year}` : ''}
                          </div>
                        )}
                      </div>
                    </button>
                    <button onClick={() => removeUpload(u.uploadId)} className="shrink-0 text-xs font-medium text-slate-300 hover:text-rose-500">× Remove</button>
                  </div>
                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="mt-2 pl-5 space-y-1.5 text-xs text-slate-600">
                      {(u.authors ?? []).length > 0 && (
                        <div><span className="font-semibold text-slate-500">Authors:</span> {(u.authors ?? []).join(', ')}</div>
                      )}
                      {u.venue && (
                        <div><span className="font-semibold text-slate-500">Journal:</span> {u.venue}</div>
                      )}
                      {u.year && (
                        <div><span className="font-semibold text-slate-500">Year:</span> {u.year}</div>
                      )}
                      {u.abstract ? (
                        <div>
                          <div className="font-semibold text-slate-500 mb-0.5">Abstract:</div>
                          <div className="max-h-32 overflow-y-auto leading-relaxed text-slate-500 border border-slate-200 rounded px-2 py-1.5 bg-white">
                            {u.abstract}
                          </div>
                        </div>
                      ) : (
                        <div className="text-slate-400 italic">No abstract extracted.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Corpus + library evidence rows */}
            <ul className="space-y-1.5">
              {allRows.map((r, idx) => {
                const removed = removedIds.has(r.workId);
                return (
                  <li key={r.workId} className={`rounded-lg border px-3 py-2 flex items-start justify-between gap-3 ${removed ? 'border-slate-200 bg-slate-50 opacity-60' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-start gap-1.5 min-w-0">
                      <span className="text-xs text-slate-400 w-7 text-right shrink-0">{idx + 1}.</span>
                      <div className="min-w-0">
                        <div className={`text-sm ${removed ? 'line-through text-slate-400' : 'text-[#0f1d35]'}`}>{r.title}{(plan?.discoveredWorkIds ?? []).includes(r.workId) && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 align-middle">Discovered</span>
                        )}</div>
                        <div className="text-xs text-slate-400 mt-0.5 truncate">{(r.authors ?? []).slice(0, 3).join(', ')}{(r.authors?.length ?? 0) > 3 ? ' et al.' : ''}{r.year ? ` · ${r.year}` : ''}{typeof r.smsLevel === 'number' ? ` · SMS ${r.smsLevel}` : ''}</div>
                      </div>
                    </div>
                    {removed ? (
                      <button onClick={() => toggleRemoved(r.workId, false)} className="shrink-0 text-xs font-medium text-teal-600 hover:text-teal-800">Restore</button>
                    ) : pendingRemove === r.workId ? (
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        <span className="text-[10px] text-slate-400">Drop this paper…</span>
                        <div className="flex gap-1">
                          <button onClick={() => dropPaper(r.workId, false)} className="text-[11px] font-medium rounded px-2 py-0.5 bg-slate-100 text-slate-600 hover:bg-slate-200">This paper only</button>
                          <button onClick={() => dropPaper(r.workId, true)} className="text-[11px] font-medium rounded px-2 py-0.5 bg-rose-50 text-rose-600 hover:bg-rose-100" title="Also hide this paper from future searches with a similar query">Hide for similar searches</button>
                          <button onClick={() => setPendingRemove(null)} className="text-[11px] text-slate-300 hover:text-slate-500">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setPendingRemove(r.workId)} className="shrink-0 text-xs font-medium text-slate-300 hover:text-rose-500">× Remove</button>
                    )}
                  </li>
                );
              })}
            </ul>

          </section>
        )}

        {/* Synthesis model badge — which model this paper will be generated with */}
        {mode === 'generate-now' && step === 'evidence' && (
          <div className="mt-6"><SynthesisModelBadge /></div>
        )}

        {/* Generate Now gate footer — curate above, then generate from the pool */}
        {mode === 'generate-now' && step === 'evidence' && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <button onClick={onBack} className="text-sm font-semibold text-slate-400 hover:text-slate-700 transition">← Back</button>
            <button
              onClick={() => void handleGenerate()}
              disabled={evidenceTotal === 0 || generating}
              className="rounded-full bg-teal-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 transition shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating ? 'Starting…' : `Generate paper from these ${evidenceTotal} papers →`}
            </button>
          </div>
        )}

        {/* ② Sharpen */}
        {step === 'sharpen' && (
          <section className="rounded-2xl border border-indigo-200 bg-indigo-50/60 px-4 py-4">
            <h2 className="text-sm font-semibold text-indigo-900 mb-2">② Let's sharpen your paper</h2>
            {clarifyLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-indigo-700"><Spin /> <span>Horizon scanning… <span className="text-indigo-400">reading your evidence to suggest a focus</span></span></div>
            ) : clarifyQs.length === 0 ? (
              <p className="text-sm text-indigo-700/80">Your question and evidence look aligned — review the outline and evidence, then Generate.</p>
            ) : (
              <div className="space-y-3">
                {clarifyQs.map((q, i) => (
                  <div key={i} className="rounded-xl bg-white border border-indigo-100 px-3 py-2.5">
                    <div className="text-sm font-medium text-[#0f1d35]">{q.q}</div>
                    {q.rationale && <div className="text-xs text-slate-500 mt-0.5">{q.rationale}</div>}
                    {q.options?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {q.options.map((opt) => {
                          const chosen = scope.include.includes(opt);
                          return (
                            <button
                              key={opt}
                              disabled={chosen}
                              onClick={() => {
                                void patchScope({ include: [...scope.include, opt] });
                                const next = { ...answers, [q.q]: opt };
                                setAnswers(next);
                                persistAnswers(next);
                              }}
                              className={`rounded-full border px-2.5 py-1 text-xs transition ${chosen ? 'bg-teal-600 border-teal-600 text-white' : 'bg-white border-indigo-300 text-indigo-700 hover:bg-indigo-100'}`}
                            >
                              {chosen ? `✓ ${opt}` : `+ ${opt}`}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <textarea
                      rows={1}
                      value={answers[q.q] ?? ''}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.q]: e.target.value }))}
                      onBlur={(e) => {
                        const next = { ...answers, [q.q]: e.target.value };
                        setAnswers(next);
                        persistAnswers(next);
                      }}
                      placeholder="Your answer (optional)…"
                      className="mt-2 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-[#0f1d35] placeholder-slate-400 focus:border-teal-500 focus:outline-none resize-none"
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ③ Outline + length */}
        {step === 'outline' && (
          <section className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-[#0f1d35]">③ Outline {outlineConfirmed && <span className="text-teal-600 text-xs font-normal">· ✓ confirmed</span>}</h2>
              <button onClick={() => void regenerateOutline()} disabled={outlineBusy} className="text-xs text-teal-700 hover:text-teal-900 disabled:opacity-50">{outlineBusy ? 'Building…' : (outlineDraft ? '↻ Regenerate' : 'Generate')}</button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Edit, reorder, add or remove sections. The confirmed outline is exactly what gets written.</p>
            {outlineDraft?.sections?.length ? (
              <>
                <ol className="space-y-2">
                  {outlineDraft.sections.map((s, idx) => (
                    <li key={s.number ?? idx} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400 w-5 text-right">{idx + 1}.</span>
                        <input value={s.heading} onChange={(e) => editSection(idx, { heading: e.target.value })}
                          className="flex-1 text-sm font-semibold text-[#0f1d35] border-b border-transparent hover:border-slate-200 focus:border-teal-500 focus:outline-none py-0.5" />
                        <button onClick={() => moveSection(idx, -1)} disabled={idx === 0} className="text-slate-300 hover:text-slate-600 disabled:opacity-30 text-xs" title="Move up">↑</button>
                        <button onClick={() => moveSection(idx, 1)} disabled={idx === outlineDraft.sections.length - 1} className="text-slate-300 hover:text-slate-600 disabled:opacity-30 text-xs" title="Move down">↓</button>
                        <button onClick={() => removeSectionAt(idx)} className="text-slate-300 hover:text-rose-500 text-sm" title="Remove">×</button>
                      </div>
                      <input value={s.scope ?? ''} onChange={(e) => editSection(idx, { scope: e.target.value })} placeholder="what this section covers…"
                        className="w-full ml-7 mt-0.5 text-xs text-slate-500 border-b border-transparent hover:border-slate-200 focus:border-teal-500 focus:outline-none py-0.5" />
                    </li>
                  ))}
                </ol>
                <div className="flex items-center gap-3 mt-3">
                  <button onClick={addSection} className="text-xs text-teal-700 hover:text-teal-900">+ Add section</button>
                  <div className="flex-1" />
                  <button onClick={() => void useThisOutline()} disabled={!outlineDirty || busy}
                    className="rounded-full bg-teal-600 text-white px-4 py-1.5 text-xs font-semibold hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    {outlineConfirmed ? '✓ Outline confirmed' : 'Use this outline'}
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">
                {clarifyLoading ? <span className="inline-flex items-center gap-2"><Spin /> Drafting a proposed outline…</span> : 'No outline yet — click "Generate".'}
              </div>
            )}
            {/* Length — under the outline */}
            <div className="mt-4 pt-3 border-t border-slate-100">
              <label className="block text-[11px] uppercase tracking-[0.12em] text-slate-500 font-semibold mb-1">Length</label>
              <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden align-middle">
                {PAGE_PRESETS.map((pages) => (
                  <button key={pages} onClick={() => void patchEmphasis({ targetWords: pages * WORDS_PER_PAGE })} disabled={busy}
                    className={`px-3 py-1.5 text-sm font-medium transition ${currentPages === pages ? 'bg-teal-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{pages}p</button>
                ))}
              </div>
              <span className="text-xs text-slate-400 ml-2">≈ {targetWords.toLocaleString()} words · JEL voice</span>
            </div>
          </section>
        )}

        {/* ④ Generate */}
        {step === 'generate' && (
          <section className="rounded-2xl border border-slate-200 bg-white px-4 py-6 max-w-lg">
            <h2 className="text-sm font-semibold text-[#0f1d35] mb-4">④ Generate survey paper</h2>
            <dl className="space-y-2 mb-6 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Papers in evidence set</dt>
                <dd className="font-semibold text-[#0f1d35]">{evidenceTotal}</dd>
              </div>
              <div className="flex justify-between items-center">
                <dt className="text-slate-500">Target length</dt>
                <dd className="flex items-center gap-2">
                  <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                    {PAGE_PRESETS.map((pages) => (
                      <button key={pages} onClick={() => void patchEmphasis({ targetWords: pages * WORDS_PER_PAGE })} disabled={busy}
                        className={`px-3 py-1 text-sm font-medium transition ${currentPages === pages ? 'bg-teal-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{pages}p</button>
                    ))}
                  </div>
                  <span className="text-xs text-slate-400">≈ {targetWords.toLocaleString()} words</span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Outline</dt>
                <dd className={`font-semibold ${outlineConfirmed ? 'text-teal-600' : 'text-slate-400'}`}>{outlineConfirmed ? '✓ confirmed' : 'not confirmed'}</dd>
              </div>
            </dl>
            <div className="mb-4"><SynthesisModelBadge /></div>
            <button
              onClick={() => void handleGenerate()}
              disabled={evidenceTotal === 0 || generating}
              className="w-full rounded-xl bg-indigo-600 text-white px-6 py-3 text-base font-semibold hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              title={evidenceTotal === 0 ? 'Add at least one paper first' : 'Generate the survey from this plan'}
            >
              {generating ? 'Starting…' : 'Generate survey paper →'}
            </button>
            {evidenceTotal === 0 && (
              <p className="text-xs text-rose-600 mt-2 text-center">Add at least one paper in the Evidence step first.</p>
            )}
          </section>
        )}

      </div>
    </div>
  );
}
