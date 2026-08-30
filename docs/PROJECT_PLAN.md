# Monitoring Intelligence Platform (MIP)

> منصة رصد وتحليل رقمي داخلية — Monitoring Intelligence + Early Warning + Decision Support
>
> **الحالة:** مرحلة التصميم (Design Phase) — لم يبدأ التنفيذ بعد
> **تاريخ الوثيقة:** 2026-08-27
> **الوثائق المرتبطة:** [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) · [X_API_STRATEGY.md](X_API_STRATEGY.md) · [AI_PIPELINE.md](AI_PIPELINE.md) · [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)

---

## 0. المبدأ الحاكم

المنصة ليست Social Listening Dashboard. الفرق الجوهري:

| Dashboard تقليدية | Monitoring Intelligence Platform |
|---|---|
| "هناك 500 منشور" | "ارتفاع 340% في فشل توثيق العقود خلال ساعتين، مدفوع بحسابين مؤثرين، وحدث مشابه في 12 May 2026 استمر 4 ساعات" |
| تعرض الأرقام | تجيب: ماذا حدث؟ هل هو طبيعي؟ من يتحدث؟ هل حدث سابقاً؟ ما الإجراء؟ كم كلّفنا اكتشافه؟ |
| تستهلك API بلا حساب | كل طلب يمر على بوابة ميزانية قبل التنفيذ |

**قاعدة ذهبية واحدة تحكم المشروع كله:**
> لا يوجد أي مسار في الكود يستطيع الوصول إلى X API إلا عبر `XApiGateway` واحد، ولا يستطيع `XApiGateway` تنفيذ أي طلب دون قرار `ALLOW` من `BudgetService`.

---

## 1. فهم المتطلبات — الخلاصة التنفيذية

### 1.1 المشكلة الحقيقية التي نحلها

ليست "كيف نرى تغريدات عن إيجار". المشكلة الحقيقية ثلاثية:

1. **مشكلة الدقة (Precision):** كلمة "إيجار" وحدها تجلب 90% إعلانات عقارية. الرصد الساذج عديم القيمة.
2. **مشكلة التكلفة (Cost):** بسعر ~$0.02/منشور، كل منشور غير مرتبط هو خسارة مالية مباشرة. **الدقة = المال.**
3. **مشكلة المعنى (Meaning):** الجمهور لا يكتب "مشكلة في توثيق العقد"، بل "العقد ما يتوثق" و"التوثيق واقف". القاموس يجب أن يُبنى من اللغة الفعلية لا من الافتراضات.

### 1.2 المعادلة المركزية للمشروع

```
Precision ↑  →  Cost per Relevant Post ↓  →  Coverage ↑ ضمن نفس الميزانية
```

هذه ليست ملاحظة جانبية — هي محرك كل قرار تصميمي في المنصة. Negative Keywords ليست ميزة تجميلية، هي **أداة توفير مالي مباشر**.

### 1.3 مصادر بناء الذكاء (بالترتيب الزمني)

| المصدر | الدور | المرحلة |
|---|---|---|
| **Connect Listening Export** | اكتشاف اللغة الفعلية للجمهور (عبارات، عامية، أخطاء إملائية، هاشتاقات) | إعداد أولي — Phase 1 |
| **300k رسالة خدمة عملاء** | بناء Taxonomy حقيقية (Services → Topics → Subtopics → Issues) عبر Clustering | Phase 3 |
| **X API (مباشر)** | الرصد التشغيلي المستمر | Phase 1 → مستمر |
| **News / RSS** | تفسير أسباب الارتفاعات | Phase 4 |
| **Internal Tickets** | تأكيد أن المشكلة حقيقية وليست ضجيج | Phase 4 |

**Connect Listening تُستخدم مرة واحدة في مرحلة الإعداد لبناء القاموس، ولا تُعتمد كمصدر رصد دائم.**

---

## 2. Architecture النهائية المقترحة

**القرار: Hybrid — Node.js/TypeScript للتشغيل + Python للذكاء.**

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web        React 19 + TypeScript + Vite + Tailwind    │
│                  RTL-first · Dark Mode · ECharts            │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST + SSE
┌───────────────────────────▼─────────────────────────────────┐
│  apps/api        Node 22 + TypeScript + Fastify             │
│                  Auth · RBAC · CRUD · Analytics Queries     │
│                  ★ XApiGateway  ★ BudgetService             │
└───────┬───────────────────┬─────────────────────┬───────────┘
        │                   │                     │
┌───────▼────────┐  ┌───────▼────────┐  ┌────────▼──────────┐
│ apps/worker    │  │  PostgreSQL 16 │  │  apps/ai          │
│ BullMQ Workers │  │  + pgvector    │  │  Python 3.12      │
│ Collect·Class. │  │  + partitions  │  │  FastAPI          │
│ Detect·Report  │  │                │  │  Embeddings       │
└───────┬────────┘  └────────────────┘  │  Clustering       │
        │                                │  Classification   │
┌───────▼────────┐                       │  LLM Abstraction  │
│  Redis 7       │                       └───────────────────┘
│  Queue·Cache   │
│  Budget Buckets│
│  Kill Switch   │
└────────────────┘
```

### 2.1 لماذا Hybrid وليس لغة واحدة؟

**ضد التوحيد على Node وحده:** تحليل 300k رسالة يتطلب UMAP + HDBSCAN + sentence-transformers. مكافئات JS لهذه المكتبات إما غير موجودة أو غير ناضجة. سنعيد اختراع العجلة بجودة أقل.

**ضد التوحيد على Python وحده:** الواجهة TypeScript. توحيد الأنواع (types) بين Frontend والـ API عبر حزمة مشتركة يوفّر فئة كاملة من الأخطاء. Fastify + BullMQ أنضج تشغيلياً لـ I/O-bound jobs (وهي غالبية عملنا).

**التكلفة المقبولة:** خدمتان بدل واحدة. مُدارة بـ Docker Compose، وحدود المسؤولية واضحة تماماً:
- `apps/ai` **لا يملك** اتصالاً بقاعدة البيانات الرئيسية للكتابة، ولا يعرف شيئاً عن X API.
- `apps/ai` خدمة **stateless**: تستقبل نصوصاً، تُرجع أرقاماً/تصنيفات/متجهات.
- كل منطق الأعمال والحالة في `apps/api` / `apps/worker`.

هذا يجعل استبدال `apps/ai` بالكامل (أو استضافته منفصلاً على GPU) عملية بلا ألم.

### 2.2 قرارات تقنية مثبتة

| القرار | الاختيار | السبب |
|---|---|---|
| ORM | **Drizzle ORM** | أقرب إلى SQL، يدعم partitioning و pgvector و raw analytics queries بلا مقاومة. Prisma يعاند في كل هذه النقاط. |
| Vector Store | **pgvector داخل PostgreSQL** | تجنّب خدمة إضافية (Qdrant/Pinecone). الحجم المتوقع (ملايين المتجهات) ضمن قدرة pgvector + HNSW index. |
| Charts | **Apache ECharts** | دعم RTL أفضل، أداء أعلى مع آلاف النقاط، وتشكيلة مخططات أوسع من Recharts. |
| Queue | **BullMQ + Redis** | Repeatable jobs، rate limiting مدمج، concurrency control، ولوحة مراقبة جاهزة. |
| Auth | **JWT قصير العمر + Refresh Token في httpOnly cookie** | منصة داخلية، لا حاجة لـ OAuth. جاهز للربط بـ Entra ID لاحقاً. |
| Time-series | **جداول Rollup مادية (hourly/daily)** | لا TimescaleDB. الاستعلامات التحليلية تقرأ من rollups لا من `posts`. |

**Folder Structure الكاملة:** انظر [ARCHITECTURE.md §3](ARCHITECTURE.md).

---

## 3. Data Flow — من X API حتى Dashboard

```
[1] Scheduler (BullMQ repeatable)
      │  يقرأ queries النشطة + polling tier لكل واحدة
      ▼
[2] BudgetService.authorize(query, estimated_units)
      │  فحص: kill_switch → monthly → daily → hourly → program → query
      ├── DENY ──► تسجيل السبب في api_denials + تخطي
      ▼ ALLOW
[3] XApiGateway.searchRecent(query, since_id, fields)
      │  DEMO_MODE؟ ──► mock fixtures
      │  DRY_RUN؟   ──► تسجيل "would run" + إرجاع فارغ
      ▼ LIVE
[4] X API → raw response
      │  تسجيل فوري في api_usage (posts_returned = quota units)
      │  تحديث since_id watermark للـ query
      ▼
[5] Ingestion: تطبيع + Deduplication
      │  Exact: post_id (ON CONFLICT DO NOTHING)
      │  Near:  simhash / normalized-text hash
      ▼
[6] Stage 1 — Rule Filter (0 تكلفة)
      │  negative keywords · ad patterns · spam heuristics · lang filter
      ├── مرفوض ──► posts.status = 'filtered_out' (يُحتفظ به لتحليل Noise)
      ▼ مقبول
[7] Stage 2 — Embedding + Cheap Classifier
      │  bge-m3 embedding → pgvector
      │  Logistic Regression فوق الـ embedding (مدرّب على ai_feedback)
      ├── confidence عالية ──► تصنيف نهائي
      ▼ confidence منخفضة (المنطقة الرمادية)
[8] Stage 3 — LLM (مُجمّع batch، ~5-10% فقط من المنشورات)
      │  تصنيف + sentiment + topic + issue
      ▼
[9] Enrichment
      │  Author Cache lookup/refresh · Risk Score · Influence Score
      ▼
[10] Rollup Aggregation (hourly)
      │  mention_metrics_hourly ← counts, sentiment, programs, topics
      ▼
[11] Detection Engines (مجدولة كل 5-15 دقيقة)
      │  Spike Detector (EWMA + seasonal baseline)
      │  Emerging Topics (n-grams جديدة + clustering)
      │  Incident Detector (spike + semantic cluster + sentiment)
      │  Incident Memory (تشابه مع حوادث سابقة عبر embeddings)
      │  Correlation Engine (X + tickets + news + official events)
      ▼
[12] Alert Engine
      │  تقييم alert_rules → Deduplication/Grouping → Channels
      ▼
[13] Dashboard / Live Feed / Reports
      │  يقرأ من rollups + posts (paginated, server-side filtered)
```

**نقطة حرجة:** الخطوات [6]→[8] هرم تكلفة. 100% من المنشورات تمر على [6] (مجاناً)، ~60% تصل [7] (رخيص جداً)، و~5-10% فقط تصل [8] (مكلف). تفاصيل في [AI_PIPELINE.md](AI_PIPELINE.md).

---

## 4. Modules

| # | Module | المسؤولية | لا يفعل |
|---|---|---|---|
| M1 | **Identity & RBAC** | مستخدمون، أدوار، صلاحيات، جلسات | أي منطق أعمال |
| M2 | **Program Registry** | البرامج والخدمات وشجرة الـ Taxonomy | الرصد |
| M3 | **Keyword Intelligence** | القواميس، المرادفات، الأخطاء الإملائية، Negative Keywords | بناء الاستعلام |
| M4 | **Query Engine** | بناء/تحويل/تقييم استعلامات X، التنسيخ (versioning) | تنفيذ الطلبات |
| M5 | **Query Sandbox** | اختبار الاستعلام على عينة + حساب Precision + توصيات | النشر للإنتاج |
| M6 | **★ Cost & Budget Engine** | Quota accounting، الميزانيات، Kill Switch، التنبؤ | جلب البيانات |
| M7 | **X Collector** | `XApiGateway` + watermarks + pagination + rate limits | التصنيف |
| M8 | **Author Cache** | ملفات الحسابات + Refresh Policy المتدرجة | تحليل التأثير |
| M9 | **Ingestion & Dedup** | التطبيع، Exact/Near/Campaign duplication | التصنيف |
| M10 | **Filtering Engine** | Stage 1 rule-based | AI |
| M11 | **Classification Engine** | Stage 2 + Stage 3 orchestration | استدعاء المزود مباشرة |
| M12 | **AI Provider Layer** | `AIProvider` / `EmbeddingProvider` interfaces | منطق أعمال |
| M13 | **Scoring Engine** | Risk Score، Influence Score (أوزان قابلة للتعديل) | التنبيه |
| M14 | **Detection Engine** | Spike، Emerging Topics، Incident، Incident Memory | الإرسال |
| M15 | **Correlation Engine** | ربط X + Tickets + News + Official Events | — |
| M16 | **Alert Engine** | القواعد، التقييم، التجميع، منع التكرار | قنوات الإرسال |
| M17 | **Notification Providers** | Email / Teams / Telegram / Webhook / In-App | تقرير من يُنبَّه |
| M18 | **Report Engine** | جدولة، تجميع، Excel/HTML/PDF، Executive Summary | — |
| M19 | **Historical Analysis** | استيراد 300k رسالة، Clustering، توليد Taxonomy | الرصد المباشر |
| M20 | **Connect Importer** | استيراد تقارير Listening → مرشّحات كلمات | — |
| M21 | **Feedback Loops** | تصحيح التصنيف + "لماذا جمعنا هذا؟" | إعادة التدريب المباشر |
| M22 | **News Collector** | RSS / News APIs | الربط |
| M23 | **Internal Data Connector** | تذاكر/بريد/محادثات (معزول أمنياً) | إرسال شيء خارجياً |
| M24 | **Audit & Logging** | سجل التدقيق + Logging مركزي | — |
| M25 | **Admin / Developer Console** | حالة النظام، الطوابير، الأخطاء | — |

**قاعدة:** M23 (البيانات الداخلية) معزول بحدود صلاحيات صارمة، ولا يُسمح لأي بيانات منه بمغادرة النظام إلى أي API خارجي إلا بتفعيل صريح موثّق. تفاصيل في [ARCHITECTURE.md §8](ARCHITECTURE.md).

---

## 5. Background Jobs

| Job | التكرار | يمس X API؟ | الأولوية |
|---|---|---|---|
| `collect:query` | حسب polling tier (5د / 30د / 6س) | ✅ عبر Budget Gate | عالية |
| `collect:author-refresh` | كل 15 دقيقة (batch) | ✅ عبر Budget Gate | متوسطة |
| `ingest:normalize-dedup` | مدفوع بالأحداث | ❌ | عالية |
| `classify:stage1` | مدفوع بالأحداث | ❌ | عالية |
| `classify:stage2-embed` | batch كل دقيقة | ❌ | عالية |
| `classify:stage3-llm` | batch كل 5 دقائق | ❌ | متوسطة |
| `score:risk` | كل 5 دقائق | ❌ | عالية |
| `score:influence` | يومياً | ❌ | منخفضة |
| `rollup:hourly` | كل ساعة :05 | ❌ | عالية |
| `detect:spike` | كل 10 دقائق | ❌ | حرجة |
| `detect:emerging-topics` | كل 30 دقيقة | ❌ | متوسطة |
| `detect:incident` | كل 10 دقائق | ❌ | حرجة |
| `detect:incident-memory` | عند إنشاء حادث | ❌ | متوسطة |
| `correlate:signals` | كل 15 دقيقة | ❌ | متوسطة |
| `alerts:evaluate` | كل 5 دقائق | ❌ | حرجة |
| `alerts:dispatch` | مدفوع بالأحداث | ❌ | حرجة |
| `reports:scheduled` | حسب cron لكل تقرير | ❌ | متوسطة |
| `budget:reconcile` | كل ساعة | ❌ | عالية |
| `budget:forecast` | كل 6 ساعات | ❌ | منخفضة |
| `cost:optimization-scan` | يومياً | ❌ | منخفضة |
| `news:fetch-rss` | كل 30 دقيقة | ❌ (مصادر أخرى) | منخفضة |
| `historical:process-import` | عند الطلب | ❌ | منخفضة |
| `retention:enforce` | يومياً 03:00 | ❌ | عالية |
| `compliance:redaction-sweep` | يومياً | ✅ (تحقق حذف) | عالية |

**5 وظائف فقط تمس X API.** كل واحدة منها تمر إجبارياً على `BudgetService`.

---

## 6. API Endpoints

قائمة كاملة في [ARCHITECTURE.md §5](ARCHITECTURE.md). الملخص حسب المجال:

```
/api/v1/auth/*                 login, refresh, logout, me
/api/v1/programs/*             CRUD + taxonomy tree
/api/v1/keywords/*             CRUD + bulk import + aliases + negatives
/api/v1/queries/*              CRUD + versions + compile + estimate
/api/v1/queries/:id/test       ★ Sandbox — العملية الوحيدة المسموح لها استهلاك API يدوياً
/api/v1/queries/:id/promote    نقل للإنتاج (يتطلب اختباراً ناجحاً)
/api/v1/posts/*                list (server-side filter) + detail + similar + why-collected
/api/v1/authors/*              list + detail + influencers ranking
/api/v1/topics/*               list + timeline + emerging + approve/ignore/block
/api/v1/incidents/*            list + detail + timeline + status + similar-history
/api/v1/alerts/*               rules CRUD + alert feed + acknowledge
/api/v1/reports/*              schedules CRUD + run-now + download
/api/v1/cost/*                 ★ usage, budgets, forecast, per-query analytics, optimization
/api/v1/cost/kill-switch       ★ POST — إيقاف فوري (global / program / query)
/api/v1/historical/*           imports + clusters + taxonomy suggestions + approve
/api/v1/connect-import/*       رفع تقرير Listening + استخراج المرشحات
/api/v1/feedback/*             تصحيح تصنيف + ملاحظات الكلمات
/api/v1/events/*               الأحداث الرسمية اليدوية
/api/v1/news/*                 مصادر + عناصر
/api/v1/settings/*             X API pricing, limits, retention, scoring weights
/api/v1/admin/*                system health, queues, audit log, users
/api/v1/stream/live            SSE — Live Feed
```

---

## 7. صفحات الواجهة

| # | الصفحة | المسار | Phase | الدور المسموح |
|---|---|---|---|---|
| 1 | Dashboard الرئيسية | `/` | 1 | الجميع |
| 2 | Live Monitoring | `/live` | 1 | الجميع |
| 3 | Monitoring Wall | `/wall` | 2 | الجميع (شاشة كبيرة) |
| 4 | Programs | `/programs` | 1 | Admin, Supervisor |
| 5 | Program Dashboard | `/programs/:id` | 2 | الجميع |
| 6 | **Keyword Intelligence** | `/keywords` | 1 | Admin, Supervisor, Analyst |
| 7 | **Query Builder** | `/queries/builder` | 1 | Admin, Supervisor |
| 8 | **Query Sandbox** | `/queries/:id/test` | 1 | Admin, Supervisor |
| 9 | Query List & Versions | `/queries` | 1 | Admin, Supervisor |
| 10 | **★ API Cost Center** | `/cost` | 1 | Admin, Supervisor |
| 11 | Query Consumption Analytics | `/cost/queries` | 1 | Admin, Supervisor |
| 12 | Cost Optimization | `/cost/optimization` | 2 | Admin |
| 13 | Post Detail (drawer) | `/posts/:id` | 1 | الجميع |
| 14 | Influencers | `/influencers` | 2 | الجميع |
| 15 | Influencer Card | `/influencers/:id` | 2 | الجميع |
| 16 | Topics | `/topics` | 2 | الجميع |
| 17 | Topic Timeline | `/topics/:id` | 3 | الجميع |
| 18 | Emerging Topics | `/topics/emerging` | 3 | Admin, Supervisor, Analyst |
| 19 | Incidents | `/incidents` | 3 | الجميع |
| 20 | Incident Detail | `/incidents/:id` | 3 | الجميع |
| 21 | Alerts | `/alerts` | 2 | الجميع |
| 22 | Alert Rules | `/alerts/rules` | 2 | Admin, Supervisor |
| 23 | Report Center | `/reports` | 2 | Admin, Supervisor |
| 24 | Historical Analysis | `/historical` | 3 | Admin, Analyst |
| 25 | Taxonomy Review | `/historical/taxonomy` | 3 | Admin, Analyst |
| 26 | Connect Import | `/connect-import` | 1 | Admin, Analyst |
| 27 | Official Events | `/events` | 4 | Admin, Supervisor |
| 28 | News | `/news` | 4 | الجميع |
| 29 | Ask (NL Search) | `/ask` | 4 | الجميع |
| 30 | Settings | `/settings` | 1 | Admin |
| 31 | Users & Roles | `/settings/users` | 1 | Admin |
| 32 | Audit Log | `/settings/audit` | 1 | Admin |
| 33 | **Developer Console** | `/admin/system` | 1 | Admin |

---

## 8. نقاط التحكم بالتكلفة (Cost Control Points)

سبع طبقات دفاع، بالترتيب من الأعلى للأدنى:

```
L0  ENV Flag             LIVE_X_API=false  → استحالة فيزيائية للاتصال
L1  Kill Switch          Redis flag، يُفحص في كل طلب، global/program/query/source
L2  Budget Gate          ALLOW/DENY قبل كل طلب — monthly → daily → hourly → program → query
L3  Query Gating         لا يصل استعلام للإنتاج قبل اختبار Sandbox بنجاح (precision ≥ العتبة)
L4  Request Shaping      since_id watermark · max_results tuning · page caps · field selection
L5  Polling Tiers        hot/warm/cold — لا يُستطلع كل استعلام بنفس الوتيرة
L6  Precision Feedback   Cost per Relevant Post → Optimization Engine → توصيات آلية
```

**المقاييس المطلوبة على Dashboard:**
- `Spent Today` / `Spent This Month` / `Remaining Budget`
- `Projected Month Cost` (تنبؤ خطي بمعدل الاستهلاك الحالي)
- `Cost per Relevant Post` = التكلفة ÷ عدد المنشورات المصنّفة `relevant`
- `Cost per Detected Issue` = التكلفة ÷ عدد الحوادث/المشاكل المكتشفة
- `Noise %` لكل استعلام = المنشورات غير المرتبطة ÷ الإجمالي

التفاصيل الكاملة في [X_API_STRATEGY.md](X_API_STRATEGY.md).

---

## 9. Security Architecture

| الطبقة | الآلية |
|---|---|
| **Authentication** | Argon2id للكلمات · Access JWT (15د) · Refresh Token دوّار في httpOnly+SameSite=Strict cookie · قفل بعد محاولات فاشلة |
| **Authorization** | RBAC بصلاحيات دقيقة (`permission` strings) لا بأدوار خام. الأدوار مجموعات صلاحيات قابلة للتعديل. |
| **الأدوار** | `admin` (كل شيء) · `supervisor` (رصد + تقارير + تنبيهات + استعلامات + ميزانية للقراءة) · `analyst` (تحليل + قواميس + تغذية راجعة) · `viewer` (قراءة فقط) |
| **صلاحيات حرجة منفصلة** | `budget:write` · `killswitch:operate` · `query:promote` · `internal_data:read` · `settings:write` — لا تُمنح تلقائياً مع الدور |
| **عزل البيانات الداخلية** | جداول `internal_*` في schema منفصل بمستخدم DB منفصل. الوصول يتطلب `internal_data:read` صراحة. |
| **حظر التسريب** | حارس على مستوى `AIProvider`: أي نص من مصدر `internal` يُرفض إرساله لمزود خارجي ما لم يكن `ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI=true` **و** المزود مُعلَّم `local`. |
| **الأسرار** | Environment Variables حصراً · `.env` في `.gitignore` · `.env.example` بقيم وهمية · فلترة الأسرار في الـ Logger |
| **Audit Log** | append-only، يسجّل `user, action, entity, old_value, new_value, ip, timestamp` لكل عملية حساسة |
| **Rate Limiting** | على مستوى API لكل مستخدم/IP، وأشد على المسارات المستهلكة للتكلفة |
| **Input Validation** | Zod على كل حدود الإدخال · استعلامات مُعامَلة (parameterized) حصراً |

---

## 10. Demo Mode — كيف يعمل

ثلاثة أوضاع مستقلة، مفصولة تماماً:

| Mode | ENV | السلوك |
|---|---|---|
| **DEMO** | `LIVE_X_API=false` (افتراضي) | `XApiGateway` يُستبدل بـ `MockXApiClient` يقرأ من `fixtures/` — بيانات عربية واقعية مولّدة تغطي كل السيناريوهات (شكاوى، إعلانات، spam، حسابات مؤثرة، spike مصطنع، حادث كامل). صفر اتصال شبكي. |
| **DRY RUN** | `X_DRY_RUN=true` | كل شيء حقيقي عدا الطلب النهائي. Scheduler يعمل، Budget Gate يقيّم، الاستعلام يُبنى ويُسجَّل: `"This query WOULD run: <compiled_query>, est. 42 units"`. لا HTTP، لا استهلاك. |
| **LIVE** | `LIVE_X_API=true` | تشغيل حقيقي. يتطلب مفاتيح صالحة + ميزانية مُهيّأة + استعلام واحد على الأقل اجتاز Sandbox. |

**حماية إضافية:** عند `LIVE_X_API=true` لأول مرة، الواجهة تعرض شاشة تأكيد تُظهر: الميزانية الشهرية، عدد الاستعلامات النشطة، الاستهلاك المتوقع اليومي. لا تشغيل بلا وعي.

كل الواجهات الـ 33 قابلة للتطوير والاختبار الكامل في DEMO Mode.

---

## 11. اختبار الاستعلامات قبل الإنتاج

دورة حياة الاستعلام إلزامية:

```
DRAFT ──► TESTED ──► APPROVED ──► ACTIVE ──► PAUSED/ARCHIVED
  │          │           │
  │          │           └─ يتطلب صلاحية query:promote + سجل تدقيق
  │          └─ يتطلب اختبار Sandbox واحد على الأقل بـ precision ≥ min_precision (افتراضي 70%)
  └─ قابل للتعديل بحرية، لا يُنفَّذ أبداً
```

**آلية الـ Sandbox:**

1. المستخدم يختار حجم العينة: 10 / 25 / 50 / 100 منشور.
2. **العينة تُخصم من الميزانية فعلياً** وتُسجّل في `api_usage` بنوع `test` — الاختبار ليس مجانياً ويجب أن يظهر في التكلفة.
3. النتائج تُصنَّف عبر AI Pipeline كاملاً (بما فيها Stage 3، لأن العينة صغيرة).
4. تصنيف كل منشور: `relevant` / `irrelevant` / `advertisement` / `spam` / `unknown`.
5. حساب `Precision Score = relevant ÷ (الإجمالي − unknown)`.
6. **تحليل مساهمة الكلمات:** لكل كلمة في الاستعلام، تُحسب نسبة الضوضاء في المنشورات التي طابقتها → توصيات محددة:
   - `"كلمة «تأجير» تسببت في 68% من الضوضاء — يُقترح استبعادها"`
   - `"إضافة negative keyword «للإيجار سنوي» ستحذف 12 من 100 نتيجة غير مرتبطة"`
   - `"الاستعلام واسع جداً: 4 كلمات OR بلا AND — خطر ضوضاء عالٍ"`
7. المستخدم يراجع كل منشور يدوياً ويصحح تصنيف AI → التصحيحات تُغذّي `ai_feedback`.
8. النتيجة تُحفظ في `query_tests` مرتبطة بـ `query_version` محددة → **مقارنة بين الإصدارات:** هل حسّن التعديل الدقة؟

**Estimate قبل الاختبار:** الواجهة تعرض `Breadth Score` (اتساع الاستعلام) و`Risk of Noise` محسوبَين من بنية الاستعلام نفسه (عدد الـ OR، وجود AND groups، عدد الـ negatives، طول العبارات) — تقدير مجاني قبل إنفاق أي شيء.

---

## 12. تحليل الـ 300,000 رسالة تاريخية

**الهدف:** ليس عدّ الكلمات، بل اكتشاف **المعنى** وبناء Taxonomy حقيقية.

**تكلفة الـ Embeddings هي القيد الحاكم.** الحل: نموذج مفتوح محلي (`BAAI/bge-m3`) داخل `apps/ai` — دعم عربي ممتاز، صفر تكلفة API، معالجة 300k رسالة في ~2-4 ساعات على CPU عادي.

**خط الأنابيب (9 مراحل):**

```
[1] Upload & Parse          Excel/CSV → streaming (لا تحميل كامل بالذاكرة)
                            كشف الأعمدة + خريطة حقول يحددها المستخدم
[2] Arabic Normalization    توحيد الألف/الهمزة، حذف التطويل والتشكيل،
                            التاء المربوطة، تطبيع الأرقام، إزالة الروابط/الإيموجي
[3] Exact Deduplication     hash على النص المطبّع → 300k قد تنكمش إلى ~180k
                            (الاستفسارات المتكررة حرفياً كثيرة جداً)
[4] Embedding               bge-m3، batch=256، مخزّن في historical_messages.embedding
[5] Dimensionality Reduction UMAP → 50 بُعد (يُسرّع الـ clustering بشدة)
[6] Clustering              HDBSCAN (min_cluster_size قابل للضبط)
                            → ~300-800 عنقود + noise bucket
[7] Cluster Labeling        لكل عنقود: استخراج 15 medoid + top TF-IDF terms
                            → استدعاء LLM واحد يُنتج:
                              service, topic, subtopic, issue, intent,
                              common_phrases[], keywords[], synonyms[], misspellings[]
                            ★ ~500 استدعاء LLM إجمالاً بدل 300,000 — التوفير 600×
[8] Taxonomy Assembly       دمج العناقيد المتشابهة (cosine بين المراكز > 0.9)
                            → بناء شجرة Program → Topic → Subtopic → Issue
[9] Human Review            كل عنقود يُعرض مع: الحجم، عيّنات، التسمية المقترحة، الثقة
                            المستخدم: Approve / Merge / Rename / Reject
                            ★ لا شيء يدخل الإنتاج بلا موافقة بشرية
```

**المخرجات النهائية:**
- شجرة Taxonomy معتمدة → جداول `topics` / `subtopics` / `issues`
- قاموس كلمات مُثرى → `keywords` + `keyword_aliases` (مرادفات + أخطاء إملائية)
- **Issue Centroids** — متجهات مرجعية تُستخدم لاحقاً لمطابقة منشورات X الجديدة بالمشاكل المعروفة فوراً وبلا تكلفة LLM

**الرابط الاستراتيجي:** هذه المرحلة (Phase 3) هي ما يحوّل المنصة من "رصد" إلى "ذكاء". بدونها، التصنيف يبقى عاماً. معها، النظام يعرف أن "العقد ما يتوثق" = `Ejar → العقود → توثيق العقد → فشل التوثيق` بثقة عالية وتكلفة صفرية.

**بديل احتياطي:** لو تعذّر تشغيل نموذج محلي، يُستخدم مزود embeddings خارجي — 300k رسالة × ~40 token ≈ 12M token ≈ $1-2 على معظم المزودين. مقبول كتكلفة لمرة واحدة، لكن يجب مراجعة سياسة الخصوصية أولاً (البيانات داخلية حساسة — انظر §9).

---

## 13. مراحل التنفيذ — نظرة عامة

| Phase | المحور | المدة التقديرية | معيار النجاح |
|---|---|---|---|
| **Phase 0** | الأساس: monorepo، DB، auth، demo mode، CI | 1-2 أسبوع | تشغيل محلي كامل بأمر واحد |
| **Phase 1** | MVP الحقيقي: قواميس، Query Builder، Sandbox، X Integration، Live Feed، **Cost Control + Kill Switch**، Dashboard | 4-6 أسابيع | استعلام حقيقي واحد يعمل بأمان مع سقف ميزانية فعّال |
| **Phase 2** | الذكاء: تصنيف AI، مشاعر، مواضيع، مؤثرون، Spike، Alerts، تقارير Excel | 4-6 أسابيع | تنبيه صحيح واحد يصل بالبريد + تقرير كل ساعتين |
| **Phase 3** | العمق: 300k رسالة، embeddings، clustering، taxonomy، Emerging Topics، Incidents + Memory | 5-7 أسابيع | Taxonomy معتمدة + حادث مكتشف آلياً |
| **Phase 4** | التكامل: بيانات داخلية، أخبار، Correlation، NL Analytics، AI Recommendations | 6-8 أسابيع | ربط مؤكد بين ارتفاع X وارتفاع التذاكر |

التفصيل الكامل بالمهام ومعايير القبول في [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md).

**قاعدة الانتقال:** لا يبدأ Phase التالي قبل أن يكون هيكل الحالي متماسكاً ومختبراً وموثّقاً.

---

## 14. المخاطر والافتراضات

| # | المخاطرة / الافتراض | الأثر | المعالجة |
|---|---|---|---|
| R1 | **ميزانية $20/شهر لا تقابل باقة X حقيقية** | حاسم | Cost Engine يعمل بوحدة Quota Units لا بالدولار. تحديد الباقة الفعلية قرار عمل يجب حسمه قبل `LIVE_X_API=true`. |
| R2 | X API قد يغيّر الأسعار/الحدود/السياسات | عالٍ | كل ذلك في `settings` قابل للتعديل. طبقة X معزولة خلف interface واحد. |
| R3 | `search/recent` يغطي 7 أيام فقط في الباقات الأدنى | متوسط | الاستطلاع المتكرر + watermarks يضمن عدم فقدان بيانات. الأرشفة عندنا لا عندهم. |
| R4 | جودة نماذج NLP العربية على اللهجة السعودية | متوسط | bge-m3 قوي على العربية. التقييم على عينة حقيقية من الـ 300k قبل الاعتماد. مسار بديل: LLM للحالات الصعبة. |
| R5 | شروط X للاحتفاظ بالبيانات وحذفها | عالٍ (قانوني) | `compliance:redaction-sweep` + سياسات retention قابلة للضبط + عدم افتراض احتفاظ أبدي. |
| R6 | تقرير Connect Listening بصيغة غير معروفة | منخفض | مستورد مرن مع خريطة أعمدة يحددها المستخدم. |
| R7 | خصوصية بيانات خدمة العملاء | عالٍ | عزل schema + حارس AIProvider + صلاحية منفصلة. لا إرسال خارجي بلا تفعيل صريح. |

---

## 15. تعريف "تم" للتصميم

- [x] فهم المتطلبات وتلخيصها
- [x] Architecture النهائية
- [x] Folder Structure → [ARCHITECTURE.md](ARCHITECTURE.md)
- [x] Database Schema → [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)
- [x] Data Flow كامل
- [x] Modules (25)
- [x] Background Jobs (24)
- [x] API Endpoints → [ARCHITECTURE.md](ARCHITECTURE.md)
- [x] صفحات الواجهة (33)
- [x] مراحل التنفيذ → [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)
- [x] نقاط التحكم بالتكلفة → [X_API_STRATEGY.md](X_API_STRATEGY.md)
- [x] Security Architecture
- [x] Demo Mode
- [x] اختبار الاستعلامات
- [x] تحليل 300k رسالة → [AI_PIPELINE.md](AI_PIPELINE.md)

**القرار المطلوب من صاحب المشروع قبل بدء التنفيذ:** حسم باقة X API الفعلية والميزانية الحقيقية (R1).
