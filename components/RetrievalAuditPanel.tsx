import React, { useEffect, useMemo, useState } from 'react';
import { RetrievalAudit, SearchRun } from '../types';
import { apiClient } from '../services/apiClient';

interface RetrievalAuditPanelProps {
  searchRuns: SearchRun[];
}

const verdictLabel: Record<string, string> = {
  good_coverage: 'Good coverage',
  partial_coverage: 'Partial coverage',
  likely_missing_key_evidence: 'Likely missing key evidence',
  filter_mismatch: 'Filter mismatch',
  retrieval_failure: 'Retrieval failure',
};

const verdictClass: Record<string, string> = {
  good_coverage: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial_coverage: 'bg-amber-50 text-amber-700 border-amber-200',
  likely_missing_key_evidence: 'bg-orange-50 text-orange-700 border-orange-200',
  filter_mismatch: 'bg-rose-50 text-rose-700 border-rose-200',
  retrieval_failure: 'bg-red-50 text-red-700 border-red-200',
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const RetrievalAuditPanel: React.FC<RetrievalAuditPanelProps> = ({ searchRuns }) => {
  const [audits, setAudits] = useState<RetrievalAudit[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [mode, setMode] = useState<'corpus' | 'external'>('corpus');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [feedbackSaving, setFeedbackSaving] = useState<string | null>(null);
  const [adminJudgments, setAdminJudgments] = useState<Map<string, 'relevant' | 'not_relevant'>>(() => new Map());
  const [error, setError] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => searchRuns.find((run) => run.id === selectedRunId) || searchRuns[0] || null,
    [searchRuns, selectedRunId],
  );

  useEffect(() => {
    if (!selectedRunId && searchRuns[0]) setSelectedRunId(searchRuns[0].id);
  }, [searchRuns, selectedRunId]);

  useEffect(() => {
    apiClient.getRetrievalAudits()
      .then(setAudits)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load audits'))
      .finally(() => setLoading(false));
  }, []);

  async function runAudit() {
    if (!selectedRun) return;
    setRunning(true);
    setError(null);
    try {
      const audit = await apiClient.runRetrievalAudit(selectedRun.id, mode);
      setAudits((prev) => [audit, ...prev.filter((a) => a.id !== audit.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audit failed');
    } finally {
      setRunning(false);
    }
  }

  async function markRelevance(audit: RetrievalAudit, item: RetrievalAudit['expectedEvidence'][number], verdict: 'relevant' | 'not_relevant') {
    const key = item.doi || item.title;
    setFeedbackSaving(`${key}:${verdict}`);
    setError(null);
    try {
      await apiClient.submitRetrievalAuditFeedback(audit.id, item, verdict);
      setAdminJudgments((prev) => new Map(prev).set(key, verdict));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save audit feedback');
    } finally {
      setFeedbackSaving(null);
    }
  }

  const latest = audits[0] ?? null;
  const missing = latest?.expectedEvidence.filter((item) => item.status === 'missing') ?? [];

  return (
    <div className="space-y-5">
      <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold">Retrieval Audit</div>
            <p className="mt-2 text-sm text-slate-600 max-w-2xl">
              Admin-only regression check: compare a run&apos;s evidence table with either relaxed in-corpus candidates or an external canonical-evidence audit.
            </p>
          </div>
          <button
            onClick={runAudit}
            disabled={!selectedRun || running}
            className="rounded-full bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 transition disabled:opacity-50"
          >
            {running ? 'Auditing...' : mode === 'external' ? 'Run external audit' : 'Run corpus audit'}
          </button>
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto]">
          <select
            value={selectedRun?.id ?? ''}
            onChange={(event) => setSelectedRunId(event.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500"
          >
            {searchRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {formatDate(run.createdAt)} - {run.query.slice(0, 110)}
              </option>
            ))}
          </select>
          <div className="text-xs text-slate-500 self-center">
            {selectedRun ? `${selectedRun.evidenceWorkIds.length} evidence rows` : 'No run selected'}
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[220px_1fr]">
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as 'corpus' | 'external')}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500"
          >
            <option value="corpus">Corpus audit</option>
            <option value="external">External audit</option>
          </select>
          <p className="text-xs text-slate-500 self-center">
            {mode === 'external'
              ? 'Uses OpenAlex, Semantic Scholar, and one LLM canonical-evidence pass; slower and admin-triggered only.'
              : 'Fast deterministic audit against works already in your corpus; best for regression baselines.'}
          </p>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}
      </section>

      {loading ? (
        <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm text-sm text-slate-500">
          Loading audits...
        </section>
      ) : audits.length === 0 ? (
        <section className="rounded-xl bg-white p-8 border border-dashed border-slate-200 text-center">
          <p className="text-sm font-medium text-slate-600">No retrieval audits yet.</p>
          <p className="mt-1 text-xs text-slate-400">Run one against a recent search to create a regression baseline.</p>
        </section>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-slate-500 font-bold">Latest audit</div>
                <p className="mt-1 text-sm font-semibold text-slate-900">{latest?.query}</p>
              </div>
              {latest && (
                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${verdictClass[latest.verdict] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                  {verdictLabel[latest.verdict] ?? latest.verdict}
                </span>
              )}
            </div>

            {latest && (
              <div className="p-5 space-y-5">
                <div className="grid gap-3 sm:grid-cols-4">
                  {[
                    ['Confidence', `${Math.round(latest.confidence * 100)}%`],
                    ['Missing expected', latest.tableDiagnostics.inCorpusButMissingCount],
                    ['Off topic rows', latest.tableDiagnostics.offTopicCount],
                    ['Filter violations', latest.tableDiagnostics.wrongGeographyCount + latest.tableDiagnostics.wrongMethodologyCount + latest.tableDiagnostics.yearFilterViolations],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500 font-bold">{label}</div>
                      <div className="mt-1 text-lg font-bold text-slate-900">{value}</div>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500 font-bold">Audit mode</div>
                      <div className="mt-1 text-sm font-semibold text-slate-900">
                        {latest.auditMode === 'external' ? 'External canonical evidence' : 'Corpus regression'}
                      </div>
                    </div>
                    {latest.auditMode === 'external' && latest.externalDiagnostics && (
                      <div className="text-xs text-slate-500 text-right">
                        <div>
                          OpenAlex {latest.externalDiagnostics.openAlexCount} - Semantic Scholar {latest.externalDiagnostics.semanticScholarCount} - LLM canonical {latest.externalDiagnostics.llmCanonicalCount}
                        </div>
                        {(latest.externalDiagnostics.llmSearchQueries?.length ?? 0) > 0 && (
                          <div className="mt-1 max-w-xl truncate">
                            LLM search: {latest.externalDiagnostics.llmSearchQueries?.join(' | ')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 font-bold mb-2">Recommended actions</div>
                  <ul className="space-y-1 text-sm text-slate-700">
                    {latest.recommendedActions.map((action) => (
                      <li key={action} className="flex gap-2">
                        <span className="text-teal-600">-</span>
                        <span>{action}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 font-bold mb-2">Expected evidence check</div>
                  <div className="space-y-2">
                    {latest.expectedEvidence.slice(0, 12).map((item, index) => (
                      <article key={`${item.title}-${index}`} className="rounded-lg border border-slate-200 p-3">
                        {(() => {
                          const key = item.doi || item.title;
                          const adminRelevance = adminJudgments.get(key) || item.adminRelevance || null;
                          return (
                            <>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-900">{item.title}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {[item.year, item.source, item.doi].filter(Boolean).join(' - ')}
                            </div>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            item.status === 'present' || item.status === 'near_duplicate_present'
                              ? 'bg-emerald-50 text-emerald-700'
                              : item.status === 'excluded_by_filter'
                              ? 'bg-slate-100 text-slate-600'
                              : 'bg-rose-50 text-rose-700'
                          }`}>
                            {item.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-500 leading-relaxed">{item.whyExpected}</p>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[11px] font-semibold text-slate-500">
                            Admin judgment:{' '}
                            <span className={
                              adminRelevance === 'relevant'
                                ? 'text-emerald-700'
                                : adminRelevance === 'not_relevant'
                                ? 'text-rose-700'
                                : 'text-slate-400'
                            }>
                              {adminRelevance ? adminRelevance.replace('_', ' ') : 'not reviewed'}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => void markRelevance(latest, item, 'relevant')}
                              disabled={feedbackSaving === `${key}:relevant`}
                              className="rounded-full border border-emerald-200 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                            >
                              {feedbackSaving === `${key}:relevant` ? 'Saving...' : 'Relevant'}
                            </button>
                            <button
                              onClick={() => void markRelevance(latest, item, 'not_relevant')}
                              disabled={feedbackSaving === `${key}:not_relevant`}
                              className="rounded-full border border-rose-200 px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                            >
                              {feedbackSaving === `${key}:not_relevant` ? 'Saving...' : 'Not relevant'}
                            </button>
                          </div>
                        </div>
                            </>
                          );
                        })()}
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-500 font-bold">Audit history</div>
            </div>
            <div className="max-h-[680px] overflow-y-auto">
              {audits.map((audit) => (
                <article key={audit.id} className="border-b border-slate-100 last:border-0 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${verdictClass[audit.verdict] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                      {verdictLabel[audit.verdict] ?? audit.verdict}
                    </span>
                    <span className="text-[11px] text-slate-400">{formatDate(audit.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-xs font-medium text-slate-700 line-clamp-2">{audit.query}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {audit.auditMode} - {audit.tableDiagnostics.inCorpusButMissingCount} missing expected - {Math.round(audit.confidence * 100)}% confidence
                  </p>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {missing.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>{missing.length} in-filter expected papers are missing.</strong> Treat these as candidates for retrieval/reranker diagnosis, not proof that the corpus is wrong. Mark bad suggestions as not relevant; future audits will suppress them.
        </section>
      )}
    </div>
  );
};

export default RetrievalAuditPanel;
