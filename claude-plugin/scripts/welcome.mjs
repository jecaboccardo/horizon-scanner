#!/usr/bin/env node
/**
 * SessionStart hook — prints a ONE-TIME welcome/onboarding tip in the terminal so a
 * client knows exactly what to type, without reading a manual. Login-aware:
 *  - not logged in  → tell them to save their key first, then how to ask.
 *  - logged in      → "you're ready, just type /horizon-scanner:horizon <question>".
 *
 * Shows once per machine (sentinel in ~/.horizon-scanner/, the same dir horizon-login
 * writes config.json to — known writable). Fail-safe: NEVER throws / never blocks the
 * session. Cross-platform (Node, not bash) since clients run Windows + macOS.
 *
 * ALSO runs an update check EVERY session (independent of the one-time sentinel above) —
 * compares the installed plugin.json version against the published version on the public
 * standalone repo, throttled to ~once/24h via a local cache file so it doesn't hit GitHub
 * on every session start. Silent if current, silent if the check fails/offline (never
 * blocks the session), one line if a newer version is available.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_REPO_RAW =
  'https://raw.githubusercontent.com/jecaboccardo/horizon-scanner-plugin/main/.claude-plugin/plugin.json';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function checkForUpdate(dir) {
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const localPluginJson = JSON.parse(
      fs.readFileSync(path.join(scriptDir, '..', '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    const installed = localPluginJson.version;

    const cachePath = path.join(dir, 'update-check.json');
    let cache = null;
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      // no cache yet
    }

    let latest;
    const stale = !cache || Date.now() - (cache.checkedAt || 0) > CHECK_INTERVAL_MS;
    if (stale) {
      // Manually-managed timeout (not AbortSignal.timeout) + explicit clearTimeout:
      // AbortSignal.timeout()'s internal timer can race a forced process.exit() right
      // after, tripping a libuv assertion on Windows (UV_HANDLE_CLOSING). Clearing our
      // own timer before returning avoids leaving that handle in a closing transition.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      let res;
      try {
        res = await fetch(PLUGIN_REPO_RAW, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return;
      const remote = await res.json();
      latest = remote.version;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: Date.now(), latest }));
    } else {
      latest = cache.latest;
    }

    if (latest && cmpVersions(latest, installed) > 0) {
      console.log(
        `\n  ⚠️  Horizon Scanner plugin update available: ${installed} → ${latest}\n` +
        `      Run: /plugin marketplace update\n`,
      );
    }
  } catch {
    // never break the session over an update check
  }
}

// No forced process.exit() below — letting Node exit naturally once the event loop is
// empty avoids a Windows libuv assertion (UV_HANDLE_CLOSING) that a forced exit can trip
// right after fetch/undici has opened network handles (seen in checkForUpdate above).
try {
  const dir = path.join(os.homedir(), '.horizon-scanner');
  await checkForUpdate(dir);

  const sentinel = path.join(dir, '.welcomed');
  if (!fs.existsSync(sentinel)) {
    const loggedIn = fs.existsSync(path.join(dir, 'config.json'));
    const lines = loggedIn
      ? [
          '',
          '  ✅ Horizon Scanner is ready.',
          '     Just type:  /horizon-scanner:horizon <your question>',
          '     e.g.        /horizon-scanner:horizon do cash transfers improve schooling in Latin America',
          '     (no quotes needed — type your question in plain English)',
          '',
        ]
      : [
          '',
          '  👋 Horizon Scanner installed. Two steps to your first paper:',
          '     1) Save your key:  /horizon-scanner:horizon-login <your hsk_ key>',
          '        (get it from the web app → account → "Set up Claude Code")',
          '     2) Then just ask:  /horizon-scanner:horizon <your question>   (no quotes)',
          '',
        ];
    console.log(lines.join('\n'));

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sentinel, new Date().toISOString());
  }
} catch {
  // never break the session over a welcome message
}
