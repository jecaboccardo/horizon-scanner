-- Force PostgREST to reload its schema cache. Self-hosted stacks don't
-- always auto-reload on DDL — this NOTIFY is the documented way to nudge
-- it without restarting the container. Safe to run anytime; idempotent.

NOTIFY pgrst, 'reload schema';
