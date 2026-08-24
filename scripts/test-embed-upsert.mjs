import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_KEY,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Embedding via LiteLLM proxy (vLLM-served).
// Migrated 2026-05-08 from direct Ollama (`localhost:11434`) — see
// scripts/import-corpus.mjs for the migration rationale.
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

if (!LLM_API_KEY) {
  console.error('FATAL: LLM_API_KEY not set');
  process.exit(1);
}

const response = await fetch(`${LLM_BASE_URL.replace(/\/+$/, '')}/v1/embeddings`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${LLM_API_KEY}`,
  },
  body: JSON.stringify({ model: EMBED_MODEL, input: 'test paper title' }),
});

if (!response.ok) {
  console.error('LiteLLM error:', response.status, await response.text());
  process.exit(1);
}

const data = await response.json();
const emb = data?.data?.[0]?.embedding;
if (!Array.isArray(emb)) {
  console.error('No embedding in response:', JSON.stringify(data).slice(0, 300));
  process.exit(1);
}
console.log(`✓ Got embedding: ${emb.length} dims`);

// Test upsert
const testRow = {
  id: 'test-embed-' + Date.now(),
  title: 'Test Paper',
  abstract: null,
  source: 'test',
  embedding: `[${emb.join(',')}]`,
  updated_at: new Date().toISOString(),
};

const { error } = await supabase.from('works').upsert([testRow], { onConflict: 'id' });
if (error) {
  console.error('Upsert error:', error);
  process.exit(1);
}
console.log('✓ Upsert successful');
