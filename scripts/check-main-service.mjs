#!/usr/bin/env node
import { createRequire } from 'module';
const { Client } = createRequire(import.meta.url)('ssh2');
const CT134 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10134, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 10000 };

function run(conn, cmd, label, timeout = 15000) {
  return new Promise((resolve) => {
    if (label) console.log(`\n--- ${label} ---`);
    const t = setTimeout(() => { console.log('(timed out)'); resolve(); }, timeout);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); console.error(err.message); return resolve(); }
      let out = '';
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => out += d);
      stream.on('close', () => { clearTimeout(t); console.log(out.trim() || '(empty)'); resolve(); });
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  await run(conn, 'ls /opt/supabase-stack/volumes/functions/main/ 2>/dev/null || echo "(no main dir)"', 'main dir contents');
  await run(conn, 'cat /opt/supabase-stack/volumes/functions/main/index.ts 2>/dev/null || echo "(not found)"', 'main/index.ts');
  conn.end();
});
conn.on('error', e => console.error('SSH error:', e.message));
conn.connect(CT134);
