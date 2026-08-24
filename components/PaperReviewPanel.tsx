import React, { useState } from 'react';
import { Work } from '../types';

interface PaperReviewPanelProps {
  works: Work[];
  onExclude: (workId: string, excluded: boolean) => void;
  onStar: (workId: string, starred: boolean) => void;
}

type FilterMode = 'all' | 'active' | 'excluded' | 'starred';

const PaperReviewPanel: React.FC<PaperReviewPanelProps> = ({ works, onExclude, onStar }) => {
  const [filter, setFilter] = useState<FilterMode>('all');
  const [search, setSearch] = useState('');

  const excludedCount = works.filter((w) => w.excluded).length;
  const starredCount = works.filter((w) => w.starred).length;

  const filtered = works.filter((w) => {
    if (filter === 'active' && (w.excluded || w.starred)) return false;
    if (filter === 'excluded' && !w.excluded) return false;
    if (filter === 'starred' && !w.starred) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        w.title.toLowerCase().includes(q) ||
        (w.authors || []).some((a) => a.toLowerCase().includes(q)) ||
        (w.venue ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Sort: starred first, then excluded last
  const sorted = [...filtered].sort((a, b) => {
    if (a.starred && !b.starred) return -1;
    if (!a.starred && b.starred) return 1;
    if (a.excluded && !b.excluded) return 1;
    if (!a.excluded && b.excluded) return -1;
    return 0;
  });

  return (
    <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold mb-1">Paper Review</div>
          <div className="text-sm text-slate-500">
            {works.length} papers &middot; {starredCount} starred &middot; {excludedCount} excluded
          </div>
        </div>
        <div className="flex gap-2">
          {(['all', 'starred', 'active', 'excluded'] as FilterMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilter(mode)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                filter === mode
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {mode === 'all' ? 'All' : mode === 'active' ? 'Active' : mode === 'starred' ? `Starred (${starredCount})` : 'Excluded'}
            </button>
          ))}
        </div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search papers by title, author, or venue..."
        className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
      />

      {sorted.length === 0 ? (
        <div className="text-sm text-slate-400 py-6 text-center rounded-xl border border-slate-200">
          {works.length === 0 ? 'No papers yet — run a search first' : 'No papers match your filter'}
        </div>
      ) : (
        <div className="space-y-3 max-h-[600px] overflow-y-auto">
          {sorted.map((work) => (
            <div
              key={work.id}
              className={`rounded-xl border p-4 transition ${
                work.starred
                  ? 'border-amber-300 bg-amber-50/60'
                  : work.excluded
                  ? 'border-slate-200 bg-slate-50/50 opacity-60'
                  : 'border-slate-200'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-900 leading-snug">{work.title}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {(work.authors || []).slice(0, 3).join(', ')}
                    {(work.authors || []).length > 3 ? ` +${work.authors.length - 3} more` : ''}
                    {work.year ? ` · ${work.year}` : ''}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {work.venue && (
                      <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{work.venue}</span>
                    )}
                    {work.methodologyDesign && (
                      <span className="text-xs bg-cyan-50 text-cyan-700 rounded-full px-2 py-0.5">{work.methodologyDesign}</span>
                    )}
                    {work.smsLevel != null && (
                      <span className="text-xs bg-violet-50 text-violet-700 rounded-full px-2 py-0.5">SMS {work.smsLevel}</span>
                    )}
                    {work.starred && (
                      <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 font-semibold">★ Starred</span>
                    )}
                    {work.excluded && (
                      <span className="text-xs bg-slate-200 text-slate-600 rounded-full px-2 py-0.5 font-semibold">Excluded</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => onStar(work.id, !work.starred)}
                    className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                      work.starred
                        ? 'bg-amber-500 text-white hover:bg-amber-600'
                        : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
                    }`}
                  >
                    {work.starred ? '★ Unstar' : '☆ Star'}
                  </button>
                  <button
                    onClick={() => onExclude(work.id, !work.excluded)}
                    className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                      work.excluded
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
                    }`}
                  >
                    {work.excluded ? 'Restore' : 'Exclude'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default PaperReviewPanel;
