#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

function sshExec(config, cmd, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const conn = new Client();
    const t = setTimeout(() => { conn.end(); resolve({ out: '(timeout)', err: '' }); }, timeoutMs);
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(t); conn.end(); return resolve({ out: '', err: err.message }); }
        let out = '', e = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => e += d);
        stream.on('close', () => { clearTimeout(t); conn.end(); resolve({ out, err: e }); });
      });
    });
    conn.on('error', err => { clearTimeout(t); resolve({ out: `(${err.message})`, err: '' }); });
    conn.connect(config);
  });
}

const CT134 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10134, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 10000 };

(async () => {
  // Check import map content
  const r1 = await sshExec(CT134, 'cat /opt/supabase-stack/volumes/functions/import_map.json');
  console.log('=== import_map.json ===\n', r1.out);

  // Check how edge-functions container is started (what --import-map arg it gets)
  const r2 = await sshExec(CT134, 'docker inspect supabase-edge-functions --format "{{json .Config.Cmd}}"');
  console.log('\n=== Container CMD ===\n', r2.out);

  // Check docker-compose config for the edge functions service
  const r3 = await sshExec(CT134, 'grep -A 20 "edge-functions" /opt/supabase-stack/docker-compose.yml 2>/dev/null | head -30');
  console.log('\n=== docker-compose edge-functions section ===\n', r3.out);
})();
