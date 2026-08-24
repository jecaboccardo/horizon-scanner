-- Evidence-card confidence is intentionally strict because it is used for
-- synthesis safety. Ranking needs a narrower signal: can this card identify
-- a finding well enough to de-duplicate or crowd similar evidence?
--
-- This generated flag only requires the fields that are usually recoverable
-- from abstracts and useful for ranking: intervention, outcome, study design,
-- and a grounded source quote. It does not require effect sizes, p-values, or
-- explicit treatment/control groups.

alter table public.evidence_cards
  add column if not exists card_usable_for_ranking boolean generated always as (
    length(btrim(coalesce(intervention, ''))) >= 3
    and lower(btrim(coalesce(intervention, ''))) not in ('unclear', 'unknown', 'n/a', 'na', 'none', 'null')
    and lower(coalesce(intervention, '')) not like '%unclear%'
    and length(btrim(coalesce(outcome, ''))) >= 3
    and lower(btrim(coalesce(outcome, ''))) not in ('unclear', 'unknown', 'n/a', 'na', 'none', 'null')
    and lower(coalesce(outcome, '')) not like '%unclear%'
    and lower(btrim(coalesce(study_design, ''))) in (
      'rct',
      'quasi-experimental',
      'observational',
      'qualitative',
      'review',
      'descriptive'
    )
    and length(btrim(coalesce(source_text, ''))) >= 40
    and lower(btrim(coalesce(source_text, ''))) not in ('unclear', 'unknown', 'n/a', 'na', 'none', 'null')
  ) stored;

create index if not exists evidence_cards_usable_for_ranking_idx
  on public.evidence_cards(work_id)
  where card_usable_for_ranking = true;

comment on column public.evidence_cards.card_usable_for_ranking is
  'Generated ranking-only usability flag. True when intervention, outcome, study_design, and source_text are explicit enough for ranking/density signals, independent of stricter synthesis confidence.';
