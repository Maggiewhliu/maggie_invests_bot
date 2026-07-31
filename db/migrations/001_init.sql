-- Maggie Stock AI — 001 初始 schema (PostgreSQL)
-- 原則:decision/delivery 紀錄 append-only;不儲存會員持倉截圖或錄影。

CREATE TABLE IF NOT EXISTS users (
  user_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  lang text NOT NULL DEFAULT 'zh-TW',
  jurisdiction text NOT NULL DEFAULT 'TW',
  jurisdiction_paid_allowed boolean NOT NULL DEFAULT false,
  opted_out boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS identities (
  provider text NOT NULL,              -- 'telegram' | 'web'
  external_id text NOT NULL,           -- telegram chat id
  user_id text NOT NULL REFERENCES users(user_id),
  PRIMARY KEY (provider, external_id)
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id text PRIMARY KEY REFERENCES users(user_id),
  tier smallint NOT NULL DEFAULT 1,    -- 0..4
  verified_by text,                    -- 'email' | 'invite' | 'manual'
  valid_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entitlements (
  user_id text NOT NULL REFERENCES users(user_id),
  feature text NOT NULL,
  granted boolean NOT NULL DEFAULT true,
  source text,                         -- 'tier' | 'override'
  PRIMARY KEY (user_id, feature)
);
CREATE TABLE IF NOT EXISTS watchlists (
  user_id text NOT NULL REFERENCES users(user_id),
  symbol text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);
CREATE TABLE IF NOT EXISTS alert_rules (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(user_id),
  symbol text NOT NULL, kind text NOT NULL, threshold numeric,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_snapshots (
  id bigserial PRIMARY KEY,
  provider text NOT NULL, dataset_id text NOT NULL, symbol text,
  as_of timestamptz NOT NULL, fetched_at timestamptz NOT NULL,
  delay_class text NOT NULL, quality text NOT NULL,
  pagination_complete boolean NOT NULL, provenance_hash text NOT NULL,
  license_context text NOT NULL, payload jsonb
);
CREATE INDEX IF NOT EXISTS idx_snap_lookup ON provider_snapshots(dataset_id, symbol, as_of DESC);
CREATE TABLE IF NOT EXISTS market_events (
  id bigserial PRIMARY KEY, symbol text, kind text NOT NULL,
  event_time timestamptz NOT NULL, confirmed boolean NOT NULL DEFAULT false,
  source text NOT NULL, source_ref text, ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS decision_records (
  id text PRIMARY KEY,                 -- decisionVersion
  node text NOT NULL, et_date text NOT NULL, symbol text,
  content_hash text NOT NULL, data_quality text NOT NULL,
  engine_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS decision_reasons (
  decision_id text NOT NULL REFERENCES decision_records(id),
  seq int NOT NULL, kind text NOT NULL,   -- 'why' | 'watch' | 'invalidate'
  body text NOT NULL, PRIMARY KEY (decision_id, seq)
);
CREATE TABLE IF NOT EXISTS outcome_rules (
  decision_id text PRIMARY KEY REFERENCES decision_records(id),
  horizon_days int NOT NULL, benchmark text NOT NULL, success_rule text NOT NULL,
  fixed_at timestamptz NOT NULL DEFAULT now()   -- 事前寫死,事後不得修改
);
CREATE TABLE IF NOT EXISTS outcome_results (
  decision_id text PRIMARY KEY REFERENCES decision_records(id),
  return_pct numeric, benchmark_return_pct numeric, excess_pct numeric,
  max_adverse_pct numeric, hit boolean, evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS publication_candidates (
  id text PRIMARY KEY, node text NOT NULL, et_date text NOT NULL,
  status text NOT NULL, content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cand_node_date ON publication_candidates(node, et_date);
CREATE TABLE IF NOT EXISTS recipient_deliveries (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES publication_candidates(id),  -- 等值查詢,不用 LIKE
  channel text NOT NULL, recipient_key text NOT NULL, lang text NOT NULL,
  status text NOT NULL, attempts int NOT NULL DEFAULT 1,
  lease_until timestamptz, next_retry_at timestamptz,
  last_error text, provider_message_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_del_cand ON recipient_deliveries(candidate_id, status);
CREATE TABLE IF NOT EXISTS license_grants (
  id bigserial PRIMARY KEY, supplier text NOT NULL, dataset text NOT NULL,
  channels text[] NOT NULL, jurisdictions text[] NOT NULL, uses text[] NOT NULL,
  valid_until timestamptz, doc_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS content_approvals (
  id bigserial PRIMARY KEY, content_sha256 text NOT NULL UNIQUE,
  approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
  context text
);
CREATE TABLE IF NOT EXISTS admin_actions (
  id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
  target text, reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_reports (
  id bigserial PRIMARY KEY, reporter_user_id text NOT NULL, target_user_id text NOT NULL,
  kind text NOT NULL, detail text, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
