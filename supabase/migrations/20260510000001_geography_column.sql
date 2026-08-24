-- Add geography array column to works for region/country filtering.
--
-- The filter UI lets users select regions (LAC, OECD) and countries
-- (Brazil, Mexico, etc.), but retrieval.ts currently runs a regex over
-- title + abstract on every query. Storing detected countries as an
-- array column makes filters fast, indexable, and consistent.
--
-- Values: ISO-style country labels and region rollups, e.g.
--   ['Brazil', 'LAC']
--   ['Mexico', 'Colombia', 'LAC']
--   ['United States', 'OECD']
--
-- Backfilled by scripts/backfill-geography.mjs (regex over title +
-- abstract + raw_data) and stamped at ingest going forward.

alter table public.works
  add column if not exists geography text[];

create index if not exists idx_works_geography
  on public.works using gin (geography)
  where geography is not null;

comment on column public.works.geography is
  'Countries and region rollups mentioned in the paper. Populated by regex over title + abstract; LAC sub-region tags ("LAC", "Caribbean", "Central America") are derived.';
