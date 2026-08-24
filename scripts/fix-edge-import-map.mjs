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
  // Show current command block so we can see exactly what to patch
  console.log('=== Current command block ===');
  await sshExec(CT134, 'grep -A 5 "command:" /opt/supabase-stack/docker-compose.yml | head -10');

  // Patch: add --import-map line after /home/deno/functions/main
  console.log('\n=== Patching docker-compose.yml ===');
  const patch = await sshExec(CT134,
    `cd /opt/supabase-stack && ` +
    // Check if already patched
    `grep -q 'import-map' docker-compose.yml && echo "already patched" || ` +
    // Patch: replace the main-service line to add import-map after it
    `sed -i 's|    - /home/deno/functions/main|    - /home/deno/functions/main\\n    - --import-map\\n    - /home/deno/functions/import_map.json|' docker-compose.yml && echo "patched"`
  );
  console.log(patch.out.trim());

  console.log('\n=== Verify patch ===');
  await sshExec(CT134, 'grep -A 8 "command:" /opt/supabase-stack/docker-compose.yml | head -12');

  console.log('\n=== Restart edge functions ===');
  await sshExec(CT134,
    'cd /opt/supabase-stack && docker compose restart supabase-edge-functions && echo "restarted"',
    35000
  );

  console.log('\nWaiting 5s...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n=== Container status ===');
  await sshExec(CT134, "docker ps --filter name=supabase-edge-functions --format '{{.Status}}'");

  console.log('\n=== Latest logs (last 20 lines) ===');
  await sshExec(CT134, 'docker logs supabase-edge-functions --tail 20 2>&1');
})();
