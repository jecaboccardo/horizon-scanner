// components/PaperBuildFork.tsx
//
// "What do you want to do next" fork, shown right after the 6 clarifier
// questions (before retrieval runs). The user picks one of two doors; both run
// the SAME 6-question retrieval (the shared source of truth), then route:
//   • Generate Now          → write the JEL-style survey paper (Paper Studio,
//                              where the creative-planner evidence expansion
//                              lives). The longer path — stated upfront.
//   • Create Brief / later   → the original 5-section evidence brief; the user
//                              can open Paper Studio later from the brief.
// App.tsx owns the choice + the handlers; this fetches synthesis-access only to
// decide the Generate-Now model option (Claude when the admin has granted it).
import { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';

interface PaperBuildForkProps {
  onGenerateNow: (mode: 'deep' | 'standard') => void;
  onCreateBrief: () => void;
  /** Optional — return to the clarifier to edit the questions. */
  onBack?: () => void;
  /** True while a paper plan is being seeded / search is starting. */
  generating?: boolean;
}

export default function PaperBuildFork({ onGenerateNow, onCreateBrief, onBack, generating }: PaperBuildForkProps) {
  // Synthesis access — Claude is offered only when an admin (BYOK) has granted it.
  const [access, setAccess] = useState<Awaited<ReturnType<typeof apiClient.getSynthesisAccess>> | null>(null);
  useEffect(() => {
    let on = true;
    apiClient.getSynthesisAccess().then((r) => { if (on) setAccess(r); }).catch(() => {});
    return () => { on = false; };
  }, []);
  const claudeGranted = !!access
    && (access.status === 'granted' || access.ownKey === true)
    && (access.provider === 'claude' || /claude/i.test(access.model || ''));
  const requestEmail = access?.requestFromEmail || 'rafaelde@iadb.org';

  return (
    <section data-print-hide className="rounded-2xl bg-gradient-to-br from-slate-50 to-white p-6 border-4 border-teal-500 shadow-xl ring-4 ring-teal-100 space-y-5">
      <div>
        <p className="text-[10px] uppercase tracking-[0.2em] text-teal-700 font-bold mb-1">What next?</p>
        <h3 className="text-lg font-bold text-slate-900">Your search is set — what do you want to create?</h3>
        <p className="text-sm text-slate-600 mt-1">Both options run the same evidence search. You can switch later.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Door 1 — Generate Now (JEL survey paper) */}
        <div
          className="text-left rounded-2xl border-2 border-teal-200 hover:border-teal-400 bg-gradient-to-br from-teal-50/60 to-white p-6 flex flex-col gap-3 min-h-[200px]"
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl">✍️</span>
            <span className="text-base font-bold text-slate-900">Generate Now</span>
          </div>
          <p className="text-sm text-slate-600 flex-1">
            Write a structured <span className="font-semibold">10-page survey paper</span> from this evidence —
            stronger reasoning, names real seminal papers.
            {claudeGranted
              ? ' Runs on your team’s Claude model.'
              : ' Claude is available once your admin grants access.'}
          </p>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              {claudeGranted ? (
                // Granted: the deep path runs on the team's Claude key (BYOK), so the
                // primary action IS Claude. Qwen is intentionally not offered here.
                <button type="button" disabled={generating}
                  onClick={() => onGenerateNow('deep')}
                  title="Generates on your team's Claude key"
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold disabled:opacity-50">
                  🧠 Generate with Claude
                </button>
              ) : (
                <>
                  <button type="button" disabled={generating}
                    onClick={() => onGenerateNow('deep')}
                    className="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold disabled:opacity-50">
                    ✨ Deep (Gemini)
                  </button>
                  <button type="button" disabled
                    title={`Request Claude access from ${requestEmail}`}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-400 text-sm font-semibold cursor-not-allowed">
                    🔒 Claude
                  </button>
                </>
              )}
            </div>
            {claudeGranted
              ? (access?.grantedByEmail && (
                  <span className="text-[10px] text-slate-400">Claude access granted by {access.grantedByEmail}.</span>
                ))
              : (
                <span className="text-[10px] text-slate-400">
                  To generate with Claude, request access from <span className="font-medium text-slate-500">{requestEmail}</span>.
                </span>
              )}
          </div>
        </div>

        {/* Door 2 — Create Brief / decide later (original flow) */}
        <button
          type="button"
          onClick={onCreateBrief}
          disabled={generating}
          className="group text-left rounded-2xl border-2 border-slate-200 hover:border-slate-400 bg-white p-6 transition disabled:opacity-60 flex flex-col gap-3 min-h-[200px]"
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl">📄</span>
            <span className="text-base font-bold text-slate-900">Create Brief / decide later</span>
          </div>
          <p className="text-sm text-slate-600 flex-1">
            Generate the <span className="font-semibold">5-section evidence brief</span> now — synthesis,
            methodology, coverage, follow-ups. You can write a survey paper later from the brief.
          </p>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
              Faster · the usual flow
            </span>
            <span className="text-slate-700 font-semibold text-sm group-hover:translate-x-0.5 transition">
              Build the brief →
            </span>
          </div>
        </button>
      </div>

      {onBack && (
        <button
          type="button"
          onClick={onBack}
          disabled={generating}
          className="text-[11px] font-semibold text-slate-500 hover:text-teal-700 disabled:opacity-40 transition flex items-center gap-1"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to questions
        </button>
      )}
    </section>
  );
}
