-- Topicality segmentation labels (core / context / off) per evidence paper, persisted
-- on the search run so the brief evidence table + plugin can show a Core/Context split.
-- Mirrors work_channels (jsonb). Read-only signal; never affects retrieval ranking.
-- Shape: { "<workId>": "core" | "context" | "off", ... } plus optional "_core" concept string.
ALTER TABLE search_runs ADD COLUMN IF NOT EXISTS work_segments jsonb;

-- PostgREST: pick up the new column.
NOTIFY pgrst, 'reload schema';
