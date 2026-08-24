#!/usr/bin/env node
// One-shot: inspect rafaelde's recent JEL papers — pulls query, filters, outline title
// to debug topic drift in the outline agent.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const CT133 = { host: process.env.VPS_HOST || '127.0.0.1', port: 10133, username: 'root', password: process.env.VPS_PASSWORD, readyTimeout: 10000 };

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

const SQL = `
\\x off
SELECT
  count(*) AS total_works,
  count(*) FILTER (WHERE abstract IS NOT NULL) AS with_abstract,
  count(*) FILTER (WHERE abstract IS NULL) AS missing_abstract,
  count(*) FILTER (WHERE sms_level IS NOT NULL) AS with_sms,
  count(*) FILTER (WHERE sms_level IS NULL AND abstract IS NOT NULL) AS sms_pending_with_abstract,
  count(*) FILTER (WHERE methodology_design IS NOT NULL) AS with_design,
  count(*) FILTER (WHERE canonical_doi IS NOT NULL) AS with_doi,
  count(*) FILTER (WHERE is_noise IS TRUE) AS marked_noise,
  count(*) FILTER (WHERE canonical_work_id IS NOT NULL) AS dedup_alias
FROM works;

SELECT
  count(*) AS evidence_cards_total,
  count(*) FILTER (WHERE finding_short IS NOT NULL) AS cards_with_finding,
  count(*) FILTER (WHERE study_design IS NOT NULL) AS cards_with_design
FROM evidence_cards;

SELECT count(*) AS sms_distribution, sms_level
FROM works WHERE sms_level IS NOT NULL GROUP BY sms_level ORDER BY sms_level;
`;

// Write SQL to /tmp on the remote host, then exec psql -f. Avoids quoting hell.
const cmd = [
  `cat > /tmp/inspect.sql <<'EOSQL'`,
  SQL.trim(),
  `EOSQL`,
  `su -s /bin/bash postgres -c 'psql -d iadb -f /tmp/inspect.sql'`,
].join('\n');

(async () => {
  const r = await sshExec(CT133, cmd, 30000);
  if (r.err) console.error('STDERR:', r.err);
  console.log(r.out);
})();
