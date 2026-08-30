BEGIN;

-- "Paying rent" is a general life phrase, not proof that a post concerns the
-- Ejar platform. Disable it as a standalone collection/relevance signal.
UPDATE keywords k
SET is_active = false,
    notes = concat_ws(' | ', nullif(k.notes, ''), 'Disabled: broad out-of-program phrase'),
    updated_at = now()
FROM programs p
WHERE p.id = k.program_id
  AND p.key = 'ejar'
  AND k.term_normalized = 'دفع الايجار'
  AND k.is_active = true;

-- Version every current query that still contains the broad phrase. This
-- immediately protects both automatic and manually created active queries.
CREATE TEMP TABLE revised_rent_queries ON COMMIT DROP AS
SELECT
  q.id AS query_id,
  gen_random_uuid() AS new_version_id,
  (SELECT coalesce(max(v2.version), 0) + 1
   FROM query_versions v2 WHERE v2.query_id = q.id) AS new_version,
  v.ast,
  replace(
    replace(v.compiled, ' OR "دفع الإيجار"', ''),
    '"دفع الإيجار" OR ', ''
  ) AS new_compiled,
  v.created_by
FROM queries q
JOIN query_versions v ON v.id = q.current_version_id
WHERE q.deleted_at IS NULL
  AND v.compiled LIKE '%دفع الإيجار%';

INSERT INTO query_versions (
  id, query_id, version, ast, compiled, compiled_length,
  change_summary, diff, created_by
)
SELECT
  new_version_id, query_id, new_version, ast, new_compiled,
  length(new_compiled),
  'إزالة عبارة عامة غير مرتبطة بالبرنامج',
  jsonb_build_object('removedTerm', 'دفع الإيجار', 'reason', 'out_of_program_noise'),
  created_by
FROM revised_rent_queries;

UPDATE queries q
SET current_version_id = r.new_version_id,
    updated_at = now()
FROM revised_rent_queries r
WHERE q.id = r.query_id;

-- Quarantine historical posts whose only positive match was the broad phrase.
CREATE TEMP TABLE unrelated_rent_posts ON COMMIT DROP AS
SELECT po.id, po.posted_at
FROM posts po
JOIN post_classifications pc
  ON pc.post_id = po.id AND pc.posted_at = po.posted_at
JOIN programs p ON p.id = pc.program_id
WHERE p.key = 'ejar'
  AND po.matched_keywords @> ARRAY['دفع الإيجار']::text[]
  AND cardinality(po.matched_keywords) = 1;

UPDATE post_classifications pc
SET relevance = 'irrelevant',
    relevance_confidence = 0.98,
    intent = NULL,
    topic_id = NULL,
    subtopic_id = NULL,
    issue_id = NULL,
    stage = 1,
    model = 'out_of_program_filter',
    reason_ar = 'ذكر دفع الإيجار وحده لا يثبت الارتباط بمنصة إيجار'
FROM unrelated_rent_posts u
WHERE pc.post_id = u.id AND pc.posted_at = u.posted_at;

UPDATE posts po
SET status = 'filtered_out',
    filter_reason = 'not_about_monitored_program'
FROM unrelated_rent_posts u
WHERE po.id = u.id AND po.posted_at = u.posted_at;

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  new_value, reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'collection.remove_broad_rent_phrase', 'keyword',
  'دفع الإيجار',
  jsonb_build_object(
    'queriesRevised', (SELECT count(*) FROM revised_rent_queries),
    'postsFiltered', (SELECT count(*) FROM unrelated_rent_posts)
  ),
  'العبارة عامة وتجمع تفاعلات لا تخص منصة إيجار',
  'warning'
);

COMMIT;
