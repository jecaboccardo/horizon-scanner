import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface YearsValue {
  startYear: number | null;
  endYear: number | null;
}

interface YearsPickerProps {
  value: YearsValue;
  onChange: (next: YearsValue) => void;
  onClose: () => void;
}

const CURRENT_YEAR = new Date().getFullYear();
const MIN_CORPUS_YEAR = 1961;

export const summariseYears = (v: YearsValue): string => {
  if (v.startYear == null && v.endYear == null) return 'All years (1961+)';
  if (v.startYear === 2020 && (v.endYear == null || v.endYear === CURRENT_YEAR)) return '2020-present';
  if (v.startYear != null && v.endYear == null) return `${v.startYear}+`;
  if (v.startYear == null && v.endYear != null) return `≤${v.endYear}`;
  return `${v.startYear}–${v.endYear}`;
};

export const YearsPicker: React.FC<YearsPickerProps> = ({ value, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [startText, setStartText] = React.useState(value.startYear != null ? String(value.startYear) : '');
  const [endText, setEndText] = React.useState(value.endYear != null ? String(value.endYear) : '');

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const apply = (preset: string) => {
    let next: { startYear: number | null; endYear: number | null } | null = null;
    if (preset === 'latest') next = { startYear: Math.max(2024, CURRENT_YEAR - 2), endYear: CURRENT_YEAR };
    if (preset === 'last10') next = { startYear: CURRENT_YEAR - 10, endYear: CURRENT_YEAR };
    if (preset === '2020')   next = { startYear: 2020, endYear: null };
    if (preset === '2010')   next = { startYear: 2010, endYear: CURRENT_YEAR };
    if (preset === 'all')    next = { startYear: null, endYear: null };
    if (!next) return;
    setStartText(next.startYear != null ? String(next.startYear) : '');
    setEndText(next.endYear != null ? String(next.endYear) : '');
    onChange(next);
  };

  const updateStart = (v: string) => {
    if (v.length === 4) {
      const n = Number(v);
      onChange({ ...value, startYear: Number.isFinite(n) ? n : null });
    } else if (v.length === 0) {
      onChange({ ...value, startYear: null });
    }
    // partial (1-3 digits): keep startYearText visible but don't commit to state
  };
  const updateEnd = (v: string) => {
    if (v.length === 4) {
      const n = Number(v);
      onChange({ ...value, endYear: Number.isFinite(n) ? n : null });
    } else if (v.length === 0) {
      onChange({ ...value, endYear: null });
    }
  };

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-2 w-[380px] bg-white border border-slate-200 rounded-2xl shadow-xl p-5 z-50"
      onClick={(e) => e.stopPropagation()}
    >
      <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-3">Year range</h4>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <button type="button" onClick={() => apply('latest')}  className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">Latest ({Math.max(2024, CURRENT_YEAR - 2)}+)</button>
        <button type="button" onClick={() => apply('last10')} className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">Last 10y</button>
        <button type="button" onClick={() => apply('2020')}   className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">Recent (2020+)</button>
        <button type="button" onClick={() => apply('2010')}   className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">2010+</button>
        <button type="button" onClick={() => apply('all')}    className="px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-md text-xs text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700">All ({MIN_CORPUS_YEAR}–{CURRENT_YEAR})</button>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          maxLength={4}
          value={startText}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 4);
            setStartText(v);
            updateStart(v);
          }}
          onKeyDown={(e) => {
            e.stopPropagation(); // prevent Enter from firing parent search handler
            if (e.key === 'Enter') e.preventDefault();
            if (e.key === 'Escape') onClose();
          }}
          placeholder={`From (${MIN_CORPUS_YEAR})`}
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
        />
        <span className="text-slate-500 text-sm">to</span>
        <input
          type="text"
          inputMode="numeric"
          maxLength={4}
          value={endText}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 4);
            setEndText(v);
            updateEnd(v);
          }}
          onKeyDown={(e) => {
            e.stopPropagation(); // prevent Enter from firing parent search handler
            if (e.key === 'Enter') e.preventDefault();
            if (e.key === 'Escape') onClose();
          }}
          placeholder={`To (${CURRENT_YEAR})`}
          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
        />
      </div>

      <div className="flex justify-end pt-3 mt-3 border-t border-slate-200">
        <button type="button" onClick={onClose} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-100">Done</button>
      </div>
    </div>
  );
};

export default YearsPicker;
