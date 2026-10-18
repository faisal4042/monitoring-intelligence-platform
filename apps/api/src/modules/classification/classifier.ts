/**
 * Stage 1 — the rule filter. Costs nothing and rejects roughly a third of
 * everything X returns before any model is involved (docs/AI_PIPELINE.md §3).
 *
 * Stage 2/3 (embeddings + LLM) arrive in Phase 2. Until then, Stage 1 is
 * followed by a transparent heuristic so the Sandbox produces a real precision
 * number rather than a placeholder — and every result records which stage
 * decided it, so the cost pyramid stays measurable from day one.
 *
 * Rejected posts are kept with a reason, never deleted: they are the only
 * source of truth for per-keyword noise rates.
 */
import { sql, normalizeArabic } from '@mip/db';
import type { RelevanceLabel, IntentLabel, SentimentLabel } from '@mip/shared';

export interface ClassificationResult {
  relevance: RelevanceLabel;
  confidence: number;
  intent: IntentLabel | null;
  sentiment: SentimentLabel;
  sentimentScore: number;
  stage: 1 | 2 | 3;
  filterReason: string | null;
  reasonAr: string;
  matchedTerms: string[];
}

// ── Advertising signals ────────────────────────────────────────────
const PHONE = /(?:\+?966|0)?5\d{8}|\d{4}\s?\d{3}\s?\d{3}/;
const PRICE = /\d[\d,.]*\s*(?:ريال|ألف|الف|ر\.?س|SAR)/i;
const AUTOMATED_TIMESTAMP = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s+at\s+\d{1,2}:\d{2}(?:AM|PM)\b/i;
const NSFW_PATTERNS = [
  /زانق\s+(?:امك|أمك)/u,
  /(?:^|[^\p{L}\p{N}_])(?:انيك|أنيك|نيك|سكس|بورنو|porn|xxx)(?:$|[^\p{L}\p{N}_])/iu,
  /(?:مقطع|فيديو|فديو)\s+(?:اباحي|إباحي|جنسي)/u,
];
const AD_PHRASES = [
  'للتواصل', 'للجادين', 'احجز الآن', 'اتصل الآن', 'رابط بالبايو', 'واتساب',
  'عروض خاصة', 'أسعار منافسة', 'اسعار منافسه', 'توصيل مجاني', 'إعلان مدفوع',
];

const SPAM_PHRASES = ['تابعني وأتابعك', 'متابعة', 'ربح', 'تداول', 'فوركس', 'اربح'];

// Commercial real-estate copy often omits prices and uses the regulator or a
// platform name as a credential. Multiple phrases below are enough to prove
// that the post is promotional even when no price is present.
const STRONG_AD_PHRASES = [
  'رحلتك العقارية', 'نختص بـ', 'نختص ب', 'التسويق العقاري',
  'تسويق جميع أنواع العقارات', 'للتواصل والاستفسارات', 'للتواصل على الخاص',
  'حاصل على رخصة', 'مرخصة بإدارة الأملاك', 'مرخص بإدارة الأملاك',
  'مسجلة كمدير عقار', 'مسجل كمدير عقار', 'خدماتنا العقارية',
];

// ── Intent signals ─────────────────────────────────────────────────
const COMPLAINT = ['ما يتوثق', 'ما يشتغل', 'مو قادر', 'ما اقدر', 'مشكله', 'مشكلة', 'يرفض',
  'واقف', 'معلق', 'متوقف', 'خطأ', 'تعبنا', 'ما يرد', 'تأخر', 'تاخر', 'مرفوض', 'ما تم', 'بدون اشعار'];
const INQUIRY = ['كيف', 'وش', 'متى', 'هل', 'كم', 'ليش', 'ايش', 'ما هي', 'شروط', '؟'];
const PRAISE = ['شكرا', 'شكراً', 'ممتاز', 'رائع', 'سهل', 'سريع', 'تجربتي', 'جميل', 'أفضل'];
const NEWS = ['تعلن', 'إطلاق', 'اطلاق', 'تحديث', 'صدر', 'وقعت', 'اعتماد'];

// Requests for charitable or humanitarian help can mention rent as a living
// expense without being about the Ejar platform (or any monitored program).
// Require two contextual signals and do not apply this guard when an official
// program/brand term is present.
const OUT_OF_SCOPE_ASSISTANCE = [
  'عائلة متعففة', 'العائلة متعففه', 'حالة انسانية', 'حالة إنسانية',
  'محتاجين يدفعو', 'مساعدة في دفع الايجار', 'تبرع', 'صدقة',
  'ساعدوهم', 'التفاصيل الكامله dm', 'التفاصيل كاملة dm',
];

const NEGATIVE_WORDS = ['مشكلة', 'مشكله', 'يرفض', 'ما يشتغل', 'خطأ', 'تعبنا', 'سيء', 'فشل',
  'مرفوض', 'تأخر', 'متوقف', 'واقف', 'ما يرد', 'زعلان', 'مستاء'];
const POSITIVE_WORDS = ['شكرا', 'شكراً', 'ممتاز', 'رائع', 'سهل', 'سريع', 'أفضل', 'جميل', 'مشكور'];

interface Dict {
  negatives: Array<{ id: string; term: string; normalized: string }>;
  positives: Array<{ id: string; term: string; normalized: string; type: string }>;
  sensitive: Array<{ term: string; normalized: string }>;
}

export async function loadDictionary(programId?: string): Promise<Dict> {
  const rows = await sql<{ id: string; term: string; term_normalized: string; type: string }[]>`
    SELECT id, term, term_normalized, type
    FROM keywords
    WHERE is_active AND (${programId ?? null}::uuid IS NULL OR program_id = ${programId ?? null}::uuid)`;

  return {
    negatives: rows.filter((r) => r.type === 'negative').map((r) => ({ id: r.id, term: r.term, normalized: r.term_normalized })),
    // Related terms such as "عقد" and "توثيق" are useful context, but they
    // are far too broad to prove relevance on their own. Automatic collection
    // is accepted only when an official/brand term or an approved service
    // phrase matches exactly after Arabic normalisation.
    positives: rows.filter((r) => r.type === 'primary' || r.type === 'service')
      .map((r) => ({ id: r.id, term: r.term, normalized: r.term_normalized, type: r.type })),
    sensitive: rows.filter((r) => r.type === 'sensitive').map((r) => ({ term: r.term, normalized: r.term_normalized })),
  };
}

function countHits(haystack: string, needles: string[]): number {
  return needles.reduce((n, w) => (haystack.includes(normalizeArabic(w)) ? n + 1 : n), 0);
}

export function classify(text: string, dict: Dict): ClassificationResult {
  const norm = normalizeArabic(text);
  const hashtagCount = (text.match(/#/g) ?? []).length;

  const matchedNegatives = dict.negatives.filter((n) => n.normalized && norm.includes(n.normalized));
  const matchedPositives = dict.positives.filter((p) => p.normalized && norm.includes(p.normalized));
  const matchedPrimary = matchedPositives.filter((p) => p.type === 'primary');
  const matchedTerms = matchedPositives.map((p) => p.term);

  if (NSFW_PATTERNS.some((pattern) => pattern.test(norm))) {
    return {
      relevance: 'irrelevant', confidence: 0.98, intent: null,
      sentiment: 'neutral', sentimentScore: 0, stage: 1,
      filterReason: 'unsafe_sexual_content',
      reasonAr: 'محتوى جنسي أو غير أخلاقي — مستبعد تلقائيًا',
      matchedTerms,
    };
  }

  if (matchedPrimary.length === 0 && countHits(norm, OUT_OF_SCOPE_ASSISTANCE) >= 2) {
    return {
      relevance: 'irrelevant', confidence: 0.97, intent: null,
      sentiment: 'neutral', sentimentScore: 0, stage: 1,
      filterReason: 'out_of_scope_assistance',
      reasonAr: 'طلب مساعدة أو حالة إنسانية تذكر الإيجار عرضاً دون ارتباط بالبرنامج',
      matchedTerms,
    };
  }

  // ── Stage 1: rule filter ────────────────────────────────────────
  if (matchedNegatives.length > 0) {
    return {
      relevance: 'advertisement', confidence: 0.93, intent: null,
      sentiment: 'neutral', sentimentScore: 0, stage: 1,
      filterReason: `negative_keyword:${matchedNegatives[0].term}`,
      reasonAr: `طابق كلمة مستبعدة: «${matchedNegatives[0].term}»`,
      matchedTerms,
    };
  }

  if (hashtagCount >= 5 || countHits(norm, SPAM_PHRASES) >= 2 || AUTOMATED_TIMESTAMP.test(text)) {
    return {
      relevance: 'spam', confidence: 0.88, intent: null,
      sentiment: 'neutral', sentimentScore: 0, stage: 1,
      filterReason: hashtagCount >= 5 ? 'excessive_hashtags'
        : AUTOMATED_TIMESTAMP.test(text) ? 'automated_timestamp' : 'spam_phrases',
      reasonAr: hashtagCount >= 5 ? `عدد الهاشتاقات ${hashtagCount} — نمط spam`
        : AUTOMATED_TIMESTAMP.test(text) ? 'نمط نشر آلي متكرر مرفق بطابع زمني' : 'عبارات spam متكررة',
      matchedTerms,
    };
  }

  const hasPhone = PHONE.test(text);
  const hasPrice = PRICE.test(text);
  const adPhraseHits = countHits(norm, AD_PHRASES);
  const strongAdHits = countHits(norm, STRONG_AD_PHRASES);
  const adSignals = (hasPhone ? 1 : 0) + (hasPrice ? 1 : 0) + (adPhraseHits > 0 ? 1 : 0);
  if (adSignals >= 2 || strongAdHits >= 2 || (hasPhone && strongAdHits >= 1)) {
    return {
      relevance: 'advertisement', confidence: 0.84, intent: null,
      sentiment: 'neutral', sentimentScore: 0, stage: 1,
      filterReason: 'ad_pattern',
      reasonAr: 'نمط إعلاني: رقم تواصل و/أو سعر مع عبارة تسويقية',
      matchedTerms,
    };
  }

  const stripped = text.replace(/@\w+/g, '').replace(/https?:\/\/\S+/g, '').trim();
  if (stripped.length < 15) {
    return {
      relevance: 'irrelevant', confidence: 0.7, intent: null,
      sentiment: 'neutral', sentimentScore: 0, stage: 1,
      filterReason: 'too_short',
      reasonAr: 'النص قصير جداً بعد إزالة المنشنات والروابط',
      matchedTerms,
    };
  }

  // ── Stage 2 (heuristic stand-in until embeddings land) ──────────
  if (matchedPositives.length === 0) {
    return {
      relevance: 'unknown', confidence: 0.4, intent: null,
      sentiment: 'neutral', sentimentScore: 0, stage: 2,
      filterReason: null,
      reasonAr: 'لم يطابق أي كلمة في القاموس — يحتاج مراجعة بشرية',
      matchedTerms,
    };
  }

  const complaint = countHits(norm, COMPLAINT);
  const inquiry = countHits(norm, INQUIRY) + (text.includes('؟') || text.includes('?') ? 1 : 0);
  const praise = countHits(norm, PRAISE);
  const news = countHits(norm, NEWS);

  let intent: IntentLabel = 'other';
  let reasonAr = 'مرتبط بالقاموس';
  if (complaint >= praise && complaint >= inquiry && complaint > 0) {
    intent = 'complaint'; reasonAr = 'يحوي مؤشرات شكوى صريحة';
  } else if (inquiry > praise && inquiry > 0) {
    intent = 'inquiry'; reasonAr = 'صيغة استفسار';
  } else if (praise > 0) {
    intent = 'praise'; reasonAr = 'صيغة إشادة';
  } else if (news > 0) {
    intent = 'news'; reasonAr = 'صيغة خبرية';
  } else {
    intent = 'experience';
  }

  const neg = countHits(norm, NEGATIVE_WORDS);
  const pos = countHits(norm, POSITIVE_WORDS);
  const score = (pos - neg) / Math.max(1, pos + neg);
  let sentiment: SentimentLabel = 'neutral';
  if (score <= -0.6) sentiment = 'very_negative';
  else if (score < 0) sentiment = 'negative';
  else if (score >= 0.6) sentiment = 'very_positive';
  else if (score > 0) sentiment = 'positive';

  // More dictionary hits => more confident it is genuinely about us.
  const confidence = Math.min(0.95, 0.55 + matchedPositives.length * 0.12);

  return {
    relevance: 'relevant',
    confidence,
    intent,
    sentiment,
    sentimentScore: score,
    stage: 2,
    filterReason: null,
    reasonAr: `${reasonAr} (طابق: ${matchedTerms.slice(0, 3).join('، ')})`,
    matchedTerms,
  };
}

/**
 * Per-keyword noise contribution: the number that turns "precision is 60%" into
 * "the word «تأجير» is what is costing you". Without this the Sandbox produces
 * a score but no action (docs/X_API_STRATEGY.md §6.2).
 */
export function keywordContribution(
  results: Array<{ matchedTerms: string[]; relevance: RelevanceLabel }>,
): Record<string, { matched: number; noise: number; noiseRate: number }> {
  const acc: Record<string, { matched: number; noise: number; noiseRate: number }> = {};
  for (const r of results) {
    for (const term of r.matchedTerms) {
      acc[term] ??= { matched: 0, noise: 0, noiseRate: 0 };
      acc[term].matched += 1;
      if (r.relevance !== 'relevant') acc[term].noise += 1;
    }
  }
  for (const term of Object.keys(acc)) {
    acc[term].noiseRate = acc[term].matched ? acc[term].noise / acc[term].matched : 0;
  }
  return acc;
}

export interface Recommendation {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  messageAr: string;
  action?: Record<string, unknown>;
}

export function buildRecommendations(
  results: Array<{ matchedTerms: string[]; relevance: RelevanceLabel; text: string }>,
  contribution: Record<string, { matched: number; noise: number; noiseRate: number }>,
  precision: number,
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const [term, stats] of Object.entries(contribution)) {
    if (stats.matched >= 3 && stats.noiseRate >= 0.6) {
      recs.push({
        type: 'add_negative',
        severity: 'critical',
        messageAr: `كلمة «${term}» طابقت ${stats.matched} منشوراً، ${Math.round(stats.noiseRate * 100)}% منها غير مرتبط. يُقترح تضييقها أو استبعادها.`,
        action: { op: 'review_keyword', term },
      });
    }
  }

  const ads = results.filter((r) => r.relevance === 'advertisement').length;
  if (ads > 0 && ads / Math.max(1, results.length) > 0.25) {
    recs.push({
      type: 'add_negative',
      severity: 'warning',
      messageAr: `${ads} من ${results.length} نتيجة إعلانات عقارية. أضف كلمات سالبة مثل «للإيجار السنوي» و«للجادين» لتقليل الهدر.`,
      action: { op: 'suggest_negatives', terms: ['للإيجار السنوي', 'للجادين', 'للتواصل'] },
    });
  }

  const unknown = results.filter((r) => r.relevance === 'unknown').length;
  if (unknown / Math.max(1, results.length) > 0.3) {
    recs.push({
      type: 'expand_dictionary',
      severity: 'warning',
      messageAr: `${unknown} منشوراً لم يطابق أي كلمة في القاموس. راجعها — قد تحوي عبارات جديدة يستخدمها الجمهور ولم تُسجَّل بعد.`,
    });
  }

  const spam = results.filter((r) => r.relevance === 'spam').length;
  if (spam > 0) {
    recs.push({
      type: 'spam_present',
      severity: 'info',
      messageAr: `${spam} من ${results.length} نتيجة صُنّفت spam (هاشتاقات مفرطة أو محتوى ترويجي). استبعادها يتم في المرحلة 1 بلا تكلفة.`,
    });
  }

  // Coverage matters as much as precision: a query that returns almost nothing
  // can score 100% and still be useless. Say so.
  if (results.length > 0 && results.length < 5) {
    recs.push({
      type: 'low_recall',
      severity: 'warning',
      messageAr: `عاد ${results.length} نتيجة فقط. الدقة عالية لكن التغطية منخفضة — قد يكون الاستعلام ضيقاً جداً ويفوّت شكاوى حقيقية. جرّب OR بين الكلمات الأساسية وكلمات الخدمات بدل AND.`,
      action: { op: 'widen_query' },
    });
  }

  // Every band must yield guidance. Previously 70-85% — the most common
  // outcome — produced no recommendation at all.
  if (precision < 0.7) {
    recs.push({
      type: 'blocked',
      severity: 'critical',
      messageAr: `الدقة ${Math.round(precision * 100)}% أقل من الحد الأدنى المطلوب (70%). لن يُسمح بترقية هذا الاستعلام قبل تحسينه.`,
    });
  } else if (precision < 0.85) {
    recs.push({
      type: 'improve',
      severity: 'warning',
      messageAr: `الدقة ${Math.round(precision * 100)}% تكفي للترقية لكنها ليست مثالية. كل 10% تحسّن في الدقة توفّر ما يعادلها من الميزانية — راجع جدول مساهمة الكلمات أدناه.`,
    });
  } else {
    recs.push({
      type: 'ok',
      severity: 'info',
      messageAr: `دقة ممتازة (${Math.round(precision * 100)}%). الاستعلام جاهز للترقية إلى الإنتاج.`,
    });
  }

  return recs;
}
