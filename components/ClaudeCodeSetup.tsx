import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient';
import { logEvent } from '../services/analytics';

// Where the Claude Code plugin marketplace lives. Defaults to the main repo
// (which carries .claude-plugin/marketplace.json + claude-plugin/). For external
// clients, publish a standalone plugin repo and set VITE_PLUGIN_MARKETPLACE to it.
const PLUGIN_MARKETPLACE = (import.meta.env.VITE_PLUGIN_MARKETPLACE as string) || 'jecaboccardo/horizon-scanner-plugin';
// Keep in sync with claude-plugin/.claude-plugin/plugin.json "version".
const PLUGIN_VERSION = '0.6.4';
const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_MARKETPLACE}`;

/**
 * Self-contained "Set up Claude Code" panel — mint a durable plugin key, show the
 * one-paste setup snippet, list/revoke active keys. Owns all its own state, so it
 * can be dropped anywhere (the account dropdown, a modal) without affecting the
 * host component's hook order.
 */
const ClaudeCodeSetup: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keys, setKeys] = useState<Array<{ id: string; prefix: string; label: string | null; last_used_at: string | null }>>([]);

  async function loadKeys() {
    try { const r = await apiClient.listPluginKeys(); setKeys(r.keys ?? []); } catch { /* non-fatal */ }
  }
  useEffect(() => { loadKeys(); /* eslint-disable-next-line */ }, []);

  const setupSnippet = mintedKey
    ? `/plugin marketplace add ${PLUGIN_MARKETPLACE}\n/plugin install horizon-scanner@horizon-scanner\n/reload-plugins\n/horizon-scanner:horizon-login ${mintedKey}`
    : '';

  async function handleSetup() {
    setBusy(true); setError(null); setMintedKey(null);
    try {
      const r = await apiClient.createPluginKey('Claude Code');
      setMintedKey(r.key);
      logEvent({ eventType: 'plugin_key.created', status: 'completed' });
      loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create key');
      logEvent({ eventType: 'plugin_key.created', status: 'failed' });
    } finally { setBusy(false); }
  }

  async function copySnippet() {
    try { await navigator.clipboard.writeText(setupSnippet); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  }

  async function handleRevoke(id: string) {
    try { await apiClient.revokePluginKey(id); setKeys(ks => ks.filter(k => k.id !== id)); } catch { /* ignore */ }
  }

  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-[13px] text-slate-600 leading-snug">
          Write full survey papers from your own <strong>Claude Code</strong> terminal, on your own
          Claude subscription. You'll set this up once, then just run <code className="text-[12px] bg-slate-100 rounded px-1">/horizon-scanner:horizon</code>.
        </p>
      )}

      {!mintedKey && (
        <button
          type="button"
          onClick={handleSetup}
          disabled={busy}
          className="w-full rounded-lg bg-slate-800 text-white text-[13px] font-semibold py-2 hover:bg-slate-900 transition disabled:opacity-40"
        >
          {busy ? 'Creating key…' : 'Set up Claude Code'}
        </button>
      )}
      {error && <p className="text-[12px] text-red-500">{error}</p>}

      {mintedKey && (
        <div className="space-y-2">
          <p className="text-[12px] text-emerald-700 leading-snug font-medium">
            Key created — copy it now, you won't see it again.
          </p>
          <pre className="text-[11px] bg-slate-900 text-slate-100 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-all">{setupSnippet}</pre>
          <button
            type="button"
            onClick={copySnippet}
            className="w-full rounded-lg bg-teal-600 text-white text-[13px] font-semibold py-2 hover:bg-teal-700 transition"
          >
            {copied ? 'Copied ✓' : 'Copy setup'}
          </button>
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
            <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500 mb-1">Then, in Claude Code</div>
            <ol className="text-[11px] text-slate-600 leading-relaxed list-decimal pl-4 space-y-0.5">
              <li>Paste the 4 lines above, <strong>one at a time, in order</strong> (Enter after each). They add the plugin, install it, <strong>activate</strong> it (<code className="bg-slate-200 rounded px-1">/reload-plugins</code>), then <strong>log you in</strong> (<code className="bg-slate-200 rounded px-1">/horizon-scanner:horizon-login</code>).</li>
              <li>Write a paper: <code className="bg-slate-200 rounded px-1">/horizon-scanner:horizon your question</code> (no quotes)</li>
            </ol>
            <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">
              The commands are namespaced — type the full <code>/horizon-scanner:…</code> form (the bare <code>/horizon</code> may not resolve).
              Order matters: <code>/horizon-scanner:horizon-login</code> only works <em>after</em> <code>/reload-plugins</code>. Set up once; then just run <code>/horizon-scanner:horizon</code> per paper.
            </p>
          </div>
          <p className="text-[11px] text-slate-400 leading-snug">
            No Claude Code yet? Install from <span className="font-medium">claude.com/claude-code</span> (needs a Claude paid plan).
          </p>
        </div>
      )}

      {keys.length > 0 && (
        <div className="pt-1 space-y-1">
          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400">Active keys</div>
          {keys.map(k => (
            <div key={k.id} className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
              <span className="font-mono truncate">{k.prefix}…{k.last_used_at ? ' · used' : ' · unused'}</span>
              <button type="button" onClick={() => handleRevoke(k.id)} className="text-red-500 hover:underline shrink-0">revoke</button>
            </div>
          ))}
        </div>
      )}

      <div className="pt-2 mt-1 border-t border-slate-100 text-[10px] text-slate-400 leading-snug space-y-0.5">
        <div>
          Plugin <span className="font-semibold text-slate-500">v{PLUGIN_VERSION}</span> ·{' '}
          <a href={PLUGIN_REPO_URL} target="_blank" rel="noreferrer" className="text-teal-600 hover:underline">repo</a>
          {' · '}
          <a href={`${PLUGIN_REPO_URL}/blob/main/CHANGELOG.md`} target="_blank" rel="noreferrer" className="text-teal-600 hover:underline">what's new (changelog)</a>
        </div>
        <div>
          To update later, run in Claude Code: <code className="bg-slate-100 rounded px-1">/plugin marketplace update horizon-scanner</code> then <code className="bg-slate-100 rounded px-1">/reload-plugins</code>.
        </div>
      </div>
    </div>
  );
};

export default ClaudeCodeSetup;
