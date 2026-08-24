#!/usr/bin/env node
// One-shot: sync the updated OA-abstract script to CT 134, then start
// OpenAlex abstract backfill + SMS classifier in the background. Reports
// status of all running backfill processes.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const CT134 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10134, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 15000 };

function ssh(cfg, cmd, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    const t = setTimeout(() => { c.end(); reject(new Error('SSH timeout')); }, timeoutMs);
    c.on('ready', () => {
      c.exec(cmd, (err, s) => {
        if (err) { clearTimeout(t); c.end(); reject(err); return; }
        let out = '', errOut = '';
        s.on('data', d => out += d);
        s.stderr.on('data', d => errOut += d);
        s.on('close', code => {
          clearTimeout(t);
          c.end();
          resolve({ out, err: errOut, code });
        });
      });
    });
    c.on('error', err => { clearTimeout(t); reject(err); });
    c.connect(cfg);
  });
}

function sftpUpload(cfg, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    const t = setTimeout(() => { c.end(); reject(new Error('SFTP timeout')); }, 30000);
    c.on('ready', () => {
      c.sftp((err, sftp) => {
        if (err) { clearTimeout(t); c.end(); reject(err); return; }
        sftp.fastPut(localPath, remotePath, (putErr) => {
          clearTimeout(t);
          c.end();
          if (putErr) reject(putErr); else resolve();
        });
      });
    });
    c.on('error', err => { clearTimeout(t); reject(err); });
    c.connect(cfg);
  });
}

(async () => {
  console.log('[1/4] Uploading updated backfill-abstracts-openalex.mjs to CT 134...');
  await sftpUpload(
    CT134,
    'D:/Iota/Horizon-scanner-IADB/scripts/backfill-abstracts-openalex.mjs',
    '/opt/horizon-scanner/repo/scripts/backfill-abstracts-openalex.mjs',
  );
  const verify = await ssh(CT134, 'grep -n -E "canonical_work_id|cited_by_count|citationsUpdated" /opt/horizon-scanner/repo/scripts/backfill-abstracts-openalex.mjs | head');
  console.log('  ✓ uploaded. Verification matches:\n' + verify.out.trim());

  console.log('\n[2/4] Starting OpenAlex abstract backfill in background...');
  const oaCmd =
    'cd /opt/horizon-scanner/repo && ' +
    'SUPABASE_URL=http://127.0.0.1:8000 VITE_SUPABASE_URL=http://127.0.0.1:8000 ' +
    'nohup node scripts/backfill-abstracts-openalex.mjs --limit 50000 ' +
    '>> /tmp/oa-abstract-backfill.log 2>&1 & ' +
    'echo "OA PID: $!"';
  const oa = await ssh(CT134, oaCmd);
  console.log('  ' + oa.out.trim());

  console.log('\n[3/4] Starting SMS classifier (throttled --sleep-ms 2500) in background...');
  const smsCmd =
    'cd /opt/horizon-scanner/repo && ' +
    'SUPABASE_URL=http://127.0.0.1:8000 VITE_SUPABASE_URL=http://127.0.0.1:8000 ' +
    'nohup node scripts/classify-sms-qwen.mjs --abstract-present --sleep-ms 2500 ' +
    '>> /tmp/sms-classify.log 2>&1 & ' +
    'echo "SMS PID: $!"';
  const sms = await ssh(CT134, smsCmd);
  console.log('  ' + sms.out.trim());

  // Give processes a few seconds to start writing logs
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n[4/4] Status check...');
  const status = await ssh(CT134,
    'ps -eo pid,etime,pcpu,pmem,cmd | grep -E "openalex|classify-sms|extraction" | grep -v grep; ' +
    'echo "--- OA log (last 5 lines) ---"; ' +
    'tail -5 /tmp/oa-abstract-backfill.log 2>/dev/null || echo "(no log yet)"; ' +
    'echo "--- SMS log (last 5 lines) ---"; ' +
    'tail -5 /tmp/sms-classify.log 2>/dev/null || echo "(no log yet)"'
  );
  console.log(status.out);
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
