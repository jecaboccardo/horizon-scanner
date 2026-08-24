-- Add query embedding to feedback rows so disliked papers can be suppressed
-- on future semantically-similar queries (cosine sim >= 0.85).
-- vector(768) matches nomic-embed-text dim used by works.embedding.

ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS query_embedding vector(768),
  ADD COLUMN IF NOT EXISTS query_text text;

-- Partial index: only dislikes need fast lookup. ~order of hundreds of rows
-- per user, so no ANN index — sequential scan with the partial filter is fine.
CREATE INDEX IF NOT EXISTS feedback_dislike_user_idx
  ON feedback (user_id)
  WHERE type = 'dislike' AND query_embedding IS NOT NULL;
