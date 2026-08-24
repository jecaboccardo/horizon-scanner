-- llm_calls: split out Claude prompt-cache token counts so cost is accurate.
--
-- Until now telemetry summed fresh input + cache-creation + cache-read into
-- tokens_in, and the cost report charged the full input rate on all of it — which
-- OVER-states BYOK Claude cost whenever caching hits (cache reads bill at ~10%,
-- cache writes at ~125%). These two nullable columns let the report price the
-- three token classes correctly and confirm the JEL/chat cache is actually landing.
--
-- Backward-compatible: nullable, no default backfill. Old rows read as NULL
-- (treated as "no cache info", priced as plain input by the report).
ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS cache_read_tokens  integer,
  ADD COLUMN IF NOT EXISTS cache_write_tokens integer;

COMMENT ON COLUMN llm_calls.cache_read_tokens  IS 'Claude cache_read_input_tokens (billed ~0.1x input). NULL = provider/call had no cache info.';
COMMENT ON COLUMN llm_calls.cache_write_tokens IS 'Claude cache_creation_input_tokens (billed ~1.25x input). NULL = no cache write.';
