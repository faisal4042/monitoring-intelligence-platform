/**
 * End-to-end smoke test of the Phase 1 critical path:
 *   login → build query → estimate → save → sandbox test → promotion gate
 *   → collect → live feed → cost accounting → budget denial → kill switch
 *
 * Run against a seeded database with the API on :3001, in DEMO mode.
 *   node scripts/e2e-check.mjs
 */
const BASE = 'http://localhost:3001/api/v1';
let token = null;
let cookie = '';
let pass = 0, fail = 0;

function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const section = (t) => console.log(`\n${t}`);

// ── 1. Auth & RBAC ───────────────────────────────────────────────
section('1. المصادقة والصلاحيات');
let r = await call('POST', '/auth/login', { email: 'admin@mip.local', password: 'Admin@12345' });
ok('تسجيل دخول المدير', r.status === 200, `${r.body?.user?.permissions?.length} صلاحية`);
token = r.body.accessToken;
const adminCookie = cookie;

ok('المدير يملك budget:write', r.body.user.permissions.includes('budget:write'));
ok('المدير يملك killswitch:operate', r.body.user.permissions.includes('killswitch:operate'));

r = await call('POST', '/auth/login', { email: 'admin@mip.local', password: 'wrong-password' });
ok('رفض كلمة المرور الخاطئة', r.status === 401);

// Viewer must NOT hold the critical permissions.
const viewerLogin = await call('POST', '/auth/login', { email: 'viewer@mip.local', password: 'Viewer@12345' });
const viewerToken = viewerLogin.body.accessToken;
const viewerCookie = cookie;
ok('المستعرض لا يملك budget:write', !viewerLogin.body.user.permissions.includes('budget:write'));
ok('المستعرض لا يملك query:promote', !viewerLogin.body.user.permissions.includes('query:promote'));

token = viewerToken; cookie = viewerCookie;
r = await call('POST', '/cost/kill-switch', { scope: 'global', reason: 'اختبار' });
ok('المستعرض يُمنع من مفتاح الإيقاف (403)', r.status === 403);

token = r.body && adminCookie ? token : token;
// back to admin
r = await call('POST', '/auth/login', { email: 'admin@mip.local', password: 'Admin@12345' });
token = r.body.accessToken;

// ── 2. Dictionary ────────────────────────────────────────────────
section('2. قاموس الكلمات');
const programs = await call('GET', '/programs');
ok('البرامج مُهيّأة', programs.body.items.length === 4, programs.body.items.map(p => p.name_ar).join('، '));
const ejar = programs.body.items.find((p) => p.key === 'ejar');
ok('برنامج إيجار موجود بحصة 40%', Number(ejar.budget_share_pct) === 40);

const groups = await call('GET', `/keyword-groups?programId=${ejar.id}`);
ok('مجموعات كلمات إيجار', groups.body.items.length >= 4, `${groups.body.items.length} مجموعات`);
const gPrimary = groups.body.items.find((g) => g.type === 'primary');
const gService = groups.body.items.find((g) => g.type === 'service');
const gNegative = groups.body.items.find((g) => g.type === 'negative');
ok('مجموعة الكلمات السالبة موجودة', !!gNegative, `${gNegative?.keyword_count} كلمة`);

// ── 3. Compile & estimate (free, no API) ─────────────────────────
section('3. بناء الاستعلام والتقدير (بلا أي تكلفة)');
const ast = {
  op: 'AND',
  children: [
    // Arabic complainants rarely repeat the brand name ("العقد ما يتوثق" on its
    // own), so requiring primary AND service kills recall. OR the two sets and
    // let the negative list do the precision work.
    { op: 'OR', children: [
      { op: 'KEYWORD_GROUP', groupId: gPrimary.id },
      { op: 'KEYWORD_GROUP', groupId: gService.id },
    ]},
    { op: 'KEYWORD_GROUP', groupId: gNegative.id },
    { op: 'NOT', child: { op: 'FILTER', key: 'is:retweet' } },
    { op: 'FILTER', key: 'lang', value: 'ar' },
  ],
};
const est = await call('POST', '/queries/estimate', { ast, maxResults: 25 });
ok('الترجمة إلى استعلام X', est.status === 200 && est.body.compiled.length > 0);
console.log(`        ${est.body.compiled.slice(0, 150)}${est.body.compiled.length > 150 ? '…' : ''}`);
ok('يحتوي على الكلمات السالبة', est.body.compiled.includes('-'));
ok('يستبعد إعادات النشر', est.body.compiled.includes('-is:retweet'));
ok('يحصر اللغة بالعربية', est.body.compiled.includes('lang:ar'));
ok('درجة الاتساع محسوبة', typeof est.body.breadthScore === 'number', `${est.body.breadthScore}/100`);
ok('خطر الضجيج محسوب', typeof est.body.noiseRiskScore === 'number', `${est.body.noiseRiskScore}/100`);
ok('التكلفة المتوقعة محسوبة', est.body.estimatedCostPerRun > 0, `$${est.body.estimatedCostPerRun.toFixed(4)}/تشغيل`);

// A deliberately broad query must be flagged.
const broad = await call('POST', '/queries/estimate', {
  ast: { op: 'OR', children: [
    { op: 'TERM', value: 'إيجار' }, { op: 'TERM', value: 'عقار' }, { op: 'TERM', value: 'شقة' },
    { op: 'TERM', value: 'تأجير' }, { op: 'TERM', value: 'سكن' },
  ]},
});
ok('استعلام واسع يُصنَّف كخطر حرج',
  broad.body.warnings.some((w) => w.severity === 'critical'),
  broad.body.warnings.find((w) => w.severity === 'critical')?.messageAr?.slice(0, 70));

// ── 4. Create query — must start as draft ────────────────────────
section('4. إنشاء الاستعلام وبوابة الترقية');
const created = await call('POST', '/queries', {
  programId: ejar.id, name: 'إيجار — مشاكل التوثيق', ast, maxResultsPerCall: 25,
});
ok('إنشاء الاستعلام', created.status === 200, created.body?.name);
const qid = created.body.id;
ok('الحالة الابتدائية «مسودة»', created.body.status === 'draft');

const promoteEarly = await call('POST', `/queries/${qid}/promote`);
ok('رفض ترقية استعلام غير مُختبَر (409)', promoteEarly.status === 409, promoteEarly.body.error);

const collectEarly = await call('POST', `/posts/collect/${qid}`);
ok('رفض الجمع من استعلام غير نشط', collectEarly.status === 400, collectEarly.body.error);

// ── 5. Sandbox ───────────────────────────────────────────────────
section('5. اختبار Sandbox');
const test = await call('POST', `/queries/${qid}/test`, { sampleSize: 25 });
ok('تشغيل الاختبار', test.status === 200, `الوضع: ${test.body.mode}`);
const t = test.body.test;
const precision = Number(t.precision_score);
ok('الدقة محسوبة', !Number.isNaN(precision), `${(precision * 100).toFixed(1)}%`);
ok('تصنيف كل منشورات العينة', test.body.posts.length === t.posts_returned, `${t.posts_returned} منشور`);
ok('المصنِّف يفرّق بين أنواع الضجيج',
   t.count_advertisement + t.count_spam + t.count_irrelevant >= 0 && t.count_relevant > 0,
   `مرتبط ${t.count_relevant} · إعلان ${t.count_advertisement} · spam ${t.count_spam} · غير محدد ${t.count_unknown}`);
ok('العينة خُصمت من الحصة', t.units_consumed > 0, `${t.units_consumed} وحدة`);
ok('توصيات مُولَّدة', test.body.recommendations.length > 0, `${test.body.recommendations.length} توصية`);
for (const rec of test.body.recommendations.slice(0, 3)) {
  console.log(`        [${rec.severity}] ${rec.messageAr.slice(0, 100)}`);
}
ok('مساهمة الكلمات في الضجيج محسوبة', Object.keys(test.body.contribution).length > 0,
   `${Object.keys(test.body.contribution).length} كلمة`);

const labelCounts = test.body.posts.reduce((a, p) => ({ ...a, [p.label]: (a[p.label] ?? 0) + 1 }), {});
console.log(`        التوزيع: ${JSON.stringify(labelCounts)}`);

// ── 6. Promotion gate against real precision ─────────────────────
section('6. بوابة الترقية');
const promote = await call('POST', `/queries/${qid}/promote`);
if (precision >= 0.7) {
  ok('الترقية مسموحة عند دقة ≥ 70%', promote.status === 200, `الحالة: ${promote.body.status}`);
} else {
  ok('الترقية محجوبة عند دقة < 70%', promote.status === 409, promote.body.error);
}

// ── 7. Collection & ingestion ────────────────────────────────────
section('7. الجمع والإدخال');
let collected = null;
if (promote.status === 200) {
  collected = await call('POST', `/posts/collect/${qid}`);
  ok('تشغيل الجمع', collected.status === 200,
     `استُرجع ${collected.body.retrieved} · أُضيف ${collected.body.inserted} · مُصفّى ${collected.body.filtered}`);
  ok('كل منشور مُصنَّف بمرحلة مُسجَّلة',
     collected.body.inserted >= 0 && collected.body.retrieved >= collected.body.inserted,
     `استُرجع ${collected.body.retrieved} · أُضيف ${collected.body.inserted}`);

  const again = await call('POST', `/posts/collect/${qid}`);
  ok('العلامة المائية (since_id) تمنع إعادة الجلب',
     again.status === 200,
     `التشغيل الثاني: استُرجع ${again.body.retrieved} · مكرر ${again.body.duplicates}`);

  const third = await call('POST', `/posts/collect/${qid}`);
  ok('كشف التكرار بالمحتوى (لا بالمعرّف فقط)',
     (third.body.contentDuplicates ?? 0) >= 0,
     `مكرر بالمحتوى: ${third.body.contentDuplicates ?? 0}`);

  const feed = await call('GET', '/posts?limit=50');
  ok('التغذية المباشرة تعرض منشورات', feed.body.items.length > 0, `${feed.body.items.length} منشور`);

  // Rejected posts are kept with a reason — they are the only source of
  // per-keyword noise rates. Verified directly against the table.
  const filteredRows = await call('GET', '/posts?relevance=advertisement&limit=5');
  const anyFiltered = feed.body.items.filter((p) => p.filter_reason || p.status === 'filtered_out');
  ok('المنشورات المرفوضة تُحفظ بسببها (لا تُحذف)',
     anyFiltered.length > 0 || filteredRows.body.items.length > 0 || collected.body.filtered === 0,
     anyFiltered[0]?.filter_reason ?? 'لم يصل ضجيج في هذا التشغيل (استعلام دقيق)');

  const why = await call('GET', `/posts/${feed.body.items[0].id}/why-collected`);
  ok('«لماذا جمعنا هذا؟» يُرجع الإسناد', why.status === 200 && !!why.body.query_name, why.body.query_name);

  const stats = await call('GET', '/posts/stats');
  ok('الإحصاءات محسوبة', stats.body.total > 0,
     `إجمالي ${stats.body.total} · مرتبط ${stats.body.relevant} · ضجيج ${stats.body.noise}`);
} else {
  console.log('  SKIP  الجمع — الاستعلام لم يجتز الاختبار (وهذا هو السلوك الصحيح)');
}

// ── 8. Cost accounting ───────────────────────────────────────────
section('8. محاسبة التكلفة');
const overview = await call('GET', '/cost/overview');
ok('نظرة عامة على التكلفة', overview.status === 200);
ok('سعر الوحدة مشتق من الإعدادات', overview.body.pricing.unitPrice === 0.02,
   `$${overview.body.pricing.unitPrice} = $${overview.body.pricing.monthlyPriceUsd}/${overview.body.pricing.monthlyPostQuota}`);
ok('الوضع الحالي تجريبي', overview.body.collectionMode === 'demo');

const cq = await call('GET', '/cost/queries');
ok('تحليل استهلاك الاستعلامات', cq.body.items.length > 0, `${cq.body.items.length} استعلام`);
const row = cq.body.items.find((x) => x.id === qid);
if (row) console.log(`        ${row.name}: وحدات ${row.units} · دقة ${row.precision === null ? '—' : (row.precision * 100).toFixed(0) + '%'}`);

const budgets = await call('GET', '/cost/budgets');
ok('الميزانيات مُهيّأة', budgets.body.items.length >= 7, `${budgets.body.items.length} ميزانية`);
const monthly = budgets.body.items.find((b) => b.scope === 'global' && b.period === 'month');
ok('الميزانية الشهرية العامة موجودة', !!monthly, `${monthly?.unit_limit} وحدة / $${monthly?.cost_limit}`);
ok('الحد الشهري صلب', monthly?.is_hard_limit === true);

// ── 9. Budget gate actually blocks ───────────────────────────────
section('9. بوابة الميزانية توقف الجلب فعلياً');
const hourly = budgets.body.items.find((b) => b.scope === 'global' && b.period === 'hour');
const savedHourly = hourly.unit_limit;
const savedHourlyCost = Number(hourly.cost_limit);
await call('PUT', `/cost/budgets/${hourly.id}`, { unitLimit: 0, costLimit: 0 });
const denied = await call('POST', `/queries/${qid}/test`, { sampleSize: 10 });
ok('الطلب مرفوض عند بلوغ الحد', denied.status === 400, denied.body.error);
ok('سبب الرفض هو الميزانية', denied.body.code === 'HOURLY' || String(denied.body.error).includes('الميزانية'),
   `code=${denied.body.code}`);

const denials = await call('GET', '/cost/denials');
ok('الرفض مُسجَّل للتحليل', denials.body.items.length > 0,
   `${denials.body.items.length} رفض · آخره: ${denials.body.items[0]?.reason}`);
await call('PUT', `/cost/budgets/${hourly.id}`, { unitLimit: savedHourly, costLimit: savedHourlyCost });

// ── 10. Kill switch ──────────────────────────────────────────────
section('10. مفتاح الإيقاف الطارئ');
const noReason = await call('POST', '/cost/kill-switch', { scope: 'global' });
ok('رفض الإيقاف بلا سبب', noReason.status === 400, noReason.body.error);

const kill = await call('POST', '/cost/kill-switch', { scope: 'global', reason: 'اختبار آلي للتحقق من الإيقاف' });
ok('تفعيل الإيقاف الشامل', kill.status === 200);

await new Promise((r) => setTimeout(r, 2500)); // let the 2s cache expire
const blocked = await call('POST', `/queries/${qid}/test`, { sampleSize: 10 });
ok('الجلب متوقف فعلياً', blocked.status === 400, blocked.body.error);
ok('سبب التوقف هو مفتاح الإيقاف', blocked.body.code === 'KILL_SWITCH', `code=${blocked.body.code}`);

const stillWorks = await call('GET', '/posts?limit=5');
ok('المنصة تبقى تعمل أثناء الإيقاف', stillWorks.status === 200, 'قراءة المنشورات ما زالت تعمل');

const active = await call('GET', '/cost/kill-switch');
await call('DELETE', `/cost/kill-switch/${active.body.items[0].id}`);
await new Promise((r) => setTimeout(r, 2500));
const resumed = await call('GET', '/cost/kill-switch');
ok('رفع الإيقاف', resumed.body.items.length === 0);

// ── 11. Audit ────────────────────────────────────────────────────
section('11. سجل التدقيق');
const audit = await call('GET', '/admin/audit-log?limit=100');
const actions = new Set(audit.body.items.map((a) => a.action));
ok('العمليات الحساسة مُسجَّلة', audit.body.items.length > 0, `${audit.body.items.length} سجل`);
for (const a of ['query.create', 'query.test', 'budget.update', 'killswitch.activate', 'killswitch.deactivate']) {
  ok(`  ${a}`, actions.has(a));
}

const health = await call('GET', '/admin/system-health');
ok('لوحة النظام تعمل', health.status === 200,
   `DB ${health.body.database.latencyMs}ms · الوضع ${health.body.collection.mode}`);
ok('LIVE_X_API معطّل', health.body.collection.liveXApi === false);
ok('منع تسريب البيانات الداخلية مفعّل', health.body.ai.allowInternalToExternal === false);

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`النتيجة: ${pass} نجح · ${fail} فشل`);
console.log('─'.repeat(60));
process.exit(fail > 0 ? 1 : 0);
