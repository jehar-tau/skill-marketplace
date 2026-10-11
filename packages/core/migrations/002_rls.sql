-- Defence in depth (spec §5). The API connects as sm_app, which is subject to these
-- policies. Each transaction sets app.actor_id; background work sets app.system = 'on'.
-- Application code performs the real authorization; these policies make a missed
-- check fail closed on the tables that hold private content.

CREATE OR REPLACE FUNCTION app_actor() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean AS $$
  SELECT COALESCE(current_setting('app.system', true), 'off') = 'on'
$$ LANGUAGE sql STABLE;

GRANT USAGE ON SCHEMA public TO sm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sm_app;

ALTER TABLE capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY capabilities_owner ON capabilities
  USING (app_is_system() OR account_id = app_actor())
  WITH CHECK (app_is_system() OR account_id = app_actor());

ALTER TABLE capability_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY capability_versions_owner ON capability_versions
  USING (app_is_system() OR account_id = app_actor())
  WITH CHECK (app_is_system() OR account_id = app_actor());

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_participant ON conversations
  USING (app_is_system() OR requester_id = app_actor() OR provider_id = app_actor())
  WITH CHECK (app_is_system() OR requester_id = app_actor() OR provider_id = app_actor());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_participant ON messages
  USING (
    app_is_system() OR EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id AND (c.requester_id = app_actor() OR c.provider_id = app_actor())
    )
  )
  WITH CHECK (
    app_is_system() OR EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id AND (c.requester_id = app_actor() OR c.provider_id = app_actor())
    )
  );

ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY ratings_party ON ratings
  USING (app_is_system() OR rater_id = app_actor() OR ratee_id = app_actor())
  WITH CHECK (app_is_system() OR rater_id = app_actor());

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY media_owner_or_participant ON media_assets
  USING (
    app_is_system() OR owner_id = app_actor() OR EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = media_assets.conversation_id AND (c.requester_id = app_actor() OR c.provider_id = app_actor())
    )
  )
  WITH CHECK (app_is_system() OR owner_id = app_actor());
