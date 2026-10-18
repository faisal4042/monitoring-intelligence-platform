BEGIN;
ALTER TABLE youtube_collector_controls ADD COLUMN IF NOT EXISTS scheduler_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE youtube_collector_controls ADD COLUMN IF NOT EXISTS interval_minutes integer NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 15 AND 1440);
ALTER TABLE youtube_collector_controls ADD COLUMN IF NOT EXISTS next_run_at timestamptz;
ALTER TABLE youtube_collector_controls ADD COLUMN IF NOT EXISTS last_cycle_at timestamptz;
ALTER TABLE youtube_collector_controls ADD COLUMN IF NOT EXISTS last_cycle_error text;
ALTER TABLE youtube_search_queries ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE youtube_search_queries ADD COLUMN IF NOT EXISTS pending_page_token text;
ALTER TABLE youtube_search_queries ADD COLUMN IF NOT EXISTS pending_after timestamptz;
ALTER TABLE youtube_search_queries ADD COLUMN IF NOT EXISTS pending_before timestamptz;
CREATE TABLE IF NOT EXISTS youtube_video_programs(
 video_id uuid NOT NULL REFERENCES youtube_videos(id) ON DELETE CASCADE,
 program_key text NOT NULL REFERENCES programs(key),
 query_id uuid REFERENCES youtube_search_queries(id) ON DELETE SET NULL,
 suggested_status text NOT NULL DEFAULT 'needs_review' CHECK(suggested_status IN ('matched','needs_review','excluded')),
 reason text NOT NULL DEFAULT '',
 matched_terms text[] NOT NULL DEFAULT '{}',
 review_status text CHECK(review_status IN ('confirmed','excluded','needs_review')),
 review_note text NOT NULL DEFAULT '',
 reviewed_by uuid REFERENCES users(id),reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(video_id,program_key)
);
CREATE INDEX IF NOT EXISTS youtube_video_programs_status ON youtube_video_programs(program_key,review_status,suggested_status);
INSERT INTO youtube_video_programs(video_id,program_key,query_id)
 SELECT v.id,q.program_key,q.id FROM youtube_videos v JOIN youtube_search_queries q ON q.id=v.first_search_query_id JOIN programs p ON p.key=q.program_key
 ON CONFLICT DO NOTHING;
COMMIT;
