-- A post can support one pending topic proposal at a time. This prevents a
-- retry or concurrent worker from inflating several proposal counts with the
-- same interaction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_suggestion_members_one_per_post
  ON topic_suggestion_members (post_id, posted_at);

