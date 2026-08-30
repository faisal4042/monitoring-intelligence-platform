-- Quarantine official-account posts collected before author exclusions were
-- enforced at X query time. Keep the records for cost/audit history, but do
-- not let them pollute topic discovery or classification metrics.

BEGIN;

CREATE TEMP TABLE official_posts_to_filter ON COMMIT DROP AS
SELECT po.id AS post_id, po.posted_at, pc.program_id
FROM posts po
JOIN authors a ON a.id = po.author_id
JOIN post_classifications pc ON pc.post_id = po.id AND pc.posted_at = po.posted_at
JOIN programs p ON p.id = pc.program_id
WHERE lower(a.username) = ANY (
  SELECT lower(replace(handle, '@', ''))
  FROM unnest(p.official_accounts) AS handle
);

UPDATE post_classifications pc SET
  relevance = 'irrelevant',
  relevance_confidence = 1,
  topic_id = NULL,
  subtopic_id = NULL,
  issue_id = NULL,
  stage = 1,
  model = 'official_account_exclusion',
  reason_ar = 'منشور صادر من حساب رسمي مستبعد من الرصد'
FROM official_posts_to_filter f
WHERE pc.post_id = f.post_id AND pc.posted_at = f.posted_at;

UPDATE posts po SET
  status = 'filtered_out',
  filter_reason = 'official_account_author'
FROM official_posts_to_filter f
WHERE po.id = f.post_id AND po.posted_at = f.posted_at;

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  new_value, reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'topic.audit_filter_official_posts', 'post_classification',
  'تنقية منشورات الحسابات الرسمية من اكتشاف المواضيع',
  jsonb_build_object('filteredPosts', (SELECT count(*) FROM official_posts_to_filter)),
  'الحسابات الرسمية ليست تفاعلات جمهور ولا ينبغي أن تنشئ مواضيع أو تستهلك مساحة التصنيف',
  'info'
);

COMMIT;
