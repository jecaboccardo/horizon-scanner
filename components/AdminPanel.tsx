import React, { useState } from 'react';
import { SourceRecord } from '../types';

interface AdminPanelProps {
  sources: SourceRecord[];
  onReview: (sourceId: string, approved: boolean, note: string) => Promise<void>;
}

const AdminPanel: React.FC<AdminPanelProps> = ({ sources, onReview }) => {
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
      <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold mb-4">Source Review</div>
      {sources.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center">
          <svg className="w-10 h-10 text-slate-300 mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <p className="text-slate-500 font-medium text-sm">No sources loaded</p>
          <p className="text-slate-400 text-xs mt-1">Sources will appear after running a search.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sources.map((source) => (
            <div key={source.id} className="rounded-xl border border-slate-200 p-4 hover:border-slate-300 hover:shadow-sm transition">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="font-semibold text-slate-900 text-sm">{source.name}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-slate-500">{source.sourceType}</span>
                    <span className="text-xs text-slate-300">·</span>
                    <span className={`text-xs font-medium ${
                      source.credibilityTier === 'Tier A' ? 'text-emerald-600' :
                      source.credibilityTier === 'Tier B' ? 'text-amber-600' : 'text-slate-500'
                    }`}>{source.credibilityTier}</span>
                    <span className="text-xs text-slate-300">·</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      source.allowedUse === 'evidence' ? 'bg-emerald-50 text-emerald-700' :
                      source.allowedUse === 'signal' ? 'bg-amber-50 text-amber-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>{source.allowedUse}</span>
                  </div>
                </div>
                <a href={source.homepage} target="_blank" rel="noreferrer" className="text-xs font-semibold text-teal-700 hover:text-teal-800 hover:underline transition">
                  Open source
                </a>
              </div>
              <textarea
                value={notes[source.id] || ''}
                onChange={(event) => setNotes((current) => ({ ...current, [source.id]: event.target.value }))}
                placeholder="Review note"
                className="mt-3 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm min-h-16 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => onReview(source.id, true, notes[source.id] || 'Approved for current policy')}
                  className="rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition"
                >
                  Approve
                </button>
                <button
                  onClick={() => onReview(source.id, false, notes[source.id] || 'Restricted pending review')}
                  className="rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 transition"
                >
                  Restrict
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default AdminPanel;
