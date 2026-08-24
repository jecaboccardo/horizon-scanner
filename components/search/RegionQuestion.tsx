// components/search/RegionQuestion.tsx
import React from 'react';

export interface RegionQuestionProps {
  regions: string[];
  setRegions: (r: string[]) => void;
}

// label = display text; key = ux_region bucket stored in filters.regions. The server
// matches it against each paper's geography-derived works.ux_region (soft boost + floor,
// never a hard exclude). 'USA and Canada' groups US+Canada (the column's bucket name).
// LAC is a region like any other (2026-06-12) — it writes to filters.regions and
// gets the same "strong preference, never exclude" treatment as every region. It
// used to be a special soft `lac` CHANNEL while other regions were hard excludes;
// that asymmetry silently dropped on-topic canon. isLac is retained = false on all
// presets (the lacOn/setLac props are now inert).
const REGION_PRESETS: { id: string; label: string; key: string; isLac: boolean }[] = [
  { id: 'lac',    label: 'Latin America & Caribbean', key: 'LAC',                    isLac: false },
  { id: 'ssa',    label: 'Sub-Saharan Africa',         key: 'Sub-Saharan Africa',     isLac: false },
  { id: 'asia',   label: 'South / Southeast Asia',     key: 'South & Southeast Asia', isLac: false },
  { id: 'usa',    label: 'USA & Canada',               key: 'USA and Canada',         isLac: false },
  { id: 'europe', label: 'Europe & Central Asia',      key: 'Europe & Central Asia',  isLac: false },
  { id: 'mena',   label: 'Middle East & North Africa', key: 'MENA',                   isLac: false },
];

export function RegionQuestion({ regions, setRegions }: RegionQuestionProps) {
  const specific = regions.length > 0;

  function selectNone() {
    setRegions([]);
  }

  function selectSpecific() {
    // Just open the picker — don't pre-select anything
  }

  function togglePreset(preset: typeof REGION_PRESETS[number]) {
    const next = regions.includes(preset.key)
      ? regions.filter((r) => r !== preset.key)
      : [...regions, preset.key];
    setRegions(next);
  }

  function isPresetOn(preset: typeof REGION_PRESETS[number]): boolean {
    return regions.includes(preset.key);
  }

  const cardBase =
    'flex items-start gap-3 rounded-xl border-2 px-4 py-3 cursor-pointer transition select-none';
  const cardOn  = `${cardBase} border-teal-500 bg-teal-50`;
  const cardOff = `${cardBase} border-slate-200 bg-white hover:border-slate-300`;

  const chipBase =
    'rounded-full px-3 py-1.5 text-[11px] font-semibold border transition cursor-pointer select-none';
  const chipOn  = `${chipBase} border-teal-600 bg-teal-100 text-teal-800`;
  const chipOff = `${chipBase} border-slate-200 bg-white text-slate-600 hover:border-teal-300`;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-700 mb-3">
        Is this question specific to a region?
      </p>

      <div className="flex flex-col gap-2">
        {/* No preference */}
        <div className={specific ? cardOff : cardOn} onClick={selectNone}>
          <div className="mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center
            border-teal-500 bg-white transition">
            {!specific && <div className="h-2 w-2 rounded-full bg-teal-500" />}
          </div>
          <div>
            <div className={`font-semibold text-[13px] leading-tight ${!specific ? 'text-teal-800' : 'text-slate-700'}`}>
              No preference
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
              All regions — the brief draws regional implications from global evidence.
            </div>
          </div>
        </div>

        {/* Other region */}
        <div className={specific ? cardOn : cardOff} onClick={selectSpecific}>
          <div className="mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center
            border-teal-500 bg-white transition">
            {specific && <div className="h-2 w-2 rounded-full bg-teal-500" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`font-semibold text-[13px] leading-tight ${specific ? 'text-teal-800' : 'text-slate-700'}`}>
              Specific region
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
              Prioritise evidence from a particular region or country.
            </div>

            {/* Region chips — always visible so user can tap to activate */}
            <div className="flex flex-wrap gap-1.5 mt-3">
              {REGION_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); togglePreset(preset); }}
                  className={isPresetOn(preset) ? chipOn : chipOff}
                  aria-pressed={isPresetOn(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
