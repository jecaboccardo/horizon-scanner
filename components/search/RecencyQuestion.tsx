// components/search/RecencyQuestion.tsx
// Three-way recency choice:
//   'recent'   → HARD floor year >= 2020 (timePeriod='recent', 2026-06-17) + recent recall channel
//   '2000plus' → hard floor year >= 2000 (no channel change)
//   'all'      → all years (1961+), no filter
import React from 'react';

export type RecencyChoice = 'recent' | '2000plus' | 'all';

export interface RecencyQuestionProps {
  choice: RecencyChoice;
  onChange: (c: RecencyChoice) => void;
}

const OPTIONS: { id: RecencyChoice; label: string; tag?: string; hint: string }[] = [
  {
    id: 'recent',
    label: 'Recent frontier (2020+)',
    hint: 'Emphasize working papers and studies published 2020 or later.',
  },
  {
    id: '2000plus',
    label: 'From 2000 onwards',
    hint: 'Include evidence from 2000 to present — excludes older historical studies.',
  },
  {
    id: 'all',
    label: 'All years (1961+)',
    tag: 'recommended',
    hint: 'Balance recent evidence with foundational classics across the full corpus.',
  },
];

export function RecencyQuestion({ choice, onChange }: RecencyQuestionProps) {
  return (
    <div>
      <div className="flex flex-col gap-2">
        {OPTIONS.map((opt) => {
          const selected = choice === opt.id;
          return (
            <label
              key={opt.id}
              className={`flex items-start gap-2.5 rounded-xl border-2 px-3 py-2.5 cursor-pointer transition ${
                selected ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <input
                type="radio"
                name="recencyFocus"
                checked={selected}
                onChange={() => onChange(opt.id)}
                className="mt-0.5 h-3.5 w-3.5 accent-teal-600 shrink-0"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`font-semibold text-[12px] leading-tight ${selected ? 'text-teal-800' : 'text-slate-700'}`}>
                    {opt.label}
                  </span>
                  {opt.tag && (
                    <span className="text-[9px] font-semibold text-teal-600 bg-teal-50 border border-teal-200 rounded px-1 py-px">
                      {opt.tag}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 leading-snug mt-0.5">{opt.hint}</div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
