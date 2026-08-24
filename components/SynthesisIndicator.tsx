import React, { useEffect, useState } from 'react';

interface Props {
  phase: 'retrieving' | 'awaiting' | 'synthesizing' | 'idle';
  evidenceCount?: number;
  universeCount?: number;
  retrievedCount?: number;
  /** kept for backward compatibility — no longer rendered (we hide construction). */
  streamingText?: string;
}

const RETRIEVING_PHRASES = [
  'Horizon scanning 500,000+ papers',
  'Horizon ranking',
  'Horizon screening',
];

const SYNTHESIZING_PHRASES = [
  'Horizon developing',
  'Horizon weighing evidence',
  'Horizon briefing',
];

const ROTATE_MS = 2500;

export default function SynthesisIndicator({
  phase,
  evidenceCount,
  universeCount,
  retrievedCount,
}: Props) {
  const [phraseIdx, setPhraseIdx] = useState(0);

  useEffect(() => {
    if (phase !== 'synthesizing' && phase !== 'retrieving') return;
    setPhraseIdx(0);
    const id = setInterval(() => setPhraseIdx((i) => i + 1), ROTATE_MS);
    return () => clearInterval(id);
  }, [phase]);

  if (phase === 'idle') return null;

  if (phase === 'awaiting') {
    return (
      <div className="flex items-center gap-2.5 rounded-xl bg-teal-50 border border-teal-200 px-4 py-3 text-sm text-teal-700">
        <svg className="w-4 h-4 text-teal-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
        <span className="font-medium">
          {evidenceCount != null ? `${evidenceCount} papers retrieved` : 'Evidence retrieved'}
          {' '}· Select audience below to synthesize
        </span>
      </div>
    );
  }

  // retrieving or synthesizing — clean spinner + rotating Horizon phrase
  const phrases = phase === 'retrieving' ? RETRIEVING_PHRASES : SYNTHESIZING_PHRASES;
  const phrase = phrases[phraseIdx % phrases.length];
  const hasCounts =
    universeCount != null || retrievedCount != null || evidenceCount != null;

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-white border border-slate-200 shadow-sm px-6 py-12">
      <svg
        className="animate-spin h-7 w-7 text-teal-600"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>

      <div
        key={phrase}
        className="text-base font-medium text-slate-700 animate-fadeInUp"
      >
        {phrase}…
      </div>

      {hasCounts && (
        <div className="text-[11px] text-slate-400 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          {universeCount != null && (
            <span>
              <strong className="text-slate-600 tabular-nums">{universeCount.toLocaleString()}</strong>{' '}
              universe
            </span>
          )}
          {retrievedCount != null && (
            <>
              <span className="text-slate-300">·</span>
              <span>
                <strong className="text-slate-600 tabular-nums">{retrievedCount}</strong> retrieved
              </span>
            </>
          )}
          {evidenceCount != null && evidenceCount > 0 && (
            <>
              <span className="text-slate-300">·</span>
              <span>
                <strong className="text-teal-600 tabular-nums">{evidenceCount}</strong> evidence
              </span>
            </>
          )}
        </div>
      )}

      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeInUp { animation: fadeInUp 350ms ease-out both; }
      `}</style>
    </div>
  );
}
