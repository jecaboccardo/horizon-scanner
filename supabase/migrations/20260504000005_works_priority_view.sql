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
  -- log10(citation_count + 1) * 3.0
  ln(coalesce(w.citation_count, 0) + 1) / ln(10) * 3.0
  -- + lac_relevance_score * 2.5
  + (case when l.id is not null then 1.0 else 0.0 end) * 2.5
  -- + (sms_level / 5.0) * 2.0
  + (coalesce(w.sms_level, 0)::numeric / 5.0) * 2.0
  -- + recency_weight * 1.5  (year>=2020 → 1.0, decays linearly to 1990 → 0)
  + greatest(0, least(1, (coalesce(w.year, 1990) - 1990)::numeric / 30.0)) * 1.5
  -- + retrieval_history_weight * 2.0
  + ln(coalesce(rh.appearances, 0) + 1) / ln(10) * 2.0
  -- + venue_quality_weight * 1.5
  + (case
      when w.abs_rating in ('4*','4') then 1.0
      when w.abs_rating in ('3') then 0.6
      when coalesce(w.repec_percentile, 0) >= 95 then 0.8
      when coalesce(w.repec_percentile, 0) >= 75 then 0.4
      else 0.0
    end) * 1.5
  as priority_score
from works w
left join lac_terms l on l.id = w.id
left join retrieval_history rh on rh.work_id = w.id
where w.title is not null
  and w.abstract is not null;

create unique index works_priority_view_id_idx on works_priority_view(id);
create index works_priority_view_score_idx on works_priority_view(priority_score desc);
