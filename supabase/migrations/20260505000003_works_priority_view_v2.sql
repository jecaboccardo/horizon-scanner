-- Rebuild works_priority_view to prioritize the backfill by:
--   1. Rigor floor: sms_level >= 3 OR sms_level IS NULL (197k papers
--      have not been classified; we don't want to lose them, but we DO
--      want to drop SMS 1/2 which are descriptive/correlational only)
--   2. Source institution: IDB and World Bank papers go first
--   3. Top journals: ABS 3+ and RePEc top quartile boosted
--   4. LAC kept as a small (1.0) boost — global evidence still wanted
--
-- Replaces 20260504000005_works_priority_view.sql

drop materialized view if exists works_priority_view;

create materialized view works_priority_view as
with retrieval_history as (
  select unnest(coalesce(candidate_work_ids, '{}'::text[])) as work_id, count(*) as appearances
  from search_runs
  group by 1
),
lac_terms as (
  select id from works
  where lower(coalesce(title,'')) ~ '\m(latin america|caribbean|mexico|brazil|argentina|chile|colombia|peru|ecuador|bolivia|uruguay|paraguay|venezuela|costa rica|panama|honduras|guatemala|el salvador|nicaragua|dominican republic|haiti|jamaica|cepal|eclac|iadb|idb)\M'
     or lower(coalesce(abstract,'')) ~ '\m(latin america|caribbean|mexico|brazil|argentina|chile|colombia|peru|ecuador|bolivia|uruguay|paraguay|venezuela|costa rica|panama|honduras|guatemala|el salvador|nicaragua|dominican republic|haiti|jamaica)\M'
)
select
  w.id,
  -- Institution boost: IDB and World Bank are top priority for IADB users
  (case
    when (w.raw_data->>'institution') in ('IDB', 'World Bank') then 4.0
    when (w.raw_data->>'institution') in ('OECD', 'IMF', 'WHO', 'PAHO', 'ECLAC') then 2.0
    when (w.raw_data->>'institution') is not null then 1.0
    else 0.0
  end)
  -- ABS journal rating (3+ is a "top journal")
  + (case
      when w.abs_rating in ('4*','4') then 3.0
      when w.abs_rating = '3' then 2.0
      when coalesce(w.repec_percentile, 0) >= 95 then 2.0
      when coalesce(w.repec_percentile, 0) >= 75 then 1.0
      else 0.0
    end)
  -- SMS bonus above the floor (3=baseline, 4=+0.75, 5=+1.5)
  + (case
      when coalesce(w.sms_level, 3) >= 3 then ((coalesce(w.sms_level, 3)::numeric - 3) / 2.0) * 1.5
      else 0.0
    end)
  -- Citation impact (log-scaled)
  + ln(coalesce(w.citation_count, 0) + 1) / ln(10) * 1.5
  -- LAC relevance (small boost — no longer dominant)
  + (case when l.id is not null then 1.0 else 0.0 end) * 1.0
  -- Recency: 2020+ → 1.0, decays linearly to 1990 → 0
  + greatest(0, least(1, (coalesce(w.year, 1990) - 1990)::numeric / 30.0)) * 1.0
  -- Past retrieval history (papers that appeared in user searches)
  + ln(coalesce(rh.appearances, 0) + 1) / ln(10) * 1.5
  as priority_score
from works w
left join lac_terms l on l.id = w.id
left join retrieval_history rh on rh.work_id = w.id
where w.title is not null
  and w.abstract is not null
  -- Hard rigor floor: drop SMS 1/2 (descriptive/correlational); keep
  -- NULL because most of the corpus hasn't been SMS-classified yet
  and (coalesce(w.sms_level, 3) >= 3);

create unique index works_priority_view_id_idx on works_priority_view(id);
create index works_priority_view_score_idx on works_priority_view(priority_score desc);

-- Re-grant after recreation (materialized views need explicit grants)
grant select on works_priority_view to service_role;
grant select on works_priority_view to authenticated;
