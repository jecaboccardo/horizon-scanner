-- Diagnostic: list indexes on `works` + their validity. Restricted to service_role.

CREATE OR REPLACE FUNCTION inspect_works_indexes()
RETURNS TABLE (
  indexname text,
  indexdef  text,
  is_valid  bool,
  is_ready  bool,
  size      text,
  scans     bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    i.relname::text                                AS indexname,
    pg_get_indexdef(i.oid)                         AS indexdef,
    ix.indisvalid                                  AS is_valid,
    ix.indisready                                  AS is_ready,
    pg_size_pretty(pg_relation_size(i.oid))        AS size,
    COALESCE(s.idx_scan, 0)                        AS scans
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
  WHERE t.relname = 'works'
  ORDER BY i.relname;
$$;

REVOKE EXECUTE ON FUNCTION inspect_works_indexes() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION inspect_works_indexes() TO service_role;

NOTIFY pgrst, 'reload schema';
