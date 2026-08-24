#!/usr/bin/env node
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CT134 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10134, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 10000 };

function sshExec(conn, cmd, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); return reject(err); }
      let out = '', e = '';
      stream.on('data', d => { process.stdout.write(d); out += d; });
      stream.stderr.on('data', d => { process.stderr.write(d); e += d; });
      stream.on('close', () => { clearTimeout(t); resolve({ out, err: e }); });
    });
  });
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const content = fs.readFileSync(localPath);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => { sftp.end(); resolve(); });
      stream.on('error', reject);
      stream.end(content);
    });
  });
}

(async () => {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve);
    conn.on('error', reject);
    conn.connect(CT134);
  });
  console.log('Connected');

  // Check what import maps exist in repo vs volumes
  console.log('\n--- import_map in repo ---');
  await sshExec(conn, 'ls -la /opt/horizon-scanner/repo/supabase/functions/import_map.json 2>/dev/null || echo "(not found)"');
  console.log('\n--- import_map in volumes ---');
  await sshExec(conn, 'ls -la /opt/supabase-stack/volumes/functions/import_map.json 2>/dev/null || echo "(not found)"');
  console.log('\n--- all import_map files under volumes/functions ---');
  await sshExec(conn, 'find /opt/supabase-stack/volumes/functions -name "import_map*" 2>/dev/null || echo "(none)"');
  console.log('\n--- deno.json in volumes ---');
  await sshExec(conn, 'find /opt/supabase-stack/volumes/functions -name "deno.json*" 2>/dev/null | head -5; echo "---"');
  console.log('\n--- auth.ts line 1-5 in volumes ---');
  await sshExec(conn, 'head -5 /opt/supabase-stack/volumes/functions/_shared/auth.ts 2>/dev/null || echo "(not found)"');

  conn.end();
})();
