# DATABASE SCHEMA — Monitoring Intelligence Platform

> PostgreSQL 16 + `pgvector` · Drizzle ORM · كل الأسماء بالإنجليزية
> مكمّلة لـ [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 0. مبادئ التصميم

| المبدأ | التطبيق |
|---|---|
| **المفاتيح** | `uuid` لكل الكيانات الداخلية. **استثناء:** `posts.x_post_id` و `authors.x_author_id` من نوع `text` — معرّفات X الأصلية، وهي مفتاح إزالة التكرار الحقيقي. |
| **التقسيم** | `posts` و `api_usage` و `mention_metrics_hourly` مقسّمة شهرياً بـ RANGE. حذف البيانات القديمة = `DROP PARTITION` بدل `DELETE` بطيء. |
| **المتجهات** | `vector(1024)` (أبعاد bge-m3) مع فهرس HNSW. البعد يتغيّر عبر migration عند تبديل النموذج. |
| **الوقت** | `timestamptz` حصراً. التخزين UTC، العرض `Asia/Riyadh`. |
| **الحذف** | `deleted_at` للكيانات القابلة للاسترجاع. حذف فعلي فقط لالتزامات الامتثال. |
| **التدقيق** | `created_at`, `updated_at`, `created_by` على كل جدول قابل للتعديل. |
| **JSONB** | للبنى المرنة فقط (AST الاستعلام، شروط التنبيه، الإعدادات). **لا** يُستخدم للتهرّب من تصميم الجداول. |
| **التجميع المسبق** | كل استعلام تحليلي يقرأ من جداول rollup. `posts` لا تُمسح تجميعياً في الزمن الحقيقي أبداً. |

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- بحث عربي جزئي
CREATE EXTENSION IF NOT EXISTS "ltree";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE SCHEMA IF NOT EXISTS internal;          -- عزل بيانات خدمة العملاء
```

---

## 1. Identity & RBAC

```sql
CREATE TABLE roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,          -- admin|supervisor|analyst|viewer
  name_ar       text NOT NULL,
  name_en       text NOT NULL,
  description   text,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key            text PRIMARY KEY,             -- 'budget:write', 'query:promote'
  domain         text NOT NULL,
  description_ar text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,                 -- Argon2id
  role_id       uuid NOT NULL REFERENCES roles(id),
  is_active     boolean NOT NULL DEFAULT true,
  locale        text NOT NULL DEFAULT 'ar',
  theme         text NOT NULL DEFAULT 'system',
  last_login_at timestamptz,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- منح دقيق فوق الدور، للعمليات الحرجة
CREATE TABLE user_permissions (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  granted_by     uuid REFERENCES users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,          -- لا يُخزَّن التوكن الخام
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text,
  ip_address    inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
```

**قائمة الصلاحيات:**
```
programs:read|write · keywords:read|write · queries:read|write
query:test · query:promote                    ← منفصلة عن queries:write
posts:read · posts:export · feedback:write
influencers:read · topics:read · topics:manage
incidents:read|write · alerts:read|write
reports:read|write · cost:read
budget:write · killswitch:operate             ← حرجة
historical:read|write · internal_data:read    ← حرجة
settings:read|write · users:write · audit:read · admin:system
```

**خرائط الأدوار الافتراضية:**

| الدور | الصلاحيات |
|---|---|
| `viewer` | كل `*:read` |
| `analyst` | viewer + `keywords:write`, `feedback:write`, `query:test`, `topics:manage`, `historical:*`, `posts:export` |
| `supervisor` | analyst + `queries:write`, `query:promote`, `alerts:write`, `reports:write`, `incidents:write`, `killswitch:operate` |
| `admin` | كل شيء |

`budget:write` و `internal_data:read` **لا تُمنحان تلقائياً لأي دور** — تُمنحان فردياً عبر `user_permissions`.

---

## 2. Programs, Services & Taxonomy

```sql
CREATE TABLE programs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,          -- ejar, mullak, mostadam, rega
  name_ar       text NOT NULL,                 -- إيجار
  name_en       text NOT NULL,
  description   text,
  color         text,
  official_accounts text[] DEFAULT '{}',       -- حسابات X الرسمية
  is_active     boolean NOT NULL DEFAULT true,
  budget_share_pct numeric(5,2),               -- حصة الميزانية: 40.00
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  deleted_at    timestamptz
);

CREATE TABLE services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  key           text NOT NULL,
  name_ar       text NOT NULL,                 -- توثيق العقد
  name_en       text,
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, key)
);

-- شجرة موحّدة: Topic → Subtopic → Issue
CREATE TABLE topics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  service_id    uuid REFERENCES services(id) ON DELETE SET NULL,
  parent_id     uuid REFERENCES topics(id) ON DELETE CASCADE,
  level         smallint NOT NULL,             -- 1=topic 2=subtopic 3=issue
  name_ar       text NOT NULL,
  name_en       text,
  description   text,
  path          ltree,                         -- ejar.contracts.notarization.failure
  centroid      vector(1024),                  -- مركز دلالي: مطابقة بلا LLM
  source        text NOT NULL DEFAULT 'manual',-- manual|historical_analysis|emerging
  source_ref    uuid,
  is_active     boolean NOT NULL DEFAULT true,
  post_count    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON topics USING gist (path);
CREATE INDEX ON topics (program_id, level) WHERE is_active;
CREATE INDEX ON topics USING hnsw (centroid vector_cosine_ops);
```

**لماذا شجرة واحدة بدل ثلاثة جداول؟** `subtopics` و `issues` لهما نفس البنية والسلوك تماماً. ثلاثة جداول متطابقة تعني ثلاثة مسارات كود لكل عملية. `level` + `parent_id` + `ltree` يعطي شجرة بأي عمق، ويسمح بمستوى رابع لاحقاً بلا migration.

---

## 3. Keyword Intelligence

```sql
CREATE TYPE keyword_type AS ENUM ('primary','service','related','negative','sensitive');

CREATE TABLE keyword_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid REFERENCES programs(id) ON DELETE CASCADE,
  key           text NOT NULL,                 -- ejar_primary, ejar_negatives
  name_ar       text NOT NULL,
  type          keyword_type NOT NULL,
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, key)
);

CREATE TABLE keywords (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        uuid NOT NULL REFERENCES keyword_groups(id) ON DELETE CASCADE,
  program_id      uuid REFERENCES programs(id) ON DELETE CASCADE,
  service_id      uuid REFERENCES services(id) ON DELETE SET NULL,
  term            text NOT NULL,               -- النص كما يُكتب
  term_normalized text NOT NULL,               -- بعد التطبيع العربي
  type            keyword_type NOT NULL,
  match_mode      text NOT NULL DEFAULT 'term',-- term|phrase|hashtag|mention|from
  language        text NOT NULL DEFAULT 'ar',
  weight          numeric(4,2) NOT NULL DEFAULT 1.0,
  source          text NOT NULL DEFAULT 'manual',
  source_ref      uuid,
  -- مقاييس الأداء الفعلية
  match_count      integer NOT NULL DEFAULT 0,
  relevant_count   integer NOT NULL DEFAULT 0,
  irrelevant_count integer NOT NULL DEFAULT 0,
  noise_rate       numeric(5,4),               -- irrelevant / match_count
  is_active     boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  UNIQUE (group_id, term_normalized)
);
CREATE INDEX ON keywords (program_id, type) WHERE is_active;
CREATE INDEX ON keywords USING gin (term_normalized gin_trgm_ops);
CREATE INDEX ON keywords (noise_rate DESC NULLS LAST) WHERE is_active;

-- مرادفات + أخطاء إملائية + صيغ عامية
CREATE TABLE keyword_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id       uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  alias            text NOT NULL,
  alias_normalized text NOT NULL,
  alias_type       text NOT NULL,              -- synonym|misspelling|dialect|abbreviation
  confidence       numeric(4,3),
  source           text NOT NULL DEFAULT 'manual',
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (keyword_id, alias_normalized)
);
```

**ملاحظة تصميم:** لا يوجد جدول `negative_keywords` منفصل. الكلمات السالبة هي `keywords` بـ `type='negative'` — نفس البنية، نفس مقاييس الأداء، نفس واجهة الإدارة. جدول منفصل كان سيعني تكرار كل شيء بلا مقابل.

`term_normalized` هو ما يُستخدم في المطابقة والتفرّد: يوحّد `أ/إ/آ→ا`، `ة→ه`، `ى→ي`، ويحذف التشكيل والتطويل. بدونه ستُدخل نفس الكلمة عشر مرات بصيغ مختلفة ويصبح القاموس عديم القيمة.

---

## 4. Queries & Versioning

```sql
CREATE TYPE query_status AS ENUM ('draft','tested','approved','active','paused','archived');
CREATE TYPE polling_tier AS ENUM ('hot','warm','cold','manual');

CREATE TABLE queries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  service_id    uuid REFERENCES services(id) ON DELETE SET NULL,
  name          text NOT NULL,
  description   text,
  status        query_status NOT NULL DEFAULT 'draft',
  current_version_id uuid,

  -- جدولة واستهلاك
  polling_tier          polling_tier NOT NULL DEFAULT 'warm',
  poll_interval_minutes int NOT NULL DEFAULT 30,
  max_results_per_call  int NOT NULL DEFAULT 50,
  max_pages_per_run     int NOT NULL DEFAULT 1,   -- سقف صارم ضد الانفجار
  daily_unit_cap        int,                      -- سقف حصة يومية للاستعلام
  since_id              text,                     -- watermark: لا إعادة جلب
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  next_run_at           timestamptz,

  -- أداء تراكمي
  total_requests   bigint NOT NULL DEFAULT 0,
  total_units      bigint NOT NULL DEFAULT 0,     -- المنشورات المُرجعة
  total_relevant   bigint NOT NULL DEFAULT 0,
  total_irrelevant bigint NOT NULL DEFAULT 0,
  precision_rate   numeric(5,4),
  is_paused        boolean NOT NULL DEFAULT false,
  pause_reason     text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  deleted_at    timestamptz
);
CREATE INDEX ON queries (status, next_run_at) WHERE status = 'active' AND NOT is_paused;
CREATE INDEX ON queries (program_id);

CREATE TABLE query_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id        uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  ast             jsonb NOT NULL,              -- AST من Query Builder
  compiled        text NOT NULL,               -- نص استعلام X النهائي
  compiled_length int NOT NULL,
  -- تقدير وقت الإنشاء
  breadth_score           numeric(5,2),
  noise_risk_score        numeric(5,2),
  estimated_units_per_run int,
  -- نتائج فعلية بعد التشغيل
  actual_precision numeric(5,4),
  actual_units     bigint NOT NULL DEFAULT 0,
  change_summary   text,                       -- ما تغيّر عن السابقة
  diff             jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id),
  UNIQUE (query_id, version)
);

ALTER TABLE queries ADD CONSTRAINT fk_current_version
  FOREIGN KEY (current_version_id) REFERENCES query_versions(id);
```

**`max_pages_per_run` صمام أمان أساسي.** بدونه، استعلام واسع على موضوع رائج يستهلك حصة الشهر كاملة في تشغيل واحد عبر الـ pagination.

**`since_id` أكبر موفّر تكلفة على الإطلاق.** يضمن أن كل استطلاع يجلب الجديد فقط. بدونه ندفع مقابل نفس المنشورات مراراً.

---

## 5. Query Sandbox

```sql
CREATE TABLE query_tests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id         uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  query_version_id uuid NOT NULL REFERENCES query_versions(id) ON DELETE CASCADE,
  sample_size      int NOT NULL,               -- 10|25|50|100
  posts_returned   int NOT NULL DEFAULT 0,

  count_relevant      int NOT NULL DEFAULT 0,
  count_irrelevant    int NOT NULL DEFAULT 0,
  count_advertisement int NOT NULL DEFAULT 0,
  count_spam          int NOT NULL DEFAULT 0,
  count_unknown       int NOT NULL DEFAULT 0,

  precision_score numeric(5,4),                -- relevant / (total - unknown)
  noise_rate      numeric(5,4),
  units_consumed  int NOT NULL DEFAULT 0,      -- الاختبار ليس مجانياً
  cost_estimate   numeric(12,6),

  recommendations      jsonb,                  -- [{type,severity,message_ar,action}]
  keyword_contribution jsonb,                  -- {term:{matched,noise_rate}}
  passed          boolean,                     -- precision >= min_precision
  human_reviewed  boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'running',
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id)
);
CREATE INDEX ON query_tests (query_id, created_at DESC);

CREATE TABLE query_test_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id         uuid NOT NULL REFERENCES query_tests(id) ON DELETE CASCADE,
  x_post_id       text NOT NULL,
  text            text NOT NULL,
  author_username text,
  ai_label        text NOT NULL,
  ai_confidence   numeric(4,3),
  human_label     text,                        -- تصحيح المستخدم
  matched_terms   text[],
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**`keyword_contribution` هو قلب فائدة الـ Sandbox.** لا يكفي معرفة أن الدقة 60% — يجب معرفة **أي كلمة** هي السبب. هذا الحقل يحوّل النتيجة من رقم إلى إجراء قابل للتنفيذ.

---

## 6. Posts & Authors

```sql
CREATE TYPE post_status AS ENUM ('ingested','filtered_out','classified','duplicate','error');

CREATE TABLE authors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  x_author_id        text NOT NULL UNIQUE,
  username           text,
  display_name       text,
  description        text,
  profile_image_url  text,
  location           text,
  followers_count    integer,
  following_count    integer,
  tweet_count        integer,
  listed_count       integer,
  is_verified        boolean,
  verified_type      text,
  account_created_at timestamptz,

  -- إدارة الكاش
  cache_tier         text NOT NULL DEFAULT 'normal', -- normal|influencer|high_priority
  profile_fetched_at timestamptz,
  next_refresh_at    timestamptz,
  fetch_count        integer NOT NULL DEFAULT 0,
  fetch_failed_count integer NOT NULL DEFAULT 0,

  -- مقاييس مشتقة
  influence_score     numeric(5,2),
  relevant_post_count integer NOT NULL DEFAULT 0,
  total_post_count    integer NOT NULL DEFAULT 0,
  avg_engagement      numeric(12,2),
  negative_ratio      numeric(5,4),
  programs_mentioned  uuid[],
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  is_flagged          boolean NOT NULL DEFAULT false,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON authors (next_refresh_at) WHERE next_refresh_at IS NOT NULL;
CREATE INDEX ON authors (influence_score DESC NULLS LAST);
CREATE INDEX ON authors (followers_count DESC NULLS LAST);
CREATE INDEX ON authors USING gin (username gin_trgm_ops);

-- لقطات تاريخية لرصد نمو المتابعين
CREATE TABLE author_snapshots (
  id              bigserial PRIMARY KEY,
  author_id       uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  followers_count integer,
  following_count integer,
  tweet_count     integer,
  captured_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON author_snapshots (author_id, captured_at DESC);
```

```sql
-- مقسّم شهرياً
CREATE TABLE posts (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  x_post_id         text NOT NULL,             -- مفتاح التفرّد الحقيقي
  author_id         uuid REFERENCES authors(id),
  x_author_id       text NOT NULL,             -- محفوظ حتى قبل جلب الملف

  text              text NOT NULL,
  text_normalized   text NOT NULL,             -- للمطابقة وكشف التكرار
  lang              text,
  posted_at         timestamptz NOT NULL,      -- مفتاح التقسيم
  url               text,

  conversation_id     text,
  in_reply_to_post_id text,
  referenced_post_id  text,
  reference_type      text,                    -- replied_to|quoted|retweeted
  is_reply            boolean NOT NULL DEFAULT false,
  is_quote            boolean NOT NULL DEFAULT false,
  is_repost           boolean NOT NULL DEFAULT false,

  hashtags  text[],
  mentions  text[],
  urls      text[],
  has_media boolean NOT NULL DEFAULT false,

  -- المصدر والإسناد → يجيب على "لماذا جمعنا هذا؟"
  source              text NOT NULL DEFAULT 'x',
  query_id            uuid REFERENCES queries(id) ON DELETE SET NULL,
  query_version_id    uuid REFERENCES query_versions(id) ON DELETE SET NULL,
  matched_keywords    text[],
  matched_keyword_ids uuid[],

  -- إزالة التكرار
  content_hash    bytea NOT NULL,              -- sha256(text_normalized)
  simhash         bigint,                      -- للتكرار التقريبي
  duplicate_of_id uuid,
  duplicate_type  text,                        -- exact|near|campaign

  status        post_status NOT NULL DEFAULT 'ingested',
  filter_reason text,                          -- سبب رفض Stage 1
  risk_score    smallint,                      -- 0-100
  risk_factors  jsonb,                         -- شرح قابل للقراءة

  collected_at  timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  -- امتثال
  is_redacted   boolean NOT NULL DEFAULT false,
  redacted_at   timestamptz,

  PRIMARY KEY (id, posted_at),
  UNIQUE (x_post_id, posted_at)                -- يمنع التكرار الحرفي
) PARTITION BY RANGE (posted_at);

CREATE TABLE posts_2026_08 PARTITION OF posts
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX ON posts (posted_at DESC);
CREATE INDEX ON posts (query_id, posted_at DESC);
CREATE INDEX ON posts (author_id, posted_at DESC);
CREATE INDEX ON posts (status, posted_at DESC);
CREATE INDEX ON posts (content_hash);
CREATE INDEX ON posts (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX ON posts (risk_score DESC) WHERE risk_score >= 70;
CREATE INDEX ON posts USING gin (text_normalized gin_trgm_ops);
CREATE INDEX ON posts USING gin (hashtags);
```

```sql
-- المقاييس منفصلة: تتغيّر بمرور الوقت بينما النص ثابت
CREATE TABLE post_metrics (
  post_id          uuid NOT NULL,
  posted_at        timestamptz NOT NULL,
  like_count       integer NOT NULL DEFAULT 0,
  repost_count     integer NOT NULL DEFAULT 0,
  reply_count      integer NOT NULL DEFAULT 0,
  quote_count      integer NOT NULL DEFAULT 0,
  bookmark_count   integer,
  impression_count integer,
  engagement_total integer GENERATED ALWAYS AS
    (like_count + repost_count + reply_count + quote_count) STORED,
  velocity_per_hour numeric(10,2),             -- سرعة الانتشار → Risk Score
  captured_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, posted_at, captured_at)
) PARTITION BY RANGE (posted_at);

-- المتجهات في جدول منفصل
CREATE TABLE post_embeddings (
  post_id    uuid PRIMARY KEY,
  posted_at  timestamptz NOT NULL,
  embedding  vector(1024) NOT NULL,
  model      text NOT NULL,                    -- لمعرفة ما يحتاج إعادة حساب
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON post_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**لماذا `post_embeddings` منفصل؟** متجه بـ 1024 بُعد ≈ 4KB. دمجه في `posts` يضخّم كل صف ويبطئ كل استعلام لا يحتاج المتجه — وهي الغالبية العظمى. الفصل يُبقي `posts` سريعاً.

---

## 7. Classification & Sentiment

```sql
CREATE TYPE relevance_label AS ENUM
  ('relevant','irrelevant','advertisement','spam','unknown');
CREATE TYPE intent_label AS ENUM
  ('complaint','inquiry','suggestion','praise','news','experience',
   'warning','issue','request','other');
CREATE TYPE sentiment_label AS ENUM
  ('very_positive','positive','neutral','negative','very_negative');

CREATE TABLE post_classifications (
  post_id     uuid NOT NULL,
  posted_at   timestamptz NOT NULL,
  relevance   relevance_label NOT NULL,
  relevance_confidence numeric(4,3),
  intent      intent_label,
  intent_confidence numeric(4,3),
  program_id  uuid REFERENCES programs(id),
  service_id  uuid REFERENCES services(id),
  topic_id    uuid REFERENCES topics(id),      -- level 1
  subtopic_id uuid REFERENCES topics(id),      -- level 2
  issue_id    uuid REFERENCES topics(id),      -- level 3
  -- إسناد المرحلة: أساس تحليل تكلفة وجودة الـ AI
  stage          smallint NOT NULL,            -- 1=rule 2=cheap 3=llm
  model          text,
  llm_tokens_in  integer,
  llm_tokens_out integer,
  llm_cost       numeric(12,8),
  human_corrected boolean NOT NULL DEFAULT false,
  corrected_by    uuid REFERENCES users(id),
  corrected_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, posted_at)
) PARTITION BY RANGE (posted_at);
CREATE INDEX ON post_classifications (relevance, posted_at DESC);
CREATE INDEX ON post_classifications (program_id, posted_at DESC);
CREATE INDEX ON post_classifications (issue_id, posted_at DESC);

CREATE TABLE post_sentiments (
  post_id    uuid NOT NULL,
  posted_at  timestamptz NOT NULL,
  label      sentiment_label NOT NULL,
  score      numeric(5,4),                     -- -1.0 .. +1.0
  confidence numeric(4,3),
  stage      smallint NOT NULL,
  model      text,
  human_corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, posted_at)
) PARTITION BY RANGE (posted_at);
```

**`stage` و `llm_cost` ليسا حقلين إداريين.** هما ما يسمح بقياس: كم منشوراً وصل Stage 3؟ كم كلّفنا؟ هل تحسّن Stage 2 كفاية لتقليل ذلك؟ بدونهما لا يمكن تحسين هرم التكلفة إطلاقاً.

---

## 8. Deduplication & Campaign Detection

```sql
CREATE TABLE duplicate_clusters (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  representative_post_id uuid NOT NULL,
  cluster_type           text NOT NULL,        -- exact|near|campaign
  post_count             integer NOT NULL DEFAULT 1,
  author_count           integer NOT NULL DEFAULT 1,
  -- إشارات الحملة المنظّمة
  is_campaign_suspected  boolean NOT NULL DEFAULT false,
  campaign_score         numeric(5,2),
  time_window_minutes    int,
  first_seen_at          timestamptz NOT NULL,
  last_seen_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE duplicate_members (
  cluster_id uuid NOT NULL REFERENCES duplicate_clusters(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL,
  posted_at  timestamptz NOT NULL,
  similarity numeric(5,4),
  PRIMARY KEY (cluster_id, post_id)
);
```

**التمييز مهم:** شخص واحد يكرر شكواه 5 مرات = ضجيج يُدمج. خمسون حساباً تنشر نفس النص خلال 10 دقائق = **إشارة استخباراتية** تستحق تنبيهاً فورياً. `author_count` مقابل `post_count` هو ما يفرّق بينهما.

---

## 9. Rollups — أساس الأداء

```sql
-- كل مخططات لوحة التحكم تقرأ من هنا، لا من posts
CREATE TABLE mention_metrics_hourly (
  bucket     timestamptz NOT NULL,             -- بداية الساعة
  program_id uuid,
  service_id uuid,
  topic_id   uuid,
  total_posts      integer NOT NULL DEFAULT 0,
  relevant_posts   integer NOT NULL DEFAULT 0,
  irrelevant_posts integer NOT NULL DEFAULT 0,
  ad_posts         integer NOT NULL DEFAULT 0,
  spam_posts       integer NOT NULL DEFAULT 0,
  positive_count   integer NOT NULL DEFAULT 0,
  neutral_count    integer NOT NULL DEFAULT 0,
  negative_count   integer NOT NULL DEFAULT 0,
  complaint_count  integer NOT NULL DEFAULT 0,
  inquiry_count    integer NOT NULL DEFAULT 0,
  unique_authors   integer NOT NULL DEFAULT 0,
  influencer_posts integer NOT NULL DEFAULT 0,
  total_engagement bigint  NOT NULL DEFAULT 0,
  max_risk_score   smallint,
  avg_risk_score   numeric(5,2),
  PRIMARY KEY (bucket, program_id, service_id, topic_id)
) PARTITION BY RANGE (bucket);

CREATE TABLE mention_metrics_daily (LIKE mention_metrics_hourly INCLUDING ALL);

-- خطوط أساس موسمية لكشف الارتفاعات
CREATE TABLE metric_baselines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type   text NOT NULL,                  -- program|service|topic|global
  scope_id     uuid,
  hour_of_week smallint NOT NULL,              -- 0..167 — موسمية أسبوعية
  metric       text NOT NULL,                  -- total|negative|complaints
  mean_value   numeric(12,4) NOT NULL,
  stddev_value numeric(12,4),
  mad_value    numeric(12,4),                  -- انحراف مطلق وسيط (قوي ضد الشواذ)
  ewma_value   numeric(12,4),
  sample_count integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, hour_of_week, metric)
);
```

**`hour_of_week` بدل `hour_of_day` قرار مقصود.** حجم النقاش الساعة 10 صباح الأحد يختلف جوهرياً عنه الساعة 10 صباح الجمعة. خط أساس يتجاهل يوم الأسبوع سيُطلق إنذارات كاذبة كل أحد وسيفوّت ارتفاعات حقيقية في العطلة.

---

## 10. Cost & Budget

```sql
CREATE TYPE api_purpose AS ENUM ('collection','test','author_refresh','manual','backfill');

-- مقسّم شهرياً — كل طلب مُسجَّل
CREATE TABLE api_usage (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  provider    text NOT NULL DEFAULT 'x',
  endpoint    text NOT NULL,
  purpose     api_purpose NOT NULL,
  query_id         uuid REFERENCES queries(id) ON DELETE SET NULL,
  query_version_id uuid,
  program_id       uuid REFERENCES programs(id) ON DELETE SET NULL,
  test_id          uuid,
  requests_count  integer NOT NULL DEFAULT 1,
  units_consumed  integer NOT NULL DEFAULT 0,  -- عدد المنشورات = وحدة الحصة
  posts_new       integer NOT NULL DEFAULT 0,
  posts_duplicate integer NOT NULL DEFAULT 0,
  unit_price      numeric(12,8) NOT NULL,      -- من settings وقت التنفيذ
  cost_estimate   numeric(14,8) NOT NULL DEFAULT 0,
  http_status     integer,
  error_code      text,
  error_message   text,
  latency_ms      integer,
  rate_limit_remaining integer,
  rate_limit_reset_at  timestamptz,
  mode         text NOT NULL DEFAULT 'live',   -- live|demo|dry_run
  triggered_by uuid REFERENCES users(id),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ON api_usage (query_id, occurred_at DESC);
CREATE INDEX ON api_usage (program_id, occurred_at DESC);
CREATE INDEX ON api_usage (purpose, occurred_at DESC);

-- الطلبات المرفوضة — لا تقل قيمة تحليلية عن المنفَّذة
CREATE TABLE api_denials (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  query_id      uuid,
  program_id    uuid,
  purpose       api_purpose NOT NULL,
  reason        text NOT NULL,   -- KILL_SWITCH|MONTHLY|DAILY|HOURLY|PROGRAM|QUERY
  scope         text,
  current_usage numeric(14,4),
  limit_value   numeric(14,4),
  requested_units integer
);
```

```sql
CREATE TYPE budget_scope  AS ENUM ('global','program','query','purpose');
CREATE TYPE budget_period AS ENUM ('hour','day','month');

CREATE TABLE api_budgets (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope    budget_scope NOT NULL,
  scope_id uuid,                                -- NULL للنطاق العام
  period   budget_period NOT NULL,
  -- حدّان مستقلان: بالوحدات وبالمال — أيهما نفد أولاً يوقف
  unit_limit    integer,
  cost_limit    numeric(12,4),
  is_hard_limit boolean NOT NULL DEFAULT true,  -- true=يوقف · false=ينبّه فقط
  alert_thresholds smallint[] NOT NULL DEFAULT '{50,70,80,90,100}',
  is_active      boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id),
  UNIQUE (scope, scope_id, period, effective_from)
);

-- Redis هو المصدر السريع، هذا مصدر الحقيقة
CREATE TABLE budget_counters (
  scope        budget_scope NOT NULL,
  scope_id     uuid,
  period       budget_period NOT NULL,
  period_start timestamptz NOT NULL,
  units_used    integer NOT NULL DEFAULT 0,
  cost_used     numeric(14,6) NOT NULL DEFAULT 0,
  requests_used integer NOT NULL DEFAULT 0,
  last_threshold_alerted smallint,              -- يمنع تكرار تنبيه نفس العتبة
  reconciled_at timestamptz,
  PRIMARY KEY (scope, scope_id, period, period_start)
);

CREATE TABLE kill_switches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL,                   -- global|program|query|source
  target_id    uuid,
  is_active    boolean NOT NULL DEFAULT true,
  reason       text NOT NULL,                   -- إجباري
  activated_by uuid NOT NULL REFERENCES users(id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  deactivated_by uuid REFERENCES users(id),
  deactivated_at timestamptz
);
CREATE UNIQUE INDEX ON kill_switches
  (scope, COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;

CREATE TABLE cost_recommendations (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type     text NOT NULL,  -- add_negative|split_query|disable_query|reduce_polling|narrow_scope
  severity text NOT NULL,  -- info|warning|critical
  query_id   uuid REFERENCES queries(id) ON DELETE CASCADE,
  program_id uuid REFERENCES programs(id) ON DELETE CASCADE,
  title_ar  text NOT NULL,
  detail_ar text NOT NULL,
  evidence  jsonb NOT NULL,                     -- الأرقام الداعمة
  suggested_action jsonb,                       -- قابل للتطبيق بضغطة
  estimated_saving_units integer,
  estimated_saving_cost  numeric(12,4),
  status     text NOT NULL DEFAULT 'pending',   -- pending|applied|dismissed
  applied_by uuid REFERENCES users(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**نقطة جوهرية:** `unit_price` مُخزَّن في **كل صف** من `api_usage`، وليس محسوباً وقت العرض. إذا تغيّر سعر باقة X الشهر القادم، تبقى التقارير التاريخية صحيحة. حساب التكلفة وقت العرض من سعر حالي هو خطأ يفسد كل البيانات التاريخية بصمت.

---

## 11. Detection: Spikes, Emerging Topics, Incidents

```sql
CREATE TABLE spikes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type  text NOT NULL,                   -- program|service|topic|global
  scope_id    uuid,
  metric      text NOT NULL,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,
  observed_value numeric(12,2) NOT NULL,
  baseline_value numeric(12,2) NOT NULL,
  growth_pct     numeric(10,2) NOT NULL,       -- +660.00
  z_score        numeric(8,3),
  severity       text NOT NULL,                -- low|medium|high|critical
  -- مقارنات متعددة النوافذ
  vs_previous_hour numeric(10,2),
  vs_24h_avg       numeric(10,2),
  vs_7d_avg        numeric(10,2),
  vs_30d_avg       numeric(10,2),
  incident_id      uuid,
  is_acknowledged  boolean NOT NULL DEFAULT false
);
CREATE INDEX ON spikes (detected_at DESC);

CREATE TABLE emerging_terms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term            text NOT NULL,
  term_normalized text NOT NULL,
  term_type       text NOT NULL,               -- ngram|hashtag|phrase|entity
  program_id      uuid REFERENCES programs(id),
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  frequency             integer NOT NULL DEFAULT 0,
  frequency_prev_period integer NOT NULL DEFAULT 0,
  growth_pct      numeric(10,2),
  unique_authors  integer NOT NULL DEFAULT 0,
  sample_post_ids uuid[],
  centroid        vector(1024),
  status          text NOT NULL DEFAULT 'pending', -- pending|approved|ignored|blocked
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  created_keyword_id uuid REFERENCES keywords(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term_normalized, program_id)
);
CREATE INDEX ON emerging_terms (status, growth_pct DESC);
```

```sql
CREATE TYPE incident_status AS ENUM
  ('new','investigating','monitoring','resolved','false_positive');

CREATE TABLE incidents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference  text NOT NULL UNIQUE,             -- INC-2026-0042
  title_ar   text NOT NULL,
  summary_ar text,
  program_id uuid REFERENCES programs(id),
  service_id uuid REFERENCES services(id),
  topic_id   uuid REFERENCES topics(id),
  status     incident_status NOT NULL DEFAULT 'new',
  severity   text NOT NULL,                    -- low|medium|high|critical
  started_at  timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  peak_at     timestamptz,
  resolved_at timestamptz,
  duration_minutes integer,
  current_volume integer NOT NULL DEFAULT 0,
  peak_volume    integer NOT NULL DEFAULT 0,
  total_volume   integer NOT NULL DEFAULT 0,
  unique_authors integer NOT NULL DEFAULT 0,
  negative_ratio numeric(5,4),
  max_risk_score smallint,
  total_reach    bigint,
  -- الذاكرة المؤسسية
  centroid        vector(1024),                -- للمطابقة مع حوادث مستقبلية
  root_cause      text,
  resolution      text,
  lessons_learned text,
  -- الارتباط
  correlated_ticket_growth_pct numeric(10,2),
  correlated_event_id uuid,
  correlated_news_id  uuid,
  confidence_score numeric(5,2),               -- ثقة أن هذا حادث حقيقي
  detection_method text NOT NULL,              -- auto_spike|auto_cluster|manual
  assigned_to uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON incidents (status, detected_at DESC);
CREATE INDEX ON incidents USING hnsw (centroid vector_cosine_ops);

CREATE TABLE incident_posts (
  incident_id     uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  post_id         uuid NOT NULL,
  posted_at       timestamptz NOT NULL,
  relevance_score numeric(4,3),
  is_key_post     boolean NOT NULL DEFAULT false,
  added_by        text NOT NULL DEFAULT 'auto',
  PRIMARY KEY (incident_id, post_id)
);

CREATE TABLE incident_timeline (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_type  text NOT NULL,  -- detected|escalated|status_change|note|volume_peak|alert_sent|resolved
  description_ar text NOT NULL,
  metadata    jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id)
);

-- Incident Memory
CREATE TABLE incident_similarities (
  incident_id         uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  similar_incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  similarity   numeric(5,4) NOT NULL,
  match_basis  text NOT NULL,                  -- centroid|topic|keywords|combined
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, similar_incident_id),
  CHECK (incident_id <> similar_incident_id)
);
```

---

## 12. Alerts

```sql
CREATE TABLE alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  program_id  uuid REFERENCES programs(id) ON DELETE CASCADE,
  -- الشروط كـ JSONB: منطق مركّب بلا انفجار أعمدة
  conditions  jsonb NOT NULL,
  severity    text NOT NULL DEFAULT 'medium',
  -- منع الإغراق
  cooldown_minutes     int NOT NULL DEFAULT 30,
  dedup_window_minutes int NOT NULL DEFAULT 20,
  dedup_key_template   text,        -- 'issue:{issue_id}' → تجميع حسب المشكلة
  max_alerts_per_hour  int NOT NULL DEFAULT 6,
  channel_ids        uuid[] NOT NULL DEFAULT '{}',
  recipient_user_ids uuid[] DEFAULT '{}',
  quiet_hours  jsonb,               -- {"start":"23:00","end":"06:00","tz":"Asia/Riyadh"}
  last_triggered_at timestamptz,
  trigger_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id)
);
```

مثال `conditions`:
```json
{ "op": "OR", "children": [
  { "metric": "negative_mentions", "window": "1h", "operator": ">", "value": 30 },
  { "metric": "growth_pct",        "window": "1h", "operator": ">", "value": 200 },
  { "metric": "risk_score",                        "operator": ">", "value": 85 },
  { "metric": "author_followers",                  "operator": ">", "value": 100000 },
  { "metric": "keyword_appeared",  "value": "انقطاع الخدمة" },
  { "metric": "incident_started" }
]}
```

```sql
CREATE TABLE notification_channels (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text NOT NULL,
  type   text NOT NULL,                        -- email|teams|telegram|webhook|inapp
  config jsonb NOT NULL,                       -- لا أسرار خام: مراجع لـ ENV
  is_active boolean NOT NULL DEFAULT true,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id     uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  spike_id    uuid REFERENCES spikes(id) ON DELETE SET NULL,
  title_ar    text NOT NULL,
  message_ar  text NOT NULL,
  severity    text NOT NULL,
  program_id  uuid REFERENCES programs(id),
  -- التجميع: تنبيه واحد يمثّل عدة أحداث
  dedup_key        text,
  grouped_count    integer NOT NULL DEFAULT 1,
  grouped_post_ids uuid[],
  evidence         jsonb NOT NULL,             -- الأرقام التي أطلقت التنبيه
  status           text NOT NULL DEFAULT 'new',
  acknowledged_by  uuid REFERENCES users(id),
  acknowledged_at  timestamptz,
  triggered_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON alerts (triggered_at DESC);
CREATE INDEX ON alerts (dedup_key, triggered_at DESC);
CREATE INDEX ON alerts (status, severity) WHERE status = 'new';

CREATE TABLE alert_deliveries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id   uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES notification_channels(id),
  status     text NOT NULL,                    -- pending|sent|failed
  attempts   integer NOT NULL DEFAULT 0,
  error_message text,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**`dedup_key` هو ما يحقق المتطلب §31.** بدل 50 تنبيهاً، الأول ينشئ التنبيه، والباقي خلال `dedup_window_minutes` يزيد `grouped_count` ويُلحق `post_id`. الرسالة تصبح: «تم رصد 50 منشوراً متعلقاً بمشكلة توثيق العقد خلال آخر 20 دقيقة».

---

## 13. Reports

```sql
CREATE TABLE report_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  report_type text NOT NULL,   -- monitoring_summary|program|incident|cost|executive
  cron_expression text NOT NULL,                -- '0 */2 * * *' = كل ساعتين
  timezone     text NOT NULL DEFAULT 'Asia/Riyadh',
  period_hours integer NOT NULL DEFAULT 2,
  filters  jsonb,
  sections text[] NOT NULL,                     -- أقسام قابلة للاختيار
  formats  text[] NOT NULL DEFAULT '{xlsx,html}',
  include_executive_summary  boolean NOT NULL DEFAULT true,
  include_ai_recommendations boolean NOT NULL DEFAULT false,
  channel_ids      uuid[] NOT NULL DEFAULT '{}',
  recipient_emails text[],
  is_active   boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id)
);

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid REFERENCES report_schedules(id) ON DELETE SET NULL,
  report_type text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'generating',
  data_snapshot jsonb,          -- الأرقام المستخدمة — لإعادة الإنتاج والتدقيق
  executive_summary_ar text,
  summary_model text,
  summary_is_ai_generated boolean NOT NULL DEFAULT true,   -- وسم إلزامي
  recommendations jsonb,
  file_paths    jsonb,          -- {"xlsx":"...","html":"...","pdf":"..."}
  generation_ms integer,
  error_message text,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  generated_by  uuid REFERENCES users(id)
);
```

**`data_snapshot` ضروري.** التقرير الذي يقول «ارتفاع 140%» يجب أن يحتفظ بالأرقام التي أنتجت هذه النسبة. بدونه لا يمكن التحقق من التقرير لاحقاً، ولا إثبات أن الملخص لم يهلوس.

---

## 14. Historical Analysis

```sql
CREATE TABLE historical_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  source_type text NOT NULL,   -- customer_service|connect_listening|tickets
  file_name   text NOT NULL,
  file_size_bytes bigint,
  file_path   text,
  column_mapping jsonb,        -- {"text":"Message","date":"CreatedAt"}
  total_rows     integer,
  processed_rows integer NOT NULL DEFAULT 0,
  valid_rows     integer NOT NULL DEFAULT 0,
  duplicate_rows integer NOT NULL DEFAULT 0,
  status  text NOT NULL DEFAULT 'uploaded',
  -- uploaded|mapping|normalizing|embedding|clustering|labeling|ready|failed
  progress_pct  numeric(5,2) NOT NULL DEFAULT 0,
  current_stage text,
  error_message text,
  -- حوكمة الخصوصية
  contains_pii boolean NOT NULL DEFAULT true,
  data_class   text NOT NULL DEFAULT 'internal',
  embedding_provider text,
  llm_calls_used integer NOT NULL DEFAULT 0,
  llm_cost   numeric(12,6) NOT NULL DEFAULT 0,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id)
);

CREATE TABLE historical_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id  uuid NOT NULL REFERENCES historical_imports(id) ON DELETE CASCADE,
  row_number integer,
  text            text NOT NULL,
  text_normalized text NOT NULL,
  content_hash    bytea NOT NULL,
  channel     text,
  occurred_at timestamptz,
  metadata    jsonb,
  embedding   vector(1024),
  cluster_id  uuid,
  is_duplicate boolean NOT NULL DEFAULT false,
  is_noise     boolean NOT NULL DEFAULT false, -- HDBSCAN noise bucket
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON historical_messages (import_id, cluster_id);
CREATE INDEX ON historical_messages (import_id, content_hash);
CREATE INDEX ON historical_messages USING hnsw (embedding vector_cosine_ops);

CREATE TABLE historical_clusters (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES historical_imports(id) ON DELETE CASCADE,
  cluster_label integer NOT NULL,
  size      integer NOT NULL,
  centroid  vector(1024),
  cohesion  numeric(5,4),
  -- مخرجات LLM
  suggested_program  text,
  suggested_service  text,
  suggested_topic    text,
  suggested_subtopic text,
  suggested_issue    text,
  suggested_intent   text,
  common_phrases     text[],
  extracted_keywords text[],
  extracted_synonyms jsonb,
  extracted_misspellings jsonb,
  extracted_entities text[],
  sample_message_ids uuid[],
  medoid_message_id  uuid,
  llm_confidence     numeric(4,3),
  -- المراجعة البشرية
  review_status  text NOT NULL DEFAULT 'pending', -- pending|approved|merged|renamed|rejected
  merged_into_id uuid REFERENCES historical_clusters(id),
  final_topic_id uuid REFERENCES topics(id),
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  review_notes   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE taxonomy_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id     uuid REFERENCES historical_imports(id) ON DELETE CASCADE,
  proposed_tree jsonb NOT NULL,
  cluster_count integer,
  coverage_pct  numeric(5,2),                  -- نسبة الرسائل المغطاة بالشجرة
  status        text NOT NULL DEFAULT 'pending',
  applied_at    timestamptz,
  applied_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connect_import_candidates (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES historical_imports(id) ON DELETE CASCADE,
  term            text NOT NULL,
  term_normalized text NOT NULL,
  candidate_type  text NOT NULL,   -- keyword|phrase|hashtag|entity|noise|exclusion
  frequency       integer NOT NULL,
  sample_contexts text[],
  suggested_program_id   uuid REFERENCES programs(id),
  suggested_keyword_type keyword_type,
  noise_probability numeric(4,3),
  status  text NOT NULL DEFAULT 'pending',     -- pending|accepted|rejected
  created_keyword_id uuid REFERENCES keywords(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

---

## 15. Feedback Loops

```sql
CREATE TABLE ai_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid,
  posted_at    timestamptz,
  test_post_id uuid,
  feedback_type text NOT NULL,    -- relevance|intent|sentiment|topic|program
  ai_value      text NOT NULL,
  ai_confidence numeric(4,3),
  ai_stage      smallint,
  human_value   text NOT NULL,
  reason        text,
  post_text_snapshot text,        -- نسخة للتدريب حتى لو حُذف المنشور
  embedding     vector(1024),     -- يغذّي Stage 2 مباشرة
  used_in_training  boolean NOT NULL DEFAULT false,
  training_batch_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX ON ai_feedback (feedback_type, used_in_training);

-- "لماذا جمعنا هذا؟" → إجراء
CREATE TABLE keyword_feedback (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id   uuid,
  posted_at timestamptz,
  query_id  uuid REFERENCES queries(id) ON DELETE SET NULL,
  matched_keyword_id uuid REFERENCES keywords(id) ON DELETE SET NULL,
  matched_term text,
  action    text NOT NULL,        -- exclude_keyword|modify_query|ignore|mark_noise
  applied   boolean NOT NULL DEFAULT false,
  resulting_keyword_id uuid REFERENCES keywords(id),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users(id)
);
```

**`embedding` داخل `ai_feedback` مقصود:** يجعل إعادة تدريب المصنّف الرخيص (Stage 2) مجرد `SELECT` بلا إعادة حساب متجهات. حلقة التغذية الراجعة تصبح رخيصة — وبالتالي تُستخدم فعلاً بدل أن تبقى ميزة على الورق.

---

## 16. News, Events & Correlation

```sql
CREATE TABLE news_sources (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL,                          -- rss|api|scrape
  url  text NOT NULL,
  config      jsonb,
  program_ids uuid[],
  poll_interval_minutes int NOT NULL DEFAULT 30,
  is_active   boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE news_items (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  external_id text,
  title     text NOT NULL,
  summary   text,
  url       text NOT NULL,
  published_at timestamptz NOT NULL,
  program_ids  uuid[],
  topic_ids    uuid[],
  embedding    vector(1024),
  content_hash bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, content_hash)
);
CREATE INDEX ON news_items (published_at DESC);

CREATE TABLE official_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,  -- maintenance|new_service|policy_change|announcement|campaign|regulation
  title_ar       text NOT NULL,
  description_ar text,
  program_id uuid REFERENCES programs(id),
  service_id uuid REFERENCES services(id),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz,
  expected_impact text,                        -- low|medium|high
  reference_url   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id)
);
CREATE INDEX ON official_events (starts_at DESC);

CREATE TABLE correlations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  spike_id    uuid REFERENCES spikes(id) ON DELETE CASCADE,
  signal_type text NOT NULL,   -- news|official_event|ticket_volume|technical_incident
  signal_id   uuid,
  lag_minutes integer,         -- الخبر سبق الارتفاع بـ 30 دقيقة
  correlation_strength numeric(5,4),
  confidence     numeric(5,4),
  explanation_ar text,
  is_ai_generated boolean NOT NULL DEFAULT false,  -- وسم
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

---

## 17. Internal Data (schema معزول)

```sql
-- مستخدم DB منفصل. mip_api لا يملك USAGE على هذا الـ schema.
CREATE TABLE internal.ticket_metrics_hourly (
  bucket     timestamptz NOT NULL,
  program_id uuid,
  service_id uuid,
  category   text,
  ticket_count    integer NOT NULL DEFAULT 0,
  new_count       integer NOT NULL DEFAULT 0,
  escalated_count integer NOT NULL DEFAULT 0,
  avg_resolution_minutes numeric(10,2),
  channel    text,                             -- phone|email|chat|social
  PRIMARY KEY (bucket, program_id, service_id, category, channel)
);

CREATE TABLE internal.tickets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE,
  subject     text,
  body        text,                            -- لا يغادر هذا الـ schema أبداً
  category    text,
  program_id  uuid,
  service_id  uuid,
  channel     text,
  status      text,
  priority    text,
  created_at_source timestamptz NOT NULL,
  resolved_at timestamptz,
  data_class  text NOT NULL DEFAULT 'internal',
  ingested_at timestamptz NOT NULL DEFAULT now()
);
```

**قرار تصميمي مهم:** Correlation Engine يقرأ من `internal.ticket_metrics_hourly` فقط — أرقام مجمّعة، بلا نص. هذا كافٍ تماماً لكشف «ارتفعت التذاكر 180% بالتزامن مع ارتفاع منشورات X 220%»، ويلغي أي حاجة لتمرير محتوى التذاكر عبر النظام أو إلى أي مزود AI.

---

## 18. Settings, Audit & Retention

```sql
-- كل ما يجب ألا يكون hardcoded
CREATE TABLE settings (
  key            text PRIMARY KEY,
  value          jsonb NOT NULL,
  value_type     text NOT NULL,
  category       text NOT NULL,
  description_ar text,
  is_sensitive   boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id)
);

CREATE TABLE settings_history (
  id         bigserial PRIMARY KEY,
  key        text NOT NULL,
  old_value  jsonb,
  new_value  jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES users(id)
);
```

**المفاتيح الأساسية** — القيم أدناه **أمثلة أولية** يجب التحقق منها مقابل صفحة أسعار X الحالية قبل أي تشغيل حي:

```json
{
  "x_api.tier": "basic",

  "x_api.pricing": {
    "model": "subscription_with_quota",
    "monthly_price_usd": 200,
    "monthly_post_quota": 10000,
    "derived_unit_price_usd": 0.02,
    "note_ar": "قيم أولية — تُحدَّث من صفحة أسعار X. لا أرقام مثبتة في الكود."
  },

  "x_api.limits": {
    "search_recent_requests_per_15min": 60,
    "max_results_per_request": 100,
    "search_window_days": 7
  },

  "x_api.endpoints": {
    "search_recent": "/2/tweets/search/recent",
    "users_lookup":  "/2/users",
    "enabled": ["search_recent", "users_lookup"]
  },

  "x_api.fields": {
    "tweet.fields": ["id","text","created_at","author_id","lang",
                     "conversation_id","public_metrics","referenced_tweets","entities"],
    "user.fields":  ["id","username","name","description","profile_image_url",
                     "public_metrics","verified","created_at"],
    "expansions":   ["author_id"],
    "note_ar": "كل حقل إضافي = حجم أكبر. يُضبط من هنا لا من الكود."
  },

  "x_api.retention": {
    "raw_response_days": 7,
    "post_content_days": 365,
    "aggregates_days": null,
    "honor_deletion_requests": true
  },

  "author_cache.refresh_hours": { "normal": 168, "influencer": 24, "high_priority": 6 },

  "scoring.risk_weights": {
    "sentiment_negative": 0.20, "author_followers": 0.15,
    "engagement_velocity": 0.20, "engagement_total": 0.10,
    "sensitive_keywords": 0.15, "similar_volume_growth": 0.15,
    "is_influencer": 0.05
  },

  "scoring.influence_weights": {
    "followers_log": 0.25, "avg_engagement": 0.25,
    "relevant_post_count": 0.20, "reach_estimate": 0.15,
    "historical_consistency": 0.15
  },

  "classification.confidence_threshold_stage2": 0.85,
  "classification.min_precision_to_promote": 0.70,
  "alerts.default_dedup_window_minutes": 20,
  "detection.spike_z_threshold": 3.0,
  "detection.emerging_min_frequency": 15,

  "ai.providers": {
    "llm":       { "primary": "openai", "fallback": "local" },
    "embedding": { "primary": "local_bge_m3", "dimensions": 1024 }
  }
}
```

```sql
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users(id),
  user_email  text,             -- لقطة: يبقى مقروءاً بعد حذف المستخدم
  action      text NOT NULL,    -- query.update, budget.update, killswitch.activate
  entity_type text NOT NULL,
  entity_id   uuid,
  entity_label text,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  ip_address  inet,
  user_agent  text,
  request_id  uuid,
  severity    text NOT NULL DEFAULT 'info'     -- info|warning|critical
);
CREATE INDEX ON audit_log (occurred_at DESC);
CREATE INDEX ON audit_log (user_id, occurred_at DESC);
CREATE INDEX ON audit_log (entity_type, entity_id);
CREATE INDEX ON audit_log (action, occurred_at DESC);
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;   -- append-only
```

**الإجراءات الواجب تدقيقها إلزامياً:**
`query.create|update|promote|delete` · `budget.update` · `killswitch.activate|deactivate` · `keyword.create|update|delete` · `alert_rule.*` · `settings.update` · `user.*` · `role.*` · `data.export` · `data.delete` · `internal_data.access` · `taxonomy.apply` · `ai_provider.change`

```sql
CREATE TABLE retention_policies (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL UNIQUE,   -- posts|raw_responses|api_usage|logs|reports
  retention_days integer,        -- NULL = دائم
  action text NOT NULL,          -- delete|anonymize|archive|drop_partition
  legal_basis text,
  is_active   boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_deleted_count bigint,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- امتثال: منشورات حُذفت من X ويجب حذفها عندنا
CREATE TABLE compliance_redactions (
  id          bigserial PRIMARY KEY,
  x_post_id   text NOT NULL,
  x_author_id text,
  redaction_type text NOT NULL,  -- deleted|protected|suspended|withheld
  detected_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  action_taken text
);
```

---

## 19. الفهارس الحرجة — ملخص

| الاستعلام | الفهرس |
|---|---|
| Live Feed مع فلاتر | `posts (status, posted_at DESC)` + partition pruning |
| بحث نصي عربي جزئي | `gin (text_normalized gin_trgm_ops)` |
| منشورات مشابهة | `hnsw (post_embeddings.embedding vector_cosine_ops)` |
| مخططات لوحة التحكم | `mention_metrics_hourly` PK + partition pruning |
| ترتيب المؤثرين | `authors (influence_score DESC NULLS LAST)` |
| جدولة الاستطلاع | `queries (status, next_run_at) WHERE active AND NOT paused` |
| تحديث كاش الحسابات | `authors (next_refresh_at) WHERE NOT NULL` |
| تحليل التكلفة | `api_usage (query_id, occurred_at DESC)` |
| ذاكرة الحوادث | `hnsw (incidents.centroid)` |
| كشف التكرار | `posts (content_hash)` |
| مطابقة المشاكل المعروفة | `hnsw (topics.centroid)` |

---

## 20. صيانة التقسيمات

وظيفة `maintenance` يومية:
- تُنشئ تقسيمات الشهرين القادمين مسبقاً (فشل الإدراج بسبب تقسيم مفقود عطل صامت مكلف).
- تنفّذ `DROP PARTITION` للأقدم من سياسة الاحتفاظ.

**`DROP PARTITION` عملية لحظية. `DELETE` على ملايين الصفوف ليست كذلك.** هذا وحده سبب كافٍ لاعتماد التقسيم من اليوم الأول لا لاحقاً.

**الجداول المقسّمة:** `posts` · `post_metrics` · `post_classifications` · `post_sentiments` · `api_usage` · `mention_metrics_hourly`
