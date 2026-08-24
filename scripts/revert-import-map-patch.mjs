#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

function sshExec(config, cmd, timeoutMs = 40000) {
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
  console.log('Removing --import-map lines from docker-compose.yml...');
  await sshExec(CT134,
    `cd /opt/supabase-stack && sed -i '/^    - --import-map$/d; /^    - \\/home\\/deno\\/functions\\/import_map.json$/d' docker-compose.yml && echo "reverted"`
  );
  console.log('\nRecreating container with original CMD...');
  await sshExec(CT134,
    `cd /opt/supabase-stack && docker compose up -d --force-recreate --no-deps functions 2>&1 | tail -5`,
    55000
  );
  await new Promise(r => setTimeout(r, 5000));
  console.log('\nCMD after revert:');
  await sshExec(CT134, 'docker inspect supabase-edge-functions --format "{{json .Config.Cmd}}"');
  console.log('\nStatus:');
  await sshExec(CT134, "docker ps --filter name=supabase-edge-functions --format '{{.Status}}'");
})();
