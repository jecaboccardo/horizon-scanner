-- Per-person / per-key attribution for BYOK synthesis token usage.
-- llm_calls previously held only tenant_id; these let GET /api/synthesis-usage
-- aggregate token counts by the user who made the call and the key it ran on.
-- Nullable: only BYOK provider calls populate them (Qwen/embeddings/app-default stay null).
ALTER TABLE public.llm_calls ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE public.llm_calls ADD COLUMN IF NOT EXISTS key_id  text;

CREATE INDEX IF NOT EXISTS llm_calls_key_user_ts_idx
  ON public.llm_calls (key_id, user_id, ts DESC);
