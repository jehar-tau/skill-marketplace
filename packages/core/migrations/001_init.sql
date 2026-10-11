-- Skill Marketplace schema (spec v0.5 §12).
-- Conventions: UUIDv7 keys, cell_id on domain tables, monthly partitions on append-heavy tables.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Time-sortable UUID (version 7) for column defaults.
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid AS $$
DECLARE
  ts bytea := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  rnd bytea := gen_random_bytes(10);
BEGIN
  rnd := set_byte(rnd, 0, (get_byte(rnd, 0) & 15) | 112);  -- version 7
  rnd := set_byte(rnd, 2, (get_byte(rnd, 2) & 63) | 128);  -- variant
  RETURN encode(ts || rnd, 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;

-- Creates monthly partitions for a range-partitioned table, from this month to N months ahead.
CREATE OR REPLACE FUNCTION ensure_month_partitions(parent text, months_ahead int DEFAULT 3) RETURNS void AS $$
DECLARE
  m date := date_trunc('month', now())::date;
  i int;
  part text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    part := format('%s_%s', parent, to_char(m + (i || ' month')::interval, 'YYYYMM'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      part, parent, m + (i || ' month')::interval, m + ((i + 1) || ' month')::interval);
  END LOOP;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- identity

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  phone_enc bytea,
  phone_hash text UNIQUE,
  display_name text,
  home_cell_id text NOT NULL DEFAULT 'pune',
  preferred_locale text NOT NULL DEFAULT 'en',
  default_view text NOT NULL DEFAULT 'find',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  terms_version_accepted text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE otp_challenges (
  phone_hash text PRIMARY KEY,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  sent_count int NOT NULL DEFAULT 1,
  window_started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  device_id text NOT NULL,
  refresh_token_hash text NOT NULL,
  push_token text,
  platform text NOT NULL,
  battery_exempt_confirmed boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX sessions_account ON sessions(account_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX sessions_device ON sessions(account_id, device_id) WHERE revoked_at IS NULL;

CREATE TABLE provider_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  paused boolean NOT NULL DEFAULT false,
  quiet_start time NOT NULL DEFAULT '22:00',
  quiet_end time NOT NULL DEFAULT '07:00',
  daily_cap int NOT NULL DEFAULT 20,
  ignored_streak int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  scope text NOT NULL,
  version text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- ---------------------------------------------------------------- taxonomy

CREATE TABLE service_categories (
  id serial PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  parent_slug text,
  risk_tier text NOT NULL,
  remote_ok boolean NOT NULL DEFAULT false,
  labels jsonb NOT NULL,
  attribute_schema_version int NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- utterances

CREATE TABLE utterances (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  purpose text NOT NULL CHECK (purpose IN ('capability', 'request')),
  input_type text NOT NULL CHECK (input_type IN ('typed_text', 'voice_clip')),
  original_text text NOT NULL,
  source_locales text[] NOT NULL DEFAULT '{}',
  reply_locale text NOT NULL DEFAULT 'en',
  audio_asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX utterances_account ON utterances(account_id, created_at DESC);

CREATE TABLE interpretations (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  utterance_id uuid NOT NULL REFERENCES utterances(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  version int NOT NULL DEFAULT 1,
  category_id int NOT NULL REFERENCES service_categories(id),
  canonical_en text NOT NULL,
  source_span text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  extra jsonb NOT NULL DEFAULT '{}',
  deadline_at timestamptz,
  confirmation_text text NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interpretations_utterance ON interpretations(utterance_id);

-- ---------------------------------------------------------------- capabilities

CREATE TABLE capabilities (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  cell_id text NOT NULL,
  category_id int NOT NULL REFERENCES service_categories(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'removed')),
  base_point geography(Point, 4326) NOT NULL,
  service_radius_m int NOT NULL DEFAULT 5000,
  h3_r8 text NOT NULL,
  remote_ok boolean NOT NULL DEFAULT false,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capabilities_geo ON capabilities USING gist (base_point);
CREATE INDEX capabilities_lookup ON capabilities(cell_id, category_id, status);
CREATE INDEX capabilities_account ON capabilities(account_id);

CREATE TABLE capability_versions (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  capability_id uuid NOT NULL REFERENCES capabilities(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  version_no int NOT NULL,
  interpretation_id uuid REFERENCES interpretations(id),
  original_text text NOT NULL,
  source_locale text NOT NULL,
  canonical_en text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', original_text || ' ' || canonical_en)) STORED,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability_id, version_no)
);
CREATE INDEX capability_versions_tsv ON capability_versions USING gin (search_tsv);

-- ---------------------------------------------------------------- requests

CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  cell_id text NOT NULL,
  category_id int NOT NULL REFERENCES service_categories(id),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('draft', 'confirmed', 'dispatching', 'responded', 'agreed', 'completed', 'cancelled', 'expired', 'no_match')),
  point geography(Point, 4326) NOT NULL,
  h3_r8 text NOT NULL,
  deadline_at timestamptz,
  expires_at timestamptz NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_account ON requests(account_id, created_at DESC);
CREATE INDEX requests_open ON requests(cell_id, category_id) WHERE status IN ('dispatching', 'responded', 'no_match');
CREATE INDEX requests_geo ON requests USING gist (point);

CREATE TABLE request_versions (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  request_id uuid NOT NULL REFERENCES requests(id),
  version_no int NOT NULL,
  interpretation_id uuid REFERENCES interpretations(id),
  original_text text NOT NULL,
  source_locale text NOT NULL,
  canonical_en text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}',
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', original_text || ' ' || canonical_en)) STORED,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, version_no)
);

-- ---------------------------------------------------------------- embeddings

CREATE TABLE embedding_models (
  model_key text PRIMARY KEY,
  dims int NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Calibrated relevance floor and ranking weights, versioned (spec §7.4).
CREATE TABLE matching_config (
  version serial PRIMARY KEY,
  model_key text NOT NULL,
  floor real NOT NULL,
  weights jsonb NOT NULL,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- dispatch

CREATE TABLE dispatch_waves (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  request_id uuid NOT NULL REFERENCES requests(id),
  request_version_id uuid NOT NULL REFERENCES request_versions(id),
  wave_no int NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  opens_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (request_version_id, wave_no)
);

CREATE TABLE matches (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  request_id uuid NOT NULL REFERENCES requests(id),
  wave_id uuid NOT NULL REFERENCES dispatch_waves(id),
  capability_id uuid NOT NULL REFERENCES capabilities(id),
  provider_account_id uuid NOT NULL REFERENCES accounts(id),
  requester_account_id uuid NOT NULL REFERENCES accounts(id),
  cell_id text NOT NULL,
  score real NOT NULL,
  rank int NOT NULL,
  is_exploration boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'notified'
    CHECK (state IN ('notified', 'seen', 'interested', 'declined', 'expired', 'filled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  -- A provider is notified at most once per request, across all waves and capabilities.
  UNIQUE (request_id, provider_account_id)
);
CREATE INDEX matches_provider ON matches(provider_account_id, created_at DESC);
CREATE INDEX matches_wave ON matches(wave_id);

CREATE TABLE notification_attempts (
  id uuid NOT NULL DEFAULT uuid_v7(),
  match_id uuid,
  account_id uuid NOT NULL,
  kind text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('push', 'sms', 'none')),
  state text NOT NULL DEFAULT 'sent' CHECK (state IN ('sent', 'delivered', 'opened', 'failed', 'suppressed')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  opened_at timestamptz,
  cost_minor int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX notification_attempts_match ON notification_attempts(match_id);
CREATE INDEX notification_attempts_account ON notification_attempts(account_id, created_at DESC);

-- ---------------------------------------------------------------- conversations

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  match_id uuid NOT NULL UNIQUE REFERENCES matches(id),
  request_id uuid NOT NULL REFERENCES requests(id),
  capability_id uuid NOT NULL REFERENCES capabilities(id),
  requester_id uuid NOT NULL REFERENCES accounts(id),
  provider_id uuid NOT NULL REFERENCES accounts(id),
  cell_id text NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_requester ON conversations(requester_id, last_message_at DESC NULLS LAST);
CREATE INDEX conversations_provider ON conversations(provider_id, last_message_at DESC NULLS LAST);

CREATE TABLE conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  delivered_seq bigint NOT NULL DEFAULT 0,
  read_seq bigint NOT NULL DEFAULT 0,
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, account_id)
);

CREATE TABLE messages (
  id uuid NOT NULL DEFAULT uuid_v7(),
  conversation_id uuid NOT NULL,
  seq bigint NOT NULL,
  sender_id uuid,
  client_message_id uuid,
  kind text NOT NULL DEFAULT 'text'
    CHECK (kind IN ('text', 'image', 'contact_share', 'agreement', 'system')),
  body text,
  meta jsonb NOT NULL DEFAULT '{}',
  source_locale text,
  cell_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- seq and client_message_id uniqueness is enforced by assigning both under the
-- conversation row lock; a partitioned table cannot carry these unique constraints.
CREATE INDEX messages_conv_seq ON messages(conversation_id, seq);
CREATE INDEX messages_conv_client ON messages(conversation_id, client_message_id);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  conversation_id uuid REFERENCES conversations(id),
  kind text NOT NULL CHECK (kind IN ('image', 'audio')),
  object_key text NOT NULL,
  thumb_key text,
  scan_state text NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending', 'uploaded', 'clean', 'rejected')),
  mime text NOT NULL,
  bytes int NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contact_shares (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  shared_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, shared_by)
);

-- ---------------------------------------------------------------- trust

CREATE TABLE agreements (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  request_id uuid NOT NULL REFERENCES requests(id),
  capability_id uuid NOT NULL REFERENCES capabilities(id),
  requester_id uuid NOT NULL REFERENCES accounts(id),
  provider_id uuid NOT NULL REFERENCES accounts(id),
  what text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  price_minor int,
  currency text NOT NULL DEFAULT 'INR',
  proposed_by uuid NOT NULL REFERENCES accounts(id),
  state text NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed', 'confirmed', 'withdrawn', 'completed', 'completed_unconfirmed', 'disputed', 'not_done')),
  confirmed_at timestamptz,
  prompted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agreements_conversation ON agreements(conversation_id);
CREATE INDEX agreements_pending ON agreements(scheduled_for) WHERE state = 'confirmed';

CREATE TABLE job_confirmations (
  agreement_id uuid NOT NULL REFERENCES agreements(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  answer text NOT NULL CHECK (answer IN ('yes', 'no')),
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agreement_id, account_id)
);

CREATE TABLE ratings (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  agreement_id uuid NOT NULL REFERENCES agreements(id),
  rater_id uuid NOT NULL REFERENCES accounts(id),
  ratee_id uuid NOT NULL REFERENCES accounts(id),
  capability_id uuid REFERENCES capabilities(id),  -- set when the ratee is the provider
  stars int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revealed_at timestamptz,
  voided_at timestamptz,
  UNIQUE (agreement_id, rater_id)
);
CREATE INDEX ratings_unrevealed ON ratings(created_at) WHERE revealed_at IS NULL;

CREATE TABLE capability_trust (
  capability_id uuid PRIMARY KEY REFERENCES capabilities(id),
  completed_jobs int NOT NULL DEFAULT 0,
  rating_avg real,
  rating_count int NOT NULL DEFAULT 0,
  notified_count int NOT NULL DEFAULT 0,
  responded_count int NOT NULL DEFAULT 0
);

CREATE TABLE requester_trust (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  completed_jobs int NOT NULL DEFAULT 0,
  rating_avg real,
  rating_count int NOT NULL DEFAULT 0
);

CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL,
  reference_enc bytea NOT NULL,
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'verified', 'rejected')),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind)
);

-- ---------------------------------------------------------------- safety

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES accounts(id),
  blocked_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  reporter_id uuid NOT NULL REFERENCES accounts(id),
  subject_account_id uuid NOT NULL REFERENCES accounts(id),
  conversation_id uuid REFERENCES conversations(id),
  reason text NOT NULL,
  detail text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_review', 'resolved', 'dismissed')),
  assigned_to text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX reports_open ON reports(created_at) WHERE state IN ('open', 'in_review');

CREATE TABLE moderation_actions (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  report_id uuid REFERENCES reports(id),
  admin_id text NOT NULL,
  action text NOT NULL,
  target_account_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- operations

CREATE TABLE outbox_events (
  id uuid NOT NULL DEFAULT uuid_v7(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  cell_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX outbox_unprocessed ON outbox_events(created_at) WHERE processed_at IS NULL;

-- Every billable-in-future touchpoint, recorded at price zero (spec §15).
CREATE TABLE lead_events (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  provider_account_id uuid NOT NULL REFERENCES accounts(id),
  match_id uuid REFERENCES matches(id),
  kind text NOT NULL CHECK (kind IN ('notified', 'interested', 'contact_shared', 'agreed')),
  price_minor int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_events_provider ON lead_events(provider_account_id, created_at DESC);

CREATE TABLE ai_runs (
  id uuid NOT NULL DEFAULT uuid_v7(),
  task text NOT NULL,
  provider text NOT NULL,
  model_id text NOT NULL,
  prompt_version text,
  usage jsonb NOT NULL DEFAULT '{}',
  est_cost_usd real NOT NULL DEFAULT 0,
  status text NOT NULL,
  latency_ms int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_events (
  id uuid NOT NULL DEFAULT uuid_v7(),
  actor_id text,
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Funnel events for onboarding and dispatch metrics (spec §5.1, §6). No user text.
CREATE TABLE funnel_events (
  id bigserial PRIMARY KEY,
  account_id uuid,
  step text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX funnel_events_step ON funnel_events(step, created_at);

SELECT ensure_month_partitions('messages');
SELECT ensure_month_partitions('outbox_events');
SELECT ensure_month_partitions('notification_attempts');
SELECT ensure_month_partitions('ai_runs');
SELECT ensure_month_partitions('audit_events');
