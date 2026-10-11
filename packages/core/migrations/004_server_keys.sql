-- Keys the server generates for itself on first use (for example the browser
-- push-notification key pair), so a new environment needs no manual key setup.
CREATE TABLE server_keys (
  name text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON server_keys FROM sm_app;
GRANT SELECT, INSERT ON server_keys TO sm_app;
