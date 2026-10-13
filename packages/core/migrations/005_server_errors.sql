-- Unexpected server failures, kept so the operations console can show them.
-- Holds the route and the error text only: no request bodies, no user content.
CREATE TABLE server_errors (
  id bigserial PRIMARY KEY,
  method text NOT NULL,
  route text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX server_errors_recent ON server_errors(created_at DESC);
GRANT SELECT, INSERT, DELETE ON server_errors TO sm_app;
GRANT USAGE, SELECT ON SEQUENCE server_errors_id_seq TO sm_app;
