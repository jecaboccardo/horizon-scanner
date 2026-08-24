import { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../services/apiClient';
import type { MonitorOverview, MonitorCost, MonitorAlert, MonitorActivityEvent } from '../types';

const POLL_MS = 60_000;
const pct = (n: number | null) => n == null ? '—' : `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;

export function PilotMonitor() {
  const [ov, setOv] = useState<MonitorOverview | null>(null);
  const [cost, setCost] = useState<MonitorCost | null>(null);
  const [alerts, setAlerts] = useState<MonitorAlert[]>([]);
  const [activity, setActivity] = useState<MonitorActivityEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // On-demand output-quality drill-down (review gap #8): the "why", not just a colour.
  const [drill, setDrill] = useState<{ kind: 'run' | 'paper'; id: string; loading: boolean; data: any } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [o, c, a, act] = await Promise.all([
        apiClient.getMonitorOverview(), apiClient.getMonitorCost(),
        apiClient.getMonitorAlerts(), apiClient.getMonitorActivity(100),
      ]);
      setOv(o); setCost(c); setAlerts(a.alerts); setActivity(act.events); setErr(null);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, POLL_MS); return () => clearInterval(t); }, [refresh]);

  const checkRun = useCallback(async (id: string) => {
    setDrill({ kind: 'run', id, loading: true, data: null });
    try { setDrill({ kind: 'run', id, loading: false, data: await apiClient.getMonitorRunQuality(id) }); }
    catch (e) { setDrill({ kind: 'run', id, loading: false, data: { error: String((e as Error).message ?? e) } }); }
  }, []);

  // Deep-check spends one gated Qwen call; fetch the cached review first, judge on demand.
  const deepCheck = useCallback(async (id: string, force = false) => {
    setDrill({ kind: 'paper', id, loading: true, data: null });
    try {
      const data = force ? await apiClient.judgePaper(id) : (await apiClient.getPaperReview(id)) ?? await apiClient.judgePaper(id);
      setDrill({ kind: 'paper', id, loading: false, data });
    } catch (e) { setDrill({ kind: 'paper', id, loading: false, data: { error: String((e as Error).message ?? e) } }); }
  }, []);

  if (err) return <div className="p-4 text-red-600">Monitor error: {err}</div>;
  if (!ov) return <div className="p-4">Loading pilot monitor…</div>;

  return (
    <div className="space-y-6 p-4">
      {alerts.length > 0 && (
        <div className="rounded border border-red-400 bg-red-50 p-3">
          <strong>{alerts.length} alert(s) firing</strong>
          <ul className="mt-1 list-disc pl-5">{alerts.map(a => <li key={a.fingerprint}><span className={a.severity === 'critical' ? 'text-red-700' : 'text-amber-700'}>[{a.severity}]</span> {a.title} — {a.detail}</li>)}</ul>
        </div>
      )}

      <section>
        <h3 className="font-semibold">Who's using it ({ov.windowDays}d)</h3>
        <table className="w-full text-sm"><thead><tr><th className="text-left">User</th><th className="text-left">Events</th></tr></thead>
          <tbody>{ov.roster.map(u => {
            const counts: Record<string, number> = ov.byUser[u] ?? {};
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            return <tr key={u}><td className="font-mono">{u.slice(0, 8)}…</td><td>{total === 0 ? <span className="text-amber-700">dormant</span> : total}</td></tr>;
          })}</tbody></table>
      </section>

      <section>
        <h3 className="font-semibold">Completion health</h3>
        <table className="w-full text-sm"><thead><tr><th className="text-left">Action</th><th>Attempts</th><th>Success</th><th>Failed</th><th>Stuck</th><th>p95 (ms)</th></tr></thead>
          <tbody>{ov.health.map(h => (
            <tr key={h.action} className={h.failed > 0 || h.stuck.length > 0 ? 'bg-red-50' : ''}>
              <td>{h.action}</td><td className="text-center">{h.attempts}</td><td className="text-center">{pct(h.successRate)}</td>
              <td className="text-center" title={h.failures.map(f => `${f.targetId}: ${f.error}`).join('\n')}>{h.failed}</td>
              <td className="text-center" title={h.stuck.map(s => s.targetId).join(', ')}>{h.stuck.length}</td><td className="text-center">{h.p95 ?? '—'}</td>
            </tr>
          ))}</tbody></table>
      </section>

      <section>
        <h3 className="font-semibold">Live activity <span className="font-normal text-xs text-gray-500">(click a search/paper to inspect quality)</span></h3>
        <ul className="max-h-64 overflow-auto text-xs font-mono">
          {activity.map(e => {
            const isRun = e.event_type.startsWith('search.') && !!e.target_id;
            const isPaper = e.event_type.startsWith('paper.generation_') && !!e.target_id;
            return (
              <li key={e.id} className={e.status === 'failed' ? 'text-red-600' : ''}>
                {e.ts.slice(11, 19)} {e.event_type} {e.status ?? ''} {e.error ?? ''} {e.payload?.query ? `— "${String(e.payload.query).slice(0, 60)}"` : ''}
                {isRun && <button className="ml-2 text-blue-600 underline" onClick={() => checkRun(e.target_id!)}>quality</button>}
                {isPaper && <button className="ml-2 text-blue-600 underline" onClick={() => deepCheck(e.target_id!)}>deep-check</button>}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Output-quality drill-down — the WHY behind a search or paper */}
      {drill && (
        <section className="rounded border border-gray-300 p-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Output quality — {drill.kind} <span className="font-mono text-xs">{drill.id.slice(0, 12)}…</span></h3>
            <div className="text-xs">
              {drill.kind === 'paper' && <button className="mr-3 text-blue-600 underline" onClick={() => deepCheck(drill.id, true)}>re-run judge</button>}
              <button className="text-gray-500 underline" onClick={() => setDrill(null)}>close</button>
            </div>
          </div>
          {drill.loading && <p className="text-sm text-gray-500">Loading…</p>}
          {!drill.loading && drill.data?.error && <p className="text-sm text-red-600">{drill.data.error}</p>}

          {!drill.loading && drill.kind === 'run' && drill.data && !drill.data.error && (
            <div className="mt-2 space-y-2 text-sm">
              {drill.data.relevance && (
                <p className={drill.data.relevance.belowFloor ? 'text-red-700' : ''}>
                  Relevance: top cosine {drill.data.relevance.topCosine?.toFixed(3) ?? '—'}, mean {drill.data.relevance.meanCosine?.toFixed(3) ?? '—'},
                  off-ratio {pct(drill.data.relevance.offRatio)} ({drill.data.relevance.coreCount} core)
                  {drill.data.relevance.belowFloor && ' — below 0.45 floor'}
                </p>
              )}
              {drill.data.relevance?.offTitles?.length > 0 && (
                <div><span className="font-medium">Off-topic:</span>
                  <ul className="list-disc pl-5">{drill.data.relevance.offTitles.map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
                </div>
              )}
              <p className="font-medium">Duplicates: {drill.data.duplicates?.length ? '' : 'none'}</p>
              {drill.data.duplicates?.length > 0 && (
                <ul className="list-disc pl-5">{drill.data.duplicates.map((d: any, i: number) => <li key={i}>{d.a} ≈ {d.b} <span className="text-gray-500">({d.reason})</span></li>)}</ul>
              )}
            </div>
          )}

          {!drill.loading && drill.kind === 'paper' && drill.data && !drill.data.error && (
            <div className="mt-2 space-y-2 text-sm">
              <p>Overall: <strong>{drill.data.overall ?? '—'}</strong> <span className="text-gray-500">({drill.data.model ?? 'cached'})</span></p>
              {(drill.data.findings ?? []).length === 0 && <p className="text-gray-500">No issues flagged.</p>}
              <ul className="space-y-1">{(drill.data.findings ?? []).map((f: any, i: number) => (
                <li key={i}>
                  <span className={f.severity === 'high' ? 'text-red-700' : f.severity === 'med' ? 'text-amber-700' : 'text-gray-600'}>[{f.severity}]</span>
                  {' '}{f.dimension} §{f.section}: {f.note}
                  {f.quote && <div className="pl-4 italic text-gray-500">"{f.quote}"</div>}
                </li>
              ))}</ul>
            </div>
          )}
        </section>
      )}

      {cost && (
        <section>
          <h3 className="font-semibold">Cost & budget ({ov.windowDays}d)</h3>
          <p>Total {usd(cost.cost.total)} · today {usd(cost.cost.today)} · projected 30d {usd(cost.cost.projected30d)}</p>
          <table className="w-full text-sm"><thead><tr><th className="text-left">Provider</th><th>Spent/Budget</th><th>Consumed</th><th>ETA (days)</th></tr></thead>
            <tbody>{cost.budget.map(b => (
              <tr key={b.provider} className={b.pctConsumed >= 95 ? 'bg-red-50' : b.pctConsumed >= 80 ? 'bg-amber-50' : ''}>
                <td>{b.provider}</td><td className="text-center">{usd(b.spentUsd)}/{usd(b.budgetUsd)}</td><td className="text-center">{Math.round(b.pctConsumed)}%</td><td className="text-center">{b.etaDays?.toFixed(1) ?? '—'}</td>
              </tr>
            ))}</tbody></table>
        </section>
      )}
    </div>
  );
}
