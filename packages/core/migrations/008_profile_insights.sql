-- What the AI has learned about a person's work, from their own chats, photos and
-- reviews. Private to that person, who can remove any line. Nobody else sees these.
CREATE TABLE profile_insights (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  capability_id uuid REFERENCES capabilities(id),
  kind text NOT NULL CHECK (kind IN ('summary', 'offering', 'price', 'working_style', 'strength', 'photo')),
  text text NOT NULL,
  source text NOT NULL CHECK (source IN ('chat', 'photo', 'profile')),
  source_id uuid,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX profile_insights_account ON profile_insights(account_id, capability_id) WHERE removed_at IS NULL;

ALTER TABLE profile_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY profile_insights_owner ON profile_insights
  USING (app_is_system() OR account_id = app_actor())
  WITH CHECK (app_is_system() OR account_id = app_actor());
GRANT SELECT, INSERT, UPDATE ON profile_insights TO sm_app;

-- Each person can switch AI learning off. A chat is only learned from when both
-- people in it have it on.
ALTER TABLE accounts ADD COLUMN ai_learning boolean NOT NULL DEFAULT true;
