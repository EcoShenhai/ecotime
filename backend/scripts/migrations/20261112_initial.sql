-- EcoTime initial schema (Master Reference §6). Every instant is timestamptz (T1); a local wall time is named *_local
-- and always paired with an IANA time_zone (T2); a schedule keeps its intent apart from the calculated instant (T3).

CREATE TABLE languages (
  code VARCHAR(16) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  dir VARCHAR(3) NOT NULL DEFAULT 'ltr' CHECK (dir IN ('ltr','rtl'))
);

-- 205 territories (CPAMind registry) with the IANA zones the tz database lists for them (§12.5)
CREATE TABLE territories (
  code VARCHAR(8) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  registry_status VARCHAR(32),
  languages JSONB NOT NULL DEFAULT '[]',
  time_zones JSONB NOT NULL DEFAULT '[]',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  kind VARCHAR(10) NOT NULL DEFAULT 'app' CHECK (kind IN ('personal','app','team')),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  max_schedules INTEGER NOT NULL DEFAULT 500 CHECK (max_schedules > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  global_eco_id VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(160),
  preferred_language VARCHAR(16) NOT NULL DEFAULT 'en',
  preferred_time_zone VARCHAR(80),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT NOT NULL,
  totp_last_step BIGINT NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind VARCHAR(10) NOT NULL CHECK (subject_kind IN ('person','admin')),
  subject_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  auth_time TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_subject_idx ON auth_sessions (subject_kind, subject_id);

CREATE TABLE api_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(120) NOT NULL,
  app_code VARCHAR(40) NOT NULL,
  scopes TEXT[] NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  key_prefix VARCHAR(16) NOT NULL UNIQUE,
  key_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upstream sources with operator and provenance (§9.4: source count is not independence)
CREATE TABLE time_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_label VARCHAR(160) NOT NULL UNIQUE,
  operator VARCHAR(160) NOT NULL,
  authenticated BOOLEAN NOT NULL DEFAULT false,
  tier SMALLINT NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 4),
  active BOOLEAN NOT NULL DEFAULT true,
  notes VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived, downsampled samples (§6.4); high-frequency history belongs in the metrics system
CREATE TABLE clock_observations (
  id BIGSERIAL PRIMARY KEY,
  host_label VARCHAR(80) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  daemon VARCHAR(40) NOT NULL,
  synchronized BOOLEAN,
  state VARCHAR(16) NOT NULL CHECK (state IN ('synchronized','degraded','unsynchronized','stale','unknown')),
  offset_us BIGINT,
  root_distance_us BIGINT,
  jitter_us BIGINT,
  stratum SMALLINT,
  server_label VARCHAR(160),
  UNIQUE (host_label, observed_at)
);
CREATE INDEX clock_observations_host_idx ON clock_observations (host_label, observed_at DESC);

CREATE TABLE clock_health_events (
  id BIGSERIAL PRIMARY KEY,
  host_label VARCHAR(80) NOT NULL,
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('state_change','clock_step','source_change','ruleset_mismatch')),
  from_state VARCHAR(16),
  to_state VARCHAR(16),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX clock_health_events_idx ON clock_health_events (host_label, occurred_at DESC);

-- Deployed tz versions: the Node runtime's and the OS package's, recorded at start and on each check (§8.5)
CREATE TABLE time_zone_rulesets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_version VARCHAR(16) NOT NULL,
  os_version VARCHAR(16),
  source VARCHAR(40) NOT NULL DEFAULT 'node-icu',
  deployed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  regression_status VARCHAR(16) NOT NULL DEFAULT 'not_run' CHECK (regression_status IN ('not_run','passed','failed')),
  recomputed_schedules INTEGER NOT NULL DEFAULT 0,
  UNIQUE (runtime_version, os_version)
);

CREATE TABLE time_zone_preferences (
  owner_type VARCHAR(12) NOT NULL CHECK (owner_type IN ('user','organization')),
  owner_id UUID NOT NULL,
  time_zone VARCHAR(80) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_type, owner_id)
);

-- Webhook targets registered by operators for an organization; the signing secret is stored encrypted
CREATE TABLE webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  url VARCHAR(500) NOT NULL,
  secret_enc TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(160) NOT NULL,
  schedule_type VARCHAR(10) NOT NULL CHECK (schedule_type IN ('once','recurring')),
  -- intent (T3)
  time_zone VARCHAR(80) NOT NULL,
  start_date_local DATE NOT NULL,
  local_time VARCHAR(5) NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  recurrence_rule VARCHAR(500),
  dst_gap_policy VARCHAR(16) NOT NULL DEFAULT 'shift_forward' CHECK (dst_gap_policy IN ('shift_forward','skip')),
  dst_overlap_policy VARCHAR(16) NOT NULL DEFAULT 'first' CHECK (dst_overlap_policy IN ('first','second')),
  -- action
  action_type VARCHAR(10) NOT NULL CHECK (action_type IN ('record','webhook','email')),
  webhook_endpoint_id UUID REFERENCES webhook_endpoints(id),
  email_to VARCHAR(320),
  payload JSONB NOT NULL DEFAULT '{}',
  -- derived and runtime state
  next_run_at TIMESTAMPTZ,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','failed','disabled')),
  lease_until TIMESTAMPTZ,
  claimed_by VARCHAR(80),
  attempt SMALLINT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  ruleset_version VARCHAR(16),
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (schedule_type = 'once' OR recurrence_rule IS NOT NULL),
  CHECK (action_type <> 'webhook' OR webhook_endpoint_id IS NOT NULL),
  CHECK (action_type <> 'email' OR email_to IS NOT NULL)
);
CREATE INDEX scheduled_jobs_org_idx ON scheduled_jobs (organization_id, status);
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (status, next_run_at); -- the scheduler's hot query

CREATE TABLE schedule_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  idempotency_key CHAR(64) NOT NULL UNIQUE,
  status VARCHAR(10) NOT NULL CHECK (status IN ('running','succeeded','retrying','failed')),
  attempt SMALLINT NOT NULL DEFAULT 1,
  worker VARCHAR(80) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  lateness_ms BIGINT NOT NULL,
  result_code VARCHAR(64),
  detail JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX schedule_executions_job_idx ON schedule_executions (job_id, scheduled_for DESC);

-- Replay protection for API writes (P9): the same Idempotency-Key returns the first result
CREATE TABLE idempotency_keys (
  key VARCHAR(100) NOT NULL,
  scope VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  result_ref VARCHAR(80) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Append-only: an update or delete of an audit row is refused by the database itself
CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind VARCHAR(10) NOT NULL,
  actor_id UUID,
  action VARCHAR(64) NOT NULL,
  subject_kind VARCHAR(32),
  subject_id VARCHAR(80),
  detail JSONB NOT NULL DEFAULT '{}',
  ip_hash CHAR(16)
);
CREATE INDEX audit_events_at_idx ON audit_events (at DESC);
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TABLE retention_policies (
  table_name VARCHAR(60) PRIMARY KEY,
  keep_days INTEGER,
  action VARCHAR(10) NOT NULL CHECK (action IN ('delete','keep')),
  note VARCHAR(200)
);
INSERT INTO retention_policies (table_name, keep_days, action, note) VALUES
  ('clock_observations', 30, 'delete', 'Diagnosis only; history lives in metrics'),
  ('clock_health_events', 400, 'delete', '13 months for seasonal and incident review'),
  ('schedule_executions', 400, 'delete', '13 months for support and audit'),
  ('idempotency_keys', 7, 'delete', 'Replay window'),
  ('auth_sessions', 7, 'delete', 'Days after expiry or revocation'),
  ('audit_events', NULL, 'keep', 'Append-only, protected from alteration and deletion');

CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_ref VARCHAR(40) NOT NULL UNIQUE,
  global_eco_id VARCHAR(255),
  subject VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  channel VARCHAR(10) NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL','ECOBUS','BOTH')),
  email_delivered BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
