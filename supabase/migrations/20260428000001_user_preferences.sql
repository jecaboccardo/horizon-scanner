-- User preferences: per-analyst personalization settings
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  default_persona text NOT NULL DEFAULT 'jel',
  regional_focus text[] NOT NULL DEFAULT '{}',
  methodology_focus text[] NOT NULL DEFAULT '{}',
  email_alerts_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own preferences"
  ON user_preferences
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Required: PostgREST needs explicit grants even with service_role key
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO service_role, authenticated;

-- Add last_sent_at to subscriptions for alert digest tracking
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
