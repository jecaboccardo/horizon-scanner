/**
 * scripts/apply-migrations.mjs
 *
 * Applies all Supabase migrations to the remote database.
 *
 * Usage (two options):
 *
 * Option A — Supabase CLI (preferred, after `npx supabase login`):
 *   npx supabase db push
 *   npx supabase db push --include-seed   # also runs seeds/01_sources.sql
 *
 * Option B — Direct database connection (no CLI auth needed):
 *   DATABASE_URL=postgresql://postgres.rktrqfaiftfwwycrwjni:<your-db-password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres \
 *   node scripts/apply-migrations.mjs
 *
 * Where to find your DB password:
 *   Supabase Dashboard → Settings → Database → Connection string
 *   (the password you set when creating the project)
 *
 * Where to find your Supabase PAT (for Option A):
 *   https://supabase.com/dashboard/account/tokens
 *   Then: npx supabase login --token <your-pat>
 *   Then: npx supabase link --project-ref rktrqfaiftfwwycrwjni
 *   Then: npx supabase db push --include-seed
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(`
ERROR: DATABASE_URL not set.

To push migrations, either:

1. Use the Supabase CLI (requires a Personal Access Token):
   - Get a PAT from: https://supabase.com/dashboard/account/tokens
   - npx supabase login --token <your-sbp_...token>
   - npx supabase link --project-ref rktrqfaiftfwwycrwjni
   - npx supabase db push --include-seed

2. Use this script with a direct DB connection:
   - Find your DB password: Supabase Dashboard → Settings → Database
   - DATABASE_URL="postgresql://postgres.rktrqfaiftfwwycrwjni:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres" node scripts/apply-migrations.mjs
`);
  process.exit(1);
}

// Dynamic import of postgres (install: npm install --save-dev postgres)
let sql;
try {
  const { default: postgres } = await import('postgres');
  sql = postgres(databaseUrl, { ssl: 'require', max: 1 });
} catch (e) {
  console.error('postgres package not installed. Run: npm install --save-dev postgres');
  process.exit(1);
}

const migrationsDir = resolve(projectRoot, 'supabase/migrations');
const seedsDir = resolve(projectRoot, 'supabase/seeds');

const migrations = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

console.log(`Applying ${migrations.length} migrations...`);

for (const file of migrations) {
  const path = resolve(migrationsDir, file);
  const content = readFileSync(path, 'utf8');
  try {
    await sql.unsafe(content);
    console.log(`  ✓ ${file}`);
  } catch (e) {
    // Idempotent errors (already exists) are OK
    if (e.message.includes('already exists')) {
      console.log(`  ~ ${file} (already applied)`);
    } else {
      console.error(`  ✗ ${file}: ${e.message}`);
      await sql.end();
      process.exit(1);
    }
  }
}

const seeds = readdirSync(seedsDir).filter(f => f.endsWith('.sql')).sort();
console.log(`\nApplying ${seeds.length} seed files...`);

for (const file of seeds) {
  const path = resolve(seedsDir, file);
  const content = readFileSync(path, 'utf8');
  try {
    await sql.unsafe(content);
    console.log(`  ✓ ${file}`);
  } catch (e) {
    console.error(`  ✗ ${file}: ${e.message}`);
  }
}

await sql.end();
console.log('\nDone.');
