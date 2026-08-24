#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

function sshExec(config, cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const conn = new Client();
    const t = setTimeout(() => { conn.end(); resolve({ out: '(timeout)', err: '' }); }, timeoutMs);
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(t); conn.end(); return resolve({ out: '', err: err.message }); }
        let out = '', e = '';
        stream.on('data', d => { process.stdout.write(d); out += d; });
        stream.stderr.on('data', d => { process.stderr.write(d); e += d; });
        stream.on('close', () => { clearTimeout(t); conn.end(); resolve({ out, err: e }); });
      });
    });
    conn.on('error', err => { clearTimeout(t); resolve({ out: `(${err.message})`, err: '' }); });
    conn.connect(config);
  });
}

const CT134 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10134, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 10000 };

(async () => {
  // Full inspect
  console.log('=== Full Entrypoint + Cmd ===');
  await sshExec(CT134, 'docker inspect supabase-edge-functions --format "Entrypoint: {{json .Config.Entrypoint}}\\nCmd: {{json .Config.Cmd}}"');

  // Check docker-compose for the edge-functions service specifically
  console.log('\n=== docker-compose edge-functions full block ===');
  await sshExec(CT134, 'grep -A 40 "container_name: supabase-edge-functions" /opt/supabase-stack/docker-compose.yml');

  // Check if there's an override file
  console.log('\n=== docker-compose.override files ===');
  await sshExec(CT134, 'ls /opt/supabase-stack/docker-compose*.yml 2>/dev/null');
})();
