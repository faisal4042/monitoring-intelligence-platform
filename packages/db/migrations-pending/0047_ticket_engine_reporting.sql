-- 0047 Ticket Engine + Reporting Center (2026-10-15).
-- NOT APPLIED TO mip. Lives outside packages/db/migrations on purpose: db:push must never pick it up.
-- Apply only through apps/api/src/operator/apply-pending-migration.ts (fenced: holds the lease, records the ledger
-- row in the same transaction), after explicit approval. Additive only: no existing table, row, role or
-- permission is changed except the new permission rows and their role grants listed at the end.
-- Fencing: every new public table receives mip_fence_* guards from the 0046 event trigger at CREATE TABLE.
-- Rollback (before any ticket/report data exists): see docs/ticket-engine/rollback.md; never DROP while data exists.
BEGIN;

-- Visible ticket numbers: MIP-<year of opening, Asia/Riyadh>-<global sequence, zero padded to 6+>.
-- One global sequence (no per-year reset): unique forever, no MAX(id)+1, no hot row. Gaps are acceptable.
CREATE SEQUENCE ticket_number_seq AS bigint START 1 NO CYCLE;

-- One person on one provider. Never merged across providers or by display name.
CREATE TABLE customer_identities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL CHECK (provider IN ('x','facebook','telegram','youtube','email','other')),
  provider_customer_id text NOT NULL CHECK (char_length(provider_customer_id) BETWEEN 1 AND 200),
  author_id            uuid REFERENCES authors(id) ON DELETE SET NULL,
  display_name         text,
  handle               text,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_customer_id)
);

-- A conversation is the scope inside which one open ticket collects every message.
CREATE TABLE conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_key     text NOT NULL UNIQUE CHECK (char_length(conversation_key) BETWEEN 8 AND 512),
  key_version          smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  channel              text NOT NULL CHECK (channel IN ('x_mention','x_reply','x_dm','facebook_comment','facebook_inbox','telegram','youtube_comment','email','other')),
  provider             text NOT NULL,
  program_id           uuid REFERENCES programs(id) ON DELETE SET NULL,
  managed_account      text,
  customer_identity_id uuid NOT NULL REFERENCES customer_identities(id),
  provider_thread_id   text,
  identity_confidence  text NOT NULL CHECK (identity_confidence IN ('provider_thread','provider_root','fallback_message')),
  ticket_count         integer NOT NULL DEFAULT 0 CHECK (ticket_count >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_message_at      timestamptz
);
CREATE INDEX conversations_customer ON conversations (customer_identity_id, last_message_at DESC);

CREATE TABLE tickets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number            text NOT NULL UNIQUE CHECK (ticket_number ~ '^MIP-[0-9]{4}-[0-9]{6,}$'),
  conversation_id          uuid NOT NULL REFERENCES conversations(id),
  customer_identity_id     uuid NOT NULL REFERENCES customer_identities(id),
  program_id               uuid REFERENCES programs(id) ON DELETE SET NULL,
  team_id                  uuid REFERENCES teams(id) ON DELETE SET NULL,
  channel                  text NOT NULL,
  status                   text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','assigned','in_progress','pending','escalated','resolved','closed')),
  priority                 text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  assignee_id              uuid REFERENCES users(id),
  version                  integer NOT NULL DEFAULT 1 CHECK (version > 0),
  opened_at                timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  first_assigned_at        timestamptz,
  last_assigned_at         timestamptz,
  first_response_at        timestamptz,
  last_response_at         timestamptz,
  last_customer_message_at timestamptz,
  last_activity_at         timestamptz NOT NULL,
  resolved_at              timestamptz,
  closed_at                timestamptz,
  closed_by                uuid REFERENCES users(id),
  close_reason             text,
  message_count            integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  customer_message_count   integer NOT NULL DEFAULT 0 CHECK (customer_message_count >= 0),
  agent_message_count      integer NOT NULL DEFAULT 0 CHECK (agent_message_count >= 0),
  reassignment_count       integer NOT NULL DEFAULT 0 CHECK (reassignment_count >= 0),
  escalation_count         integer NOT NULL DEFAULT 0 CHECK (escalation_count >= 0),
  correction_count         integer NOT NULL DEFAULT 0 CHECK (correction_count >= 0),
  needs_review             boolean NOT NULL DEFAULT false,
  review_reason            text,
  intent                   text,
  sentiment                text,
  topic_id                 uuid REFERENCES topics(id) ON DELETE SET NULL,
  CONSTRAINT tickets_closed_shape CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT tickets_resolved_shape CHECK (status NOT IN ('resolved') OR resolved_at IS NOT NULL),
  CONSTRAINT tickets_owner_shape CHECK (status NOT IN ('assigned','in_progress','pending') OR assignee_id IS NOT NULL),
  CONSTRAINT tickets_open_shape CHECK (status <> 'open' OR assignee_id IS NULL)
);
-- The core guarantee: at most one non-closed ticket per conversation, enforced by PostgreSQL.
CREATE UNIQUE INDEX tickets_one_active_per_conversation ON tickets (conversation_id) WHERE status <> 'closed';
CREATE INDEX tickets_status_activity ON tickets (status, last_activity_at DESC);
CREATE INDEX tickets_assignee_active ON tickets (assignee_id, status) WHERE status <> 'closed';
CREATE INDEX tickets_program_opened ON tickets (program_id, opened_at DESC);
CREATE INDEX tickets_customer_opened ON tickets (customer_identity_id, opened_at DESC);
CREATE INDEX tickets_closed_at ON tickets (closed_at) WHERE status = 'closed';
CREATE INDEX tickets_review ON tickets (opened_at) WHERE needs_review;

-- Every message keeps its own provider id. (provider, provider_message_id) is the idempotency key:
-- a redelivered message can never create a second row or a second ticket.
-- post_id/post_posted_at reference posts(id, posted_at) WITHOUT a foreign key: posts is partitioned and
-- monthly partitions are dropped by retention; a FK would block that. The link is validated at ingestion.
CREATE TABLE ticket_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id            uuid NOT NULL REFERENCES tickets(id),
  conversation_id      uuid NOT NULL REFERENCES conversations(id),
  provider             text NOT NULL,
  provider_message_id  text NOT NULL CHECK (char_length(provider_message_id) BETWEEN 1 AND 200),
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound','internal_note')),
  author_kind          text NOT NULL CHECK (author_kind IN ('customer','agent','system')),
  agent_id             uuid REFERENCES users(id),
  post_id              uuid,
  post_posted_at       timestamptz,
  body                 text CHECK (body IS NULL OR char_length(body) <= 20000),
  event_at             timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  disposition          text NOT NULL DEFAULT 'attached' CHECK (disposition IN ('attached','late_review')),
  correlation_id       text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id),
  CONSTRAINT ticket_messages_post_pair CHECK ((post_id IS NULL) = (post_posted_at IS NULL)),
  CONSTRAINT ticket_messages_agent CHECK ((author_kind = 'agent') = (agent_id IS NOT NULL))
);
CREATE INDEX ticket_messages_ticket_event ON ticket_messages (ticket_id, event_at, id);
CREATE INDEX ticket_messages_conversation_event ON ticket_messages (conversation_id, event_at);
CREATE INDEX ticket_messages_post ON ticket_messages (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX ticket_messages_event_at ON ticket_messages (event_at);

-- Status/assignment history and every action. Append-only (assignments and status history are events).
CREATE TABLE ticket_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES tickets(id),
  version         integer NOT NULL CHECK (version > 0),
  event_type      text NOT NULL CHECK (event_type IN ('created','message_attached','late_message','assigned','reassigned','unassigned',
                    'started','replied','on_hold','resumed','escalated','deescalated','resolved','closed','admin_correction',
                    'priority_changed','review_flagged','review_cleared')),
  from_status     text,
  to_status       text NOT NULL,
  actor_kind      text NOT NULL CHECK (actor_kind IN ('user','system','ingestion')),
  actor_id        uuid REFERENCES users(id),
  assignee_id     uuid REFERENCES users(id),
  reason          text CHECK (reason IS NULL OR char_length(reason) <= 2000),
  correlation_id  text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, version),
  CONSTRAINT ticket_events_actor CHECK ((actor_kind = 'user') = (actor_id IS NOT NULL)),
  CONSTRAINT ticket_events_reason CHECK (event_type NOT IN ('escalated','admin_correction','on_hold') OR char_length(trim(coalesce(reason,''))) > 0)
);
CREATE INDEX ticket_events_ticket ON ticket_events (ticket_id, occurred_at);
CREATE INDEX ticket_events_occurred ON ticket_events (occurred_at);
CREATE FUNCTION ticket_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Ticket history is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER ticket_events_append_only BEFORE UPDATE OR DELETE ON ticket_events FOR EACH ROW EXECUTE FUNCTION ticket_reject_history_change();

-- ── Reporting ──
CREATE TABLE report_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id),
  name         text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  report_type  text NOT NULL,
  visibility   text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  definition   jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX report_templates_owner ON report_templates (owner_id) WHERE deleted_at IS NULL;
CREATE TABLE report_template_versions (
  template_id  uuid NOT NULL REFERENCES report_templates(id),
  version      integer NOT NULL CHECK (version > 0),
  definition   jsonb NOT NULL,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

CREATE TABLE report_exports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by         uuid NOT NULL REFERENCES users(id),
  report_type          text NOT NULL,
  format               text NOT NULL CHECK (format IN ('xlsx','csv','tsv','json','jsonl')),
  definition           jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  template_id          uuid REFERENCES report_templates(id),
  template_version     integer,
  schema_version       text NOT NULL,
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','expired')),
  cancel_requested     boolean NOT NULL DEFAULT false,
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  rows_written         bigint NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  rows_estimate        bigint,
  file_name            text,
  file_path            text,
  file_bytes           bigint,
  file_sha256          text,
  parts                integer,
  error                text,
  idempotency_key      text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  schedule_run_id      uuid,
  lease_owner          uuid,
  lease_until          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  expires_at           timestamptz,
  UNIQUE (requested_by, idempotency_key),
  CONSTRAINT report_exports_done_shape CHECK (status <> 'succeeded' OR (file_path IS NOT NULL AND file_sha256 IS NOT NULL AND finished_at IS NOT NULL))
);
CREATE INDEX report_exports_queue ON report_exports (created_at) WHERE status IN ('queued','running');
CREATE INDEX report_exports_user ON report_exports (requested_by, created_at DESC);
CREATE TABLE report_export_downloads (
  id            bigserial PRIMARY KEY,
  export_id     uuid NOT NULL REFERENCES report_exports(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  downloaded_at timestamptz NOT NULL DEFAULT now(),
  ip_address    inet
);
CREATE INDEX report_export_downloads_export ON report_export_downloads (export_id, downloaded_at DESC);

CREATE TABLE report_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id),
  template_id   uuid NOT NULL REFERENCES report_templates(id),
  name          text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  cadence       text NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  timezone      text NOT NULL DEFAULT 'Asia/Riyadh' CHECK (timezone = 'Asia/Riyadh'),
  run_at_local  time NOT NULL DEFAULT '07:00',
  weekday       smallint CHECK (weekday BETWEEN 0 AND 6),
  monthday      smallint CHECK (monthday BETWEEN 1 AND 28),
  format        text NOT NULL CHECK (format IN ('xlsx','csv','tsv','json','jsonl')),
  is_active     boolean NOT NULL DEFAULT true,
  next_run_at   timestamptz NOT NULL,
  last_run_at   timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_schedules_shape CHECK ((cadence = 'weekly') = (weekday IS NOT NULL) AND (cadence = 'monthly') = (monthday IS NOT NULL))
);
CREATE INDEX report_schedules_due ON report_schedules (next_run_at) WHERE is_active;
-- Dedup: one run per schedule and period, whoever executes it and however often it is retried.
CREATE TABLE report_schedule_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   uuid NOT NULL REFERENCES report_schedules(id),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL CHECK (period_end > period_start),
  export_id     uuid REFERENCES report_exports(id),
  status        text NOT NULL DEFAULT 'created' CHECK (status IN ('created','failed')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_start)
);

-- ── Permissions (additive; existing reports:read / reports:write are reused) ──
INSERT INTO permissions (key, domain, description_ar) VALUES
  ('tickets:read',             'tickets', 'عرض التذاكر المسندة للمستخدم وتذاكر فريقه غير المسندة'),
  ('tickets:read_all',         'tickets', 'عرض جميع التذاكر'),
  ('tickets:work',             'tickets', 'معالجة التذاكر المسندة: البدء والتعليق والحل والإغلاق'),
  ('tickets:assign',           'tickets', 'إسناد التذاكر وإعادة إسنادها وتصعيدها'),
  ('tickets:manage',           'tickets', 'تصحيح إداري للتذاكر المغلقة ومراجعة الحالات الملتبسة'),
  ('reports:export',           'reports', 'تصدير التقارير وتنزيل ملفاتها'),
  ('reports:manage_templates', 'reports', 'إنشاء قوالب التقارير المشتركة وإدارتها')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.permission_key
FROM (VALUES
  ('admin','tickets:read'),('admin','tickets:read_all'),('admin','tickets:work'),('admin','tickets:assign'),('admin','tickets:manage'),
  ('admin','reports:export'),('admin','reports:manage_templates'),
  ('supervisor','tickets:read'),('supervisor','tickets:read_all'),('supervisor','tickets:work'),('supervisor','tickets:assign'),
  ('supervisor','reports:export'),('supervisor','reports:manage_templates'),
  ('analyst','tickets:read'),('analyst','tickets:read_all'),('analyst','reports:export'),
  ('agent','tickets:read'),('agent','tickets:work')
) AS g(role_key, permission_key)
JOIN roles r ON r.key = g.role_key
JOIN permissions p ON p.key = g.permission_key
ON CONFLICT DO NOTHING;

COMMIT;
