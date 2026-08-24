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
  // Show the full edge-functions command block in docker-compose
  console.log('=== docker-compose command block for edge-functions ===');
  await sshExec(CT134,
    'grep -A 50 "container_name: supabase-edge-functions" /opt/supabase-stack/docker-compose.yml | grep -A 10 "command:"'
  );

  // Fix: if patched twice, revert and redo once cleanly
  console.log('\n=== Checking if double-patched ===');
  const check = await sshExec(CT134, 'grep -c "import-map" /opt/supabase-stack/docker-compose.yml');
  const count = parseInt(check.out.trim(), 10);
  console.log(`import-map occurrences: ${count}`);

  if (count === 4) {
    console.log('Double-patched — reverting to original and re-patching once...');
    // Revert both patches and do it once on the correct occurrence (edge-functions block only)
    await sshExec(CT134,
      `cd /opt/supabase-stack && ` +
      // Remove all the import-map lines that were added
      `sed -i '/^    - --import-map$/d; /^    - \\/home\\/deno\\/functions\\/import_map.json$/d' docker-compose.yml && ` +
      // Now patch only the one in the supabase-edge-functions block using awk
      `awk '/container_name: supabase-edge-functions/{found=1} found && /- \\/home\\/deno\\/functions\\/main/{print; print "    - --import-map"; print "    - /home/deno/functions/import_map.json"; found=0; next} {print}' docker-compose.yml > /tmp/dc_patched.yml && ` +
      `mv /tmp/dc_patched.yml docker-compose.yml && echo "clean patch done"`
    );
  }

  console.log('\n=== Verify final command block ===');
  await sshExec(CT134,
    'grep -A 50 "container_name: supabase-edge-functions" /opt/supabase-stack/docker-compose.yml | grep -A 12 "command:"'
  );

  // Restart using plain docker (not compose)
  console.log('\n=== Restarting container ===');
  await sshExec(CT134, 'docker restart supabase-edge-functions && echo "restarted"', 35000);

  await new Promise(r => setTimeout(r, 5000));
  console.log('\n=== Status ===');
  await sshExec(CT134, "docker ps --filter name=supabase-edge-functions --format '{{.Status}}'");
  console.log('\n=== CMD now running ===');
  await sshExec(CT134, 'docker inspect supabase-edge-functions --format "{{json .Config.Cmd}}"');
})();
