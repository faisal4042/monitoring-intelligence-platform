-- Keep the executive news surface limited to direct authority/program/service
-- coverage. Generic property-market stories remain archived but hidden.

UPDATE news_sources
SET is_active = false, next_run_at = NULL, updated_at = now()
WHERE name_ar = 'الرصد الصحفي الشامل — القطاع العقاري';

UPDATE news_articles
SET is_relevant = false,
    matched_keyword = NULL,
    program_id = NULL,
    topic_id = NULL,
    relevance_score = 0,
    updated_at = now()
WHERE relevance_score < 90;

UPDATE news_sources
SET next_run_at = LEAST(COALESCE(next_run_at, now()), now()), updated_at = now()
WHERE is_active;

INSERT INTO audit_log (action, entity_type, entity_label, new_value, reason)
VALUES (
  'news.enforce_direct_program_scope', 'platform', 'Direct program news only',
  jsonb_build_object('minimumRelevanceScore', 90, 'genericSectorFeedDisabled', true, 'rawArticlesPreserved', true),
  'Show only stories directly tied to the authority, a monitored program, or one of its services'
);
