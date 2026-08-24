WITH derived AS (
  SELECT
    id,
    CASE
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'nber'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.3386/%'
        THEN 'NBER'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'iza'
        THEN 'IZA'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'cepr'
        THEN 'CEPR'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'oecd'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.1787/%'
        OR lower(coalesce(venue, '')) LIKE '%oecd%'
        THEN 'OECD'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'wb'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.1596/%'
        OR lower(coalesce(raw_data->>'institution', '')) = 'world bank'
        OR lower(coalesce(venue, '')) LIKE '%world bank%'
        OR lower(coalesce(url, '')) LIKE '%worldbank.org%'
        OR lower(coalesce(url, '')) LIKE '%openknowledge.worldbank%'
        THEN 'World Bank'
      WHEN lower(coalesce(canonical_doi, '')) LIKE '10.18235/%'
        OR lower(coalesce(raw_data->>'institution', '')) IN ('idb', 'iadb')
        OR lower(coalesce(source, '')) IN ('idb', 'idb_publications')
        OR lower(coalesce(corpus_source, '')) = 'idb_bulk'
        OR lower(coalesce(venue, '')) LIKE '%idb publication%'
        OR lower(coalesce(url, '')) LIKE '%iadb.org%'
        THEN 'IADB'
      WHEN lower(coalesce(venue, '')) = 'ssrn electronic journal'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.2139/ssrn%'
        THEN 'SSRN'
      WHEN lower(coalesce(source, '')) = 'repec'
        OR lower(coalesce(venue, '')) = 'repec: research papers in economics'
        OR lower(coalesce(url, '')) LIKE '%ideas.repec.org%'
        OR lower(coalesce(url, '')) LIKE '%econpapers.repec.org%'
        THEN 'RePEc'
      ELSE NULL
    END AS next_source_family,
    CASE
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'nber' THEN 'NBER Working Papers'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'iza' THEN 'IZA Discussion Papers'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'cepr' THEN 'CEPR Discussion Papers'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'oecd' THEN 'OECD Working Papers'
      WHEN lower(coalesce(raw_data->>'series_key', '')) = 'wb'
        AND publication_type = 'working_paper' THEN 'World Bank Working Paper / Report'
      WHEN lower(coalesce(venue, '')) IN ('world bank economic review', 'the world bank economic review')
        THEN 'The World Bank Economic Review'
      WHEN lower(coalesce(venue, '')) IN ('world bank research observer', 'the world bank research observer')
        THEN 'The World Bank Research Observer'
      ELSE venue
    END AS next_venue,
    CASE
      WHEN (lower(coalesce(raw_data->>'series_key', '')) = 'nber'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.3386/%')
        AND coalesce(publication_type, '') IN ('', 'other', 'report', 'journal_article')
        THEN 'working_paper'
      WHEN (lower(coalesce(venue, '')) = 'ssrn electronic journal'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.2139/ssrn%')
        AND coalesce(publication_type, '') <> 'working_paper'
        THEN 'working_paper'
      WHEN lower(coalesce(venue, '')) IN (
        'world bank economic review',
        'the world bank economic review',
        'world bank research observer',
        'the world bank research observer'
      )
        THEN 'journal_article'
      WHEN lower(coalesce(venue, '')) LIKE '%world bank policy research working paper%'
        THEN 'working_paper'
      ELSE publication_type
    END AS next_publication_type,
    CASE
      WHEN (lower(coalesce(raw_data->>'series_key', '')) = 'nber'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.3386/%')
        AND coalesce(publication_type, '') IN ('', 'other', 'report', 'journal_article')
        THEN 'source_family_nber'
      WHEN (lower(coalesce(venue, '')) = 'ssrn electronic journal'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.2139/ssrn%')
        AND coalesce(publication_type, '') <> 'working_paper'
        THEN 'source_family_ssrn'
      WHEN lower(coalesce(venue, '')) IN (
        'world bank economic review',
        'the world bank economic review',
        'world bank research observer',
        'the world bank research observer'
      )
        THEN 'world_bank_journal_venue'
      WHEN lower(coalesce(venue, '')) LIKE '%world bank policy research working paper%'
        THEN 'world_bank_working_paper_venue'
      ELSE publication_type_method
    END AS next_publication_type_method,
    CASE
      WHEN (
        lower(coalesce(raw_data->>'series_key', '')) IN ('nber')
        OR lower(coalesce(canonical_doi, '')) LIKE '10.3386/%'
        OR lower(coalesce(venue, '')) = 'ssrn electronic journal'
        OR lower(coalesce(canonical_doi, '')) LIKE '10.2139/ssrn%'
        OR lower(coalesce(venue, '')) IN (
          'world bank economic review',
          'the world bank economic review',
          'world bank research observer',
          'the world bank research observer'
        )
        OR lower(coalesce(venue, '')) LIKE '%world bank policy research working paper%'
      )
        THEN GREATEST(coalesce(publication_type_confidence, 0), 0.95)
      ELSE publication_type_confidence
    END AS next_publication_type_confidence
  FROM public.works
),
typed AS (
  SELECT
    w.id,
    d.next_source_family,
    d.next_venue,
    d.next_publication_type,
    d.next_publication_type_method,
    d.next_publication_type_confidence,
    CASE
      WHEN d.next_publication_type = 'journal_article' THEN 'journal'
      WHEN d.next_source_family IN ('NBER', 'SSRN') THEN 'working_paper_series'
      WHEN d.next_source_family IN ('IZA', 'CEPR') THEN 'discussion_paper_series'
      WHEN d.next_source_family = 'OECD' AND d.next_publication_type = 'working_paper' THEN 'working_paper_series'
      WHEN d.next_source_family = 'World Bank' AND d.next_publication_type = 'working_paper' THEN 'working_paper_series'
      WHEN d.next_source_family = 'World Bank'
        AND (
          lower(coalesce(d.next_venue, '')) LIKE '%open knowledge%'
          OR lower(coalesce(d.next_venue, '')) LIKE '%documents & reports%'
        )
        THEN 'repository'
      WHEN d.next_source_family = 'IADB'
        OR lower(coalesce(d.next_venue, '')) LIKE '%idb publication%'
        THEN 'institutional_publication'
      WHEN lower(coalesce(d.next_venue, '')) LIKE '%ebook%'
        OR lower(coalesce(d.next_venue, '')) LIKE '%ebooks%'
        THEN 'book_series'
      WHEN d.next_publication_type = 'working_paper' THEN 'working_paper_series'
      WHEN d.next_publication_type = 'discussion_paper' THEN 'discussion_paper_series'
      WHEN d.next_publication_type = 'report' THEN 'institutional_publication'
      ELSE 'other'
    END AS next_venue_kind
  FROM public.works w
  JOIN derived d USING (id)
)
UPDATE public.works w
SET
  source_family = t.next_source_family,
  venue_kind = t.next_venue_kind,
  venue = t.next_venue,
  publication_type = t.next_publication_type,
  publication_type_method = t.next_publication_type_method,
  publication_type_confidence = t.next_publication_type_confidence
FROM typed t
WHERE w.id = t.id
  AND (
    w.source_family IS DISTINCT FROM t.next_source_family
    OR w.venue_kind IS DISTINCT FROM t.next_venue_kind
    OR w.venue IS DISTINCT FROM t.next_venue
    OR w.publication_type IS DISTINCT FROM t.next_publication_type
    OR w.publication_type_method IS DISTINCT FROM t.next_publication_type_method
    OR w.publication_type_confidence IS DISTINCT FROM t.next_publication_type_confidence
  );
