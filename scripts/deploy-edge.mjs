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
        stream.on('close', (code) => { clearTimeout(t); conn.end(); resolve({ out, err: e, code }); });
      });
    });
    conn.on('error', err => { clearTimeout(t); resolve({ out: `(${err.message})`, err: '' }); });
    conn.connect(config);
  });
}

const CT134 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10134, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 10000 };

(async () => {
  console.log('=== Step 1: git pull ===');
  const pull = await sshExec(CT134, 'cd /opt/horizon-scanner/repo && git pull origin main 2>&1', 30000);
  if (pull.code !== 0) { console.error('git pull failed'); process.exit(1); }

  console.log('\n=== Step 2: copy functions ===');
  const copy = await sshExec(CT134, 'cp -r /opt/horizon-scanner/repo/supabase/functions/* /opt/supabase-stack/volumes/functions/ && echo "copy ok"', 15000);
  if (!copy.out.includes('copy ok')) { console.error('copy failed'); process.exit(1); }

  console.log('\n=== Step 3: restart edge functions ===');
  const restart = await sshExec(CT134, 'docker restart supabase-edge-functions && echo "restart ok"', 30000);
  if (!restart.out.includes('restart ok')) { console.error('restart failed'); process.exit(1); }

  console.log('\n=== Step 4: wait 4s then check container is running ===');
  await new Promise(r => setTimeout(r, 4000));
  const check = await sshExec(CT134, "docker ps --filter name=supabase-edge-functions --format '{{.Status}}'", 10000);
  console.log('Container status:', check.out.trim());
  console.log('\nDeploy complete.');
})();
