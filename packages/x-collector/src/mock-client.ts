/**
 * DEMO MODE data source. Used whenever LIVE_X_API=false, which is the default.
 *
 * The samples deliberately mix genuine complaints, inquiries, praise, property
 * ads and spam, because the whole point of the filtering and precision work is
 * that raw X results are mostly noise. A mock that returns only clean, relevant
 * posts would make the pipeline look good and teach us nothing.
 */
import type { SearchRequest, XPost, XUser } from './types.js';
import { compileMatcher } from './query-match.js';

interface Sample { text: string; kind: 'complaint' | 'inquiry' | 'praise' | 'ad' | 'spam' | 'news'; author: string }

const SAMPLES: Sample[] = [
  // ── Genuine complaints, written the way people actually write ──
  { text: 'العقد ما يتوثق من أمس والدعم ما يرد، وش الحل؟ @Ejar_Sa', kind: 'complaint', author: 'u_faisal' },
  { text: 'مو قادر أوثق العقد يطلع لي خطأ في المنصة كل مرة', kind: 'complaint', author: 'u_nora' },
  { text: 'التوثيق واقف عندي من ثلاث أيام والمستأجر ينتظر', kind: 'complaint', author: 'u_saad' },
  { text: 'إيجار يرفض العقد بدون ما يوضح السبب، تعبنا والله', kind: 'complaint', author: 'u_ahmed' },
  { text: 'العقد معلق ما وصلني قبول من المستأجر مع إني أرسلته من أسبوع', kind: 'complaint', author: 'u_hind' },
  { text: 'سددت الإيجار من يومين والحالة ما تحدثت في المنصة', kind: 'complaint', author: 'u_khalid' },
  { text: 'ليش تجديد العقد ما يشتغل؟ كل ما أضغط تجديد يطلع خطأ', kind: 'complaint', author: 'u_reem' },
  { text: 'طلبت فسخ العقد قبل شهر ولين الحين ما تم شي', kind: 'complaint', author: 'u_majed' },
  { text: 'الوسيط رافع العقد بمبلغ غلط وما أقدر أعدل', kind: 'complaint', author: 'u_layla' },
  { text: 'منصة ملاك ما تقبل تسجيل الاتحاد عندنا من شهر', kind: 'complaint', author: 'u_omar' },
  { text: 'رسوم اتحاد الملاك ارتفعت بدون إشعار مسبق', kind: 'complaint', author: 'u_dana' },
  { text: 'طلب فرز الوحدات مرفوض والسبب غير واضح إطلاقاً', kind: 'complaint', author: 'u_bandar' },
  { text: 'التسجيل العقاري متوقف عندي والصك ما ينزل', kind: 'complaint', author: 'u_yasser' },
  { text: 'شهادة البناء المستدام تأخرت أكثر من المدة المعلنة', kind: 'complaint', author: 'u_areej' },

  // ── Inquiries ──
  { text: 'كيف أقدر أوثق عقد الإيجار إلكترونياً؟ وش المستندات المطلوبة', kind: 'inquiry', author: 'u_tariq' },
  { text: 'هل تجديد العقد تلقائي ولا لازم أجدد يدوي في منصة إيجار؟', kind: 'inquiry', author: 'u_mona' },
  { text: 'وش شروط الحصول على رخصة الوساطة العقارية؟', kind: 'inquiry', author: 'u_salem' },
  { text: 'متى تفتح دورات المعهد العقاري الجديدة؟', kind: 'inquiry', author: 'u_ghada' },
  { text: 'كم رسوم تسجيل اتحاد الملاك في منصة ملاك؟', kind: 'inquiry', author: 'u_fahad' },

  // ── Praise ──
  { text: 'صراحة توثيق العقد صار سهل وسريع بعد التحديث الأخير، شكراً إيجار', kind: 'praise', author: 'u_abdullah' },
  { text: 'تجربتي مع الهيئة العامة للعقار كانت ممتازة والخدمة سريعة', kind: 'praise', author: 'u_maha' },
  { text: 'شهادة مستدام وصلت أسرع من المتوقع، شكراً للفريق', kind: 'praise', author: 'u_rakan' },

  // ── Property ads — the noise the negative keywords exist to remove ──
  { text: 'شقة للإيجار في حي النرجس ٣ غرف وصالة السعر ٤٥ ألف للتواصل ٠٥٥٠٠٠٠٠٠٠', kind: 'ad', author: 'u_agent1' },
  { text: 'أرض للإيجار على شارعين بحي الياسمين مساحة ٩٠٠م للجادين فقط', kind: 'ad', author: 'u_agent2' },
  { text: 'فيلا للإيجار السنوي بحي الملقا تشطيب فاخر عروض خاصة هذا الشهر', kind: 'ad', author: 'u_agent1' },
  { text: 'تأجير معدات ثقيلة وحفارات بأسعار منافسة اتصل الآن', kind: 'ad', author: 'u_equip' },
  { text: 'سيارة للإيجار يومي وأسبوعي أسعار مخفضة وتوصيل مجاني', kind: 'ad', author: 'u_cars' },
  { text: 'استراحة للإيجار اليومي مع مسبح وملعب، احجز الآن قبل نفاد المواعيد', kind: 'ad', author: 'u_rest' },
  { text: 'مطلوب مستأجر لمحل تجاري بموقع مميز، إعلان مدفوع', kind: 'ad', author: 'u_agent2' },
  { text: 'دور للإيجار مدخل خاص بحي الصحافة، للتواصل واتساب', kind: 'ad', author: 'u_agent1' },

  // ── Spam ──
  { text: 'اربح الآن 💰💰 #ربح #تداول #فوركس #ذهب #عملات #استثمار #ايجار رابط بالبايو', kind: 'spam', author: 'u_spam1' },
  { text: 'تابعني وأتابعك 🔥 #متابعة #ايجار #عقار #الرياض #جدة #الدمام', kind: 'spam', author: 'u_spam2' },

  // ── News ──
  { text: 'الهيئة العامة للعقار تعلن عن تحديث جديد في لائحة الوساطة العقارية', kind: 'news', author: 'u_news' },
  { text: 'إطلاق خدمة جديدة في منصة إيجار لتسهيل توثيق العقود', kind: 'news', author: 'u_news' },
];


/**
 * DEMO avatars as inline data URIs. Real X profiles come back with a
 * profile_image_url; generating one here means the image path in the UI is
 * genuinely exercised in demo mode instead of always falling back to initials.
 */
function demoAvatar(seed: string, label: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const bg = `hsl(${hue} 55% 42%)`;
  const fg = `hsl(${hue} 60% 92%)`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" rx="48" fill="${bg}"/>` +
    `<text x="48" y="62" font-family="system-ui,sans-serif" font-size="40" font-weight="600" ` +
    `fill="${fg}" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const AUTHORS: Record<string, Omit<XUser, 'id'>> = {
  u_faisal:   { username: 'faisal_re', name: 'فيصل', description: 'مهتم بالقطاع العقاري', followersCount: 1240, followingCount: 320, tweetCount: 4100 },
  u_nora:     { username: 'nora_kh', name: 'نورة', description: '', followersCount: 480, followingCount: 210, tweetCount: 900 },
  u_saad:     { username: 'saad_alm', name: 'سعد', description: 'مؤجر', followersCount: 89, followingCount: 150, tweetCount: 300 },
  u_ahmed:    { username: 'ahmed_v', name: 'أحمد', description: 'كاتب رأي — مهتم بالشأن العقاري', followersCount: 142000, followingCount: 800, tweetCount: 22000, verified: true },
  u_hind:     { username: 'hind_s', name: 'هند', description: '', followersCount: 2300, followingCount: 400, tweetCount: 1800 },
  u_khalid:   { username: 'khalid_t', name: 'خالد', description: '', followersCount: 640, followingCount: 300, tweetCount: 1200 },
  u_reem:     { username: 'reem_a', name: 'ريم', description: '', followersCount: 15600, followingCount: 500, tweetCount: 6700 },
  u_majed:    { username: 'majed_q', name: 'ماجد', description: '', followersCount: 320, followingCount: 180, tweetCount: 700 },
  u_layla:    { username: 'layla_m', name: 'ليلى', description: 'وسيط عقاري مرخص', followersCount: 8900, followingCount: 1200, tweetCount: 5400 },
  u_omar:     { username: 'omar_h', name: 'عمر', description: '', followersCount: 1100, followingCount: 400, tweetCount: 2200 },
  u_dana:     { username: 'dana_r', name: 'دانة', description: '', followersCount: 3400, followingCount: 600, tweetCount: 2900 },
  u_bandar:   { username: 'bandar_z', name: 'بندر', description: 'مطور عقاري', followersCount: 27000, followingCount: 900, tweetCount: 11000, verified: true },
  u_yasser:   { username: 'yasser_n', name: 'ياسر', description: '', followersCount: 760, followingCount: 250, tweetCount: 1400 },
  u_areej:    { username: 'areej_b', name: 'أريج', description: 'مهندسة معمارية', followersCount: 5200, followingCount: 700, tweetCount: 3100 },
  u_tariq:    { username: 'tariq_w', name: 'طارق', description: '', followersCount: 210, followingCount: 190, tweetCount: 450 },
  u_mona:     { username: 'mona_f', name: 'منى', description: '', followersCount: 980, followingCount: 350, tweetCount: 1600 },
  u_salem:    { username: 'salem_g', name: 'سالم', description: '', followersCount: 430, followingCount: 220, tweetCount: 880 },
  u_ghada:    { username: 'ghada_l', name: 'غادة', description: '', followersCount: 1700, followingCount: 500, tweetCount: 2400 },
  u_fahad:    { username: 'fahad_y', name: 'فهد', description: '', followersCount: 5600, followingCount: 800, tweetCount: 4200 },
  u_abdullah: { username: 'abdullah_c', name: 'عبدالله', description: '', followersCount: 3200, followingCount: 450, tweetCount: 2700 },
  u_maha:     { username: 'maha_d', name: 'مها', description: '', followersCount: 890, followingCount: 300, tweetCount: 1500 },
  u_rakan:    { username: 'rakan_p', name: 'راكان', description: '', followersCount: 12400, followingCount: 600, tweetCount: 7800 },
  u_agent1:   { username: 'aqar_deals1', name: 'عقارات الرياض', description: 'تسويق عقاري — إعلانات', followersCount: 45000, followingCount: 12000, tweetCount: 89000 },
  u_agent2:   { username: 'aqar_deals2', name: 'مكتب العقار', description: 'بيع وتأجير', followersCount: 23000, followingCount: 9000, tweetCount: 54000 },
  u_equip:    { username: 'equip_rent', name: 'تأجير معدات', description: 'معدات ثقيلة', followersCount: 3400, followingCount: 2000, tweetCount: 9800 },
  u_cars:     { username: 'car_rent_sa', name: 'تأجير سيارات', description: '', followersCount: 18000, followingCount: 5000, tweetCount: 32000 },
  u_rest:     { username: 'rest_booking', name: 'استراحات', description: '', followersCount: 7600, followingCount: 3000, tweetCount: 15000 },
  u_spam1:    { username: 'win_now_x', name: 'أرباح', description: 'تداول', followersCount: 120, followingCount: 8000, tweetCount: 40000 },
  u_spam2:    { username: 'follow_back', name: 'متابعة', description: '', followersCount: 900, followingCount: 12000, tweetCount: 60000 },
  u_news:     { username: 'aqar_news', name: 'أخبار العقار', description: 'حساب إخباري', followersCount: 96000, followingCount: 200, tweetCount: 18000, verified: true },
};

for (const [key, a] of Object.entries(AUTHORS)) {
  a.profileImageUrl = demoAvatar(a.username, [...a.name][0] ?? key[2] ?? '?');
}

let counter = 1_800_000_000_000_000_000n;
function nextId(): string { counter += 137n; return counter.toString(); }

function extract(text: string, prefix: '#' | '@'): string[] {
  const re = prefix === '#' ? /#([\p{L}\p{N}_]+)/gu : /@([A-Za-z0-9_]+)/g;
  return [...text.matchAll(re)].map((m) => m[1]);
}

function metricsFor(kind: Sample['kind'], followers: number) {
  // Complaints from big accounts spread; ads mostly do not.
  const base = kind === 'complaint' ? 0.004 : kind === 'praise' ? 0.002 : kind === 'news' ? 0.003 : 0.0004;
  const reach = Math.max(1, Math.round(followers * base * (0.5 + Math.random())));
  return {
    like: reach,
    repost: Math.round(reach * 0.35),
    reply: Math.round(reach * 0.2),
    quote: Math.round(reach * 0.08),
  };
}

export class MockXClient {
  async searchRecent(req: SearchRequest): Promise<XPost[]> {
    // Simulate network latency so loading states get exercised.
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 280));

    // Results respond to the query, so a better query really does score better.
    const matches = compileMatcher(req.query);
    const hits = SAMPLES.filter((s) => matches({ text: s.text, lang: 'ar' }));

    // Honour since_id the way X does: once a watermark exists, only "new"
    // posts come back. Without this the biggest cost saver in the system would
    // be invisible in DEMO mode.
    const fresh = req.sinceId ? Math.max(0, Math.round(hits.length * 0.25)) : hits.length;

    const pool = [...hits]
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(req.maxResults, fresh));
    const now = Date.now();

    return pool.map((s, i) => {
      const author = AUTHORS[s.author];
      const id = nextId();
      return {
        id,
        text: s.text,
        createdAt: new Date(now - i * 7 * 60_000 - Math.random() * 3_600_000).toISOString(),
        authorId: s.author,
        lang: 'ar',
        conversationId: id,
        hashtags: extract(s.text, '#'),
        mentions: extract(s.text, '@'),
        urls: [],
        metrics: metricsFor(s.kind, author.followersCount),
        author: { id: s.author, ...author },
        media: [],
      } satisfies XPost;
    });
  }

  async getUsers(ids: string[]): Promise<XUser[]> {
    return ids.filter((id) => AUTHORS[id]).map((id) => ({ id, ...AUTHORS[id] }));
  }
}
