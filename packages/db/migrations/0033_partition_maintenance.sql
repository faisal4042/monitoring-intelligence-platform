-- Monthly partition maintenance.
--
-- 0001_init.sql created ensure_monthly_partitions() and called it once, so
-- the five monthly-partitioned tables were only ever covered up to two months
-- past the day 0001 ran (production: up to 2026-11-01 00:00 UTC). From then on
-- the API keeps coverage ahead at startup and daily (lib/partitions.ts); this
-- migration fixes the function and extends coverage once at deploy time.
--
-- Same signature and return type, so CREATE OR REPLACE — no DROP. Two fixes:
--   1. Bounds are computed in UTC explicitly. The original used
--      date_trunc('month', now()) and date literals, both of which follow the
--      session TimeZone: a session in Asia/Riyadh would compute bounds at
--      21:00 UTC that overlap the existing midnight-UTC partitions and fail.
--   2. Concurrency-safe: a transaction-scoped advisory lock lets only one
--      caller maintain partitions at a time (several API instances, startup
--      and the daily check racing), and CREATE TABLE IF NOT EXISTS backs it up.
--
-- Additive only: it creates empty future partitions and never touches existing
-- partitions or rows.

CREATE OR REPLACE FUNCTION ensure_monthly_partitions(months_ahead integer DEFAULT 2)
RETURNS void AS $$
DECLARE
  tbl        text;
  i          integer;
  month_start date;
  s          timestamptz;
  e          timestamptz;
  part       text;
  base       date;
BEGIN
  -- One maintainer at a time across every connection; released at commit.
  PERFORM pg_advisory_xact_lock(hashtext('mip:ensure_monthly_partitions'));

  -- The current month in UTC, whatever the session TimeZone is.
  base := date_trunc('month', now() AT TIME ZONE 'UTC')::date;

  FOREACH tbl IN ARRAY ARRAY['posts','post_classifications','post_sentiments','post_metrics','api_usage']
  LOOP
    FOR i IN 0..months_ahead LOOP
      month_start := (base + make_interval(months => i))::date;
      -- Midnight UTC on the 1st, as absolute instants (the %L literal carries
      -- its offset, so the bound means the same instant in any session).
      s := month_start::timestamp AT TIME ZONE 'UTC';
      e := (month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      part := format('%s_%s', tbl, to_char(month_start, 'YYYY_MM'));
      IF to_regclass(format('public.%I', part)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
          part, tbl, s, e);
      END IF;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Current month + 6: coverage through the end of month+6 the moment this deploys.
SELECT ensure_monthly_partitions(6);
