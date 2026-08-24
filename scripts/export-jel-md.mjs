#!/usr/bin/env node
/**
 * export-jel-md.mjs — render a jel_papers row to markdown for human A/B review.
 * Usage: node scripts/export-jel-md.mjs <paperId> <out.md>
 * Keeps [workId] tags inline so citation grounding is visible. Prints metrics.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();
const [paperId, outPath] = process.argv.slice(2);
if (!paperId || !outPath) { console.error('usage: export-jel-md.mjs <paperId> <out.md>'); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: p, error } = await sb.from('jel_papers').select('*').eq('id', paperId).single();
if (error || !p) { console.error('fetch failed:', error?.message); process.exit(1); }

const outline = p.outline ?? {};
const sections = Array.isArray(p.sections) ? [...p.sections] : [];
const ord = (s) => { const n = parseInt(String(s.number), 10); return Number.isNaN(n) ? 999 : n; };
sections.sort((a, b) => ord(a) - ord(b));

const lines = [];
lines.push(`# ${outline.title ?? p.query ?? '(untitled)'}`, '');
if (outline.abstract) lines.push('## Abstract', '', outline.abstract, '');
for (const s of sections) {
  lines.push(`## §${s.number}. ${s.heading ?? ''}`.trim(), '');
  lines.push((s.body ?? '').trim(), '');
}
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

// metrics
const distinctCited = new Set();
let totalWords = 0;
const reEffect = /([+\-]?\d+(\.\d+)?\s?(%|pp|percentage points|standard deviations?|SD|σ))/gi;
let magnitudeHits = 0;
for (const s of sections) {
  (s.citedWorkIds ?? []).forEach((id) => distinctCited.add(id));
  totalWords += s.wordCount ?? (s.body ? s.body.split(/\s+/).length : 0);
  magnitudeHits += ((s.body ?? '').match(reEffect) || []).length;
}
console.log(JSON.stringify({
  paperId, status: p.status, title: (outline.title ?? '').slice(0, 80),
  sections: sections.length, totalWords,
  distinctWorkIdsCited: distinctCited.size,
  magnitudeMentions: magnitudeHits,
  hasDevilsAdvocate: sections.some((s) => String(s.number) === 'critique'),
  out: outPath,
}, null, 2));
