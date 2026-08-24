#!/usr/bin/env node
/**
 * Fix NULL titles by querying OpenAlex and Semantic Scholar APIs
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const OPENAI_URL = 'https://api.openalex.org/works';
const SS_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchTitleFromOpenAlex(doi) {
  if (!doi) return null;
  try {
    const response = await fetch(`${OPENAI_URL}/${doi}?select=title`);
    if (response.ok) {
      const data = await response.json();
      return data.title || null;
    }
  } catch (err) {
    process.stderr.write('O');
  }
  return null;
}

async function fetchTitleFromSS(doi) {
  if (!doi) return null;
  try {
    const response = await fetch(`${SS_URL}?query=${doi}&fields=title`, {
      headers: { 'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY || '' }
    });
    if (response.ok) {
      const data = await response.json();
      if (data.data?.[0]?.title) {
        return data.data[0].title;
      }
    }
  } catch (err) {
    process.stderr.write('S');
  }
  return null;
}

async function main() {
  console.log('=== Fix NULL Titles ===\n');

  // Fetch papers with NULL titles
  const { data: nullTitlePapers, error } = await supabase
    .from('works')
    .select('id, canonical_doi, source')
    .is('title', null)
    .limit(100); // Process 100 at a time

  if (error) {
    console.error('Fetch error:', error.message);
    process.exit(1);
  }

  if (!nullTitlePapers || nullTitlePapers.length === 0) {
    console.log('✓ No papers with NULL titles found!');
    process.exit(0);
  }

  console.log(`Found ${nullTitlePapers.length} papers with NULL titles\n`);

  let fixed = 0;
  let failed = 0;

  for (let i = 0; i < nullTitlePapers.length; i++) {
    const paper = nullTitlePapers[i];
    process.stderr.write(`[${i+1}/${nullTitlePapers.length}] `);

    let title = null;

    // Try OpenAlex first
    if (paper.canonical_doi) {
      title = await fetchTitleFromOpenAlex(paper.canonical_doi);
      if (title) {
        process.stderr.write('✓');
      }
    }

    // Try Semantic Scholar if OpenAlex failed
    if (!title && paper.canonical_doi) {
      title = await fetchTitleFromSS(paper.canonical_doi);
      if (title) {
        process.stderr.write('✓');
      }
    }

    if (title) {
      // Update the paper with the fetched title
      const { error: updateError } = await supabase
        .from('works')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', paper.id);

      if (updateError) {
        process.stderr.write('E');
        failed++;
      } else {
        process.stderr.write('.');
        fixed++;
      }
    } else {
      process.stderr.write('x');
      failed++;
    }

    // Rate limit
    await sleep(100);
  }

  console.log(`\n\nDone: ${fixed} fixed, ${failed} failed`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
