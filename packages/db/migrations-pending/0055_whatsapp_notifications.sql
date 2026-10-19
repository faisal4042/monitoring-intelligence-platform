-- 0055 WhatsApp notification channel (2026-10-19). PROPOSAL FOR REVIEW — NOT APPLIED TO mip OR PRODUCTION.
-- Lives outside packages/db/migrations on purpose: db:push must never pick it up.
-- Numbering: migrations-pending holds 0047–0054; nothing else claims 0055.
-- Apply only through apps/api/src/operator/apply-pending-migration.ts (holds the fencing lease and writes the
-- _migrations ledger row in the same transaction), after explicit approval. Exactly one BEGIN;/COMMIT; pair.
-- Fencing: every new public table below receives mip_fence_* guards from the 0046 event trigger at CREATE TABLE;
-- nothing here disables, bypasses or alters a guard.
-- Additive only: new tables and seven permission rows. No existing table, row, role, role grant or user grant
-- is changed, and the new permissions are granted to nobody here (docs/whatsapp/README.md).
-- The channel starts disabled and unconfigured; nothing is sent until an administrator configures Meta,
-- approves templates, registers opted-in recipients, enables the channel and WHATSAPP_ENABLED=true.
-- Rollback (only while no message, recipient or grant exists): 0055_whatsapp_notifications_rollback.sql.
BEGIN;

-- One row: connection, operating controls and last known health. Secrets are stored encrypted by the API
-- (AES-256-GCM, apps/api/src/lib/crypto.ts) and are never returned to the client; *_last4 is for display only.
CREATE TABLE whatsapp_settings (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled                   boolean NOT NULL DEFAULT false,
  paused                    boolean NOT NULL DEFAULT false,
  waba_id                   text CHECK (waba_id IS NULL OR waba_id ~ '^[0-9]{5,30}$'),
  phone_number_id           text CHECK (phone_number_id IS NULL OR phone_number_id ~ '^[0-9]{5,30}$'),
  api_version               text CHECK (api_version IS NULL OR api_version ~ '^v[0-9]{1,3}\.[0-9]{1,2}$'),
  access_token_encrypted    text,
  access_token_last4        text CHECK (access_token_last4 IS NULL OR char_length(access_token_last4) = 4),
  app_secret_encrypted      text,
  verify_token_encrypted    text,
  display_phone_number      text,
  verified_name             text,
  -- Operating controls.
  max_per_minute            integer NOT NULL DEFAULT 20 CHECK (max_per_minute BETWEEN 1 AND 1000),
  daily_limit               integer CHECK (daily_limit IS NULL OR daily_limit BETWEEN 1 AND 1000000),
  monthly_limit             integer CHECK (monthly_limit IS NULL OR monthly_limit BETWEEN 1 AND 10000000),
  max_attempts              integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  backoff_base_seconds      integer NOT NULL DEFAULT 30 CHECK (backoff_base_seconds BETWEEN 5 AND 3600),
  backoff_max_seconds       integer NOT NULL DEFAULT 1800 CHECK (backoff_max_seconds BETWEEN 30 AND 86400),
  -- Undelivered messages older than this are cancelled, never sent late (also while paused).
  retention_minutes         integer NOT NULL DEFAULT 240 CHECK (retention_minutes BETWEEN 5 AND 10080),
  -- Digest/threshold knobs for derived events.
  overdue_digest_minutes    integer NOT NULL DEFAULT 240 CHECK (overdue_digest_minutes BETWEEN 30 AND 10080),
  negative_min_followers    integer NOT NULL DEFAULT 10000 CHECK (negative_min_followers BETWEEN 0 AND 100000000),
  news_failures_per_hour    integer NOT NULL DEFAULT 5 CHECK (news_failures_per_hour BETWEEN 1 AND 1000),
  quota_alert_percent       integer NOT NULL DEFAULT 80 CHECK (quota_alert_percent BETWEEN 1 AND 100),
  -- Optional, operator-entered estimate per business-initiated message. Shown as an estimate only, never as
  -- Meta's billed cost (Meta prices per conversation/message category and country).
  cost_estimate_per_message numeric(10,4) CHECK (cost_estimate_per_message IS NULL OR cost_estimate_per_message >= 0),
  cost_estimate_currency    text CHECK (cost_estimate_currency IS NULL OR cost_estimate_currency ~ '^[A-Z]{3}$'),
  -- Health.
  last_verified_at          timestamptz,
  last_verified_ok          boolean,
  last_error_code           text,
  last_error_message        text CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 500),
  last_error_at             timestamptz,
  webhook_verified_at       timestamptz,
  last_webhook_at           timestamptz,
  updated_by                uuid REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (backoff_max_seconds >= backoff_base_seconds)
);
INSERT INTO whatsapp_settings (id) VALUES (true);

-- Message templates as registered with Meta. A template is sent only when meta_status = 'approved'.
-- body_preview is a local copy of the approved body for preview; Meta's copy is authoritative.
CREATE TABLE whatsapp_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512),
  language         text NOT NULL CHECK (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  event_type       text,
  category         text NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION')),
  body_preview     text NOT NULL CHECK (char_length(body_preview) BETWEEN 1 AND 1024),
  variables        text[] NOT NULL DEFAULT '{}',
  meta_status      text NOT NULL DEFAULT 'draft' CHECK (meta_status IN ('draft','pending','approved','rejected','paused','disabled')),
  meta_template_id text,
  meta_reason      text CHECK (meta_reason IS NULL OR char_length(meta_reason) <= 500),
  last_synced_at   timestamptz,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, language),
  CHECK (cardinality(variables) <= 10)
);

-- Per event type: on/off and the template to use. Unknown/unavailable event types are refused by the API.
CREATE TABLE whatsapp_event_settings (
  event_type  text PRIMARY KEY CHECK (event_type ~ '^[a-z_]{3,60}$'),
  enabled     boolean NOT NULL DEFAULT false,
  template_id uuid REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A recipient is always an existing platform user (never a customer or an author of collected content).
-- The number is stored encrypted; phone_hash (HMAC-SHA256 with the server key) finds a recipient from an
-- inbound webhook (opt-out) without decrypting every row.
CREATE TABLE whatsapp_recipients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL UNIQUE REFERENCES users(id),
  phone_encrypted       text NOT NULL,
  phone_hash            text NOT NULL UNIQUE CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  phone_last4           text NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),
  country_code          text NOT NULL CHECK (country_code ~ '^\+[0-9]{1,4}$'),
  is_supervisor         boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  opt_in_status         text NOT NULL DEFAULT 'pending' CHECK (opt_in_status IN ('pending','opted_in','opted_out')),
  opt_in_at             timestamptz,
  opt_in_method         text CHECK (opt_in_method IS NULL OR char_length(opt_in_method) <= 200),
  opt_in_recorded_by    uuid REFERENCES users(id),
  opted_out_at          timestamptz,
  opt_out_source        text CHECK (opt_out_source IS NULL OR opt_out_source IN ('webhook','self','admin')),
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (opt_in_status <> 'opted_in' OR opt_in_at IS NOT NULL),
  CHECK (opt_in_status <> 'opted_out' OR opted_out_at IS NOT NULL)
);

-- The employee's own choice per event type. Absent row = receive (if routed). Mandatory events ignore
-- enabled=false (operational duty), enforced by the API and the dispatcher.
CREATE TABLE whatsapp_recipient_subscriptions (
  recipient_id uuid NOT NULL REFERENCES whatsapp_recipients(id) ON DELETE CASCADE,
  event_type   text NOT NULL CHECK (event_type ~ '^[a-z_]{3,60}$'),
  enabled      boolean NOT NULL,
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_id, event_type)
);

-- Routing: who receives an event. audience 'assignee' needs no other column; 'supervisors' = recipients
-- flagged is_supervisor (optionally within a program's teams); 'role' = recipients whose user has role_key;
-- 'program_team' = recipients on teams covering program_id; 'recipient' = one named recipient.
CREATE TABLE whatsapp_routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL CHECK (event_type ~ '^[a-z_]{3,60}$'),
  audience     text NOT NULL CHECK (audience IN ('assignee','supervisors','role','program_team','recipient')),
  role_key     text,
  program_id   uuid REFERENCES programs(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES whatsapp_recipients(id) ON DELETE CASCADE,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (audience <> 'role' OR role_key IS NOT NULL),
  CHECK (audience <> 'program_team' OR program_id IS NOT NULL),
  CHECK (audience <> 'recipient' OR recipient_id IS NOT NULL)
);
CREATE INDEX whatsapp_routes_event ON whatsapp_routes (event_type) WHERE is_active;

-- Detected events (the outbox). dedupe_key makes detection idempotent across overlapping ticks.
-- payload holds only the sanitized template variables — never customer text, handles or numbers.
CREATE TABLE whatsapp_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL,
  dedupe_key   text NOT NULL UNIQUE CHECK (char_length(dedupe_key) <= 300),
  program_id   uuid REFERENCES programs(id) ON DELETE SET NULL,
  assignee_id  uuid REFERENCES users(id),
  payload      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_events_created ON whatsapp_events (created_at DESC);

-- One message per (event, recipient). idempotency_key is the duplicate guard: the same event can never be
-- queued twice for the same person, however often detection runs.
CREATE TABLE whatsapp_messages (
  id                bigserial PRIMARY KEY,
  event_id          uuid REFERENCES whatsapp_events(id) ON DELETE SET NULL,
  event_type        text NOT NULL,
  recipient_id      uuid NOT NULL REFERENCES whatsapp_recipients(id),
  template_id       uuid REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  template_name     text NOT NULL,
  template_language text NOT NULL,
  program_id        uuid REFERENCES programs(id) ON DELETE SET NULL,
  variables         text[] NOT NULL DEFAULT '{}',
  idempotency_key   text NOT NULL UNIQUE CHECK (char_length(idempotency_key) <= 400),
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','processing','accepted','sent','delivered','read','failed','cancelled')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  locked_until      timestamptz,
  error_class       text CHECK (error_class IS NULL OR error_class IN ('transient','rate_limited','permanent','config','uncertain','policy')),
  last_error_code   text,
  last_error_message text CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 500),
  meta_message_id   text UNIQUE,
  is_test           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at       timestamptz,
  sent_at           timestamptz,
  delivered_at      timestamptz,
  read_at           timestamptz,
  failed_at         timestamptz,
  cancelled_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_messages_due ON whatsapp_messages (next_attempt_at) WHERE status = 'queued';
CREATE INDEX whatsapp_messages_created ON whatsapp_messages (created_at DESC);
CREATE INDEX whatsapp_messages_recipient ON whatsapp_messages (recipient_id, created_at DESC);

-- Every send attempt, including the ones that never got an answer (outcome 'in_flight' until finished).
CREATE TABLE whatsapp_message_attempts (
  id              bigserial PRIMARY KEY,
  message_id      bigint NOT NULL REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
  attempt_no      integer NOT NULL CHECK (attempt_no > 0),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  outcome         text NOT NULL DEFAULT 'in_flight' CHECK (outcome IN ('in_flight','accepted','transient','rate_limited','permanent','config','uncertain','policy')),
  http_status     integer,
  error_code      text,
  error_message   text CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  meta_message_id text,
  UNIQUE (message_id, attempt_no)
);

-- Status webhooks already applied, so a redelivered webhook changes nothing.
CREATE TABLE whatsapp_status_events (
  meta_message_id text NOT NULL,
  status          text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  error_code      text,
  PRIMARY KEY (meta_message_id, status)
);

-- Detection cursors per event source. Reads re-cover a short overlap behind `position` but never go
-- before `started_at` (when the channel was enabled), so enabling never replays earlier events.
CREATE TABLE whatsapp_source_cursors (
  source     text PRIMARY KEY,
  position   timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO permissions (key, domain, description_ar) VALUES
  ('whatsapp:view', 'notifications', 'عرض إعدادات واتساب وحالتها'),
  ('whatsapp:configure', 'notifications', 'تعديل إعدادات اتصال واتساب وأنواع التنبيهات'),
  ('whatsapp:toggle', 'notifications', 'تفعيل قناة واتساب وتعطيلها وإيقافها مؤقتًا'),
  ('whatsapp:recipients', 'notifications', 'إدارة مستلمي واتساب ومسارات التوجيه'),
  ('whatsapp:templates', 'notifications', 'إدارة قوالب رسائل واتساب'),
  ('whatsapp:log', 'notifications', 'عرض سجل رسائل واتساب'),
  ('whatsapp:test_send', 'notifications', 'إرسال رسالة واتساب تجريبية')
ON CONFLICT (key) DO NOTHING;

COMMIT;
