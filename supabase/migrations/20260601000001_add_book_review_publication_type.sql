-- Add book_review as a valid publication_type value.
-- Detected via JSTOR browser backfill (Reviewed Work / Review by markers).

alter table public.works drop constraint if exists works_publication_type_check;

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
      'book_review',
      'conference_paper',
      'preprint',
      'dataset',
      'dissertation',
      'other'
    )
  );

comment on column public.works.publication_type is
  'Normalized document family: journal_article, working_paper, discussion_paper, report, book, book_chapter, book_review, conference_paper, preprint, dataset, dissertation, other.';
