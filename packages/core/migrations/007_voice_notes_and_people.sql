-- Voice notes in chat.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check
  CHECK (kind IN ('text', 'image', 'audio', 'contact_share', 'agreement', 'system'));

-- "My people": someone a user has chosen to keep, or has completed a job with.
-- A customer's list is the people who helped them; a provider's list is their customers.
-- One-directional and private: being on someone's list is not shown to the other person.
CREATE TABLE saved_people (
  owner_id uuid NOT NULL REFERENCES accounts(id),
  person_id uuid NOT NULL REFERENCES accounts(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  source text NOT NULL DEFAULT 'saved' CHECK (source IN ('saved', 'job')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, person_id)
);
ALTER TABLE saved_people ENABLE ROW LEVEL SECURITY;
CREATE POLICY saved_people_owner ON saved_people
  USING (app_is_system() OR owner_id = app_actor())
  WITH CHECK (app_is_system() OR owner_id = app_actor());
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_people TO sm_app;
