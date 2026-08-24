import React, { useState } from 'react';
import { PlannerAddedPaper, PlannerDroppedProposal } from '../types';

interface Props {
  added: PlannerAddedPaper[];
  dropped: PlannerDroppedProposal[];
  model: string | null;
  onAccept: (ids: string[]) => void;
  onCancel: () => void;
}

const SMS_BADGE: Record<number, string> = {
  5: 'bg-emerald-100 text-emerald-800',
  4: 'bg-teal-100 text-teal-800',
  3: 'bg-sky-100 text-sky-800',
  2: 'bg-slate-100 text-slate-600',
  1: 'bg-slate-100 text-slate-500',
  0: 'bg-slate-50 text-slate-400',
};

function SmsBadge({ level }: { level: number | null }) {
  if (level == null) return null;
  const cls = SMS_BADGE[level] ?? 'bg-slate-100 text-slate-500';
  const label = level >= 5 ? 'RCT' : level >= 4 ? 'QE' : level >= 3 ? 'Quasi-exp' : level >= 2 ? 'Observational' : level >= 1 ? 'Descriptive' : 'Review';
  return <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${cls}`}>SMS {level} · {label}</span>;
}

interface PaperRowProps {
  key?: React.Key;
  p: PlannerAddedPaper;
  checked: boolean;
  onToggle: (id: string) => void;
}

function PaperRow({ p, checked, onToggle }: PaperRowProps) {
  return (
    <label className={`flex gap-3 p-3 rounded-lg cursor-pointer hover:bg-slate-50 border ${checked ? 'border-teal-200 bg-teal-50/30' : 'border-transparent'}`}>
      <input type="checkbox" className="mt-0.5 accent-teal-600" checked={checked} onChange={() => onToggle(p.id)} />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
          <SmsBadge level={p.smsLevel} />
          <span className="text-[10px] text-slate-400">rel {p.similarity.toFixed(2)}</span>
          <span className="text-[10px] italic text-violet-600">{p.why}</span>
        </div>
        <div className="text-sm font-medium text-slate-800 leading-snug" dangerouslySetInnerHTML={{ __html: p.title }} />
        <div className="text-[11px] text-slate-500 mt-0.5">
          {p.authors?.slice(0, 3).join(', ')}{(p.authors?.length ?? 0) > 3 ? ' et al.' : ''}
          {p.year ? ` · ${p.year}` : ''}
          {p.citationCount != null ? ` · ${p.citationCount.toLocaleString()} cites` : ''}
        </div>
      </div>
    </label>
  );
}

export function EvidenceExpansionReview({ added, dropped, model, onAccept, onCancel }: Props) {
  const evidence = added.filter(p => p.tier === 'evidence');
  const context = added.filter(p => p.tier === 'context');

  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set(evidence.map(p => p.id)));
  const [showDropped, setShowDropped] = useState(false);

  const toggle = (id: string) => setCheckedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAll = (ids: string[], select: boolean) => setCheckedIds(prev => {
    const next = new Set(prev);
    ids.forEach(id => select ? next.add(id) : next.delete(id));
    return next;
  });

  const selectedCount = checkedIds.size;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800">
            Evidence scan · {model ?? 'AI'} found {added.length} paper{added.length !== 1 ? 's' : ''}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Strong evidence is pre-checked · context papers are unchecked — review before adding
          </div>
        </div>
      </div>

      <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-50">
        {evidence.length > 0 && (
          <div className="px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-teal-700">🔬 Strong evidence</span>
                <span className="text-[10px] bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded-full font-semibold">{evidence.length}</span>
                <span className="text-[10px] text-slate-400">SMS ≥ 3 · RCT / QE / meta-analysis</span>
              </div>
              <div className="flex gap-2 text-[10px] text-teal-600">
                <button onClick={() => toggleAll(evidence.map(p => p.id), true)} className="hover:underline">All</button>
                <button onClick={() => toggleAll(evidence.map(p => p.id), false)} className="hover:underline">None</button>
              </div>
            </div>
            <div className="space-y-1">
              {evidence.map(p => <PaperRow key={p.id} p={p} checked={checkedIds.has(p.id)} onToggle={toggle} />)}
            </div>
          </div>
        )}

        {context.length > 0 && (
          <div className="px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">📚 Background context</span>
                <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full font-semibold">{context.length}</span>
                <span className="text-[10px] text-slate-400">reviews, theory — unchecked by default</span>
              </div>
              <div className="flex gap-2 text-[10px] text-slate-500">
                <button onClick={() => toggleAll(context.map(p => p.id), true)} className="hover:underline">All</button>
                <button onClick={() => toggleAll(context.map(p => p.id), false)} className="hover:underline">None</button>
              </div>
            </div>
            <div className="space-y-1">
              {context.map(p => <PaperRow key={p.id} p={p} checked={checkedIds.has(p.id)} onToggle={toggle} />)}
            </div>
          </div>
        )}

        {dropped.length > 0 && (
          <div className="px-4 py-2">
            <button onClick={() => setShowDropped(v => !v)} className="text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-1">
              {showDropped ? '▾' : '▸'} {dropped.length} proposal{dropped.length !== 1 ? 's' : ''} filtered out
            </button>
            {showDropped && (
              <ul className="mt-1.5 space-y-0.5">
                {dropped.map((d, i) => (
                  <li key={i} className="text-[10px] text-slate-400 flex gap-2">
                    <span className="shrink-0 font-mono">{d.reason}</span>
                    <span className="truncate">{d.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between gap-3">
        <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700">Cancel</button>
        <button
          onClick={() => onAccept([...checkedIds])}
          disabled={selectedCount === 0}
          className="rounded-full bg-teal-600 hover:bg-teal-700 disabled:opacity-40 px-5 py-2 text-sm font-semibold text-white transition"
        >
          Add {selectedCount} paper{selectedCount !== 1 ? 's' : ''} to evidence
        </button>
      </div>
    </div>
  );
}

export default EvidenceExpansionReview;
