import React, { useEffect, useMemo, useRef } from 'react';

const SMS_LEVELS: { level: number; short: string; full: string }[] = [
  { level: 5, short: 'RCT', full: 'Randomized controlled trial or strongest experimental design.' },
  { level: 4, short: 'Quasi-causal', full: 'Instrumental variables, regression discontinuity, difference-in-differences, or similarly credible comparison design.' },
  { level: 3, short: 'Structured empirical', full: 'Empirical observational evidence with controls, matching, panel data, modeling, or structured quantitative/qualitative analysis.' },
  { level: 2, short: 'Descriptive empirical', full: 'Descriptive statistics, diagnostics, surveys, before/after evidence, case studies, or implementation reports.' },
  { level: 1, short: 'Weak empirical', full: 'Limited empirical support, qualitative context, or evidence with unclear design.' },
  { level: 0, short: 'Review / theory', full: 'Literature review, theoretical paper, conceptual work, or background context.' },
];

const RIGOR_PRESETS = [
  {
    id: 'all',
    label: 'All evidence, ranked by strength',
    hint: 'Includes SMS 0-5. Best default: keep useful context, but rank stronger evidence first.',
    levels: [] as number[],
  },
  {
    id: 'empirical',
    label: 'Empirical only',
    hint: 'Includes SMS 2-5. Removes theory, opinion, reviews, and background-only records.',
    levels: [2, 3, 4, 5],
  },
  {
    id: 'causal',
    label: 'Strong causal only',
    hint: 'Includes SMS 4-5. Best for impact, effectiveness, and intervention questions.',
    levels: [4, 5],
  },
  {
    id: 'reviews',
    label: 'Reviews and syntheses',
    hint: 'Includes SMS 0 and review/theory records. Useful for background, syntheses, and framing.',
    levels: [0],
  },
] as const;

interface RigorPickerProps {
  value: number[];
  onChange: (next: number[]) => void;
  onClose: () => void;
}

const normalize = (levels: readonly number[]): string => [...levels].sort((a, b) => a - b).join(',');

export const summariseRigor = (smsLevels: number[]): string => {
  const normalized = normalize(smsLevels);
  if (normalized === '' || normalized === '0,1,2,3,4,5') return 'All, ranked';
  if (normalized === '2,3,4,5') return 'Empirical';
  if (normalized === '4,5') return 'Strong causal';
  if (normalized === '0') return 'Reviews';

  const sorted = [...smsLevels].sort((a, b) => b - a);
  const max = sorted[0];
  const min = sorted[sorted.length - 1];
  if (sorted.length === 1) return `SMS ${max}`;
  if (max - min + 1 === sorted.length) return `SMS ${min}-${max}`;
  return `SMS ${sorted.join(',')}`;
};

export const RigorPicker: React.FC<RigorPickerProps> = ({ value, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const activePresetId = useMemo(() => {
    const selected = normalize(value);
    if (selected === '' || selected === '0,1,2,3,4,5') return 'all';
    return RIGOR_PRESETS.find((preset) => normalize(preset.levels) === selected)?.id ?? null;
  }, [value]);

  const toggleLevel = (level: number) => {
    const next = value.includes(level) ? value.filter((x) => x !== level) : [...value, level];
    onChange(next);
  };

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-2 w-[520px] bg-white border border-slate-200 rounded-2xl shadow-xl p-5 z-50"
      onClick={(e) => e.stopPropagation()}
    >
      <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-3">
        Rigor - SMS methodology strength
      </h4>

      <div className="space-y-2">
        {RIGOR_PRESETS.map((preset) => {
          const active = activePresetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange([...preset.levels])}
              className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border transition ${
                active
                  ? 'bg-teal-50 border-teal-600 ring-2 ring-teal-100'
                  : 'bg-white border-slate-200 hover:bg-slate-50'
              }`}
            >
              <span className={`mt-0.5 h-4 w-4 rounded-full border ${active ? 'border-[5px] border-teal-600' : 'border-slate-300'}`} />
              <span className="flex-1">
                <span className="block text-sm font-semibold text-slate-900">{preset.label}</span>
                <span className="block text-xs text-slate-600 mt-0.5">{preset.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <details className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold text-slate-700">SMS scale definitions</summary>
        <div className="space-y-1 mt-2">
          {SMS_LEVELS.map(({ level, short, full }) => (
            <div key={level} className="flex items-start gap-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-900 w-12">SMS {level}</span>
              <span className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-semibold text-slate-700">
                {short}
              </span>
              <span className="flex-1">{full}</span>
            </div>
          ))}
        </div>
      </details>

      <details className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold text-slate-700">Custom SMS levels</summary>
        <div className="space-y-1 mt-2">
          {SMS_LEVELS.map(({ level, short, full }) => (
            <label key={level} className="flex items-start gap-3 px-2 py-2 rounded-md hover:bg-slate-100 cursor-pointer">
              <input
                type="checkbox"
                checked={value.includes(level)}
                onChange={() => toggleLevel(level)}
                className="accent-teal-600 mt-0.5"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">SMS {level}</span>
                  <span className="px-2 py-0.5 bg-slate-100 rounded text-[11px] font-semibold text-slate-700">{short}</span>
                </div>
                <div className="text-xs text-slate-600 mt-0.5">{full}</div>
              </div>
            </label>
          ))}
        </div>
      </details>

      <div className="flex justify-between items-center pt-3 mt-3 border-t border-slate-200">
        <span className="text-xs text-slate-500">SMS = Scientific Methodology Strength</span>
        <button onClick={onClose} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-100">
          Done
        </button>
      </div>
    </div>
  );
};

export default RigorPicker;
