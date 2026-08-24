#!/usr/bin/env node
/**
 * Coverage analysis: check ABS top journals against corpus by venue name match.
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Top 40 SCL-relevant journals (curated from ABS 4* + 4)
const TOP_JOURNALS = [
  // ABS 4* economics
  { tier: '4*', name: 'American Economic Review', match: 'american economic review' },
  { tier: '4*', name: 'Econometrica', match: 'econometrica' },
  { tier: '4*', name: 'Journal of Political Economy', match: 'journal of political economy' },
  { tier: '4*', name: 'Quarterly Journal of Economics', match: 'quarterly journal of economics' },
  { tier: '4*', name: 'Review of Economic Studies', match: 'review of economic studies' },
  // ABS 4* sociology/psych
  { tier: '4*', name: 'American Journal of Sociology', match: 'american journal of sociology' },
  { tier: '4*', name: 'American Sociological Review', match: 'american sociological review' },
  { tier: '4*', name: 'Psychological Science', match: 'psychological science' },
  { tier: '4*', name: 'Journal of Applied Psychology', match: 'journal of applied psychology' },
  { tier: '4*', name: 'Personnel Psychology', match: 'personnel psychology' },
  { tier: '4*', name: 'Annual Review of Sociology', match: 'annual review of sociology' },
  { tier: '4*', name: 'Human Resource Management Journal', match: 'human resource management journal' },
  // ABS 4 economics
  { tier: '4', name: 'AEJ: Applied Economics', match: 'applied economics' },
  { tier: '4', name: 'AEJ: Economic Policy', match: 'economic policy' },
  { tier: '4', name: 'AEJ: Macroeconomics', match: 'macroeconomics' },
  { tier: '4', name: 'Economic Journal', match: 'economic journal' },
  { tier: '4', name: 'International Economic Review', match: 'international economic review' },
  { tier: '4', name: 'Journal of Econometrics', match: 'journal of econometrics' },
  { tier: '4', name: 'Journal of Economic Literature', match: 'journal of economic literature' },
  { tier: '4', name: 'Journal of Economic Perspectives', match: 'journal of economic perspectives' },
  { tier: '4', name: 'Journal of International Economics', match: 'journal of international economics' },
  { tier: '4', name: 'Journal of Labor Economics', match: 'journal of labor economics' },
  { tier: '4', name: 'Journal of Public Economics', match: 'journal of public economics' },
  { tier: '4', name: 'Journal of Development Economics', match: 'journal of development economics' },
  { tier: '4', name: 'Journal of Health Economics', match: 'journal of health economics' },
  { tier: '4', name: 'Journal of Human Resources', match: 'journal of human resources' },
  { tier: '4', name: 'Review of Economics and Statistics', match: 'review of economics and statistics' },
  { tier: '4', name: 'Journal of European Economic Association', match: 'journal of the european economic association' },
  { tier: '4', name: 'Demography', match: 'demography' },
  { tier: '4', name: 'World Development', match: 'world development' },
  { tier: '4', name: 'Population and Development Review', match: 'population and development review' },
  { tier: '4', name: 'Social Science & Medicine', match: 'social science' },
  { tier: '4', name: 'Sociology of Education', match: 'sociology of education' },
  { tier: '4', name: 'Economic Development and Cultural Change', match: 'economic development and cultural change' },
  { tier: '4', name: 'Journal of Population Economics', match: 'journal of population economics' },
  { tier: '4', name: 'Industrial and Labor Relations Review', match: 'industrial and labor relations review' },
  { tier: '4', name: 'British Journal of Industrial Relations', match: 'british journal of industrial relations' },
  { tier: '4', name: 'Health Economics', match: 'health economics' },
  { tier: '4', name: 'World Bank Economic Review', match: 'world bank economic review' },
  { tier: '4', name: 'Journal of Economic Behavior & Organization', match: 'journal of economic behavior' },
];

async function countJournal(matchPattern) {
  // Match against venue field (case-insensitive substring)
  const { count } = await supabase
    .from('works')
    .select('id', { count: 'exact', head: true })
    .ilike('venue', `%${matchPattern}%`);
  return count || 0;
}

async function countJournalRecent(matchPattern, fromYear) {
  const { count } = await supabase
    .from('works')
    .select('id', { count: 'exact', head: true })
    .ilike('venue', `%${matchPattern}%`)
    .gte('year', fromYear);
  return count || 0;
}

async function main() {
  console.log('=== ABS Top 40 SCL-relevant journal coverage ===\n');
  console.log('Tier | Journal'.padEnd(70) + '| Total | Last 15y | Last 30y');
  console.log('-'.repeat(110));

  const results = [];
  for (const j of TOP_JOURNALS) {
    const total = await countJournal(j.match);
    const last15 = await countJournalRecent(j.match, 2011);
    const last30 = await countJournalRecent(j.match, 1996);
    results.push({ ...j, total, last15, last30 });
    console.log(
      `${j.tier.padEnd(3)} | ${j.name.padEnd(50)} | ${String(total).padStart(5)} | ${String(last15).padStart(8)} | ${String(last30).padStart(8)}`
    );
  }

  const totalSum = results.reduce((s, r) => s + r.total, 0);
  const last15Sum = results.reduce((s, r) => s + r.last15, 0);
  const last30Sum = results.reduce((s, r) => s + r.last30, 0);
  console.log('-'.repeat(110));
  console.log(`TOTAL across ${results.length} top journals: ${totalSum} (last 15y: ${last15Sum}, last 30y: ${last30Sum})`);

  // Identify gaps
  console.log('\n=== Journals with WEAK coverage (<100 papers) ===');
  results.filter(r => r.total < 100).forEach(r =>
    console.log(`  ${r.tier} ${r.name}: ${r.total} papers`)
  );

  console.log('\n=== Journals with NO 30-year history (<50 papers pre-2011) ===');
  results.filter(r => (r.last30 - r.last15) < 50).forEach(r =>
    console.log(`  ${r.tier} ${r.name}: only ${r.last30 - r.last15} pre-2011 papers`)
  );
}

main().catch(e => console.error(e.message));
