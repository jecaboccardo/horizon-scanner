-- Migration: add SMS methodology classification columns to works
-- SMS = Maryland Scientific Methods Scale (1-5)

alter table public.works
  add column if not exists sms_level smallint,
  add column if not exists methodology_design text,
  add column if not exists causal_strength text,
  add column if not exists sms_method text default 'keyword';

-- sms_level: 1-5 (Maryland SMS)
-- methodology_design: RCT, DiD, IV, RDD, Observational, Simulation, Qualitative, Mixed Methods
-- causal_strength: high, moderate, limited, signal
-- sms_method: 'keyword' | 'llm' | 'manual' — how the classification was made

comment on column public.works.sms_level is 'Maryland Scientific Methods Scale: 5=RCT, 4=quasi-exp strong, 3=quasi-exp weak, 2=correlational, 1=descriptive';
comment on column public.works.sms_method is 'Classification method: keyword (rule-based), llm (Gemini), manual (human override)';

create index if not exists idx_works_sms_level on public.works(sms_level) where sms_level is not null;
