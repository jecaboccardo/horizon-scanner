#!/usr/bin/env node
/**
 * Directly upload changed edge-function files to CT 134 and restart,
 * without going through git (avoids disturbing other session's WIP commits).
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Client } = require('ssh2');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CT134 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10134, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 10000 };

// Files to upload: [local path relative to repo root, remote destination]
const FILES = [
  ['supabase/functions/_shared/topicGeoChannel.ts', '/opt/supabase-stack/volumes/functions/_shared/topicGeoChannel.ts'],
  ['supabase/functions/_shared/retrieval.ts',       '/opt/supabase-stack/volumes/functions/_shared/retrieval.ts'],
  ['supabase/functions/api/index.ts',               '/opt/supabase-stack/volumes/functions/api/index.ts'],
];

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

function sshExec(conn, cmd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); return reject(err); }
      let out = '', e = '';
      stream.on('data', d => { process.stdout.write(d); out += d; });
      stream.stderr.on('data', d => { process.stderr.write(d); e += d; });
      stream.on('close', (code) => { clearTimeout(t); resolve({ out, err: e, code }); });
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
  console.log('Connected to CT 134');

  for (const [rel, remote] of FILES) {
    const local = path.join(ROOT, rel);
    console.log(`Uploading ${rel} → ${remote}`);
    await uploadFile(conn, local, remote);
    console.log('  ok');
  }

  console.log('\nRestarting supabase-edge-functions...');
  await sshExec(conn, 'docker restart supabase-edge-functions && echo "restart ok"', 30000);

  console.log('\nWaiting 4s...');
  await new Promise(r => setTimeout(r, 4000));

  const { out } = await sshExec(conn, "docker ps --filter name=supabase-edge-functions --format '{{.Status}}'", 10000);
  console.log('Container status:', out.trim());

  conn.end();
  console.log('\nDeploy complete.');
})();
