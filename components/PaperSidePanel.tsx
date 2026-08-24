import React from 'react';
import { EvidenceRow, Work } from '../types';

interface PaperSidePanelProps {
  paper: Work | null;
  row: EvidenceRow | null;
  onClose: () => void;
  onSave: (workId: string) => void;
  onFeedback: (type: 'like' | 'dislike', workId: string) => void;
}

const SMS_LABELS: Record<number, string> = {
  5: 'RCT — Gold standard',
  4: 'Strong quasi-experiment (DiD / IV / RDD)',
  3: 'Quasi-experimental',
  2: 'Correlational',
  1: 'Descriptive',
};

const PaperSidePanel: React.FC<PaperSidePanelProps> = ({ paper, row, onClose, onSave, onFeedback }) => {
  if (!paper || !row) return null;

  const paperUrl = row.doi
    ? `https://doi.org/${row.doi}`
    : row.url || paper.openAccessPdfUrl || null;

  const authors = row.authors.length > 0
    ? row.authors.join(', ')
    : paper.authors?.join(', ') ?? '—';

  const abstract = paper.abstract || paper.summary || row.finding || '';

  return (
    <div className="w-[380px] shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-100 shrink-0">
        <h2 className="text-sm font-semibold text-slate-900 leading-snug">{row.title}</h2>
        <button
          onClick={onClose}
          className="shrink-0 mt-0.5 rounded-md p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
          aria-label="Close panel"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Meta */}
        <div className="text-xs text-slate-500 space-y-1">
          {authors && <div>{authors}</div>}
          <div className="flex flex-wrap items-center gap-2">
            {paper.venue && <span className="font-medium text-slate-700">{paper.venue}</span>}
            {row.year > 0 && <span>{row.year}</span>}
            {paper.citationCount > 0 && (
              <span className="flex items-center gap-1 text-slate-400">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
                  <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
                </svg>
                {paper.citationCount.toLocaleString()} citations
              </span>
            )}
          </div>
        </div>

        {/* Abstract */}
        {abstract && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-slate-400 font-bold mb-2">Abstract</div>
            <p className="text-sm text-slate-700 leading-relaxed">{abstract}</p>
          </div>
        )}

        {/* Quality metrics */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-slate-400 font-bold mb-3">Quality Metrics</div>
          <div className="space-y-3">
            {/* SMS */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-slate-600">Study design</div>
                <div className="text-[10px] text-slate-400">Maryland SMS scale</div>
              </div>
              {paper.smsLevel != null ? (
                <div className="text-right shrink-0">
                  <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold ${
                    paper.smsLevel >= 4 ? 'bg-emerald-100 text-emerald-800' :
                    paper.smsLevel === 3 ? 'bg-amber-100 text-amber-800' :
                    'bg-slate-100 text-slate-600'
                  }`}>
                    SMS {paper.smsLevel}
                  </span>
                  <div className="text-[10px] text-slate-400 mt-0.5 max-w-[160px] text-right leading-snug">
                    {SMS_LABELS[paper.smsLevel] ?? ''}
                  </div>
                </div>
              ) : (
                <span className="text-xs text-slate-400">Unclassified</span>
              )}
            </div>

            {/* ABS */}
            {paper.absRating && (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-slate-600">Journal quality</div>
                  <div className="text-[10px] text-slate-400">ABS Academic Journal Guide</div>
                </div>
                <span className={`shrink-0 inline-block rounded-md px-2 py-0.5 text-xs font-bold ${
                  paper.absRating === '4*' || paper.absRating === '4' ? 'bg-violet-100 text-violet-800' :
                  paper.absRating === '3' ? 'bg-blue-100 text-blue-700' :
                  'bg-slate-100 text-slate-600'
                }`}>
                  ABS {paper.absRating}
                </span>
              </div>
            )}

            {/* RePEC */}
            {paper.repecPercentile != null && (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-slate-600">Journal rank</div>
                  <div className="text-[10px] text-slate-400">IDEAS / RePEC</div>
                </div>
                <span className={`shrink-0 inline-block rounded-md px-2 py-0.5 text-xs font-bold ${
                  paper.repecPercentile >= 90 ? 'bg-orange-100 text-orange-800' :
                  paper.repecPercentile >= 50 ? 'bg-yellow-100 text-yellow-800' :
                  'bg-slate-100 text-slate-600'
                }`}>
                  Top {Math.round(100 - paper.repecPercentile)}%
                </span>
              </div>
            )}

            {paper.smsLevel == null && !paper.absRating && paper.repecPercentile == null && (
              <p className="text-xs text-slate-400">No quality scores available for this paper.</p>
            )}
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="p-4 border-t border-slate-100 flex items-center gap-2 shrink-0">
        {paperUrl ? (
          <a
            href={paperUrl}
            target="_blank"
            rel="noreferrer"
            className="flex-1 rounded-full bg-teal-700 text-white text-xs font-semibold px-4 py-2.5 text-center hover:bg-teal-800 transition"
          >
            Open paper ↗
          </a>
        ) : (
          <div className="flex-1" />
        )}

        <button
          onClick={() => onFeedback('like', paper.id)}
          className="rounded-full border border-slate-200 p-2 text-slate-400 hover:text-emerald-600 hover:border-emerald-300 hover:bg-emerald-50 transition"
          title="Relevant"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 10v12" />
            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
          </svg>
        </button>

        <button
          onClick={() => onFeedback('dislike', paper.id)}
          className="rounded-full border border-slate-200 p-2 text-slate-400 hover:text-rose-600 hover:border-rose-300 hover:bg-rose-50 transition"
          title="Not relevant"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 14V2" />
            <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
          </svg>
        </button>

        <button
          onClick={() => onSave(paper.id)}
          className="rounded-full border border-slate-200 p-2 text-slate-400 hover:text-teal-600 hover:border-teal-300 hover:bg-teal-50 transition"
          title="Save paper"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default PaperSidePanel;
