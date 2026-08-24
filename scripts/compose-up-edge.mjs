#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

function sshExec(config, cmd, timeoutMs = 60000) {
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
  // Find the service key (yaml key, not container_name)
  console.log('=== Service key for edge-functions ===');
  await sshExec(CT134,
    `cd /opt/supabase-stack && docker compose config --services 2>/dev/null | grep -i edge`
  );

  // Recreate with updated config (--no-deps: don't restart dependencies)
  console.log('\n=== docker compose up --force-recreate ===');
  await sshExec(CT134,
    `cd /opt/supabase-stack && docker compose up -d --force-recreate --no-deps functions 2>&1 | tail -5`,
    55000
  );
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n=== CMD after recreate ===');
  await sshExec(CT134, 'docker inspect supabase-edge-functions --format "{{json .Config.Cmd}}"');

  console.log('\n=== Latest logs ===');
  await sshExec(CT134, 'docker logs supabase-edge-functions --tail 15 2>&1');
})();
