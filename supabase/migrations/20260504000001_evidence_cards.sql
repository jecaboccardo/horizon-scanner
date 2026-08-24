create table if not exists evidence_cards (
  id uuid primary key default gen_random_uuid(),
  work_id text not null references works(id) on delete cascade,

  -- A. Core structured
  study_design text,
  comparison_type text,
  country text[],
  region text[],
  setting text,
  population_group text,
  analysis_unit text,
  age_range text,
  income_group text,

  -- A2. Topic
  intervention text not null,
  outcome text not null,
  secondary_outcomes text[],

  -- B. Causal core
  treatment_group text,
  control_group text,

  -- C. Effect
  effect_direction text,
  effect_size_text text,
  effect_size_numeric numeric,
  effect_type text,
  baseline_level text,
  statistical_significance text,

  -- D. Study context
  sample_size integer,
  sample_size_text text,
  time_horizon text,
  data_source text,
  identification_strategy text,

  -- E. Qualitative
  limitations text[],
  heterogeneity text,
  secondary_findings text,
  mechanism text,
  external_validity_note text,

  -- F. Confidence (derived)
  confidence text not null check (confidence in ('high','medium','low')),
  confidence_score integer not null,

  -- G. Grounding (mandatory)
  source_section text,
  source_text text not null,
  ungrounded_fields text[],

  -- H. Compact narrative
  finding_short text not null,

  -- Multi-finding awareness
  multi_finding_flag boolean default false,

  -- Provenance
  extracted_by text not null,
  extraction_prompt_version text not null,
  extraction_tier integer not null check (extraction_tier in (1,2,3)),
  extracted_at timestamptz not null default now(),
  needs_review boolean default false,
  source_language text default 'en',

  unique (work_id)
);

create index if not exists evidence_cards_work_id_idx on evidence_cards(work_id);
create index if not exists evidence_cards_study_design_idx on evidence_cards(study_design);
create index if not exists evidence_cards_country_idx on evidence_cards using gin(country);
create index if not exists evidence_cards_confidence_idx on evidence_cards(confidence);
create index if not exists evidence_cards_needs_review_idx on evidence_cards(needs_review) where needs_review = true;

alter table evidence_cards enable row level security;
create policy "service_role_all" on evidence_cards for all using (auth.role() = 'service_role');
create policy "authenticated_read" on evidence_cards for select using (auth.role() = 'authenticated');
