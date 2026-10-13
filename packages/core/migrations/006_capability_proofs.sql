-- Optional proof of work for a talent: a link (Instagram, website, video) or a photo.
-- Private to its owner. Nothing here is shown to anyone else until the owner chooses
-- to share it (a later feature); it exists so a profile can be built up slowly.
CREATE TABLE capability_proofs (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  capability_id uuid NOT NULL REFERENCES capabilities(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('link', 'photo')),
  url text,
  media_asset_id uuid REFERENCES media_assets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'link' AND url IS NOT NULL) OR (kind = 'photo' AND media_asset_id IS NOT NULL))
);
CREATE INDEX capability_proofs_capability ON capability_proofs(capability_id, created_at);

ALTER TABLE capability_proofs ENABLE ROW LEVEL SECURITY;
CREATE POLICY capability_proofs_owner ON capability_proofs
  USING (app_is_system() OR account_id = app_actor())
  WITH CHECK (app_is_system() OR account_id = app_actor());
GRANT SELECT, INSERT, DELETE ON capability_proofs TO sm_app;
