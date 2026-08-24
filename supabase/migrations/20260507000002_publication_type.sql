-- Normalize publication/document type on works.
--
-- This gives the app a reliable top-level field for filters and labels instead
-- of inferring "journal vs working paper vs report" from venue text every time.

alter table public.works
  add column if not exists publication_type text,
  add column if not exists publication_type_method text,
  add column if not exists publication_type_confidence numeric(3,2);

do $$
begin
  alter table public.works
    add constraint works_publication_type_check
    check (
      publication_type is null or publication_type in (
        'journal_article',
        'working_paper',
        'discussion_paper',
        'report',
        'book',
        'book_chapter',
        'conference_paper',
        'preprint',
        'dataset',
        'dissertation',
        'other'
      )
    );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.works
    add constraint works_publication_type_confidence_check
    check (
      publication_type_confidence is null
      or (publication_type_confidence >= 0 and publication_type_confidence <= 1)
    );
exception
  when duplicate_object then null;
end $$;

with classified as (
  select
    id,
    replace(lower(coalesce(raw_data->>'publication_type', '')), '-', '_') as raw_type,
    lower(concat_ws(
      ' ',
      title,
      venue,
      source,
      corpus_source,
      raw_data->>'container-title',
      raw_data->>'source',
      raw_data->>'type'
    )) as haystack,
    corpus_source,
    journal_issn,
    abs_rating,
    repec_percentile
  from public.works
),
typed as (
  select
    id,
    case
      -- More specific venue/source hints first, because some aggregators store
      -- generic raw types while the venue contains the useful document family.
      when haystack ~ '\m(discussion paper|discussion papers|discussion series|iza discussion)\M'
        then 'discussion_paper'
      when haystack ~ '\m(working paper|working papers|policy research working paper|nber|ssrn|working papers series)\M'
        then 'working_paper'
      when haystack ~ '\m(preprint|pre-print|preprints)\M'
        then 'preprint'
      when haystack ~ '\m(conference paper|conference proceedings|proceedings paper)\M'
        then 'conference_paper'
      when haystack ~ '\m(technical note|technical notes|report|reports|monograph|iadb publication|idb publication)\M'
        then 'report'

      -- Raw importer metadata.
      when raw_type in ('journal_article', 'journal-article', 'article')
        then 'journal_article'
      when raw_type in ('working_paper', 'working-paper')
        then 'working_paper'
      when raw_type in ('discussion_paper', 'discussion-paper')
        then 'discussion_paper'
      when raw_type = 'report'
        then 'report'
      when raw_type in ('book_chapter', 'book-chapter')
        then 'book_chapter'
      when raw_type = 'book'
        then 'book'
      when raw_type in ('proceedings_article', 'proceedings-article', 'conference_paper', 'conference-paper')
        then 'conference_paper'
      when raw_type in ('posted_content', 'posted-content', 'preprint')
        then 'preprint'
      when raw_type = 'dataset'
        then 'dataset'
      when raw_type = 'dissertation'
        then 'dissertation'

      -- Structured quality/source hints.
      when journal_issn is not null
        or abs_rating is not null
        or haystack ~ '\m(journal|review|quarterly|annals)\M'
        or corpus_source in ('journal_whitelist', 'journal_gaps', 'lac_health_policy')
        then 'journal_article'
      when corpus_source in ('idb_bulk', 'jpal_index')
        then 'report'

      else 'other'
    end as publication_type,
    case
      when haystack ~ '\m(discussion paper|discussion papers|discussion series|iza discussion)\M'
        or haystack ~ '\m(working paper|working papers|policy research working paper|nber|ssrn|working papers series)\M'
        or haystack ~ '\m(preprint|pre-print|preprints)\M'
        or haystack ~ '\m(conference paper|conference proceedings|proceedings paper)\M'
        or haystack ~ '\m(technical note|technical notes|report|reports|monograph|iadb publication|idb publication)\M'
        then 'venue_hint'
      when raw_type in (
        'journal_article', 'journal-article', 'article',
        'working_paper', 'working-paper',
        'discussion_paper', 'discussion-paper',
        'report',
        'book_chapter', 'book-chapter',
        'book',
        'proceedings_article', 'proceedings-article',
        'conference_paper', 'conference-paper',
        'posted_content', 'posted-content',
        'preprint',
        'dataset',
        'dissertation'
      )
        then 'raw_data'
      when journal_issn is not null or abs_rating is not null
        then 'journal_metadata'
      when corpus_source in ('journal_whitelist', 'journal_gaps', 'lac_health_policy', 'idb_bulk', 'jpal_index')
        then 'corpus_source'
      else 'fallback'
    end as publication_type_method,
    case
      when haystack ~ '\m(discussion paper|discussion papers|discussion series|iza discussion)\M'
        or haystack ~ '\m(working paper|working papers|policy research working paper|nber|ssrn|working papers series)\M'
        or haystack ~ '\m(preprint|pre-print|preprints)\M'
        or haystack ~ '\m(conference paper|conference proceedings|proceedings paper)\M'
        or haystack ~ '\m(technical note|technical notes|report|reports|monograph|iadb publication|idb publication)\M'
        then 0.85
      when raw_type in (
        'journal_article', 'journal-article', 'article',
        'working_paper', 'working-paper',
        'discussion_paper', 'discussion-paper',
        'report',
        'book_chapter', 'book-chapter',
        'book',
        'proceedings_article', 'proceedings-article',
        'conference_paper', 'conference-paper',
        'posted_content', 'posted-content',
        'preprint',
        'dataset',
        'dissertation'
      )
        then 0.95
      when journal_issn is not null or abs_rating is not null
        then 0.80
      when corpus_source in ('journal_whitelist', 'journal_gaps', 'lac_health_policy', 'idb_bulk', 'jpal_index')
        then 0.70
      else 0.35
    end as publication_type_confidence
  from classified
)
update public.works w
set
  publication_type = typed.publication_type,
  publication_type_method = typed.publication_type_method,
  publication_type_confidence = typed.publication_type_confidence,
  updated_at = now()
from typed
where w.id = typed.id;

create index if not exists idx_works_publication_type
  on public.works (publication_type);

create index if not exists idx_works_publication_type_method
  on public.works (publication_type_method);

comment on column public.works.publication_type is
  'Normalized document family: journal_article, working_paper, discussion_paper, report, book, book_chapter, conference_paper, preprint, dataset, dissertation, other.';

comment on column public.works.publication_type_method is
  'How publication_type was inferred: raw_data, venue_hint, journal_metadata, corpus_source, fallback.';

comment on column public.works.publication_type_confidence is
  'Heuristic confidence score from 0 to 1 for publication_type.';
