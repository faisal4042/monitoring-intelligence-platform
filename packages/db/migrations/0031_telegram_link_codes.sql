-- Short-lived codes for the "press Start" Telegram linking flow: a user
-- opens a deep link (t.me/<bot>?start=<code>), Telegram delivers the
-- resulting /start message to our webhook, and we resolve `code` back to
-- the channel awaiting its chat_id — no manual Chat ID copy/paste.
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code       text PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
