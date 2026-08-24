-- Owner self-preference for BYOK synthesis: the key's provider/model is what the
-- TEAM (grantees) use; these two columns let the owner control their OWN generations
-- independently — turn their own usage off (team still uses the key) or pick a
-- different model of the same provider (e.g. team = Sonnet, owner = Opus).
ALTER TABLE synthesis_keys ADD COLUMN IF NOT EXISTS owner_self_use boolean NOT NULL DEFAULT true;
ALTER TABLE synthesis_keys ADD COLUMN IF NOT EXISTS owner_self_model text;

NOTIFY pgrst, 'reload schema';
