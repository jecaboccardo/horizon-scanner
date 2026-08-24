-- Wave 2 (2026-05-07): persist per-paper Direct/Indirect classification on
-- the search_run row so brief view can render badges without re-running
-- classification.
--
-- Shape: { "<work_id>": { "evidenceMatch": "direct"|"indirect"|"excluded",
--                         "facetsMatched": ["gender", "geography"],
--                         "facetsMissed":  ["migration"] } }
--
-- NULL = facet retrieval was off when this run executed (legacy rows).

ALTER TABLE search_runs
  ADD COLUMN IF NOT EXISTS evidence_classification jsonb,
  ADD COLUMN IF NOT EXISTS query_facets             jsonb;

COMMENT ON COLUMN search_runs.evidence_classification IS
  'Per-paper Direct/Indirect/Excluded classification. Keyed by work id. Populated when ENABLE_FACET_RETRIEVAL=true.';
COMMENT ON COLUMN search_runs.query_facets IS
  'LLM-decomposed query facets used for classification. Array of {label, expansion[], required}. Populated when ENABLE_FACET_RETRIEVAL=true.';
