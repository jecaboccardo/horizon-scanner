-- Keep citation_count nullable: NULL means "unknown/not supplied", while 0
-- means a source explicitly reported zero citations.
alter table public.works
  alter column citation_count drop default;

comment on column public.works.citation_count is
  'Citation count when supplied by a citation source. NULL means unknown/not supplied; 0 means explicitly reported zero.';
