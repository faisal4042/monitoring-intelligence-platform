# ARCHITECTURE — Monitoring Intelligence Platform

> البنية التقنية التفصيلية · مكمّلة لـ [PROJECT_PLAN.md](PROJECT_PLAN.md)

---

## 1. نظرة عامة على الخدمات

خمس وحدات نشر (deployables) + بنية تحتية:

| الخدمة | التقنية | المسؤولية | تتصل بـ |
|---|---|---|---|
| `web` | React 19 + Vite + TS | الواجهة | `api` فقط |
| `api` | Node 22 + Fastify + TS | REST، Auth، RBAC، استعلامات تحليلية، إدارة الطوابير | PG, Redis, `ai` |
| `worker` | Node 22 + BullMQ + TS | كل المهام الخلفية | PG, Redis, `ai`, **X API** |
| `ai` | Python 3.12 + FastAPI | Embeddings، Clustering، Classification، LLM abstraction | مزودو AI فقط |
| `scheduler` | جزء من `worker` | إنتاج المهام المتكررة | Redis |

**بنية تحتية:** PostgreSQL 16 + pgvector · Redis 7 · (اختياري: MinIO/S3 لملفات التقارير والاستيراد)

### 1.1 حدود المسؤولية الصارمة

```
web      ── لا يعرف شيئاً عن X API أو AI. يستهلك REST فقط.
api      ── لا ينفّذ عملاً ثقيلاً. يضع مهاماً في الطابور ويقرأ النتائج.
             ★ يملك BudgetService (القراءة والقرار) لكن لا يجلب من X.
worker   ── الوحيد الذي يستدعي X API، وحصراً عبر XApiGateway.
ai       ── stateless تماماً. نص داخل → أرقام/تصنيفات/متجهات خارج.
             لا اتصال بـ Postgres. لا معرفة بالبرامج أو الاستعلامات.
```

**لماذا `ai` بلا قاعدة بيانات؟** لجعله قابلاً للاستبدال أو النقل إلى GPU host أو الاستعاضة عنه بخدمة سحابية دون لمس أي منطق أعمال. كل الحالة تبقى في `worker`.

---

## 2. مخطط التفاعل

```
                          ┌──────────────┐
                          │   Browser    │
                          └──────┬───────┘
                                 │ HTTPS
                    ┌────────────▼────────────┐
                    │      web (Vite SPA)     │
                    └────────────┬────────────┘
                       REST      │      SSE (/stream/live)
                    ┌────────────▼────────────┐
                    │       api (Fastify)     │
                    │  ┌───────────────────┐  │
                    │  │ Auth · RBAC       │  │
                    │  │ Controllers       │  │
                    │  │ ★ BudgetService   │  │──┐
                    │  │ QueryCompiler     │  │  │ shared
                    │  └───────────────────┘  │  │ package
                    └───┬─────────┬────────┬──┘  │
                        │         │        │     │
              ┌─────────▼──┐  ┌───▼────┐  ┌▼─────▼──────────┐
              │ PostgreSQL │  │ Redis  │  │ worker (BullMQ) │
              │ + pgvector │  │        │  │ ┌─────────────┐ │
              └────────────┘  │ queues │◄─┤ │ Collectors  │ │
                     ▲        │ cache  │  │ │ Classifiers │ │
                     │        │ buckets│  │ │ Detectors   │ │
                     │        │ ★kill  │  │ │ Alerters    │ │
                     └────────┤ switch │  │ │ Reporters   │ │
                              └────────┘  │ └──────┬──────┘ │
                                          └────────┼────────┘
                                    ┌──────────────┼──────────┐
                                    │              │          │
                          ┌─────────▼──────┐  ┌────▼──────────▼──┐
                          │ ★ XApiGateway  │  │  ai (FastAPI)    │
                          │  (المنفذ الوحيد)│  │  embed/classify  │
                          └─────────┬──────┘  │  cluster/llm     │
                                    │         └────┬─────────────┘
                              ┌─────▼─────┐   ┌────▼──────────────┐
                              │  X API    │   │ AI Providers      │
                              └───────────┘   │ OpenAI/Local/Qwen │
                                              └───────────────────┘
```

---

## 3. Folder Structure

Monorepo بـ **pnpm workspaces** + **Turborepo**.

```
mip/
├── apps/
│   ├── web/                          # React SPA
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── router.tsx
│   │   │   │   ├── providers.tsx     # QueryClient, Theme, i18n, Auth
│   │   │   │   └── layout/           # AppShell, Sidebar, Topbar
│   │   │   ├── features/             # ★ التنظيم حسب الميزة لا حسب نوع الملف
│   │   │   │   ├── auth/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── live-feed/
│   │   │   │   ├── monitoring-wall/
│   │   │   │   ├── programs/
│   │   │   │   ├── keywords/         # Keyword Intelligence
│   │   │   │   ├── query-builder/
│   │   │   │   │   ├── components/QueryCanvas.tsx
│   │   │   │   │   ├── components/GroupNode.tsx
│   │   │   │   │   ├── components/CompiledPreview.tsx
│   │   │   │   │   └── components/BreadthMeter.tsx
│   │   │   │   ├── query-sandbox/
│   │   │   │   ├── cost-center/      # ★ Budget, Kill Switch, Analytics
│   │   │   │   ├── posts/
│   │   │   │   ├── influencers/
│   │   │   │   ├── topics/
│   │   │   │   ├── incidents/
│   │   │   │   ├── alerts/
│   │   │   │   ├── reports/
│   │   │   │   ├── historical/
│   │   │   │   ├── connect-import/
│   │   │   │   ├── news/
│   │   │   │   ├── events/
│   │   │   │   ├── ask/              # NL Search
│   │   │   │   ├── settings/
│   │   │   │   └── admin/            # Developer Console
│   │   │   ├── components/ui/        # Primitives (Button, Table, Drawer…)
│   │   │   ├── components/charts/    # ECharts wrappers, RTL-aware
│   │   │   ├── lib/
│   │   │   │   ├── api-client.ts     # typed fetch من packages/shared
│   │   │   │   ├── sse.ts
│   │   │   │   ├── rbac.ts           # <Can permission="budget:write">
│   │   │   │   └── format.ts         # أرقام/تواريخ عربية
│   │   │   ├── i18n/
│   │   │   │   ├── ar.json           # ★ اللغة الافتراضية
│   │   │   │   └── en.json
│   │   │   └── styles/
│   │   │       ├── globals.css
│   │   │       └── theme.css         # CSS vars — light/dark
│   │   ├── index.html                # dir="rtl" lang="ar"
│   │   ├── tailwind.config.ts        # + tailwindcss-rtl
│   │   └── vite.config.ts
│   │
│   ├── api/                          # Fastify REST
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── plugins/              # auth, rbac, error-handler, logger, cors
│   │   │   ├── modules/              # ★ كل module = routes + service + repo + schema
│   │   │   │   ├── auth/
│   │   │   │   ├── programs/
│   │   │   │   ├── keywords/
│   │   │   │   ├── queries/
│   │   │   │   │   ├── query.routes.ts
│   │   │   │   │   ├── query.service.ts
│   │   │   │   │   ├── query-compiler.ts     # AST → X query string
│   │   │   │   │   ├── query-estimator.ts    # breadth + noise risk
│   │   │   │   │   └── query-version.service.ts
│   │   │   │   ├── sandbox/
│   │   │   │   ├── cost/                     # ★
│   │   │   │   │   ├── budget.service.ts     # ALLOW/DENY
│   │   │   │   │   ├── usage.service.ts
│   │   │   │   │   ├── forecast.service.ts
│   │   │   │   │   ├── killswitch.service.ts
│   │   │   │   │   └── optimizer.service.ts
│   │   │   │   ├── posts/
│   │   │   │   ├── authors/
│   │   │   │   ├── topics/
│   │   │   │   ├── incidents/
│   │   │   │   ├── alerts/
│   │   │   │   ├── reports/
│   │   │   │   ├── historical/
│   │   │   │   ├── connect-import/
│   │   │   │   ├── news/
│   │   │   │   ├── events/
│   │   │   │   ├── feedback/
│   │   │   │   ├── settings/
│   │   │   │   ├── admin/
│   │   │   │   └── stream/
│   │   │   └── lib/
│   │   └── package.json
│   │
│   ├── worker/                       # BullMQ
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── scheduler.ts          # repeatable jobs registration
│   │   │   ├── queues.ts
│   │   │   ├── jobs/
│   │   │   │   ├── collect/
│   │   │   │   │   ├── collect-query.job.ts
│   │   │   │   │   └── author-refresh.job.ts
│   │   │   │   ├── ingest/
│   │   │   │   ├── classify/
│   │   │   │   ├── score/
│   │   │   │   ├── rollup/
│   │   │   │   ├── detect/
│   │   │   │   ├── correlate/
│   │   │   │   ├── alerts/
│   │   │   │   ├── reports/
│   │   │   │   ├── budget/
│   │   │   │   ├── historical/
│   │   │   │   ├── news/
│   │   │   │   └── maintenance/      # retention, redaction
│   │   │   ├── engines/              # ★ منطق قابل لإعادة الاستخدام والاختبار
│   │   │   │   ├── filtering/
│   │   │   │   ├── dedup/
│   │   │   │   ├── scoring/
│   │   │   │   ├── spike/
│   │   │   │   ├── emerging/
│   │   │   │   ├── incident/
│   │   │   │   ├── correlation/
│   │   │   │   └── alert-rules/
│   │   │   └── integrations/
│   │   │       ├── x/                # ★ طبقة X معزولة بالكامل
│   │   │       │   ├── x-api.gateway.ts      # ★ المنفذ الوحيد
│   │   │       │   ├── x-api.client.ts       # HTTP حقيقي
│   │   │       │   ├── x-api.mock.ts         # DEMO
│   │   │       │   ├── x-field-selector.ts   # حقول من الإعدادات
│   │   │       │   ├── x-rate-limiter.ts
│   │   │       │   ├── x-pricing.ts          # من settings لا hardcoded
│   │   │       │   └── types.ts
│   │   │       ├── ai/               # عميل HTTP لـ apps/ai
│   │   │       ├── notify/
│   │   │       │   ├── provider.interface.ts
│   │   │       │   ├── email.provider.ts
│   │   │       │   ├── teams.provider.ts
│   │   │       │   ├── telegram.provider.ts
│   │   │       │   ├── webhook.provider.ts
│   │   │       │   └── inapp.provider.ts
│   │   │       └── internal/         # ★ موصل البيانات الداخلية (معزول)
│   │   └── package.json
│   │
│   └── ai/                           # Python FastAPI — stateless
│       ├── app/
│       │   ├── main.py
│       │   ├── routers/
│       │   │   ├── embed.py
│       │   │   ├── classify.py
│       │   │   ├── cluster.py
│       │   │   ├── summarize.py
│       │   │   └── health.py
│       │   ├── providers/            # ★ AIProvider abstraction
│       │   │   ├── base.py           # LLMProvider, EmbeddingProvider (ABC)
│       │   │   ├── openai_provider.py
│       │   │   ├── local_provider.py
│       │   │   ├── qwen_provider.py
│       │   │   └── registry.py
│       │   ├── nlp/
│       │   │   ├── arabic.py         # ★ تطبيع عربي
│       │   │   ├── tokenize.py
│       │   │   ├── ngrams.py
│       │   │   └── simhash.py
│       │   ├── pipelines/
│       │   │   ├── cheap_classifier.py   # LogReg فوق embeddings
│       │   │   ├── clustering.py         # UMAP + HDBSCAN
│       │   │   ├── labeling.py           # تسمية العناقيد عبر LLM
│       │   │   └── grounded_summary.py   # ★ ملخص بلا هلوسة
│       │   └── models/               # Pydantic schemas
│       ├── models_cache/             # gitignored — أوزان النماذج
│       ├── pyproject.toml
│       └── Dockerfile
│
├── packages/
│   ├── shared/                       # ★ عقد مشترك بين web و api
│   │   ├── src/
│   │   │   ├── types/                # Post, Query, Incident, Alert…
│   │   │   ├── schemas/              # Zod — مصدر الحقيقة للتحقق
│   │   │   ├── enums/
│   │   │   ├── permissions.ts        # ★ قائمة الصلاحيات + خرائط الأدوار
│   │   │   └── query-ast.ts          # ★ تعريف AST المشترك للاستعلام
│   │   └── package.json
│   ├── db/
│   │   ├── src/
│   │   │   ├── schema/               # Drizzle schema حسب المجال
│   │   │   ├── client.ts
│   │   │   ├── seed/
│   │   │   │   ├── roles.ts
│   │   │   │   ├── programs.ts       # إيجار، ملاك، مستدام، REGA…
│   │   │   │   ├── settings.ts       # ★ أسعار وحدود X الافتراضية
│   │   │   │   └── demo/             # ★ بيانات DEMO الكاملة
│   │   │   └── migrations/
│   │   └── drizzle.config.ts
│   ├── config/                       # ★ تحميل + تحقق ENV (Zod)
│   └── logger/                       # Pino + ★ redaction للأسرار
│
├── fixtures/                         # ★ استجابات X وهمية لـ DEMO Mode
│   ├── x-search-ejar-*.json
│   ├── x-search-ads-noise.json
│   ├── x-users.json
│   └── scenarios/                    # spike, incident, influencer-burst
│
├── infra/
│   ├── docker-compose.yml            # postgres, redis, api, worker, ai, web
│   ├── docker-compose.dev.yml
│   └── Dockerfile.*
│
├── docs/                             # هذه الوثائق
├── .env.example                      # ★ بلا أسرار حقيقية
├── .gitignore                        # ★ .env, models_cache, uploads
├── turbo.json
└── pnpm-workspace.yaml
```

---

## 4. المكونات الحرجة — تفصيل

### 4.1 `XApiGateway` — المنفذ الوحيد

```ts
// apps/worker/src/integrations/x/x-api.gateway.ts

interface XApiGateway {
  searchRecent(req: SearchRequest): Promise<GatewayResult<XPost[]>>;
  getUsers(ids: string[]): Promise<GatewayResult<XUser[]>>;
}

// كل استدعاء يمر بهذا التسلسل — بلا استثناء:
async function execute(req) {
  // 1. ENV — استحالة فيزيائية
  if (!config.LIVE_X_API) return mockClient.handle(req);

  // 2. Kill Switch (Redis — أسرع فحص)
  const kill = await killSwitch.check({ scope: 'global' })
            ?? await killSwitch.check({ scope: 'program', id: req.programId })
            ?? await killSwitch.check({ scope: 'query',   id: req.queryId });
  if (kill.active) return denied('KILL_SWITCH', kill.reason);

  // 3. Budget Gate — ★ القاعدة الأساسية
  const decision = await budgetService.authorize({
    queryId: req.queryId,
    programId: req.programId,
    estimatedUnits: req.maxResults,
    purpose: req.purpose,          // 'collection' | 'test' | 'author_refresh'
  });
  if (decision.verdict === 'DENY') {
    await usageService.recordDenial(req, decision.reason);
    return denied('BUDGET', decision.reason);
  }

  // 4. Dry Run — كل شيء حقيقي عدا الطلب
  if (config.X_DRY_RUN) {
    logger.info({ compiled: req.query, wouldConsume: req.maxResults },
                'DRY RUN: this query would run');
    return dryRun();
  }

  // 5. Rate Limit (token bucket في Redis)
  await rateLimiter.acquire(req.endpoint);

  // 6. الطلب الفعلي
  const res = await client.request(req);

  // 7. ★ محاسبة فورية — قبل أي معالجة، وحتى عند الفشل لاحقاً
  await usageService.record({
    queryId: req.queryId, programId: req.programId,
    endpoint: req.endpoint, purpose: req.purpose,
    requests: 1,
    postsReturned: res.data?.length ?? 0,   // ★ وحدة الحصة الحقيقية
    httpStatus: res.status,
    rateLimitRemaining: res.headers['x-rate-limit-remaining'],
  });

  return ok(res);
}
```

**لماذا هذا التصميم صحيح:** أي مطور مستقبلي يريد استدعاء X لن يجد طريقاً آخر. لا يوجد `fetch('https://api.x.com/...')` في أي مكان آخر — يُفرض بقاعدة ESLint:
```
no-restricted-imports / no-restricted-syntax:
  منع axios/fetch/undici داخل أي ملف خارج integrations/x/
```

### 4.2 `BudgetService` — القرار الذري

```ts
type BudgetDecision =
  | { verdict: 'ALLOW'; grantedUnits: number }
  | { verdict: 'DENY';  reason: DenyReason; scope: string; usage: number; limit: number };
```

الفحص بالترتيب (أوقف عند أول رفض):

| # | النطاق | المصدر |
|---|---|---|
| 1 | Emergency Stop / Kill Switch | Redis |
| 2 | Monthly global | Redis counter + PG reconcile |
| 3 | Daily global | Redis counter |
| 4 | Hourly global | Redis counter |
| 5 | Program monthly (حصة نسبية) | Redis counter |
| 6 | Query daily cap | Redis counter |
| 7 | Purpose cap (مثلاً حد للاختبارات اليومية) | Redis counter |

**الذرية:** فحص + حجز في **سكربت Lua واحد** على Redis — يمنع سباق عدة workers يتجاوزون السقف معاً.

```lua
-- reserve.lua: يفحص كل العدادات ويحجز، أو يرفض بلا تعديل
-- KEYS: عدادات النطاقات · ARGV: الحدود + الوحدات المطلوبة
-- إما ALLOW مع حجز كامل، أو DENY بلا أثر جانبي — لا حالة وسطى
```

**التسوية (Reconcile):** `budget:reconcile` كل ساعة يقارن عدادات Redis بمجموع `api_usage` في PG ويصحح الانحراف. Redis سريع لكنه ليس مصدر الحقيقة — PG هو.

**الحجز مقابل الاستهلاك الفعلي:** نحجز `max_results` (أسوأ حالة) قبل الطلب، ثم نُرجع الفرق بعد معرفة العدد الحقيقي. هذا يمنع التجاوز بشكل قاطع.

### 4.3 `QueryCompiler` — من AST إلى X Query

AST مشترك بين الواجهة والخادم (`packages/shared/query-ast.ts`):

```ts
type QueryNode =
  | { op: 'AND' | 'OR'; children: QueryNode[] }
  | { op: 'NOT'; child: QueryNode }
  | { op: 'TERM';    value: string }
  | { op: 'PHRASE';  value: string }
  | { op: 'HASHTAG'; value: string }
  | { op: 'FROM' | 'TO' | 'MENTION'; value: string }
  | { op: 'KEYWORD_GROUP'; groupId: string }   // ★ يتوسّع من القاموس وقت الترجمة
  | { op: 'FILTER'; key: 'lang'|'is:retweet'|'is:reply'|'has:links'; value?: string };
```

مثال المستخدم من §5 في المتطلبات يترجم إلى:

```
"إيجار" (عقد OR توثيق OR مستأجر OR مؤجر)
-سيارة -معدات -استراحة -إعلان -"للبيع" -is:retweet lang:ar
```

**نقطة تصميم مهمة:** `KEYWORD_GROUP` لا يُثبَّت في نص الاستعلام. يُخزَّن كمرجع ويُوسَّع عند الترجمة. النتيجة: **تعديل القاموس يحدّث كل الاستعلامات التي تستخدمه تلقائياً** — بلا لمس الكود وبلا تعديل كل استعلام يدوياً.

المترجم يتحقق أيضاً من: طول الاستعلام (حد X)، عمق التداخل، عدد العوامل — ويرفض ما يتجاوز حدود الباقة المُهيّأة في `settings`.

### 4.4 `QueryEstimator` — تقدير مجاني قبل الإنفاق

```
Breadth Score (0-100) = f(
   عدد حدود OR في المستوى الأعلى        ↑ يوسّع
   وجود AND groups                        ↓ يضيّق
   وجود عبارات دقيقة (phrases)            ↓ يضيّق
   عدد negative keywords                  ↓ يضيّق
   عمومية الكلمة (تكرارها في بياناتنا)   ↑ يوسّع
   وجود lang: filter                      ↓ يضيّق
)

Noise Risk = Breadth × (1 − negative_coverage) × historical_noise_of_terms
```

`historical_noise_of_terms` يأتي من بياناتنا الفعلية: لكل كلمة، نسبة المنشورات التي طابقتها وصُنّفت `irrelevant`. **التقدير يتحسّن مع الزمن ذاتياً.**

### 4.5 Kill Switch

```ts
POST /api/v1/cost/kill-switch
{ scope: 'global'|'program'|'query'|'source', targetId?: string,
  reason: string, expiresAt?: string }
```

- يُكتب في **Redis أولاً** (أثر فوري خلال ميلي ثانية) ثم في PG (ديمومة + تدقيق).
- عند إقلاع `worker` يُعاد بناء حالة Redis من PG — لا تفقد القفل بعد إعادة تشغيل.
- الواجهة: زر أحمر ثابت في الشريط العلوي **`إيقاف جمع بيانات X`** مرئي دائماً لمن يملك `killswitch:operate`، مع مؤشر حالة (نشط/موقوف).
- يتطلب سبباً نصياً → يُسجَّل في `audit_log`.

---

## 5. API Endpoints — التفصيل

جميع المسارات تحت `/api/v1`. الترميز: 🔒 = تتطلب صلاحية خاصة · 💰 = قد تستهلك حصة X.

### Auth & Identity
```
POST   /auth/login                      → tokens
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me                         → user + permissions[]
```

### Programs & Taxonomy
```
GET    /programs                        ?active=
POST   /programs                        🔒 programs:write
GET    /programs/:id
PATCH  /programs/:id                    🔒
GET    /programs/:id/services
POST   /programs/:id/services           🔒
GET    /programs/:id/taxonomy           → شجرة topics/subtopics/issues
GET    /programs/:id/dashboard          ?from=&to=
```

### Keyword Intelligence
```
GET    /keywords                        ?programId=&type=&q=&page=
POST   /keywords                        🔒 keywords:write
PATCH  /keywords/:id                    🔒
DELETE /keywords/:id                    🔒
POST   /keywords/bulk-import            🔒  CSV/JSON
GET    /keyword-groups                  ?programId=
POST   /keyword-groups                  🔒
GET    /keywords/:id/aliases            مرادفات + أخطاء إملائية
POST   /keywords/:id/aliases            🔒
GET    /keywords/:id/performance        ★ noise% + مساهمة في التكلفة
GET    /keywords/negative               ?programId=
```

### Queries
```
GET    /queries                         ?programId=&status=
POST   /queries                         🔒 queries:write   (status=draft)
GET    /queries/:id
PATCH  /queries/:id                     🔒  ينشئ version جديدة تلقائياً
DELETE /queries/:id                     🔒
POST   /queries/compile                 AST → نص X (بلا حفظ، بلا تكلفة)
POST   /queries/estimate                breadth + noise risk + est. units
GET    /queries/:id/versions
GET    /queries/:id/versions/:v/diff
POST   /queries/:id/rollback/:v         🔒
POST   /queries/:id/test                🔒💰 ★ Sandbox — { sampleSize: 10|25|50|100 }
GET    /queries/:id/tests               سجل الاختبارات + precision لكل version
POST   /queries/:id/promote             🔒 query:promote  (يتطلب اختباراً ناجحاً)
POST   /queries/:id/pause               🔒
POST   /queries/:id/activate            🔒
GET    /queries/:id/consumption         requests, units, cost, precision, noise%
```

### Posts
```
GET    /posts                           فلترة كاملة server-side + cursor pagination
                                        ?programId=&serviceId=&topicId=&sentiment=
                                        &classification=&minRisk=&isInfluencer=
                                        &from=&to=&q=&authorId=&cursor=&limit=
GET    /posts/:id
GET    /posts/:id/similar               ★ pgvector kNN
GET    /posts/:id/why-collected         ★ matched query + matched keywords
POST   /posts/:id/feedback              تصحيح التصنيف → ai_feedback
GET    /posts/export                    🔒 CSV/Excel (محدود بسقف)
```

### Authors & Influencers
```
GET    /authors/:id
GET    /influencers                     ?programId=&sort=influence|followers|mentions
GET    /influencers/:id/card            ★ البطاقة الكاملة
GET    /influencers/:id/posts
POST   /authors/:id/refresh             🔒💰 تحديث يدوي للملف
```

### Topics
```
GET    /topics                          ?programId=&parentId=
GET    /topics/:id/timeline             ?granularity=hour|day&from=&to=
GET    /topics/emerging                 ★ ?status=pending|approved|ignored|blocked
POST   /topics/emerging/:id/approve     🔒 → يضيف للقاموس
POST   /topics/emerging/:id/ignore      🔒
POST   /topics/emerging/:id/block       🔒 → negative keyword
```

### Incidents
```
GET    /incidents                       ?status=&programId=&from=
GET    /incidents/:id
GET    /incidents/:id/posts
GET    /incidents/:id/timeline
GET    /incidents/:id/similar-history   ★ Incident Memory
PATCH  /incidents/:id                   🔒 status, title, root_cause, resolution
POST   /incidents/:id/notes             🔒
```

### Alerts
```
GET    /alert-rules
POST   /alert-rules                     🔒 alerts:write
PATCH  /alert-rules/:id                 🔒
POST   /alert-rules/:id/test            محاكاة على بيانات تاريخية
GET    /alerts                          ?status=&severity=&from=
POST   /alerts/:id/acknowledge
GET    /notification-channels
POST   /notification-channels           🔒
POST   /notification-channels/:id/test  إرسال رسالة تجريبية
```

### Reports
```
GET    /report-schedules
POST   /report-schedules                🔒 reports:write
PATCH  /report-schedules/:id            🔒
POST   /report-schedules/:id/run-now    🔒
GET    /reports                         سجل التشغيل
GET    /reports/:id/download            ?format=xlsx|html|pdf
```

### ★ Cost & Budget
```
GET    /cost/overview                   spent today/month, remaining, projected
GET    /cost/usage                      ?groupBy=query|program|day|hour&from=&to=
GET    /cost/queries                    ★ جدول Query Consumption Analytics كامل
GET    /cost/efficiency                 ★ cost per relevant post / per issue
GET    /cost/forecast                   تنبؤ نهاية الشهر + سيناريوهات
GET    /cost/optimization               ★ توصيات آلية لخفض التكلفة
POST   /cost/optimization/:id/apply     🔒 تطبيق توصية
GET    /budgets
PUT    /budgets                         🔒 budget:write  (global + حصص البرامج)
GET    /budgets/alerts                  عتبات 50/70/80/90/100%
POST   /cost/kill-switch                🔒 killswitch:operate  ★
DELETE /cost/kill-switch/:id            🔒 رفع الإيقاف
GET    /cost/kill-switch                الحالة الحالية
GET    /cost/denials                    الطلبات المرفوضة + الأسباب
```

### Historical & Connect
```
POST   /historical/imports              🔒 رفع Excel/CSV (multipart, streaming)
GET    /historical/imports/:id          حالة المعالجة + التقدم
POST   /historical/imports/:id/mapping  خريطة الأعمدة
POST   /historical/imports/:id/process  🔒 بدء خط الأنابيب
GET    /historical/clusters             ?importId=&minSize=
GET    /historical/clusters/:id         عيّنات + التسمية المقترحة
POST   /historical/clusters/:id/review  🔒 approve|merge|rename|reject
GET    /historical/taxonomy/suggestions
POST   /historical/taxonomy/apply       🔒 ★ اعتماد الشجرة → الإنتاج
POST   /connect-import                  🔒 رفع تقرير Listening
GET    /connect-import/:id/candidates   كلمات/عبارات مرشحة + تصنيفها
POST   /connect-import/:id/apply        🔒 → keywords
```

### News, Events, Correlation
```
GET/POST /news-sources                  🔒
GET    /news                            ?from=&programId=
GET/POST /events                        🔒 الأحداث الرسمية اليدوية
GET    /correlations                    ?incidentId=|topicId=
```

### Settings & Admin
```
GET    /settings                        🔒 settings:read
PUT    /settings/:key                   🔒 settings:write  → audit
       المفاتيح: x_api.pricing · x_api.limits · x_api.endpoints
                 x_api.fields · x_api.retention · author_cache.refresh
                 scoring.risk_weights · scoring.influence_weights
                 ai.providers · alerts.dedup_window · retention.*
GET    /admin/system-health             ★ Developer Console
GET    /admin/queues                    عمق كل طابور + الفاشلة
POST   /admin/queues/:name/retry        🔒
GET    /admin/x-api-status              ★ آخر نجاح/فشل + الأخطاء + rate limits
GET    /admin/ai-status                 حالة المزودين
GET    /admin/audit-log                 🔒 audit:read  ?userId=&action=&from=
GET/POST/PATCH /admin/users             🔒 users:write
GET    /admin/roles
```

### Streaming
```
GET    /stream/live                     SSE — منشورات جديدة (مفلترة حسب الصلاحية)
GET    /stream/alerts                   SSE — تنبيهات فورية
GET    /stream/wall                     SSE — مقاييس Monitoring Wall
```

---

## 6. تصميم الواجهة

### 6.1 RTL أولاً

```html
<html dir="rtl" lang="ar">
```

- Tailwind بخصائص منطقية حصراً: `ps-4` / `pe-4` / `ms-auto` / `text-start` — **لا `pl-` أو `pr-` أبداً**.
- الخط: `IBM Plex Sans Arabic` أو `Noto Sans Arabic` (محلي، بلا CDN خارجي).
- الأرقام: عربية-هندية أم لاتينية؟ **لاتينية (0-9)** للأرقام والمقاييس — أوضح في السياق التقني.
- التواريخ: ميلادي بصيغة عربية + عرض المنطقة الزمنية (`Asia/Riyadh`).
- ECharts: `textStyle.fontFamily` عربي + عكس محاور الفئات + tooltips من اليمين.

### 6.2 Dark Mode

CSS custom properties على `:root` مع `class="dark"` على `<html>`. ثلاث حالات: `light` / `dark` / `system`. محفوظة في `localStorage` + تفضيل المستخدم في DB.

### 6.3 الأداء

| القاعدة | التطبيق |
|---|---|
| لا تحميل كامل في المتصفح | cursor pagination في كل الجداول |
| فلترة على الخادم | كل الفلاتر معاملات URL → SQL |
| قوائم طويلة | `@tanstack/react-virtual` في Live Feed |
| Cache | TanStack Query + `staleTime` مناسب لكل مورد |
| Live Feed | SSE بـ throttle — تجميع الوصول كل 3 ثوانٍ لا لكل منشور |
| Charts | تُقرأ من rollups لا من `posts` |
| Monitoring Wall | endpoint مخصص مُجمّع مسبقاً + تحديث كل 30 ثانية |

### 6.4 Monitoring Wall

عرض مستقل بلا شريط جانبي، خط كبير، تباين عالٍ، ألوان حالة واضحة. مصمم لـ 1920×1080 و 4K. تحديث تلقائي. يعرض فقط: الحجم الحالي، الارتفاعات الكبرى، التنبيهات الحرجة، المؤثرون النشطون، الحوادث المفتوحة، المواضيع الرائجة، توزيع المشاعر.

---

## 7. مواصفات AI Provider Abstraction

```python
# apps/ai/app/providers/base.py
class LLMProvider(ABC):
    name: str
    is_local: bool                    # ★ حاسم لحارس الخصوصية
    @abstractmethod
    async def complete(self, prompt, *, schema=None, max_tokens, temperature) -> LLMResult
    @abstractmethod
    def estimate_cost(self, in_tokens, out_tokens) -> float

class EmbeddingProvider(ABC):
    name: str
    dimensions: int
    is_local: bool
    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]
```

**التسجيل عبر إعدادات، لا كود:**
```json
{ "ai.providers": {
    "llm":       { "primary": "openai:gpt-...", "fallback": "local:qwen" },
    "embedding": { "primary": "local:bge-m3" }
}}
```

**حارس الخصوصية (يُطبَّق في `apps/ai`):**
```python
if payload.data_class == "internal" and not provider.is_local:
    if not settings.ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI:
        raise PrivacyViolation("internal data cannot reach external provider")
```
كل استدعاء يحمل `data_class: "public" | "internal"` إجبارياً. لا قيمة افتراضية — النسيان يعني خطأ لا تسريباً.

---

## 8. فصل البيانات الداخلية

```
PostgreSQL
├── schema: public       ← بيانات X العامة، الاستعلامات، الحوادث…
└── schema: internal     ← ★ تذاكر، بريد، محادثات خدمة العملاء
    مستخدم DB منفصل (mip_internal) — مستخدم api الافتراضي لا يملك USAGE عليه
    الوصول عبر اتصال منفصل يُفتح فقط داخل المسارات المحمية بـ internal_data:read
```

Correlation Engine يعمل على **المجاميع فقط** (عدد التذاكر بالساعة حسب الفئة) لا على محتوى التذاكر — وهذا كافٍ تماماً لكشف الارتباط، ويلغي الحاجة لتمرير نصوص حساسة.

---

## 9. Logging & Observability

- **Pino** بمخرجات JSON، بـ `redact: ['*.password','*.token','*.apiKey','*.authorization','req.headers.cookie']`.
- `requestId` (UUID) يُمرَّر عبر كل الطبقات بما فيها مهام الطابور — تتبّع كامل من نقرة المستخدم حتى استدعاء X.
- سجلات منفصلة معنونة: `x_api`، `budget`، `ai`، `alerts` — قابلة للفلترة في Developer Console.
- **لا يُسجَّل نص المنشور الكامل** في السجلات العامة (خصوصية + حجم).
- مقاييس: عمق الطوابير، زمن المعالجة، معدل نجاح X API، استهلاك الحصة، زمن استجابة AI.

---

## 10. Environment Variables

```bash
# .env.example — قيم وهمية فقط، يدخل Git
NODE_ENV=development
APP_URL=http://localhost:5173

DATABASE_URL=postgresql://mip:changeme@localhost:5432/mip
DATABASE_URL_INTERNAL=postgresql://mip_internal:changeme@localhost:5432/mip
REDIS_URL=redis://localhost:6379

JWT_SECRET=change-me
JWT_REFRESH_SECRET=change-me

# ★ مفاتيح السلامة — الافتراضي آمن دائماً
LIVE_X_API=false
X_DRY_RUN=false
X_BEARER_TOKEN=
X_API_KEY=
X_API_SECRET=

AI_SERVICE_URL=http://localhost:8000
AI_API_KEY=
ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI=false   # ★

SMTP_HOST=
SMTP_USER=
SMTP_PASS=
TEAMS_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=

LOG_LEVEL=info
TZ=Asia/Riyadh
```

`.gitignore`: `.env`, `.env.*` (عدا `.env.example`), `models_cache/`, `uploads/`, `reports-output/`

**عند الإقلاع:** `packages/config` يتحقق من كل المتغيرات عبر Zod ويفشل فوراً عند نقص أي متغير مطلوب. وإذا كان `LIVE_X_API=true` بلا `X_BEARER_TOKEN` → فشل الإقلاع بصوت عالٍ.
