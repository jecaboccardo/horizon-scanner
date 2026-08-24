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
  await run(conn, 'docker exec supabase-edge-functions edge-runtime start --help 2>&1 | grep -i "wall\\|timeout\\|limit\\|worker" | head -20', 'edge-runtime start --help (timeout flags)');
  await run(conn, 'docker exec supabase-edge-functions env | sort | grep -iE "wall|timeout|limit|worker" | head -20', 'Env vars (timeout-related)');
  await run(conn, 'grep -i "wall\\|timeout\\|WORKER" /opt/supabase-stack/docker-compose.yml | head -10', 'docker-compose timeout settings');
  conn.end();
});
conn.on('error', e => console.error('SSH error:', e.message));
conn.connect(CT134);
