// One-off: check whether the 20 canonical AI+labor papers Jess listed are in
// the corpus. Uses title-substring + ILIKE matching against works.title, plus
// author surname when title is generic.

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const PAPERS = [
  { rank: 1,  authors: ['Brynjolfsson', 'Li', 'Raymond'],         title_frag: 'Generative AI at Work',                       year: 2025 },
  { rank: 2,  authors: ['Brambilla', 'Cesar', 'Falcone', 'Gasparini'], title_frag: 'Impact of Robots in Latin America',     year: 2023 },
  { rank: 3,  authors: ['Acemoglu', 'Autor', 'Hazell', 'Restrepo'], title_frag: 'AI and Jobs',                              year: 2022 },
  { rank: 4,  authors: ['Humlum', 'Vestergaard'],                  title_frag: 'ChatGPT',                                   year: 2025 },
  { rank: 5,  authors: ['Yang'],                                   title_frag: 'AI Technology Affects Productivity',        year: 2022 },
  { rank: 6,  authors: ['Daniotti'],                               title_frag: 'using AI to code',                          year: 2026 },
  { rank: 7,  authors: ['Graetz', 'Michaels'],                     title_frag: 'Robots at Work',                            year: 2018 },
  { rank: 8,  authors: ['Acemoglu', 'Restrepo'],                   title_frag: 'Robots and Jobs',                           year: 2020 },
  { rank: 9,  authors: ['Felten', 'Raj', 'Seamans'],               title_frag: 'Occupational Exposure',                     year: 2021 },
  { rank: 10, authors: ['Webb'],                                   title_frag: 'Impact of AI on the Labor Market',          year: 2020 },
  { rank: 11, authors: ['Gmyrek', 'Berg', 'Bescond'],              title_frag: 'Buffer or Bottleneck',                      year: 2024 },
  { rank: 12, authors: ['Egana', 'Bravo-Ortega'],                  title_frag: 'AI and Labor Market Transformations',       year: 2025 },
  { rank: 13, authors: ['Ciaschi'],                                title_frag: 'Distributive Impact of AI',                 year: 2025 },
  { rank: 14, authors: ['Azuara Herrera'],                         title_frag: 'AI, Productivity',                          year: 2024 },
  { rank: 15, authors: ['Herrera Giraldo'],                        title_frag: 'AI Diffusion in Colombia',                  year: 2024 },
  { rank: 16, authors: ['Garcia-Suaza'],                           title_frag: 'AI exposure in Colombia',                   year: 2024 },
  { rank: 17, authors: ['Brambilla'],                              title_frag: 'Risk of Automation in Latin America',       year: 2021 },
  { rank: 18, authors: ['Dutz', 'Almeida', 'Packard'],             title_frag: 'Jobs of Tomorrow',                          year: 2018 },
  { rank: 19, authors: ['Bakker'],                                 title_frag: 'AI and productivity in',                    year: 2025 },
  { rank: 20, authors: ['Giuntella'],                              title_frag: 'AI and worker wellbeing',                   year: 2025 },
];

async function findMatches(p) {
  // Title fragment search. Use ILIKE for substring, accent-insensitive via
  // unaccent extension would be cleaner but plain ILIKE is fine for these.
  const { data, error } = await supabase
    .from('works')
    .select('id, title, year, authors, source, venue')
    .ilike('title', `%${p.title_frag}%`)
    .limit(5);
  if (error) {
    console.error(`  ! query error: ${error.message}`);
    return [];
  }
  // Filter to ones with at least one author surname overlap (loose)
  return (data || []).filter((row) => {
    const a = (row.authors || []).join(' ').toLowerCase();
    return p.authors.some((surname) =>
      a.includes(surname.toLowerCase().split(/\s+/)[0])
    );
  });
}

async function main() {
  console.log('Checking 20 canonical AI+labor papers against the corpus...\n');
  let hits = 0;
  let misses = 0;
  for (const p of PAPERS) {
    const matches = await findMatches(p);
    const tag = matches.length > 0 ? '✅ HIT ' : '❌ MISS';
    if (matches.length > 0) hits++;
    else misses++;
    const titleSnip = p.title_frag.length > 38 ? p.title_frag.slice(0, 38) + '…' : p.title_frag;
    const authorSnip = p.authors.slice(0, 2).join('+');
    console.log(`${tag}  #${String(p.rank).padStart(2, '0')}  ${authorSnip.padEnd(20)} ${p.year}  ${titleSnip}`);
    if (matches.length > 0) {
      for (const m of matches.slice(0, 2)) {
        const t = (m.title || '').slice(0, 70);
        console.log(`         └ ${m.year}  ${t}  [${m.source || '?'}]`);
      }
    }
  }
  console.log(`\nSummary: ${hits} of ${PAPERS.length} found in corpus, ${misses} missing.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
