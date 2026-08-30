/**
 * Drives the real UI: login → dashboard → cost centre → keywords → queries
 * → query builder → live feed → admin, reporting what actually rendered.
 */
export default async function run(page, ui) {
  const out = { steps: [] };
  const note = (name, data) => out.steps.push({ name, ...data });

  // ── Login page ──
  await page.waitForSelector('form', { timeout: 15000 });
  const loginSnap = await ui.snapshot();
  note('login', {
    rendered: loginSnap.includes('textbox'),
    rtl: await page.evaluate(() => document.documentElement.dir),
    lang: await page.evaluate(() => document.documentElement.lang),
    heading: await page.locator('h1').first().innerText().catch(() => null),
  });

  await page.fill('input[type=email]', 'admin@mip.local');
  await page.fill('input[type=password]', 'Admin@12345');
  await page.click('button[type=submit]');

  // ── Dashboard ──
  await page.waitForSelector('h1', { timeout: 15000 });
  await page.waitForTimeout(2500);

  const dash = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.card')]
      .map((c) => c.innerText.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 2 && t.length < 120);
    return {
      heading: document.querySelector('h1')?.innerText ?? null,
      tiles: tiles.slice(0, 8),
      charts: document.querySelectorAll('canvas, svg').length,
      killSwitchVisible: [...document.querySelectorAll('button')]
        .some((b) => b.innerText.includes('إيقاف جمع بيانات')),
      modeBadge: [...document.querySelectorAll('span')]
        .map((s) => s.innerText).find((t) => /تجريبي|حي|جاف/.test(t)) ?? null,
    };
  });
  note('dashboard', dash);

  // ── Cost Center ──
  await page.click('a[href="/cost"]');
  await page.waitForTimeout(2200);
  const cost = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.innerText ?? null,
    tiles: [...document.querySelectorAll('.card')]
      .slice(0, 4).map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
    tabs: [...document.querySelectorAll('button')]
      .map((b) => b.innerText).filter((t) => /استهلاك|الميزانيات|المرفوضة/.test(t)),
    tableRows: document.querySelectorAll('tbody tr').length,
    pricingNote: document.body.innerText.includes('سعر الوحدة'),
  }));
  note('cost-center', cost);

  // ── Keywords ──
  await page.click('a[href="/keywords"]');
  await page.waitForTimeout(2000);
  const kw = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.innerText ?? null,
    groups: document.querySelectorAll('.card').length,
    badges: document.querySelectorAll('.badge').length,
    hasNegatives: document.body.innerText.includes('مستبعدة'),
  }));
  note('keywords', kw);

  // ── Queries ──
  await page.click('a[href="/queries"]');
  await page.waitForTimeout(2000);
  const q = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.innerText ?? null,
    queryCards: document.querySelectorAll('.card').length,
    hasCompiled: document.querySelectorAll('pre').length,
    statuses: [...document.querySelectorAll('.badge')].map((b) => b.innerText).slice(0, 6),
  }));
  note('queries', q);

  // ── Query Builder (the live estimate is the interesting part) ──
  await page.goto('http://localhost:5173/queries/new');
  await page.waitForTimeout(1500);
  const selects = page.locator('select');
  await selects.first().selectOption({ index: 1 });
  await page.waitForTimeout(2500);
  const qb = await page.evaluate(() => ({
    compiled: document.querySelector('pre')?.innerText?.slice(0, 130) ?? null,
    meters: [...document.querySelectorAll('.num')]
      .map((e) => e.innerText).filter((t) => t.includes('/100')),
    warnings: [...document.querySelectorAll('div')]
      .map((d) => d.innerText)
      .filter((t) => t.length < 220 && /يُقترح|استبعاد|اتساع|إعادات النشر|اللغة/.test(t))
      .slice(0, 3),
  }));
  note('query-builder', qb);

  // ── Live feed ──
  await page.goto('http://localhost:5173/live');
  await page.waitForTimeout(2500);
  const live = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.innerText ?? null,
    posts: document.querySelectorAll('.card').length,
    sample: document.querySelectorAll('.card')[0]?.innerText?.replace(/\s+/g, ' ').slice(0, 110) ?? null,
    whyButtons: [...document.querySelectorAll('button')]
      .filter((b) => b.innerText.includes('لماذا جمعنا')).length,
  }));
  note('live-feed', live);

  // ── Admin ──
  await page.goto('http://localhost:5173/admin');
  await page.waitForTimeout(2200);
  const admin = await page.evaluate(() => ({
    heading: document.querySelector('h1')?.innerText ?? null,
    auditRows: document.querySelectorAll('tbody tr').length,
    hasModeInfo: document.body.innerText.includes('LIVE_X_API'),
  }));
  note('admin', admin);

  // ── Dark mode ──
  const themeBtn = page.locator('aside button').first();
  await themeBtn.click();
  await page.waitForTimeout(700);
  note('dark-mode', {
    htmlClass: await page.evaluate(() => document.documentElement.className),
    bodyBg: await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  });

  return out;
}
