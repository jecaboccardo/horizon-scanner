import React, { useEffect, useRef, useState } from 'react';

const LAC_COUNTRIES = [
  'Brazil', 'Mexico', 'Colombia', 'Argentina', 'Chile', 'Peru', 'Ecuador',
  'Venezuela', 'Bolivia', 'Paraguay', 'Uruguay',
  'Costa Rica', 'Panama', 'Guatemala', 'Honduras', 'El Salvador', 'Nicaragua',
  'Dominican Republic', 'Haiti', 'Jamaica', 'Trinidad and Tobago', 'Barbados',
];
const NORTH_AMERICA = ['United States', 'Canada'];
const EUROPE = ['United Kingdom', 'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Sweden', 'EU (all)'];
const REST = ['Sub-Saharan Africa', 'MENA', 'South Asia', 'East Asia & Pacific'];

interface RegionPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
}

export const summariseRegions = (regions: string[]): string => {
  if (regions.length === 0) return 'Global';
  if (regions.length === 1) return regions[0];
  if (regions.includes('LAC')) return regions.length === 1 ? 'LAC' : `LAC + ${regions.length - 1}`;
  return `${regions.length} regions`;
};

export const RegionPicker: React.FC<RegionPickerProps> = ({ value, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const toggle = (region: string) => {
    const next = value.includes(region) ? value.filter((x) => x !== region) : [...value, region];
    onChange(next);
  };

  // Presets are mutually-exclusive shortcuts. Clicking the active preset again
  // deselects (returns to Global / empty). Clicking a non-active preset replaces
  // the current selection. Global is the empty-state — clicking it just clears.
  const presetTargets: Record<string, string[]> = {
    global: [],
    lac: ['LAC'],
    oecd: ['OECD'],
    high: ['High-income'],
    lmi: ['Low- and middle-income'],
  };
  const isPresetActive = (preset: string): boolean => {
    if (preset === 'global') return value.length === 0;
    const target = presetTargets[preset];
    return value.length === target.length && target.every((t) => value.includes(t));
  };
  const apply = (preset: string) => {
    if (isPresetActive(preset) && preset !== 'global') {
      onChange([]);
      return;
    }
    onChange(presetTargets[preset] ?? []);
  };

  const matches = (s: string) => !search || s.toLowerCase().includes(search.toLowerCase());

  const renderGroup = (label: string, items: string[]) => {
    const filtered = items.filter(matches);
    if (filtered.length === 0) return null;
    return (
      <div className="mt-3">
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 px-1">{label}</div>
        <div className="grid grid-cols-2 gap-x-2">
          {filtered.map((c) => (
            <label key={c} className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-slate-100 cursor-pointer">
              <input type="checkbox" checked={value.includes(c)} onChange={() => toggle(c)} className="accent-teal-600" />
              <span className="text-sm text-slate-900">{c}</span>
            </label>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-2 w-[540px] bg-white border border-slate-200 rounded-2xl shadow-xl p-5 z-50"
      onClick={(e) => e.stopPropagation()}
    >
      <h4 className="text-xs font-bold uppercase tracking-wider text-teal-700 mb-3">Country / region</h4>

      <input
        type="search"
        placeholder="Search countries…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full mb-3 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
      />

      <div className="flex flex-wrap gap-1.5 mb-2">
        <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mr-1 self-center">Quick:</span>
        {([
          { id: 'global', label: 'Global' },
          { id: 'lac', label: 'LAC (all)' },
          { id: 'oecd', label: 'OECD' },
          { id: 'high', label: 'High-income' },
          { id: 'lmi', label: 'Low- & middle-income' },
        ] as const).map((p) => {
          const active = isPresetActive(p.id);
          return (
            <button
              key={p.id}
              onClick={() => apply(p.id)}
              title={active && p.id !== 'global' ? `Click to deselect — switches back to Global` : undefined}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition ${
                active
                  ? 'bg-teal-600 text-white border-teal-700 shadow-sm'
                  : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-teal-50 hover:border-teal-600 hover:text-teal-700'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="max-h-72 overflow-y-auto pr-1">
        {renderGroup('Latin America & Caribbean', LAC_COUNTRIES)}
        {renderGroup('North America', NORTH_AMERICA)}
        {renderGroup('Europe', EUROPE)}
        {renderGroup('Africa · Asia · Oceania', REST)}
      </div>

      <div className="flex justify-between items-center pt-3 mt-3 border-t border-slate-200">
        <span className="text-xs text-slate-500">Selecting a region = ANY of its countries match</span>
        <button onClick={onClose} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-100">Done</button>
      </div>
    </div>
  );
};

export default RegionPicker;
