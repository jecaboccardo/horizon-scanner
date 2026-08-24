// components/search/EvidenceTypeQuestion.tsx
// Causal + foundational channel checkboxes — extracted from SearchIntentCard.tsx
import React from 'react';
import type { ChannelId } from '../../types';

export interface EvidenceTypeQuestionProps {
  channels: Set<string>;
  setChannel: (id: 'causal' | 'foundational', on: boolean) => void;
}

const EVIDENCE_CHANNEL_OPTIONS: { id: 'causal' | 'foundational'; label: string; hint: string }[] = [
  {
    id: 'causal',
    label: 'Causal evidence',
    hint: 'RCTs, DiD, IV, natural experiments — high SMS score',
  },
  {
    id: 'foundational',
    label: 'Foundational / macro',
    hint: 'Highly-cited theory & cross-country empirical (Hanushek, Barro, Card…)',
  },
];

export function EvidenceTypeQuestion({ channels, setChannel }: EvidenceTypeQuestionProps) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-700 mb-2">
        What type of evidence matters for your question?
      </p>
      <div className="grid grid-cols-2 gap-2">
        {EVIDENCE_CHANNEL_OPTIONS.map((opt) => {
          const checked = channels.has(opt.id);
          return (
            <label
              key={opt.id}
              className={`flex items-start gap-2 rounded-xl border-2 px-3 py-2.5 cursor-pointer transition ${
                checked ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => setChannel(opt.id, !checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded accent-teal-600 shrink-0"
              />
              <div className="min-w-0">
                <div
                  className={`font-semibold text-[12px] leading-tight ${
                    checked ? 'text-teal-800' : 'text-slate-700'
                  }`}
                >
                  {opt.label}
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
