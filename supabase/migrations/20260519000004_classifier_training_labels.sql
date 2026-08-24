-- Classifier training labels — passive label collection from production LLM judge.
--
-- Every time the LLM judge tier of the direct/indirect classifier produces a
-- verdict, we persist a row here. Over weeks of normal usage this accumulates
-- thousands of (paper, query, verdict) tuples covering the full rank
-- distribution — the data we need to retrain the trained-classifier tier so
-- it can carry load when LiteLLM is unhealthy (and in general).
--
-- The classifier was previously trained on only ~446 human-labeled top-60
-- papers, which is why the OOD guard rejected ~all rank-60-200 papers in
-- production. Once we have a few thousand auto-labels here from rank 0-200,
-- retraining lifts that gate and the trained tier becomes load-bearing.
--
-- This table is append-only from the API path. A separate offline trainer
-- reads it (potentially deduped, sampled, joined with human labels) and
-- produces a new model artifact.

CREATE TABLE IF NOT EXISTS public.classifier_training_labels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Paper identity. canonical_doi is preferred; paper_id is the works.id fallback.
  paper_id        text,
  canonical_doi   text,
  -- Query context at classification time.
  query           text NOT NULL,
  query_facets    jsonb,           -- the QueryFacets decomposition
  -- Verdict.
  classification  text NOT NULL CHECK (
    classification IN ('direct-lac', 'direct-global', 'indirect', 'excluded')
  ),
  label_source    text NOT NULL DEFAULT 'llm_judge' CHECK (
    label_source IN ('llm_judge', 'human', 'cosine_seed', 'trained')
  ),
  llm_rationale   text,
  llm_model       text,
  -- Feature vector used by trainedClassifier.ts so future retrains can replay
  -- without re-deriving features against possibly-changed code.
  paper_features  jsonb,
  -- Paper snapshot fields so a future retrain doesn't have to join works
  -- (which may have churned by then).
  paper_title             text,
  paper_year              int,
  paper_methodology_design text,
  paper_sms_level         int,
  paper_citation_count    int,
  paper_venue             text,
  paper_source_family     text,
  paper_retrieval_source  text,   -- 'corpus' | 'topic_geo_channel' | 'live_*'
  geography_matched       boolean,
  -- Provenance.
  search_run_id   uuid,
  tenant_id       text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS classifier_training_labels_source_created_idx
  ON public.classifier_training_labels (label_source, created_at DESC);

CREATE INDEX IF NOT EXISTS classifier_training_labels_doi_idx
  ON public.classifier_training_labels (canonical_doi)
  WHERE canonical_doi IS NOT NULL;

CREATE INDEX IF NOT EXISTS classifier_training_labels_query_idx
  ON public.classifier_training_labels USING gin (to_tsvector('simple', query));

COMMENT ON TABLE public.classifier_training_labels IS
  'Passive collection of LLM-judge verdicts for offline retraining of the trained-classifier tier.';
