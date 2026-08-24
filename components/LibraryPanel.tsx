import React, { useEffect, useState } from 'react';
import { EvidenceBrief, JelPaper, SavedPaper } from '../types';
import { apiClient } from '../services/apiClient';
import { track } from '../services/analytics';

interface LibraryPanelProps {
  briefs: EvidenceBrief[];
  onOpenBrief: (brief: EvidenceBrief) => void;
  jelPapers?: JelPaper[];
  onOpenJelPaper?: (paper: JelPaper) => void;
  onRenameJelPaper?: (id: string, newTitle: string) => void;
  onDeleteJelPaper?: (id: string) => void;
}

const SMS_LABELS: Record<number, { label: string; color: string }> = {
  5: { label: 'SMS 5', color: 'bg-emerald-100 text-emerald-800' },
  4: { label: 'SMS 4', color: 'bg-teal-100 text-teal-800' },
  3: { label: 'SMS 3', color: 'bg-sky-100 text-sky-800' },
  2: { label: 'SMS 2', color: 'bg-slate-100 text-slate-700' },
  1: { label: 'SMS 1', color: 'bg-slate-100 text-slate-500' },
  0: { label: 'Review / Theory', color: 'bg-slate-100 text-slate-500' },
};

const JEL_STATUS_STYLES: Record<string, string> = {
  queued:  'bg-slate-100 text-slate-600',
  running: 'bg-amber-50 text-amber-700 animate-pulse',
  done:    'bg-emerald-50 text-emerald-700',
  error:   'bg-red-50 text-red-700',
};

const JEL_STATUS_LABELS: Record<string, string> = {
  queued:  'Queued',
  running: 'Drafting…',
  done:    'Ready',
  error:   'Error',
};

const LibraryPanel: React.FC<LibraryPanelProps> = ({
  briefs,
  onOpenBrief,
  jelPapers = [],
  onOpenJelPaper,
  onRenameJelPaper,
  onDeleteJelPaper,
}) => {
  const [savedPapers, setSavedPapers] = useState<SavedPaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingPaperId, setDeletingPaperId] = useState<string | null>(null);
  const [renamingJelId, setRenamingJelId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingJelId, setDeletingJelId] = useState<string | null>(null);
  const savedBriefs = briefs.filter((brief) => brief.auditTrace?.savedToLibrary === true);

  useEffect(() => {
    apiClient.getSavedPapers()
      .then(setSavedPapers)
      .catch(() => setSavedPapers([]))
      .finally(() => setLoading(false));
  }, []);

  async function handleRemoveSavedPaper(feedbackId: string) {
    setDeletingPaperId(feedbackId);
    try {
      await apiClient.deleteSavedPaper(feedbackId);
      setSavedPapers((current) => current.filter((paper) => paper.feedbackId !== feedbackId));
    } catch (err) {
      track('library.paper_removed_error', { severity: 'warning', error_message: err instanceof Error ? err.message : 'Remove failed' });
    } finally {
      setDeletingPaperId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        {/* Saved Papers */}
        <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
          <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold mb-4">
            Saved Papers
            {savedPapers.length > 0 && (
              <span className="ml-2 text-slate-400 font-normal normal-case">{savedPapers.length}</span>
            )}
          </div>

          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-xl border border-slate-100 p-4 animate-pulse">
                  <div className="h-3.5 bg-slate-100 rounded-md w-3/4 mb-2" />
                  <div className="h-3 bg-slate-100 rounded-md w-1/3" />
                </div>
              ))}
            </div>
          ) : savedPapers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center">
              <svg className="w-8 h-8 text-slate-300 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              <p className="text-xs text-slate-400">No saved papers yet. Click the bookmark icon on any paper in a brief.</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {savedPapers.map((paper) => {
                const sms = paper.smsLevel != null ? SMS_LABELS[paper.smsLevel] : null;
                return (
                  <article key={paper.feedbackId} className="rounded-xl border border-slate-200 p-4 hover:border-slate-300 hover:shadow-sm transition">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {paper.url || paper.canonicalDoi ? (
                          <a
                            href={paper.url || `https://doi.org/${paper.canonicalDoi}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-semibold text-slate-900 hover:text-teal-700 transition line-clamp-2"
                          >
                            {paper.title}
                          </a>
                        ) : (
                          <p className="text-sm font-semibold text-slate-900 line-clamp-2">{paper.title}</p>
                        )}
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                          {paper.year && <span>{paper.year}</span>}
                          {paper.venue && <span className="truncate max-w-[150px]">{paper.venue}</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {sms && (
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${sms.color}`}>
                            {sms.label}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleRemoveSavedPaper(paper.feedbackId)}
                          disabled={deletingPaperId === paper.feedbackId}
                          className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                          aria-label={`Remove saved paper: ${paper.title}`}
                          title="Remove saved paper"
                        >
                          {deletingPaperId === paper.feedbackId ? 'Removing' : 'Remove'}
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] text-slate-400">
                      Saved {new Date(paper.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Saved Briefs */}
        <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
          <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold mb-4">
            Saved Briefs
            {savedBriefs.length > 0 && (
              <span className="ml-2 text-slate-400 font-normal normal-case">{savedBriefs.length}</span>
            )}
          </div>

          {savedBriefs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center">
              <svg className="w-8 h-8 text-slate-300 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <p className="text-xs text-slate-400">No saved briefs yet. Open a brief and click Save next to Export.</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {savedBriefs.slice(0, 20).map((brief) => {
                const persona = brief.auditTrace?.persona;
                return (
                  <article
                    key={brief.id}
                    onClick={() => onOpenBrief(brief)}
                    className="rounded-xl border border-slate-200 p-4 hover:border-teal-300 hover:shadow-sm transition cursor-pointer group"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900 group-hover:text-teal-700 transition line-clamp-2 flex-1">
                        {brief.query}
                      </p>
                      {persona && persona !== 'jel' && (
                        <span className="shrink-0 rounded-full bg-violet-100 text-violet-700 px-2 py-0.5 text-[10px] font-bold capitalize">
                          {persona.replace('-', ' ')}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-400">
                      <span>{new Date(brief.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span className={`rounded-full px-2 py-0.5 font-semibold ${brief.status === 'ready' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                        {brief.status}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* JEL Survey Papers */}
      {(jelPapers.length > 0 || true) && (
        <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
          <div className="text-xs uppercase tracking-[0.2em] text-indigo-700 font-bold mb-4">
            JEL Survey Papers
            {jelPapers.length > 0 && (
              <span className="ml-2 text-slate-400 font-normal normal-case">{jelPapers.length}</span>
            )}
          </div>

          {jelPapers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center">
              <svg className="w-8 h-8 text-slate-300 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <p className="text-xs text-slate-400">
                No JEL papers yet. Open a brief and click <span className="font-semibold text-indigo-600">Generate Paper</span> to commission a full survey article.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {jelPapers.map((paper) => {
                const title = paper.outline?.title ?? paper.query;
                const statusLabel = JEL_STATUS_LABELS[paper.status] ?? paper.status;
                const statusClass = JEL_STATUS_STYLES[paper.status] ?? JEL_STATUS_STYLES.queued;
                const sectionCount = paper.sections?.length ?? 0;
                // +1 counts the Devil's Advocate "Critical Assessment" section appended
                // after the outline sections — so a finished paper reads 8/8, not 8/7
                // (mirrors the Studio chip math in App.tsx).
                const outlineSectionCount = paper.outline?.sections?.length ?? 0;
                const totalSections = outlineSectionCount > 0 ? outlineSectionCount + 1 : null;
                const isRenaming = renamingJelId === paper.id;
                const isDeleting = deletingJelId === paper.id;
                const createdAt = new Date(paper.createdAt);
                return (
                  <article
                    key={paper.id}
                    className={`rounded-xl border border-slate-200 p-4 transition group ${isRenaming ? '' : 'hover:border-indigo-300 hover:shadow-sm'}`}
                  >
                    {/* Status + actions row */}
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}>
                          {statusLabel}
                        </span>
                        {paper.status === 'running' && totalSections && (
                          <span className="text-[10px] text-slate-400 tabular-nums">
                            {Math.min(sectionCount, totalSections)}/{totalSections}
                          </span>
                        )}
                        {/* Stop — always visible on an in-progress paper so a mistaken
                            generation can be cancelled from the Library. */}
                        {onDeleteJelPaper && (paper.status === 'running' || paper.status === 'queued') && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!window.confirm('Stop generating this paper? It will be removed.')) return;
                              setDeletingJelId(paper.id);
                              try { await onDeleteJelPaper(paper.id); } finally { setDeletingJelId(null); }
                            }}
                            disabled={isDeleting}
                            className="rounded-full bg-red-50 text-red-600 px-2 py-0.5 text-[10px] font-semibold hover:bg-red-100 transition disabled:opacity-40"
                            title="Stop and remove this in-progress paper"
                          >
                            {isDeleting ? 'Stopping…' : '■ Stop'}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                        {/* Rename */}
                        {onRenameJelPaper && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setRenamingJelId(paper.id); setRenameValue(title); }}
                            className="rounded p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition"
                            title="Rename"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        )}
                        {/* Delete */}
                        {onDeleteJelPaper && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!window.confirm(`Delete "${title}"?\nThis cannot be undone.`)) return;
                              setDeletingJelId(paper.id);
                              try { await onDeleteJelPaper(paper.id); } finally { setDeletingJelId(null); }
                            }}
                            disabled={isDeleting}
                            className="rounded p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 transition disabled:opacity-40"
                            title="Delete"
                          >
                            {isDeleting ? (
                              <svg width="12" height="12" className="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Title — inline editable when renaming */}
                    {isRenaming ? (
                      <div className="mb-2">
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && renameValue.trim()) {
                              await onRenameJelPaper?.(paper.id, renameValue.trim());
                              setRenamingJelId(null);
                            }
                            if (e.key === 'Escape') setRenamingJelId(null);
                          }}
                          onBlur={() => setRenamingJelId(null)}
                          className="w-full text-sm font-semibold text-slate-900 border border-indigo-300 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-indigo-300"
                          placeholder="Paper title"
                        />
                        <p className="text-[10px] text-slate-400 mt-0.5">Enter to save · Esc to cancel</p>
                      </div>
                    ) : (
                      <p
                        onClick={() => paper.status === 'done' && onOpenJelPaper?.(paper)}
                        className={`text-sm font-semibold text-slate-900 line-clamp-2 mb-1 ${paper.status === 'done' ? 'cursor-pointer group-hover:text-indigo-700 transition' : ''}`}
                      >
                        {title}
                      </p>
                    )}

                    {/* Metadata */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
                      <span title={createdAt.toLocaleString()}>
                        {createdAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        {' '}
                        {createdAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {paper.wordCount ? <span>{paper.wordCount.toLocaleString()} words</span> : null}
                      {paper.citationCount ? <span>{paper.citationCount} refs</span> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default LibraryPanel;
