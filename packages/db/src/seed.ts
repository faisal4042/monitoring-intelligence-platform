/**
 * Seeds roles, permissions, the admin user, the four programs, their keyword
 * dictionaries, default settings and budgets.
 *
 * Idempotent: safe to run repeatedly.
 */
import argon2 from 'argon2';
import { sql, db } from './client.js';
import { normalizeArabic } from './normalize.js';
import {
  ALL_PERMISSIONS, ROLE_PERMISSIONS, ROLE_LABELS, ROLE_KEYS, PERMISSIONS,
} from '@mip/shared';

const PERMISSION_DESCRIPTIONS: Record<string, [string, string]> = {
  'programs:read': ['programs', 'عرض البرامج والخدمات'],
  'programs:write': ['programs', 'إضافة وتعديل البرامج'],
  'keywords:read': ['keywords', 'عرض القواميس'],
  'keywords:write': ['keywords', 'تعديل الكلمات المفتاحية'],
  'queries:read': ['queries', 'عرض الاستعلامات'],
  'queries:write': ['queries', 'إنشاء وتعديل الاستعلامات'],
  'query:test': ['queries', 'تشغيل اختبار الاستعلام (يستهلك حصة)'],
  'query:promote': ['queries', 'ترقية استعلام إلى الإنتاج'],
  'posts:read': ['posts', 'عرض المنشورات'],
  'posts:export': ['posts', 'تصدير المنشورات'],
  'feedback:write': ['feedback', 'تصحيح تصنيف المنشورات'],
  'influencers:read': ['influencers', 'عرض الحسابات المؤثرة'],
  'influencers:write': ['influencers', 'إدارة قائمة الحسابات المؤثرة المتابَعة'],
  'topics:read': ['topics', 'عرض المواضيع'],
  'topics:manage': ['topics', 'إدارة شجرة المواضيع'],
  'incidents:read': ['incidents', 'عرض الحوادث'],
  'incidents:write': ['incidents', 'إدارة الحوادث'],
  'alerts:read': ['alerts', 'عرض التنبيهات'],
  'alerts:write': ['alerts', 'إدارة قواعد التنبيه'],
  'reports:read': ['reports', 'عرض التقارير'],
  'reports:write': ['reports', 'إدارة جدولة التقارير'],
  'cost:read': ['cost', 'عرض التكلفة والاستهلاك'],
  'budget:write': ['cost', 'تعديل الميزانيات — صلاحية حرجة'],
  'killswitch:operate': ['cost', 'تشغيل وإيقاف مفتاح الإيقاف الطارئ — صلاحية حرجة'],
  'historical:read': ['historical', 'عرض التحليل التاريخي'],
  'historical:write': ['historical', 'رفع ومعالجة البيانات التاريخية'],
  'internal_data:read': ['internal', 'الوصول لبيانات خدمة العملاء — صلاحية حرجة'],
  'settings:read': ['settings', 'عرض الإعدادات'],
  'settings:write': ['settings', 'تعديل الإعدادات'],
  'users:write': ['admin', 'إدارة المستخدمين'],
  'news:read': ['news', 'عرض رصد الأخبار والمواقع'],
  'news:manage_sources': ['news', 'إدارة مصادر الأخبار (إضافة/تعديل/تعطيل)'],
  'audit:read': ['admin', 'عرض سجل التدقيق'],
  'admin:system': ['admin', 'لوحة النظام والمطور'],
};

// Support/PR accounts that must never be collected under ANY program, not
// just the one they nominally belong to — a post from one of these often
// mentions other programs' handles too and would otherwise slip through
// that program's own query. Every program's list below includes these on
// top of its own official accounts. Adding an account here is the durable
// fix: official_accounts is reasserted from this array on every seed run
// (ON CONFLICT DO UPDATE), so a fix applied only via the API/DB is silently
// lost the next time `pnpm db:seed` runs — this bit a real exclusion once.
const GLOBAL_EXCLUDED_ACCOUNTS = ['@Ejar_Sa', '@Citizen_care', '@NHC_Care'];

const PROGRAMS = [
  { key: 'ejar', nameAr: 'إيجار', nameEn: 'Ejar', color: '#2563eb', share: 40, officialAccounts: [...GLOBAL_EXCLUDED_ACCOUNTS] },
  { key: 'rega', nameAr: 'الهيئة العامة للعقار', nameEn: 'REGA', color: '#0d9488', share: 30, officialAccounts: ['@REGA_CARES', '@REGA_KSA', '@SpokespRega', '@SRE_Institute', '@Subdivision_SA', '@RERSaudi', '@RERSaudi_care', ...GLOBAL_EXCLUDED_ACCOUNTS] },
  { key: 'mullak', nameAr: 'ملاك', nameEn: 'Mullak', color: '#7c3aed', share: 15, officialAccounts: ['@Mullak_SA', ...GLOBAL_EXCLUDED_ACCOUNTS] },
  { key: 'mostadam', nameAr: 'البناء المستدام', nameEn: 'Mostadam', color: '#16a34a', share: 15, officialAccounts: ['@Mostadam_SA', ...GLOBAL_EXCLUDED_ACCOUNTS] },
];

const NEWS_COVERAGE_QUERIES: Array<{ programKey: string; nameAr: string; nameEn: string; query: string; weight: number }> = [
  { programKey: 'ejar', nameAr: 'الرصد الصحفي المخصص — إيجار', nameEn: 'Targeted press coverage — Ejar', query: 'إيجار when:30d', weight: 99 },
  { programKey: 'rega', nameAr: 'الرصد الصحفي الشامل — الهيئة العامة للعقار', nameEn: 'Comprehensive press — REGA', query: '("الهيئة العامة للعقار" OR "التسجيل العيني" OR "الوساطة العقارية" OR "المعهد العقاري السعودي") when:30d', weight: 98 },
  { programKey: 'mullak', nameAr: 'الرصد الصحفي الشامل — ملاك', nameEn: 'Comprehensive press — Mullak', query: '("برنامج ملاك" OR "جمعيات الملاك" OR "اتحاد الملاك") when:30d', weight: 96 },
  { programKey: 'mostadam', nameAr: 'الرصد الصحفي الشامل — البناء المستدام', nameEn: 'Comprehensive press — Mostadam', query: '("البناء المستدام" OR "فحص جودة البناء" OR "المباني المستدامة") when:30d', weight: 96 },
];

const SERVICES: Record<string, Array<[string, string]>> = {
  ejar: [
    ['contract_notarization', 'توثيق العقد'],
    ['contract_renewal', 'تجديد العقد'],
    ['contract_termination', 'فسخ وإنهاء العقد'],
    ['payments', 'المدفوعات والسداد'],
    ['brokerage', 'الوساطة العقارية'],
  ],
  rega: [
    ['real_estate_registration', 'التسجيل العقاري'],
    ['unit_partitioning', 'فرز الوحدات العقارية'],
    ['real_estate_institute', 'المعهد العقاري'],
    ['brokerage_license', 'رخصة الوساطة'],
  ],
  mullak: [
    ['owners_association', 'اتحاد الملاك'],
    ['fees', 'الرسوم والاشتراكات'],
  ],
  mostadam: [
    ['certification', 'شهادة البناء المستدام'],
    ['assessment', 'التقييم'],
  ],
};

/** type -> [group key, group name, terms] */
const KEYWORDS: Record<string, Array<[string, string, string, string[]]>> = {
  ejar: [
    ['primary', 'ejar_primary', 'الكلمات الأساسية عالية الدقة', [
      '@Ejar_Sa', 'منصة إيجار', 'منصة ايجار', 'شبكة إيجار', 'شبكة ايجار',
    ]],
    ['service', 'ejar_services', 'كلمات الخدمات', [
      'توثيق العقد', 'تجديد العقد', 'فسخ العقد', 'إنهاء العقد', 'دفع الإيجار',
      'العقد ما يتوثق', 'التوثيق واقف', 'العقد معلق', 'ما يتوثق',
    ]],
    ['related', 'ejar_related', 'كلمات مرتبطة', [
      'مؤجر', 'مستأجر', 'وسيط', 'عقد', 'توثيق', 'سداد', 'المكتب العقاري',
    ]],
    ['negative', 'ejar_negatives', 'كلمات مستبعدة', [
      'للبيع', 'شقة للإيجار', 'أرض للإيجار', 'سيارة للإيجار', 'إعلان', 'عروض',
      'مطلوب مستأجر', 'تأجير معدات', 'استراحة للإيجار', 'شاليه', 'مخيم',
      'للإيجار السنوي', 'دور للإيجار', 'فيلا للإيجار',
      'تمويل شخصي', 'إعادة تمويل', 'شراء مديونية', 'للتواصل واتساب',
      'تداول', 'فوركس', 'كريبتو', 'USDT', 'crypto', 'trading',
    ]],
    ['sensitive', 'ejar_sensitive', 'كلمات حساسة', [
      'نصب', 'احتيال', 'شكوى رسمية', 'محكمة', 'قضية', 'تعميم',
    ]],
  ],
  rega: [
    ['primary', 'rega_primary', 'الكلمات الأساسية عالية الدقة', [
      '@REGA_CARES', '@REGA_KSA', '@SpokespRega', '@SRE_Institute',
      '@Subdivision_SA', '@RERSaudi', '@RERSaudi_care',
      'الهيئة العامة للعقار', 'هيئة العقار', 'المعهد العقاري السعودي',
      'منصة فرز الوحدات العقارية',
    ]],
    ['service', 'rega_services', 'كلمات الخدمات', ['التسجيل العقاري', 'فرز الوحدات', 'المعهد العقاري', 'رخصة وساطة']],
    ['related', 'rega_related', 'كلمات مرتبطة', ['صك', 'سجل عقاري', 'فرز', 'ترخيص']],
    ['negative', 'rega_negatives', 'كلمات مستبعدة', [
      'للبيع', 'للإيجار', 'إعلان', 'عروض', 'دلال', 'للتواصل واتساب',
      'تمويل شخصي', 'شراء مديونية', 'تداول', 'فوركس', 'كريبتو',
      'USDT', 'crypto', 'trading', 'مطلوب مسوق', 'تقديم العروض والطلبات',
    ]],
  ],
  mullak: [
    ['primary', 'mullak_primary', 'الكلمات الأساسية عالية الدقة', [
      '@Mullak_SA', 'منصة ملاك', 'برنامج ملاك', 'جمعيات ملاك',
    ]],
    ['service', 'mullak_services', 'كلمات الخدمات', ['رسوم الاتحاد', 'اشتراك ملاك', 'جمعية الملاك']],
    ['negative', 'mullak_negatives', 'كلمات مستبعدة', [
      'للبيع', 'للإيجار', 'إعلان', 'ملاك الأسهم', 'للتواصل واتساب',
      'تداول', 'فوركس', 'كريبتو', 'USDT', 'crypto', 'trading',
    ]],
  ],
  mostadam: [
    ['primary', 'mostadam_primary', 'الكلمات الأساسية عالية الدقة', [
      '@Mostadam_SA', 'منصة البناء المستدام', 'برنامج البناء المستدام',
      'منصة مستدام', 'شهادة مستدام', 'تقييم مستدام',
    ]],
    ['service', 'mostadam_services', 'كلمات الخدمات', ['شهادة مستدام', 'تقييم مستدام', 'تصنيف المباني']],
    ['negative', 'mostadam_negatives', 'كلمات مستبعدة', [
      'إعلان', 'دورة تدريبية', 'وظائف', 'للتواصل واتساب', 'للطلب',
      'خدمات الضيافة', 'القهوة السعودية', 'تداول', 'فوركس', 'كريبتو',
      'USDT', 'crypto', 'trading',
    ]],
  ],
};

// Historical workbook review showed these standalone terms are ambiguous and
// pull property ads or generic sustainability/ownership conversations. Keep
// them inactive; exact brand phrases and official handles above replace them.
const LOW_PRECISION_PRIMARY_TERMS: Record<string, string[]> = {
  ejar: ['إيجار', 'ايجار'],
  rega: ['REGA'],
  mullak: ['ملاك', 'اتحاد الملاك'],
  mostadam: ['البناء المستدام', 'مستدام', 'Mostadam'],
};

// These phrases occur verbatim in sports contracts or in non-Saudi property
// news. X can also stem them into nearby forms, so they are not safe automatic
// triggers without an official handle/brand phrase.
const LOW_PRECISION_SERVICE_TERMS: Record<string, string[]> = {
  ejar: ['تجديد العقد', 'فسخ العقد', 'إنهاء العقد'],
  rega: ['التسجيل العقاري'],
};

/** Real dialect variants — the point of the Connect Listening discovery phase. */
const ALIASES: Array<[string, string, string]> = [
  ['العقد ما يتوثق', 'مو قادر أوثق العقد', 'dialect'],
  ['العقد ما يتوثق', 'ما اقدر اوثق العقد', 'dialect'],
  ['العقد ما يتوثق', 'العقد يرفض التوثيق', 'dialect'],
  ['التوثيق واقف', 'التوثيق ما يشتغل', 'dialect'],
  ['التوثيق واقف', 'التوثيق متوقف', 'synonym'],
  ['العقد معلق', 'ما وصلني قبول العقد', 'dialect'],
  ['توثيق', 'توثيغ', 'misspelling'],
  ['إيجار', 'ايجار', 'misspelling'],
  ['مستأجر', 'مستاجر', 'misspelling'],
  ['مؤجر', 'موجر', 'misspelling'],
];

const SETTINGS: Array<[string, unknown, string, string, string]> = [
  ['x_api.tier', 'basic', 'string', 'x_api', 'باقة X API الحالية'],
  ['x_api.pricing', {
    model: 'subscription_with_quota',
    monthly_price_usd: 200,
    monthly_post_quota: 10000,
    derived_unit_price_usd: 0.02,
    note_ar: 'قيم أولية — يجب التحقق منها من صفحة أسعار X قبل التشغيل الحي. لا أرقام مثبتة في الكود.',
  }, 'object', 'x_api', 'نموذج تسعير X API — يحوّل وحدات الحصة إلى تكلفة'],
  ['x_api.limits', {
    search_recent_requests_per_15min: 60,
    max_results_per_request: 100,
    search_window_days: 7,
  }, 'object', 'x_api', 'حدود المعدل والنافذة الزمنية'],
  ['x_api.fields', {
    'tweet.fields': ['id', 'text', 'created_at', 'author_id', 'lang', 'conversation_id', 'public_metrics', 'referenced_tweets', 'entities', 'possibly_sensitive'],
    'user.fields': ['id', 'username', 'name', 'description', 'profile_image_url', 'public_metrics', 'verified', 'created_at'],
    expansions: ['author_id'],
    note_ar: 'كل حقل إضافي يزيد حجم الاستجابة. expansions=author_id يجلب بيانات المؤلف بلا طلب منفصل.',
  }, 'object', 'x_api', 'الحقول المطلوبة من X API'],
  ['x_api.retention', {
    raw_response_days: 7,
    post_content_days: 365,
    aggregates_days: null,
    honor_deletion_requests: true,
  }, 'object', 'x_api', 'سياسات الاحتفاظ بالبيانات'],
  ['author_cache.refresh_hours', { normal: 168, influencer: 24, high_priority: 6 }, 'object', 'collection', 'فترات تحديث ملفات الحسابات'],
  ['scoring.risk_weights', {
    sentiment_negative: 0.20, author_followers: 0.15, engagement_velocity: 0.20,
    engagement_total: 0.10, sensitive_keywords: 0.15, similar_volume_growth: 0.15,
    is_influencer: 0.05,
  }, 'object', 'scoring', 'أوزان درجة الخطورة'],
  ['scoring.influence_weights', {
    followers_log: 0.25, avg_engagement: 0.25, relevant_post_count: 0.20,
    reach_estimate: 0.15, historical_consistency: 0.15,
  }, 'object', 'scoring', 'أوزان درجة التأثير'],
  ['classification.confidence_threshold_stage2', 0.85, 'number', 'ai', 'عتبة الثقة لحسم التصنيف بلا LLM'],
  ['classification.min_precision_to_promote', 0.70, 'number', 'queries', 'أدنى دقة مطلوبة لترقية استعلام للإنتاج'],
  ['detection.spike_z_threshold', 3.0, 'number', 'detection', 'عتبة z-score لكشف الارتفاع'],
  ['detection.emerging_min_frequency', 15, 'number', 'detection', 'أدنى تكرار لاعتبار العبارة ناشئة'],
  ['alerts.default_dedup_window_minutes', 20, 'number', 'alerts', 'نافذة تجميع التنبيهات'],
  ['ai.providers', {
    llm: { primary: 'openai', fallback: 'local' },
    embedding: { primary: 'local_bge_m3', dimensions: 1024 },
  }, 'object', 'ai', 'مزودو الذكاء الاصطناعي'],
];

async function main() {
  console.log('\nSeeding database...\n');

  // ── Permissions ──
  for (const key of ALL_PERMISSIONS) {
    const [domain, desc] = PERMISSION_DESCRIPTIONS[key] ?? ['general', key];
    await sql`INSERT INTO permissions (key, domain, description_ar)
              VALUES (${key}, ${domain}, ${desc})
              ON CONFLICT (key) DO UPDATE SET description_ar = EXCLUDED.description_ar`;
  }
  console.log(`  permissions       ${ALL_PERMISSIONS.length}`);

  // ── Roles ──
  const roleIds: Record<string, string> = {};
  for (const key of ROLE_KEYS) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO roles (key, name_ar, name_en, is_system)
      VALUES (${key}, ${ROLE_LABELS[key].ar}, ${ROLE_LABELS[key].en}, true)
      ON CONFLICT (key) DO UPDATE SET name_ar = EXCLUDED.name_ar
      RETURNING id`;
    roleIds[key] = row.id;
    await sql`DELETE FROM role_permissions WHERE role_id = ${row.id}`;
    for (const p of ROLE_PERMISSIONS[key]) {
      await sql`INSERT INTO role_permissions (role_id, permission_key) VALUES (${row.id}, ${p})`;
    }
  }
  console.log(`  roles             ${ROLE_KEYS.length}`);

  // ── Admin user ──
  // Production credentials come from the deployment secret store. Existing
  // passwords are never reset by a routine redeploy/seed operation.
  const isProduction = process.env.NODE_ENV === 'production';
  const adminEmail = (process.env.INITIAL_ADMIN_EMAIL ?? 'admin@mip.local').trim().toLowerCase();
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD ?? (isProduction ? '' : 'Admin@12345');
  let [admin] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE lower(email) = ${adminEmail} LIMIT 1`;
  if (!admin) {
    if (isProduction && adminPassword.length < 16) {
      throw new Error('INITIAL_ADMIN_PASSWORD must be at least 16 characters for the first production seed');
    }
    const hash = await argon2.hash(adminPassword, { type: argon2.argon2id });
    [admin] = await sql<{ id: string }[]>`
      INSERT INTO users (email, full_name, password_hash, role_id)
      VALUES (${adminEmail}, ${'مدير النظام'}, ${hash}, ${roleIds.admin})
      RETURNING id`;
  } else {
    await sql`UPDATE users SET role_id = ${roleIds.admin}, is_active = true WHERE id = ${admin.id}`;
  }

  // budget:write and internal_data:read are never role-granted — grant to admin explicitly.
  for (const p of [PERMISSIONS.BUDGET_WRITE, PERMISSIONS.INTERNAL_DATA_READ]) {
    await sql`INSERT INTO user_permissions (user_id, permission_key, granted_by)
              VALUES (${admin.id}, ${p}, ${admin.id})
              ON CONFLICT DO NOTHING`;
  }

  // A production database may be restored from a developer workstation.
  // Never leave the well-known local demo accounts usable after that restore.
  if (isProduction) {
    await sql`
      UPDATE refresh_tokens
      SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND user_id IN (
          SELECT id FROM users
          WHERE lower(email) IN ('admin@mip.local', 'viewer@mip.local')
            AND lower(email) <> ${adminEmail}
        )`;
    await sql`
      UPDATE users
      SET is_active = false, failed_login_attempts = 0, locked_until = NULL,
          updated_at = now()
      WHERE lower(email) IN ('admin@mip.local', 'viewer@mip.local')
        AND lower(email) <> ${adminEmail}`;
  }

  // Global X account exclusions apply retroactively as well as to future
  // collection. Keep the rows for referential integrity and auditability, but
  // redact them from every user-facing feed and statistic.
  const excludedXUsernames = (process.env.AUTO_COLLECTION_EXCLUDED_USERS ?? '')
    .split(',')
    .map((username) => username.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  if (excludedXUsernames.length > 0) {
    await sql`
      UPDATE posts p
      SET is_redacted = true, redacted_at = COALESCE(p.redacted_at, now())
      FROM authors a
      WHERE p.author_id = a.id
        AND lower(a.username) = ANY(${excludedXUsernames}::text[])
        AND NOT p.is_redacted`;
  }

  // A read-only demo account so the RBAC split is visible immediately.
  const viewerPassword = process.env.INITIAL_VIEWER_PASSWORD ?? (isProduction ? '' : 'Viewer@12345');
  if (viewerPassword) {
    if (isProduction && viewerPassword.length < 16) throw new Error('INITIAL_VIEWER_PASSWORD must be at least 16 characters');
    const viewerHash = await argon2.hash(viewerPassword, { type: argon2.argon2id });
    await sql`INSERT INTO users (email, full_name, password_hash, role_id)
              VALUES (${process.env.INITIAL_VIEWER_EMAIL ?? 'viewer@mip.local'}, ${'مستعرض'}, ${viewerHash}, ${roleIds.viewer})
              ON CONFLICT (email) DO NOTHING`;
  }
  console.log(`  users             admin${viewerPassword ? ' + viewer' : ''}`);

  // ── Programs, services, keywords ──
  let kwCount = 0;
  const keywordIdByTerm = new Map<string, string>();
  const programIdByKey = new Map<string, string>();

  for (const p of PROGRAMS) {
    const [prog] = await sql<{ id: string }[]>`
      INSERT INTO programs (key, name_ar, name_en, color, budget_share_pct, official_accounts, created_by)
      VALUES (${p.key}, ${p.nameAr}, ${p.nameEn}, ${p.color}, ${p.share}, ${p.officialAccounts}, ${admin.id})
      ON CONFLICT (key) DO UPDATE SET
        name_ar = EXCLUDED.name_ar,
        color = EXCLUDED.color,
        official_accounts = EXCLUDED.official_accounts
      RETURNING id`;
    programIdByKey.set(p.key, prog.id);

    for (const [sKey, sName] of SERVICES[p.key] ?? []) {
      await sql`INSERT INTO services (program_id, key, name_ar)
                VALUES (${prog.id}, ${sKey}, ${sName})
                ON CONFLICT (program_id, key) DO NOTHING`;
    }

    for (const [type, gKey, gName, terms] of KEYWORDS[p.key] ?? []) {
      const [grp] = await sql<{ id: string }[]>`
        INSERT INTO keyword_groups (program_id, key, name_ar, type)
        VALUES (${prog.id}, ${gKey}, ${gName}, ${type}::keyword_type)
        ON CONFLICT (program_id, key) DO UPDATE SET name_ar = EXCLUDED.name_ar
        RETURNING id`;

      for (const term of terms) {
        const normalized = normalizeArabic(term);
        const mode = term.trim().startsWith('@')
          ? 'mention'
          : term.trim().startsWith('#')
            ? 'hashtag'
            : term.trim().includes(' ')
              ? 'phrase'
              : 'term';
        const [kw] = await sql<{ id: string }[]>`
          INSERT INTO keywords (group_id, program_id, term, term_normalized, type, match_mode, created_by)
          VALUES (${grp.id}, ${prog.id}, ${term}, ${normalized}, ${type}::keyword_type, ${mode}, ${admin.id})
          ON CONFLICT (group_id, term_normalized) DO UPDATE SET term = EXCLUDED.term
          RETURNING id`;
        keywordIdByTerm.set(term, kw.id);
        kwCount++;
      }
    }

    const lowPrecisionTerms = (LOW_PRECISION_PRIMARY_TERMS[p.key] ?? []).map(normalizeArabic);
    if (lowPrecisionTerms.length > 0) {
      await sql`UPDATE keywords
                SET is_active = false, updated_at = now(),
                    notes = 'مُعطلة بعد تحليل الملف التاريخي: كلمة مفردة عالية الضوضاء'
                WHERE program_id = ${prog.id}
                  AND type = 'primary'
                  AND term_normalized = ANY(${lowPrecisionTerms}::text[])`;
    }

    const lowPrecisionServiceTerms = (LOW_PRECISION_SERVICE_TERMS[p.key] ?? []).map(normalizeArabic);
    if (lowPrecisionServiceTerms.length > 0) {
      await sql`UPDATE keywords
                SET is_active = false, updated_at = now(),
                    notes = 'معطلة للرصد التلقائي: عبارة عامة ثبت أنها تجلب نتائج خارج نطاق البرنامج'
                WHERE program_id = ${prog.id}
                  AND type = 'service'
                  AND term_normalized = ANY(${lowPrecisionServiceTerms}::text[])`;
    }
  }
  console.log(`  programs          ${PROGRAMS.length}`);
  console.log(`  keywords          ${kwCount}`);

  // Durable press-discovery shards. Migrations cover existing databases;
  // seeding also creates them on a brand-new database where programs do not
  // exist until this loop has run.
  for (const source of NEWS_COVERAGE_QUERIES) {
    const programId = programIdByKey.get(source.programKey);
    if (!programId) continue;
    const encodedQuery = encodeURIComponent(source.query).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const feedUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=ar&gl=SA&ceid=SA:ar`;
    await sql`
      INSERT INTO news_sources (
        program_id, name_ar, name_en, base_url, country, language, source_type,
        connector_type, rss_url, source_weight, check_interval_minutes,
        next_run_at, crawl_allowed, is_active, created_by
      ) VALUES (
        ${programId}::uuid, ${source.nameAr}, ${source.nameEn}, ${feedUrl}, 'SA', 'ar', 'news_site',
        'rss', ${feedUrl}, ${source.weight}, 5, now(), true, true, ${admin.id}::uuid
      ) ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO news_source_health (source_id)
      SELECT id FROM news_sources WHERE lower(base_url) = lower(${feedUrl})
      ON CONFLICT (source_id) DO NOTHING`;
  }
  console.log(`  news coverage     ${NEWS_COVERAGE_QUERIES.length} program shards`);

  // ── Aliases ──
  let aliasCount = 0;
  for (const [term, alias, aliasType] of ALIASES) {
    const kwId = keywordIdByTerm.get(term);
    if (!kwId) continue;
    await sql`INSERT INTO keyword_aliases (keyword_id, alias, alias_normalized, alias_type, source)
              VALUES (${kwId}, ${alias}, ${normalizeArabic(alias)}, ${aliasType}, 'seed')
              ON CONFLICT (keyword_id, alias_normalized) DO NOTHING`;
    aliasCount++;
  }
  console.log(`  keyword aliases   ${aliasCount}`);

  // ── Settings ──
  for (const [key, value, valueType, category, desc] of SETTINGS) {
    await sql`INSERT INTO settings (key, value, value_type, category, description_ar)
              VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${valueType}, ${category}, ${desc})
              ON CONFLICT (key) DO NOTHING`;
  }
  // Preserve customised field selections while ensuring the safety flag is
  // requested from X in existing as well as fresh databases.
  await sql`
    UPDATE settings
    SET value = jsonb_set(
          value,
          '{tweet.fields}',
          CASE
            WHEN (value->'tweet.fields') ? 'possibly_sensitive' THEN value->'tweet.fields'
            ELSE (value->'tweet.fields') || '["possibly_sensitive"]'::jsonb
          END
        ),
        updated_at = now()
    WHERE key = 'x_api.fields'`;
  console.log(`  settings          ${SETTINGS.length}`);

  // ── Budgets ──
  // Deliberately conservative defaults. 1000 units/month = the $20 budget at
  // the seeded unit price. See docs/X_API_STRATEGY.md §1.
  const budgets: Array<[string, string | null, string, number, number | null]> = [
    // Monthly is the real cap ($20 at the seeded unit price). Daily and hourly
    // are burst guards sized so a 100-post sandbox test still fits.
    ['global', null, 'month', 1000, 20],
    ['global', null, 'day', 150, 3],
    ['global', null, 'hour', 100, 2],
  ];
  for (const [scope, scopeId, period, units, cost] of budgets) {
    await sql`INSERT INTO api_budgets (scope, scope_id, period, unit_limit, cost_limit, is_hard_limit, alert_thresholds, updated_by)
              VALUES (${scope}::budget_scope, ${scopeId}, ${period}::budget_period, ${units}, ${cost}, true, '{50,70,80,90,100}', ${admin.id})
              ON CONFLICT DO NOTHING`;
  }

  // Per-program monthly share of the global unit limit.
  const progRows = await sql<{ id: string; budget_share_pct: string | null }[]>`
    SELECT id, budget_share_pct FROM programs WHERE is_active`;
  for (const r of progRows) {
    const share = Number(r.budget_share_pct ?? 0);
    if (!share) continue;
    await sql`INSERT INTO api_budgets (scope, scope_id, period, unit_limit, is_hard_limit, alert_thresholds, updated_by)
              VALUES ('program'::budget_scope, ${r.id}, 'month'::budget_period, ${Math.floor(1000 * share / 100)}, true, '{50,70,80,90,100}', ${admin.id})
              ON CONFLICT DO NOTHING`;
  }
  console.log(`  budgets           ${budgets.length + progRows.length}`);

  // ── Retention policies ──
  const retention: Array<[string, number | null, string]> = [
    ['raw_responses', 7, 'delete'],
    ['posts', 365, 'drop_partition'],
    ['api_usage', 730, 'drop_partition'],
    ['aggregates', null, 'archive'],
  ];
  for (const [entity, days, action] of retention) {
    await sql`INSERT INTO retention_policies (entity, retention_days, action)
              VALUES (${entity}, ${days}, ${action})
              ON CONFLICT (entity) DO NOTHING`;
  }

  console.log('\nDone.\n');
  console.log(`  Admin:  ${adminEmail} (password is managed outside the repository)`);
  if (viewerPassword) console.log('  Viewer: enabled (password is managed outside the repository)');
  console.log('');

  await sql.end();
}

main().catch(async (err) => {
  console.error('\nSeed failed:', err);
  await sql.end().catch(() => {});
  process.exit(1);
});
