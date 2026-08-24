import React, { useEffect, useState } from 'react';
import { DomainWeight, WeightAlert, WeightProposal } from '../types';
import { apiClient } from '../services/apiClient';

interface WeightPanelProps {
  isAdmin: boolean;
}

const WeightPanel: React.FC<WeightPanelProps> = ({ isAdmin }) => {
  const [weights, setWeights] = useState<DomainWeight[]>([]);
  const [proposals, setProposals] = useState<WeightProposal[]>([]);
  const [alerts, setAlerts] = useState<WeightAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ usersProcessed: number; proposalsCreated: number; alertFired: boolean; processedSignals: number } | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    void loadData();
  }, [isAdmin]);

  async function loadData() {
    setLoading(true);
    try {
      const [w, p, a] = await Promise.all([
        apiClient.getWeights(),
        apiClient.getProposals(),
        apiClient.getAlerts(),
      ]);
      setWeights(w);
      setProposals(p);
      setAlerts(a);
    } catch {
      // silently degrade — panel shows empty state
    } finally {
      setLoading(false);
    }
  }

  async function handleRunAgent() {
    setRunning(true);
    setRunResult(null);
    try {
      const result = await apiClient.runLearningAgent();
      setRunResult(result);
      const [w, p, a] = await Promise.all([
        apiClient.getWeights(),
        apiClient.getProposals(),
        apiClient.getAlerts(),
      ]);
      setWeights(w);
      setProposals(p);
      setAlerts(a);
    } catch {
      // silently degrade
    } finally {
      setRunning(false);
    }
  }

  async function handleReview(proposalId: string, status: 'approved' | 'rejected') {
    try {
      await apiClient.reviewProposal(proposalId, status);
      const [w, p] = await Promise.all([
        apiClient.getWeights(),
        apiClient.getProposals(),
      ]);
      setWeights(w);
      setProposals(p);
    } catch {
      // silently degrade
    }
  }

  if (!isAdmin) return null;

  const pendingProposals = proposals.filter((p) => p.status === 'pending');
  const unresolvedAlerts = alerts.filter((a) => !a.resolvedAt);

  return (
    <section className="rounded-xl bg-white p-6 border border-slate-200 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-teal-700 font-bold mb-1">Learning Agent Weights</div>
          <div className="text-sm text-slate-500">Bayesian domain weight tracking &amp; proposal management</div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={() => void handleRunAgent()}
            disabled={running}
            className="rounded-full bg-[#0f1d35] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 transition"
          >
            {running ? 'Running...' : 'Run Agent Now'}
          </button>
          {runResult && (
            <div className="text-xs text-slate-500 text-right">
              Last run: {runResult.usersProcessed} users, {runResult.processedSignals} signals,{' '}
              {runResult.alertFired ? 'alert fired' : `${runResult.proposalsCreated} proposals created`}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-slate-400 py-8 text-center">Loading...</div>
      ) : (
        <div className="space-y-8">
          {/* Drift Alerts */}
          {unresolvedAlerts.length > 0 && (
            <div>
              <h2 className="text-sm font-bold text-rose-700 uppercase tracking-[0.2em] mb-3">
                Drift Alerts ({unresolvedAlerts.length})
              </h2>
              <div className="space-y-3">
                {unresolvedAlerts.map((alert) => (
                  <div key={alert.id} className="rounded-xl border border-rose-200 bg-rose-50 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-rose-800">{alert.alertType}</div>
                        <div className="text-sm text-rose-700 mt-1">{alert.message}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-bold text-rose-700">
                          {typeof alert.totalDriftPct === 'number' ? `${alert.totalDriftPct.toFixed(1)}% drift` : 'N/A'}
                        </div>
                        <div className="text-xs text-rose-500 mt-0.5">
                          {new Date(alert.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending Proposals */}
          <div>
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-[0.2em] mb-3">
              Pending Proposals ({pendingProposals.length})
            </h2>
            {pendingProposals.length === 0 ? (
              <div className="text-sm text-slate-400 py-4 text-center rounded-xl border border-slate-200">
                No pending proposals
              </div>
            ) : (
              <div className="space-y-3">
                {pendingProposals.map((proposal) => (
                  <div key={proposal.id} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="font-semibold text-slate-900">{proposal.domain}</span>
                          <span className="text-xs text-slate-500">
                            {proposal.currentWeight.toFixed(2)} &rarr; {proposal.proposedWeight.toFixed(2)}
                          </span>
                          {proposal.driftPct != null && (
                            <span className="text-xs text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">
                              {proposal.driftPct.toFixed(1)}% drift
                            </span>
                          )}
                          <span className="text-xs text-slate-400">{proposal.signalCount} signals</span>
                        </div>
                        <p className="text-sm text-slate-600">{proposal.explanation}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => void handleReview(proposal.id, 'approved')}
                          className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 transition"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => void handleReview(proposal.id, 'rejected')}
                          className="rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 transition"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Domain Weights table */}
          <div>
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-[0.2em] mb-3">
              Domain Weights ({weights.length})
            </h2>
            {weights.length === 0 ? (
              <div className="text-sm text-slate-400 py-4 text-center rounded-xl border border-slate-200">
                No weight records yet
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-left">
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">User</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Domain</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Weight</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Signals</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Alpha</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-[0.2em]">Beta</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {weights.map((w) => (
                      <tr key={w.id} className="hover:bg-slate-50 transition">
                        <td className="px-4 py-3 font-mono text-xs text-slate-500 max-w-[120px] truncate" title={w.userId}>
                          {w.userId.slice(0, 8)}…
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900">{w.domain}</td>
                        <td className="px-4 py-3">
                          <span className={`font-semibold ${w.weight > 1.1 ? 'text-emerald-700' : w.weight < 0.9 ? 'text-rose-700' : 'text-slate-700'}`}>
                            {w.weight.toFixed(2)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{w.signalCount}</td>
                        <td className="px-4 py-3 text-slate-500">{w.alpha.toFixed(1)}</td>
                        <td className="px-4 py-3 text-slate-500">{w.betaParam.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default WeightPanel;
