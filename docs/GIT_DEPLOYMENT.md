# Git والنشر — MIP

```
Local Development  ──git push──▶  GitHub (faisal4042/monitoring-intelligence-platform)  ──Coolify──▶  Production
```

- الإنتاج: Coolify على `panel.interactivedashboardpages.com`، والموقع `https://monitoring.interactivedashboardpages.com`.
- Coolify يتابع فرع **`main`**، و**النشر التلقائي مفعّل**: أي `push` إلى `main` يبني الحاويات من جديد وينشرها.
- السيرفر ليس مكان تطوير. لا تعديل ولا `git pull` يدوي على السيرفر؛ Coolify يجلب الكود بنفسه في كل نشر.

---

## الفروع

| الفرع | الغرض | يُنشر؟ |
|---|---|---|
| `main` | الإنتاج — كل commit فيه قابل للنشر | نعم، تلقائياً |
| `develop` | التجميع والاختبار قبل الإنتاج | لا |
| `feature/<name>` | ميزة جديدة، تتفرع من `develop` | لا |
| `fix/<name>` | إصلاح، يتفرع من `develop` (أو من `main` للعاجل) | لا |

القواعد: لا `push --force` على `main` أو `develop`، ولا commit مباشر على `main` إلا للإصلاحات العاجلة.

---

## دورة التطوير

```bash
git switch develop && git pull
git switch -c feature/alerts-email

# ... تعديل واختبار محلي ...
pnpm typecheck
node scripts/e2e-check.mjs

git add <files>                        # راجع git status قبل الإضافة، لا تستخدم add . بلا نظر
git commit -m "feat(alerts): email channel"
git push -u origin feature/alerts-email

# بعد المراجعة: دمج في develop
git switch develop && git merge --no-ff feature/alerts-email && git push
```

### الإصدار إلى الإنتاج

```bash
git switch main && git pull
git merge --no-ff develop
git tag -a v2026.10.07 -m "release"     # نقطة رجوع واضحة
git push && git push --tags             # ← هذا يطلق النشر في Coolify
```

بعد النشر تحقّق:

```bash
curl -s https://monitoring.interactivedashboardpages.com/health
```

ويجب أن تكون حالة التطبيق في Coolify `running:healthy`.

### Commits

اتبع [Conventional Commits](https://www.conventionalcommits.org): `feat:` و`fix:` و`chore:` و`docs:` و`refactor:`. اجعل كل commit تغييراً واحداً مفهوماً.

---

## الرجوع إلى إصدار سابق (Rollback)

**الطريقة المفضّلة:** `git revert`. تنشئ commit جديداً يلغي التغيير، فيبقى التاريخ سليماً ولا حاجة لأي force push.

```bash
git switch main && git pull
git revert <sha>            # أو: git revert <old>..<new> لعدة commits
git push                    # يطلق نشراً بالنسخة المصحّحة
```

**الطريقة الأسرع (بدون Git):** من Coolify ← التطبيق ← Deployments، اختر نشراً سابقاً ناجحاً واضغط Redeploy. بعدها نفّذ `revert` في Git حتى لا يرجع الخطأ مع أول push قادم.

**للاطلاع فقط على نسخة قديمة محلياً:**

```bash
git switch --detach v2026.10.01
```

**ممنوع على الإنتاج بدون موافقة:** `git reset --hard` و`git push --force`.

> الرجوع بالكود **لا يرجع قاعدة البيانات**. اقرأ قسم Migrations.

---

## ملفات `.env`

- `.env` و`.env.*` مستبعدة من Git. فقط `.env.example` يُرفع، وفيه **أسماء** المتغيرات بلا قيم سرية.
- **محلياً:** `cp .env.example .env` ثم املأ القيم.
- **الإنتاج:** المتغيرات تُدار في Coolify (التطبيق ← Environment Variables)، ولا يوجد ملف `.env` في المستودع، فلا يمكن لأي push أو نشر أن يغيّرها.
- متغير جديد = أضفه إلى `packages/config/src/index.ts` وإلى `.env.example` بقيمة فارغة أو آمنة، ثم أضف قيمته في Coolify **قبل** نشر الكود الذي يحتاجه.
- إذا تسرّب سر إلى Git: دوّره فوراً عند المزوّد. حذفه من commit لاحق لا يكفي لأنه يبقى في التاريخ.

---

## Migrations

- الملفات في `packages/db/migrations/NNNN_name.sql`، وتُطبّق للأمام فقط. المطبّق سابقاً يُتخطّى.
- حاوية الـ API تشغّل `pnpm db:push && pnpm db:seed` عند كل إقلاع، أي أن الـ migrations تُطبّق تلقائياً مع كل نشر.
- **لا تعدّل migration نُشرت.** أي تغيير يكون migration جديدة برقم أعلى.
- اكتب migrations **إضافية ومتوافقة مع الخلف**: إضافة أعمدة nullable أو جداول جديدة. عند الحذف أو إعادة التسمية: انشر الكود الذي لم يعد يستخدم العمود أولاً، ثم احذف العمود في إصدار لاحق. بهذا يبقى الـ rollback للكود آمناً.
- قبل أي migration تحذف أو تعدّل بيانات، خذ نسخة احتياطية من حاوية postgres في Coolify:

  ```bash
  pg_dump -U mip -d mip -Fc > /backups/mip-$(date +%F-%H%M).dump
  ```

  (احفظها خارج المستودع.)

---

## Docker Compose

| الملف | الاستخدام |
|---|---|
| `infra/docker-compose.yml` | محلي فقط: Postgres على 5433 وRedis على 6380 |
| `docker-compose.yaml` | الإنتاج: يقرأه Coolify (web + api + ai + postgres + redis) |
| `docker-compose.prod.yml` | نسخة مطابقة من ملف الإنتاج |

- بيانات الإنتاج في **named volumes** (`postgres-data` و`redis-data`) لا في المستودع. إعادة النشر تبني الحاويات من جديد وتُبقي الـ volumes كما هي.
- **لا تُعِد تسمية** الـ volumes أو خدمتي `postgres`/`redis` في `docker-compose.yaml`. تغيير الاسم يعني volume جديداً فارغاً، أي قاعدة بيانات فارغة في الإنتاج.
- لا تضغط **Delete** على التطبيق أو الـ volumes في Coolify، ولا تشغّل `docker compose down -v` على السيرفر.
- اختبر أي تغيير على Dockerfile محلياً قبل الدفع:

  ```bash
  docker compose -f docker-compose.yaml build
  ```

---

## النشر اليدوي عبر Coolify API (اختياري)

القيم في `.env` المحلي (`COOLIFY_API_URL` و`COOLIFY_API_TOKEN` و`COOLIFY_APP_UUID`):

```bash
curl -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$COOLIFY_API_URL/deploy?uuid=$COOLIFY_APP_UUID"
```
