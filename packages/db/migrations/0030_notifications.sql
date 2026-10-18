-- Notification channels (email/telegram) and alert rules that watch new
-- posts and rising signal stories. Channel config is stored encrypted
-- (app-level AES-256-GCM, key derived from JWT_SECRET) since it holds real
-- SMTP passwords / bot tokens — see apps/api/src/lib/crypto.ts.

CREATE TABLE IF NOT EXISTS notification_channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('email', 'telegram')),
  name             text NOT NULL,
  config_encrypted text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  last_test_at     timestamptz,
  last_test_ok     boolean,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  condition_type   text NOT NULL CHECK (condition_type IN
                     ('keyword_match', 'follower_threshold', 'influencer_activity', 'topic_rising')),
  condition        jsonb NOT NULL DEFAULT '{}',
  program_id       uuid REFERENCES programs(id),
  message_template text NOT NULL,
  channel_ids      uuid[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_active ON alert_rules (is_active) WHERE is_active;

-- One row per (rule, matched entity) — both the delivery log the UI shows
-- and the dedup guard the worker relies on (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  entity_type      text NOT NULL CHECK (entity_type IN ('post', 'story')),
  entity_id        uuid NOT NULL,
  message          text NOT NULL,
  channel_results  jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_created ON alert_deliveries (created_at DESC);
