-- Aggregators/repositories should remain usable as source_family filters, but
-- should not masquerade as the publication venue shown to users.

UPDATE public.works
SET
  venue = 'The World Bank Research Observer',
  source_family = 'World Bank',
  venue_kind = 'journal',
  publication_type = 'journal_article',
  publication_type_method = 'world_bank_journal_doi',
  publication_type_confidence = GREATEST(coalesce(publication_type_confidence, 0), 0.95)
WHERE lower(coalesce(canonical_doi, '')) LIKE '10.1093/wbro/%'
  AND (
    venue IS DISTINCT FROM 'The World Bank Research Observer'
    OR source_family IS DISTINCT FROM 'World Bank'
    OR venue_kind IS DISTINCT FROM 'journal'
    OR publication_type IS DISTINCT FROM 'journal_article'
  );

UPDATE public.works
SET
  venue = 'The World Bank Economic Review',
  source_family = 'World Bank',
  venue_kind = 'journal',
  publication_type = 'journal_article',
  publication_type_method = 'world_bank_journal_doi',
  publication_type_confidence = GREATEST(coalesce(publication_type_confidence, 0), 0.95)
WHERE lower(coalesce(canonical_doi, '')) LIKE '10.1093/wber/%'
  AND (
    venue IS DISTINCT FROM 'The World Bank Economic Review'
    OR source_family IS DISTINCT FROM 'World Bank'
    OR venue_kind IS DISTINCT FROM 'journal'
    OR publication_type IS DISTINCT FROM 'journal_article'
  );

UPDATE public.works
SET venue = NULL
WHERE venue = 'RePEc: Research Papers in Economics';
