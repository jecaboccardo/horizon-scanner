#!/usr/bin/env node
// Quick Qwen health check — exits 0 if Qwen responds, 1 if not
import { config } from 'dotenv';
config();

const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY;

try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(`${LLM_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model: 'qwen2.5:14b-synthesis',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
      temperature: 0,
    }),
  });
  clearTimeout(timer);
  if (res.ok) {
    console.log(`UP (HTTP ${res.status})`);
    process.exit(0);
  } else {
    console.log(`DOWN (HTTP ${res.status})`);
    process.exit(1);
  }
} catch (e) {
  console.log(`DOWN (${e.message?.slice(0, 60)})`);
  process.exit(1);
}
