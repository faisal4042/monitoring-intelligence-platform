-- Replace the flat, incident-per-topic list with a stable two-level taxonomy.
-- Existing human-approved links are preserved by merging old topics into the
-- new operational children; old labels remain as aliases for future matching.

BEGIN;

CREATE TEMP TABLE desired_topic_taxonomy (
  program_key text NOT NULL,
  parent_name text NOT NULL,
  parent_description text NOT NULL,
  child_name text NOT NULL,
  child_description text NOT NULL,
  service_key text
) ON COMMIT DROP;

INSERT INTO desired_topic_taxonomy VALUES
  ('ejar','العقود والإجراءات','إنشاء العقود وتوثيقها وتجديدها وتعديلها وإنهاؤها.','توثيق وإنشاء العقود','إنشاء عقد الإيجار وتوثيقه ومتطلبات العقار والأطراف.','contract_notarization'),
  ('ejar','العقود والإجراءات','إنشاء العقود وتوثيقها وتجديدها وتعديلها وإنهاؤها.','تجديد العقود','التجديد اليدوي والتلقائي وأخطاء وشروط التجديد.','contract_renewal'),
  ('ejar','العقود والإجراءات','إنشاء العقود وتوثيقها وتجديدها وتعديلها وإنهاؤها.','إنهاء وفسخ العقود','إنهاء العقد قبل موعده أو بعد الخروج ورفض أحد الأطراف.','contract_termination'),
  ('ejar','العقود والإجراءات','إنشاء العقود وتوثيقها وتجديدها وتعديلها وإنهاؤها.','نقل وتعديل العقود','نقل العقد والتنازل والتعديلات على بياناته أو مبالغه.','contract_notarization'),
  ('ejar','العقود والإجراءات','إنشاء العقود وتوثيقها وتجديدها وتعديلها وإنهاؤها.','بيانات الأطراف والوكالات','الوكالات الشرعية والأهلية وبيانات المؤجر والمستأجر والعقار.','contract_notarization'),
  ('ejar','المدفوعات والتحصيل','الفواتير والسداد والمحفظة وتحويل مستحقات الأطراف.','الدفع الإلكتروني والفواتير','أخطاء السداد والفواتير وتخصيص المدفوعات للعقود.','payments'),
  ('ejar','المدفوعات والتحصيل','الفواتير والسداد والمحفظة وتحويل مستحقات الأطراف.','المحفظة وتحويل الدفعات','شحن المحفظة وانعكاس المبالغ وتحويل مستحقات المستفيدين.','payments'),
  ('ejar','المنصة وخدمة العملاء','أداء منصة إيجار وقنوات الدعم والتذاكر.','أعطال المنصة والأداء','البطء والتعليق وأخطاء الموقع أو التطبيق. ',NULL),
  ('ejar','المنصة وخدمة العملاء','أداء منصة إيجار وقنوات الدعم والتذاكر.','التذاكر والدعم','فتح التذاكر ومتابعتها وتأخر الرد أو المعالجة. ',NULL),
  ('ejar','حقوق والتزامات الأطراف','مسؤوليات المؤجر والمستأجر وسلامة وصيانة العقار.','الصيانة ومسؤوليات العقار','تحديد مسؤولية الصيانة والعدادات والمرافق بين الأطراف.',NULL),
  ('ejar','حقوق والتزامات الأطراف','مسؤوليات المؤجر والمستأجر وسلامة وصيانة العقار.','اشتراطات وسلامة العقار','متطلبات السلامة والمراقبة والاشتراطات على العقار المؤجر.',NULL),

  ('rega','التراخيص والوساطة العقارية','تراخيص فال والمنصات وتنظيم نشاط الوسطاء والمسوقين.','رخصة فال ومتطلباتها','الدورات والاختبارات والرسوم وإصدار وتجديد رخصة فال.','brokerage_license'),
  ('rega','التراخيص والوساطة العقارية','تراخيص فال والمنصات وتنظيم نشاط الوسطاء والمسوقين.','ترخيص المنصات العقارية','الترخيص الرسمي والبيئة التجريبية ومتطلبات إطلاق المنصات.','brokerage_license'),
  ('rega','التراخيص والوساطة العقارية','تراخيص فال والمنصات وتنظيم نشاط الوسطاء والمسوقين.','تنظيم الوسطاء والمسوقين','حقوق والتزامات الوسطاء والمسوقين وآلية تعامل الهيئة معهم.','brokerage_license'),
  ('rega','التسجيل والبيانات العقارية','التسجيل العيني وفرز الوحدات ومتطلبات بيانات العقار.','التسجيل العيني للعقارات','طلبات وإجراءات وملاحظات التسجيل العيني للعقار.','real_estate_registration'),
  ('rega','التسجيل والبيانات العقارية','التسجيل العيني وفرز الوحدات ومتطلبات بيانات العقار.','فرز الوحدات والعقارات','محاضر الفرز والقرارات المساحية ومتطلبات فرز الوحدات.','unit_partitioning'),
  ('rega','التطوير العقاري وحماية المستفيد','التزامات المطورين وحماية المشترين والمستفيدين.','تأخر تسليم الوحدات العقارية','تأخر المطور في التسليم والمطالبة بالتعويض أو المعالجة.',NULL),
  ('rega','التطوير العقاري وحماية المستفيد','التزامات المطورين وحماية المشترين والمستفيدين.','أسعار وهوامش التطوير','الأسعار وهوامش الربح والرسوم المرتبطة بالتطوير العقاري.',NULL),
  ('rega','المعهد العقاري والتدريب','برامج ودورات واختبارات المعهد العقاري السعودي.','الاختبارات والدورات','آلية الاختبارات والدورات والشهادات والتجربة التدريبية.','real_estate_institute'),
  ('rega','السوق والتنظيم العقاري','اتجاهات السوق والسياسات والتنظيمات العقارية العامة.','مؤشرات واستثمارات السوق','الاستثمار والطلب والمؤشرات والاهتمام المحلي والدولي بالسوق.',NULL),
  ('rega','السوق والتنظيم العقاري','اتجاهات السوق والسياسات والتنظيمات العقارية العامة.','تنظيم الأحياء والاستخدامات','تنظيم الأحياء واستخدامات العقار والملاحظات الحضرية المرتبطة.',NULL),

  ('mullak','الجمعيات والحوكمة','تأسيس جمعيات الملاك وإدارتها وحوكمتها.','تفعيل وإدارة جمعية الملاك','التأسيس والتفعيل وإدارة بيانات الجمعية والأعضاء.','owners_association'),
  ('mullak','الجمعيات والحوكمة','تأسيس جمعيات الملاك وإدارتها وحوكمتها.','التصويت والاجتماعات','المحاضر والتصويت والاجتماعات وقرارات الجمعية.','owners_association'),
  ('mullak','الرسوم والاشتراكات','الرسوم والميزانيات والتحصيل في جمعيات الملاك.','الرسوم والمطالبات المالية','الاشتراكات والرسوم والمطالبات والسداد.','fees'),
  ('mullak','المنصة والدعم الفني','تشغيل منصة ملاك والتكاملات وقنوات الدعم.','مشكلات منصة ملاك والدعم الفني','الأعطال وصعوبة الاستخدام والمرفقات والتواصل مع الدعم.',NULL),

  ('mostadam','الشهادات والاعتماد','إصدار وتجديد شهادات البناء المستدام ومتطلباتها.','إصدار الشهادة ومتطلباتها','طلبات الشهادة والمستندات والرسوم وحالة الإصدار.','certification'),
  ('mostadam','التقييم والمعايير','التقييم الفني ومعايير وتصنيف المباني المستدامة.','التقييم الفني وتصنيف المباني','نتائج التقييم والنقاط والمعايير الفنية وتصنيف المبنى.','assessment'),
  ('mostadam','المنصة والدعم الفني','استخدام منصة مستدام والدعم المرتبط بالطلبات.','التسجيل والأعطال التقنية','التسجيل والدخول ورفع المستندات والأعطال ومتابعة الدعم.',NULL);

-- Main topics.
INSERT INTO topics (program_id, level, name_ar, description, source)
SELECT p.id, 1, d.parent_name, max(d.parent_description), 'taxonomy_audit'
FROM desired_topic_taxonomy d
JOIN programs p ON p.key = d.program_key
WHERE NOT EXISTS (
  SELECT 1 FROM topics t
  WHERE t.program_id = p.id AND t.is_active AND t.name_ar = d.parent_name
)
GROUP BY p.id, d.parent_name;

-- Reuse an existing exact child label when possible.
UPDATE topics t SET
  parent_id = parent.id,
  level = 2,
  service_id = service.id,
  description = d.child_description,
  updated_at = now()
FROM desired_topic_taxonomy d
JOIN programs p ON p.key = d.program_key
JOIN topics parent ON parent.program_id = p.id AND parent.name_ar = d.parent_name AND parent.is_active
LEFT JOIN services service ON service.program_id = p.id AND service.key = d.service_key
WHERE t.program_id = p.id AND t.is_active AND t.name_ar = d.child_name;

-- Create missing children.
INSERT INTO topics (program_id, service_id, parent_id, level, name_ar, description, source)
SELECT p.id, service.id, parent.id, 2, d.child_name, d.child_description, 'taxonomy_audit'
FROM desired_topic_taxonomy d
JOIN programs p ON p.key = d.program_key
JOIN topics parent ON parent.program_id = p.id AND parent.name_ar = d.parent_name AND parent.is_active
LEFT JOIN services service ON service.program_id = p.id AND service.key = d.service_key
WHERE NOT EXISTS (
  SELECT 1 FROM topics t
  WHERE t.program_id = p.id AND t.is_active AND t.name_ar = d.child_name
);

CREATE TEMP TABLE topic_restructure_map (
  program_key text NOT NULL,
  source_name text NOT NULL,
  target_name text NOT NULL
) ON COMMIT DROP;

INSERT INTO topic_restructure_map VALUES
  ('ejar','إلزام الملاك بتركيب كاميرات مراقبة','اشتراطات وسلامة العقار'),
  ('ejar','إنهاء عقد الإيجار بعد الخروج النهائي','إنهاء وفسخ العقود'),
  ('ejar','إنهاء عقد الإيجار قبل انتهاء المدة','إنهاء وفسخ العقود'),
  ('ejar','إيجار عقار بدون صك','توثيق وإنشاء العقود'),
  ('ejar','التجديد التلقائي لعقد الإيجار وإلزام المستأجر','تجديد العقود'),
  ('ejar','التوثيق التلقائي لعقد الإيجار','توثيق وإنشاء العقود'),
  ('ejar','بطء منصة إيجار وغياب تطبيق الجوال','أعطال المنصة والأداء'),
  ('ejar','تأخر الرد على التذاكر في إيجار','التذاكر والدعم'),
  ('ejar','تأخر انعكاس شحن محفظة إيجار','المحفظة وتحويل الدفعات'),
  ('ejar','تأخر نزول الدفعات المالية للمستفيدين','المحفظة وتحويل الدفعات'),
  ('ejar','تحديث الوكالات الشرعية في منصة إيجار','بيانات الأطراف والوكالات'),
  ('ejar','تخصيص المقابل المالي لعقد محدد','الدفع الإلكتروني والفواتير'),
  ('ejar','توثيق تنازل المؤجر عن جزء من الإيجار','نقل وتعديل العقود'),
  ('ejar','خطأ في الدفع الإلكتروني بمنصة إيجار','الدفع الإلكتروني والفواتير'),
  ('ejar','رفض المؤجر إلغاء عقد الإيجار','إنهاء وفسخ العقود'),
  ('ejar','رقم الوحدة في طلب نقل الذمة المالية للكهرباء','الصيانة ومسؤوليات العقار'),
  ('ejar','صعوبة تجديد عقد الإيجار','تجديد العقود'),
  ('ejar','عقد إيجار قصير المدة','توثيق وإنشاء العقود'),
  ('ejar','مسؤولية غطاء المكيف الخارجي','الصيانة ومسؤوليات العقار'),
  ('ejar','نقل عقد الإيجار إلى مستأجر آخر','نقل وتعديل العقود'),
  ('rega','آلية اختبارات المعهد العقاري','الاختبارات والدورات'),
  ('rega','اهتمام دولي بالعقار السعودي','مؤشرات واستثمارات السوق'),
  ('rega','تحديد هامش ربح المطورين العقاريين','أسعار وهوامش التطوير'),
  ('rega','ترخيص المنصات العقارية والإطلاق التجريبي','ترخيص المنصات العقارية'),
  ('rega','تنظيم الأحياء القديمة وسكن العمالة','تنظيم الأحياء والاستخدامات'),
  ('rega','دورات ومتطلبات ورسوم رخصة فال','رخصة فال ومتطلباتها'),
  ('rega','رخصة فال قبل النظام الجديد','رخصة فال ومتطلباتها'),
  ('rega','معاملة الهيئة للوسطاء والمسوقين','تنظيم الوسطاء والمسوقين');

CREATE TEMP TABLE resolved_topic_restructure AS
SELECT source.id AS source_id, source.name_ar AS source_name,
       target.id AS target_id, target.name_ar AS target_name,
       (SELECT count(*)::int FROM post_classifications c WHERE c.topic_id = source.id) AS source_post_count,
       (SELECT count(*)::int FROM topics child WHERE child.parent_id = source.id AND child.is_active) AS source_child_count
FROM topic_restructure_map m
JOIN programs p ON p.key = m.program_key
JOIN topics source ON source.program_id = p.id AND source.name_ar = m.source_name AND source.is_active
JOIN topics target ON target.program_id = p.id AND target.name_ar = m.target_name AND target.is_active
WHERE source.id <> target.id;

-- Keep the old approved labels as aliases on the new operational child.
INSERT INTO topic_keywords (topic_id, term, kind, created_by)
SELECT DISTINCT r.target_id, r.source_name, 'alias',
       (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1)
FROM resolved_topic_restructure r
ON CONFLICT DO NOTHING;

-- Move classifications without losing human-review provenance.
UPDATE post_classifications c SET
  topic_id = r.target_id,
  stage = 3,
  model = 'taxonomy_restructure',
  human_corrected = true,
  corrected_by = coalesce(c.corrected_by, (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1)),
  corrected_at = coalesce(c.corrected_at, now())
FROM resolved_topic_restructure r
WHERE c.topic_id = r.source_id;

UPDATE topic_suggestions s
SET approved_topic_id = r.target_id, updated_at = now()
FROM resolved_topic_restructure r
WHERE s.approved_topic_id = r.source_id;

INSERT INTO topic_merge_history (
  source_topic_id, target_topic_id, moved_posts, moved_children, merged_by, note
)
SELECT r.source_id, r.target_id,
       r.source_post_count,
       r.source_child_count,
       (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
       'إعادة هيكلة شجرة المواضيع إلى محاور رئيسية وفروع تشغيلية'
FROM resolved_topic_restructure r;

UPDATE topics source SET is_active = false, updated_at = now()
FROM resolved_topic_restructure r
WHERE source.id = r.source_id;

-- Refresh child centroids and counts after the merges.
UPDATE topics target SET
  post_count = stats.post_count,
  centroid = coalesce(stats.centroid, target.centroid),
  updated_at = now()
FROM (
  SELECT t.id, count(c.post_id)::int AS post_count, avg(pe.embedding) AS centroid
  FROM topics t
  LEFT JOIN post_classifications c ON c.topic_id = t.id
  LEFT JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
  WHERE t.is_active AND t.level = 2
  GROUP BY t.id
) stats
WHERE target.id = stats.id;

UPDATE topics parent SET
  post_count = coalesce((SELECT sum(child.post_count) FROM topics child WHERE child.parent_id = parent.id AND child.is_active), 0),
  updated_at = now()
WHERE parent.is_active AND parent.level = 1;

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  old_value, new_value, reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'topic.taxonomy_restructure', 'topic_taxonomy',
  'إعادة هيكلة شجرة المواضيع',
  jsonb_build_object('activeFlatTopics', (SELECT count(*) FROM resolved_topic_restructure)),
  jsonb_build_object(
    'mainTopics', (SELECT count(*) FROM topics WHERE is_active AND level = 1),
    'subtopics', (SELECT count(*) FROM topics WHERE is_active AND level = 2),
    'mergedTopics', (SELECT count(*) FROM resolved_topic_restructure)
  ),
  'تحويل الحالات المفردة إلى تصنيف رئيسي وفرعي ثابت مع حفظ الروابط والمرادفات',
  'info'
);

COMMIT;
