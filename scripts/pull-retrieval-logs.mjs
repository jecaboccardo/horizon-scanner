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
  console.log('Connecting to CT 134...');
  const result = await sshExec(CT134,
    `docker logs supabase-edge-functions --since 72h 2>&1 | grep -E '\\[retrieval\\]|\\[causalChannel\\]|\\[foundationalChannel\\]|\\[recentChannel\\]|\\[topicGeo\\]|merged=|candidates=|rerank mode|Raw papers|SS |corpus=|HyDE|selection pool|density-rerank|cross-encoder' | tail -300`,
    25000
  );
  if (result.err && result.err.trim()) console.error('STDERR:', result.err.trim());
  if (!result.out.trim()) {
    console.log('No matching log lines found. Trying broader search...');
    const r2 = await sshExec(CT134, `docker logs supabase-edge-functions --since 72h 2>&1 | tail -50`, 20000);
    console.log(r2.out);
  } else {
    console.log(result.out);
  }
})();
