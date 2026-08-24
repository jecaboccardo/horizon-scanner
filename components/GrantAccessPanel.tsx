import { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';

const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (cheaper)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (highest quality)' },
];
const MODEL_NAMES: Record<string, string> = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
};
const friendlyModel = (k: any) => (k?.model && MODEL_NAMES[k.model]) || k?.model || (k?.provider === 'claude' ? 'Claude' : 'Gemini');

export default function GrantAccessPanel() {
  const [keys, setKeys] = useState<any[]>([]);
  const [provider, setProvider] = useState<'gemini' | 'claude'>('claude');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: string; email: string }>>([]);
  const [grants, setGrants] = useState<Array<{ id: string; email: string; createdAt: string }>>([]);

  const [usage, setUsage] = useState<Awaited<ReturnType<typeof apiClient.getSynthesisUsage>> | null>(null);
  const [usageWindow, setUsageWindow] = useState<'30d' | 'all'>('30d');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const activeKey = keys[0] || null;

  async function refresh() {
    const k = await apiClient.getSynthesisKeys().catch(() => ({ keys: [] }));
    setKeys(k.keys);
    const g = await apiClient.getSynthesisGrants().catch(() => ({ grants: [] }));
    setGrants(g.grants);
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (activeKey) apiClient.getSynthesisUsage(usageWindow).then(setUsage).catch(() => {});
    else setUsage(null);
  }, [activeKey, usageWindow]);

  async function saveKey() {
    setErr(null); setSaving(true);
    try {
      await apiClient.setSynthesisKey({ provider, apiKey, model: provider === 'claude' ? model : undefined, label: label || null });
      setApiKey(''); await refresh();
    } catch (e: any) { setErr(e?.message || 'Could not save key'); }
    finally { setSaving(false); }
  }

  async function search(v: string) {
    setQ(v);
    if (v.trim().length < 2) { setResults([]); return; }
    const r = await apiClient.searchSynthesisUsers(v).catch(() => ({ users: [] }));
    setResults(r.users);
  }
  async function grant(email: string) {
    if (!activeKey) { setErr('Set a key first'); return; }
    try { await apiClient.grantSynthesisAccess(activeKey.id, email); setQ(''); setResults([]); await refresh(); }
    catch (e: any) { setErr(e?.message || 'Could not grant'); }
  }
  async function revoke(id: string) {
    await apiClient.revokeSynthesisGrant(id).catch(() => {}); await refresh();
  }
  async function revokeKey() {
    if (!activeKey) return;
    if (!window.confirm(`Revoke your ${activeKey.provider === 'claude' ? 'Claude' : 'Gemini'} key? You and the ${grants.length} ${grants.length === 1 ? 'person' : 'people'} you granted will fall back to the app default model (Gemini).`)) return;
    setErr(null);
    try { await apiClient.revokeSynthesisKey(activeKey.id); await refresh(); }
    catch (e: any) { setErr(e?.message || 'Could not revoke key'); }
  }
  // Owner self-preference — independent of the team grant.
  async function setSelfUse(v: boolean) {
    if (!activeKey) return; setErr(null);
    try { await apiClient.updateSynthesisKeySelf(activeKey.id, { ownerSelfUse: v }); await refresh(); }
    catch (e: any) { setErr(e?.message || 'Could not update'); }
  }
  async function setSelfModel(m: string) {
    if (!activeKey) return; setErr(null);
    try { await apiClient.updateSynthesisKeySelf(activeKey.id, { ownerSelfModel: m || null }); await refresh(); }
    catch (e: any) { setErr(e?.message || 'Could not update'); }
  }

  return (
    <div className="max-w-3xl space-y-8 p-4">
      <section className="rounded-xl border border-slate-200 p-5">
        <h2 className="text-lg font-semibold text-slate-800">Synthesis API key</h2>
        <p className="text-sm text-slate-500 mb-3">Your key powers brief &amp; paper generation for everyone you grant access to (and your own). You pay the provider; the key is encrypted and never shown again.</p>

        {/* Explicit ACTIVE / NOT-SET status so the admin always knows the current state. */}
        {activeKey ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 mb-4">
            <div className="flex items-center gap-2 text-emerald-800 font-semibold text-sm">
              <span aria-hidden>✅</span>
              <span>{activeKey.provider === 'claude' ? 'Claude' : 'Gemini'} is ACTIVE</span>
            </div>
            <div className="text-sm text-emerald-700 mt-1">
              Model: <strong>{friendlyModel(activeKey)}</strong>{activeKey.label ? ` · ${activeKey.label}` : ''}
            </div>
            <div className="text-sm text-emerald-700">
              Team model (everyone you grant): <strong>{friendlyModel(activeKey)}</strong> · powering <strong>{grants.length}</strong> {grants.length === 1 ? 'person' : 'people'}.
            </div>
            {(activeKey.createdAt || activeKey.created_at) && (
              <div className="text-[11px] text-emerald-600/80 mt-1">Set {new Date(activeKey.createdAt || activeKey.created_at).toLocaleDateString()}.</div>
            )}

            {/* Owner self-preference — your OWN generations, independent of the team. */}
            <div className="mt-3 pt-3 border-t border-emerald-200/70">
              <div className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wide mb-1">You (owner) — your own briefs &amp; papers</div>
              <label className="flex items-center gap-2 text-sm text-emerald-800">
                <input type="checkbox" checked={activeKey.owner_self_use !== false} onChange={(e) => setSelfUse(e.target.checked)} />
                Run my own generations on this key
              </label>
              {activeKey.owner_self_use !== false ? (
                activeKey.provider === 'claude' ? (
                  <div className="flex items-center gap-2 mt-1.5 text-sm text-emerald-800">
                    <span>My model:</span>
                    <select value={activeKey.owner_self_model || ''} onChange={(e) => setSelfModel(e.target.value)} className="border border-emerald-300 rounded px-2 py-1 text-sm bg-white">
                      <option value="">Same as team ({friendlyModel(activeKey)})</option>
                      {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                ) : null
              ) : (
                <div className="text-[11px] text-emerald-700/80 mt-1">Your own briefs &amp; papers use the app default (Gemini). Your team still uses this key.</div>
              )}
            </div>

            <button onClick={revokeKey} className="mt-3 text-sm text-rose-600 font-semibold underline">Revoke key</button>
            <span className="text-[11px] text-emerald-700/70 ml-2">Revoking switches you and everyone you granted back to the app default (Gemini).</span>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-4 text-sm text-amber-800">
            <strong>No key set.</strong> You and anyone you grant currently use the app default model (Gemini). Set your Claude (or Gemini) key below to switch everyone to it.
          </div>
        )}

        {/* Set OR replace/rotate — always available so the admin can change the key. */}
        <div className="text-sm font-semibold text-slate-700 mb-1">{activeKey ? 'Replace / rotate key' : 'Set your key'}</div>
        {activeKey && (
          <p className="text-[11px] text-slate-500 mb-2">Saving a new key replaces the current one and automatically moves all {grants.length} existing grant{grants.length === 1 ? '' : 's'} to it — no one loses access.</p>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <select value={provider} onChange={(e) => setProvider(e.target.value as 'gemini' | 'claude')} className="border rounded px-2 py-1 text-sm">
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
          </select>
          {provider === 'claude' && (
            <select value={model} onChange={(e) => setModel(e.target.value)} className="border rounded px-2 py-1 text-sm">
              {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste API key" type="password" className="border rounded px-2 py-1 text-sm flex-1 min-w-[220px]" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className="border rounded px-2 py-1 text-sm w-40" />
          <button onClick={saveKey} disabled={saving || apiKey.length < 8} className="bg-teal-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50">{saving ? 'Saving…' : activeKey ? 'Replace key' : 'Save'}</button>
        </div>
        {err && <div className="text-sm text-rose-600 mt-2">{err}</div>}
      </section>

      <section className="rounded-xl border border-slate-200 p-5">
        <h2 className="text-lg font-semibold text-slate-800">Grant access</h2>
        <p className="text-sm text-slate-500 mb-3">Search users who have already registered, then grant. They generate on your key — no setup on their side.</p>
        <input value={q} onChange={(e) => search(e.target.value)} placeholder="Search by email…" className="border rounded px-2 py-1 text-sm w-full mb-2" />
        {results.length > 0 && (
          <ul className="border rounded divide-y mb-3">
            {results.map((u) => (
              <li key={u.id} className="flex justify-between items-center px-3 py-2 text-sm">
                <span>{u.email}</span>
                <button onClick={() => grant(u.email)} className="text-teal-600 underline">Grant</button>
              </li>
            ))}
          </ul>
        )}
        <h3 className="text-sm font-semibold text-slate-700 mt-4 mb-1">People with access ({grants.length})</h3>
        <ul className="border rounded divide-y">
          {grants.map((g) => (
            <li key={g.id} className="flex justify-between items-center px-3 py-2 text-sm">
              <span>
                {g.email}
                {g.createdAt && <span className="text-[11px] text-slate-400 ml-2">Granted {new Date(g.createdAt).toLocaleDateString()}</span>}
              </span>
              <button onClick={() => revoke(g.id)} className="text-rose-600 underline">Revoke</button>
            </li>
          ))}
          {grants.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">No one yet.</li>}
        </ul>

        {activeKey && (
          <div className="mt-6 pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700">Usage on your key</h3>
              <select value={usageWindow} onChange={(e) => setUsageWindow(e.target.value as '30d' | 'all')} className="border rounded px-2 py-1 text-xs">
                <option value="30d">Last 30 days</option>
                <option value="all">All time</option>
              </select>
            </div>
            {!usage || usage.byPerson.length === 0 ? (
              <p className="text-sm text-slate-400">No usage recorded yet{usage?.since ? ` (tracking since ${new Date(usage.since).toLocaleDateString()})` : ''}.</p>
            ) : (
              <>
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700 mb-2">
                  Total: <strong>{usage.overall.tokensIn.toLocaleString()}</strong> in · <strong>{usage.overall.tokensOut.toLocaleString()}</strong> out · {usage.overall.calls} calls · ~${usage.overall.estCostUsd.toFixed(2)} <span className="text-slate-400">(est.)</span>
                </div>
                <ul className="border rounded divide-y">
                  {usage.byPerson.map((p) => {
                    const open = expanded.has(p.email);
                    return (
                      <li key={p.email}>
                        <button onClick={() => setExpanded((s) => { const n = new Set(s); n.has(p.email) ? n.delete(p.email) : n.add(p.email); return n; })}
                          className="w-full flex justify-between items-center px-3 py-2 text-sm text-left hover:bg-slate-50">
                          <span>{open ? '▾' : '▸'} {p.email}</span>
                          <span className="text-slate-600 tabular-nums">{p.tokensIn.toLocaleString()} in · {p.tokensOut.toLocaleString()} out · ~${p.estCostUsd.toFixed(2)}</span>
                        </button>
                        {open && (
                          <div className="px-6 pb-2">
                            {p.daily.map((d) => (
                              <div key={d.date} className="flex justify-between text-[12px] text-slate-500 py-0.5">
                                <span>{d.date}</span>
                                <span className="tabular-nums">{d.tokensIn.toLocaleString()} in · {d.tokensOut.toLocaleString()} out · {d.calls} calls</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] text-slate-400 mt-1">Tokens are exact; $ is an estimate from published per-model rates. Includes your own generations when "run my own on this key" is on.</p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
