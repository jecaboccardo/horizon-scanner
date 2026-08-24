-- Index management RPC functions for bulk import
-- Allows dropping/rebuilding the pgvector index to avoid statement timeouts during large corpus imports

-- Drop pgvector HNSW index before bulk insert (prevents statement timeouts)
CREATE OR REPLACE FUNCTION public.drop_embedding_index()
RETURNS TABLE (status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'works'
      AND indexname = 'idx_works_embedding'
  ) THEN
    DROP INDEX IF EXISTS public.idx_works_embedding;
    RETURN QUERY SELECT 'Index dropped'::TEXT AS status;
  ELSE
    RETURN QUERY SELECT 'Index not found'::TEXT AS status;
  END IF;
END
$$;

-- Rebuild HNSW index after bulk insert (restores vector search performance)
CREATE OR REPLACE FUNCTION public.rebuild_embedding_index()
RETURNS TABLE (status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- Only rebuild if index doesn't exist and there are embeddings
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'works'
      AND indexname = 'idx_works_embedding'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.works
      WHERE embedding IS NOT NULL
    ) THEN
      CREATE INDEX idx_works_embedding
        ON public.works
        USING hnsw (embedding extensions.vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
      RETURN QUERY SELECT 'Index rebuilt'::TEXT AS status;
    ELSE
      RETURN QUERY SELECT 'No embeddings to index'::TEXT AS status;
    END IF;
  ELSE
    RETURN QUERY SELECT 'Index already exists'::TEXT AS status;
  END IF;
END
$$;
