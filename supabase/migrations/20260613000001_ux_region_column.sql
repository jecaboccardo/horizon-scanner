-- works.ux_region text[] — coarse UX-filter region buckets derived from
-- works.geography, for the region filter the user sees. Six buckets:
--   LAC · Sub-Saharan Africa · South & Southeast Asia · USA and Canada
--   (United States + Canada grouped) · Europe & Central Asia · MENA
-- Papers matching no bucket (empty geography, or East-Asia/Oceania/OECD-only) →
-- ['Global']. Multi-value (a cross-country paper gets several buckets).
--
-- Populated by scripts/derive-ux-region.mjs — JS BATCHED, not a bulk SQL UPDATE:
-- `works` is a wide table (768-dim embedding + raw_data per row) so any column
-- UPDATE rewrites the full row → a single 490k-row UPDATE is IO-bound and holds
-- locks for >15min, contending with live prod writes (learned the hard way).
--
-- The region FILTER does NOT yet query this column (retrieval still matches
-- REGION_KEYWORDS against geography). Wiring the filter to ux_region (ux_region &&
-- ARRAY['LAC']) is a separate eval-gated change — the GIN index below is ready for it.
--
-- NOTE: column + data were applied to prod live (2026-06-13) ahead of this file;
-- IF NOT EXISTS makes re-application a no-op.
ALTER TABLE public.works ADD COLUMN IF NOT EXISTS ux_region text[];
CREATE INDEX IF NOT EXISTS idx_works_ux_region ON public.works USING gin (ux_region);
