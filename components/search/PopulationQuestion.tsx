// components/search/PopulationQuestion.tsx
// Option C: pure text input with inline detected-tag feedback (2026-06-10).
// No chip grid. value[0] = raw text entered; empty array = no focus.
import React, { useEffect, useRef, useState } from 'react';
import { POPULATION_GROUPS } from '../../utils/queryIntent';

export interface PopulationQuestionProps {
  value: string[];
  onChange: (v: string[]) => void;
  /** Pre-detected labels from the main query — used to pre-fill the input. */
  detected: string[];
}

function detectFromText(text: string): string[] {
  if (!text.trim()) return [];
  return POPULATION_GROUPS
    .filter((g) => {
      const escaped = g.keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i').test(text);
    })
    .map((g) => g.label);
}

export function PopulationQuestion({ value, onChange, detected }: PopulationQuestionProps) {
  const text = value[0] ?? '';
  const hasYes = value.length > 0;
  const [showInput, setShowInput] = useState(hasYes);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pre-fill from detected labels on first render if nothing is set yet
  useEffect(() => {
    if (detected.length > 0 && value.length === 0) {
      // Show the input pre-seeded with the detected text (ask-to-confirm)
      const hint = detected.join(', ');
      setShowInput(true);
      onChange([hint]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleYes() {
    setShowInput(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleNo() {
    setShowInput(false);
    onChange([]);
  }

  function handleTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    onChange(v ? [v] : []);
  }

  const detectedTags = detectFromText(text);

  const cardBase =
    'flex items-start gap-3 rounded-xl border-2 px-4 py-3 cursor-pointer transition select-none';
  const cardOn  = `${cardBase} border-teal-500 bg-teal-50`;
  const cardOff = `${cardBase} border-slate-200 bg-white hover:border-slate-300`;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-700 mb-1">
        Any specific population to focus on?
      </p>
      <p className="text-[10px] text-slate-500 mb-3 leading-snug">
        Optional — shapes the brief's emphasis and gives matching papers a soft boost.
      </p>

      <div className="flex flex-col gap-2">
        {/* No */}
        <div className={!showInput ? cardOn : cardOff} onClick={handleNo}>
          <div className="mt-0.5 h-4 w-4 rounded-full border-2 border-teal-500 bg-white flex items-center justify-center shrink-0">
            {!showInput && <div className="h-2 w-2 rounded-full bg-teal-500" />}
          </div>
          <div>
            <div className={`font-semibold text-[13px] leading-tight ${!showInput ? 'text-teal-800' : 'text-slate-700'}`}>
              No, general population
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              Include all groups — no emphasis filter.
            </div>
          </div>
        </div>

        {/* Yes */}
        <div className={showInput ? cardOn : cardOff} onClick={handleYes}>
          <div className="mt-0.5 h-4 w-4 rounded-full border-2 border-teal-500 bg-white flex items-center justify-center shrink-0">
            {showInput && <div className="h-2 w-2 rounded-full bg-teal-500" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`font-semibold text-[13px] leading-tight ${showInput ? 'text-teal-800' : 'text-slate-700'}`}>
              Yes
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              Describe the group you care about.
            </div>

            {showInput && (
              <div className="mt-3">
                <input
                  ref={inputRef}
                  type="text"
                  value={text}
                  onChange={handleTextChange}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. women, rural youth, low-income families…"
                  className="w-full rounded-lg border border-teal-400 px-3 py-2 text-[12px] text-slate-800 placeholder-slate-400 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-300"
                />
                {detectedTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <span className="text-[10px] text-slate-400">Matched:</span>
                    {detectedTags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2.5 py-0.5 text-[10px] font-semibold text-teal-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
