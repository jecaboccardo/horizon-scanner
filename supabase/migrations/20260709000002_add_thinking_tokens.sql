-- Gemini "thinking" (reasoning) tokens. For thinking models (gemini-2.5-pro),
-- usageMetadata.thoughtsTokenCount is billed at the OUTPUT rate but is NOT part
-- of candidatesTokenCount (which we log as tokens_out). Logging it separately
-- lets the cost report price it correctly instead of understating Pro cost, and
-- keeps tokens_out meaning "prose output length". Nullable, no default → instant
-- ADD COLUMN, no table rewrite. Null for all pre-existing rows and for models
-- that don't report thinking (flash with budget 0, Qwen, embeddings, Claude).
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS thinking_tokens integer;
