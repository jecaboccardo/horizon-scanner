-- Bootstrap: mark all existing migrations as already applied
-- Run this ONCE on LXC 133 before the GitHub Actions db-migrate workflow goes live
-- Command: su postgres -c "psql -d iadb < bootstrap-schema-migrations.sql"  (LXC 133 has no sudo; database is iadb not postgres)

create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

insert into schema_migrations (filename, applied_at) values
('20260407000001_create_profiles.sql', now()),
('20260407000002_create_sources.sql', now()),
('20260407000003_create_search_runs.sql', now()),
('20260407000004_create_briefs.sql', now()),
('20260407000005_create_subscriptions.sql', now()),
('20260407000006_create_feed.sql', now()),
('20260407000007_create_feedback.sql', now()),
('20260407000008_journal_rankings.sql', now()),
('20260407000009_rls_policies.sql', now()),
('20260407100001_create_works.sql', now()),
('20260408000001_abs_rankings_expand.sql', now()),
('20260408000002_repec_rankings_expand.sql', now()),
('20260408000003_works_sms_columns.sql', now()),
('20260408000004_works_journal_rankings.sql', now()),
('20260408000005_works_rationale_columns.sql', now()),
('20260408100001_domain_weights.sql', now()),
('20260408100002_weight_proposals.sql', now()),
('20260408100003_weight_alerts.sql', now()),
('20260408100004_feedback_processed_at.sql', now()),
('20260408100005_learning_rls.sql', now()),
('20260409000001_add_works_excluded.sql', now()),
('20260420200001_create_brief_messages.sql', now()),
('20260421300001_pgvector_embeddings.sql', now()),
('20260422000001_bm25_citations.sql', now()),
('20260423000001_embedding_index_rpc.sql', now()),
('20260424000001_scl_topics.sql', now()),
('20260428000001_user_preferences.sql', now()),
('20260428000002_match_works_search_path.sql', now()),
('20260429000001_embedding_1024.sql', now()),
('20260430000001_corpus_ingest_runs.sql', now())
on conflict (filename) do nothing;

-- Verify (should return 30):
select count(*) from schema_migrations;
