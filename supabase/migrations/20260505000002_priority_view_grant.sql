-- 20260505000002_priority_view_grant.sql
-- Materialized views are not covered by GRANT ALL ON ALL TABLES — they need
-- explicit grants. enqueue.mjs failed with "permission denied for materialized
-- view works_priority_view" because of this gap.

grant select on works_priority_view to service_role;
