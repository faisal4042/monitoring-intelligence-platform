import { sql, normalizeArabic } from '@mip/db';

interface DictEntry {
  term: string;
  normalized: string;
  programId: string;
  programKey: string;
  weight: number;
}

interface TopicEntry {
  id: string;
  programId: string;
  name: string;
  normalized: string;
  tokens: string[];
}

interface GeneralTerm {
  term: string;
  programKey: 'ejar' | 'rega' | 'mostadam' | 'mullak';
  weight?: number;
}

// These terms are intentionally written as real UTF-8 Arabic. The previous
// file contained mojibake literals, so only database phrases worked and basic
// words such as "عقارية" silently failed.
const GENERAL_TERMS: GeneralTerm[] = [
  { term: 'الهيئة العامة للعقار', programKey: 'rega', weight: 100 },
  { term: 'هيئة العقار', programKey: 'rega', weight: 95 },
  { term: 'السجل العقاري', programKey: 'rega', weight: 95 },
  { term: 'المعهد العقاري', programKey: 'rega', weight: 95 },
  { term: 'فرز الوحدات', programKey: 'rega', weight: 95 },
  { term: 'رخصة فال', programKey: 'rega', weight: 95 },
  { term: 'الوساطة العقارية', programKey: 'rega', weight: 90 },
  { term: 'التصرفات العقارية', programKey: 'rega', weight: 90 },
  { term: 'التسجيل العيني', programKey: 'rega', weight: 90 },
  { term: 'التوازن العقاري', programKey: 'rega', weight: 90 },
  { term: 'السوق العقاري', programKey: 'rega', weight: 85 },
  { term: 'القطاع العقاري', programKey: 'rega', weight: 85 },
  { term: 'التطوير العقاري', programKey: 'rega', weight: 80 },
  { term: 'الاستثمار العقاري', programKey: 'rega', weight: 80 },
  { term: 'التمويل العقاري', programKey: 'rega', weight: 80 },
  { term: 'عقار', programKey: 'rega', weight: 65 },
  { term: 'العقار', programKey: 'rega', weight: 65 },
  { term: 'عقارات', programKey: 'rega', weight: 65 },
  { term: 'العقارات', programKey: 'rega', weight: 65 },
  { term: 'عقاري', programKey: 'rega', weight: 65 },
  { term: 'العقاري', programKey: 'rega', weight: 65 },
  { term: 'عقارية', programKey: 'rega', weight: 65 },
  { term: 'العقارية', programKey: 'rega', weight: 65 },
  { term: 'الإسكان', programKey: 'rega', weight: 60 },
  { term: 'سكني', programKey: 'rega', weight: 60 },
  { term: 'سكنية', programKey: 'rega', weight: 60 },
  { term: 'أراض سكنية', programKey: 'rega', weight: 65 },
  { term: 'أراضي سكنية', programKey: 'rega', weight: 65 },
  { term: 'وحدات سكنية', programKey: 'rega', weight: 65 },
  { term: 'مخطط سكني', programKey: 'rega', weight: 65 },
  { term: 'مشروع سكني', programKey: 'rega', weight: 65 },

  { term: 'منصة إيجار', programKey: 'ejar', weight: 100 },
  { term: 'شبكة إيجار', programKey: 'ejar', weight: 100 },
  { term: 'إيجار بلس', programKey: 'ejar', weight: 100 },
  { term: 'مؤشر السلوك الإيجاري', programKey: 'ejar', weight: 95 },
  { term: 'عقد الإيجار', programKey: 'ejar', weight: 90 },
  { term: 'عقود الإيجار', programKey: 'ejar', weight: 90 },
  { term: 'العقود الإيجارية', programKey: 'ejar', weight: 90 },
  { term: 'الإيجار', programKey: 'ejar', weight: 65 },
  { term: 'إيجار', programKey: 'ejar', weight: 70 },
  { term: 'إيجارات', programKey: 'ejar', weight: 65 },
  { term: 'الإيجارات', programKey: 'ejar', weight: 65 },
  { term: 'إيجارية', programKey: 'ejar', weight: 65 },
  { term: 'مستأجر', programKey: 'ejar', weight: 65 },
  { term: 'مؤجر', programKey: 'ejar', weight: 65 },
  { term: 'تأجير', programKey: 'ejar', weight: 65 },

  { term: 'برنامج البناء المستدام', programKey: 'mostadam', weight: 100 },
  { term: 'منصة البناء المستدام', programKey: 'mostadam', weight: 100 },
  { term: 'شهادة مستدام', programKey: 'mostadam', weight: 95 },
  { term: 'تقييم مستدام', programKey: 'mostadam', weight: 95 },
  { term: 'استدامة المباني', programKey: 'mostadam', weight: 85 },
  { term: 'المباني المستدامة', programKey: 'mostadam', weight: 85 },
  { term: 'البناء الأخضر', programKey: 'mostadam', weight: 80 },

  { term: 'منصة ملاك', programKey: 'mullak', weight: 100 },
  { term: 'برنامج ملاك', programKey: 'mullak', weight: 100 },
  { term: 'جمعية الملاك', programKey: 'mullak', weight: 95 },
  { term: 'جمعيات الملاك', programKey: 'mullak', weight: 95 },
  { term: 'اتحاد الملاك', programKey: 'mullak', weight: 90 },
  { term: 'ملاك العقارات المشتركة', programKey: 'mullak', weight: 90 },
];

const STOP_WORDS = new Set([
  'في', 'من', 'إلى', 'على', 'عن', 'مع', 'أو', 'و', 'التي', 'الذي', 'هذا', 'هذه',
  'برنامج', 'منصة', 'الهيئة', 'العامة', 'وزارة', 'عقار', 'العقار', 'عقارات',
  'العقارات', 'عقاري', 'العقاري', 'عقارية', 'العقارية', 'الإسكان', 'سكني', 'سكنية',
  'إيجار', 'الإيجار', 'إيجارات', 'الإيجارات', 'إيجارية', 'المؤجر', 'مؤجر', 'المستأجر', 'مستأجر',
].map(normalizeArabic));
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { entries: DictEntry[]; topics: TopicEntry[]; loadedAt: number } | null = null;

function tokens(value: string): string[] {
  return normalizeArabic(value).split(' ').map((token) => {
    // Canonicalise attached Arabic particles for semantic overlap:
    // والوساطة / بالوساطة / للوساطة -> وساطه.
    const canonical = token.replace(/^[وف]?(?:[بك]?ال|لل)/u, '');
    return canonical.length >= 3 ? canonical : token;
  }).filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !STOP_WORDS.has(`ال${token}`));
}

async function loadMatchers() {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  const programs = await sql<{ id: string; key: string }[]>`SELECT id, key FROM programs WHERE is_active`;
  const byKey = new Map(programs.map((program) => [program.key, program.id]));
  const rows = await sql<{ term: string; term_normalized: string; program_id: string; program_key: string }[]>`
    SELECT DISTINCT k.term, k.term_normalized, g.program_id, p.key AS program_key
    FROM keywords k
    JOIN keyword_groups g ON g.id = k.group_id
    JOIN programs p ON p.id = g.program_id
    WHERE k.is_active AND g.is_active AND k.type IN ('primary', 'service')`;
  const entries: DictEntry[] = rows.map((row) => ({
    term: row.term,
    normalized: row.term_normalized,
    programId: row.program_id,
    programKey: row.program_key,
    weight: 100,
  }));
  for (const item of GENERAL_TERMS) {
    const programId = byKey.get(item.programKey);
    if (!programId) continue;
    entries.push({
      term: item.term,
      normalized: normalizeArabic(item.term),
      programId,
      programKey: item.programKey,
      weight: item.weight ?? 70,
    });
  }
  entries.sort((a, b) => b.weight - a.weight || b.normalized.length - a.normalized.length);

  const topicRows = await sql<{ id: string; program_id: string; name_ar: string; description: string | null }[]>`
    SELECT id, program_id, name_ar, description
    FROM topics WHERE is_active
    ORDER BY level DESC, name_ar`;
  const topics = topicRows.map((topic) => ({
    id: topic.id,
    programId: topic.program_id,
    name: topic.name_ar,
    normalized: normalizeArabic(topic.name_ar),
    tokens: tokens(topic.name_ar),
  }));
  cache = { entries, topics, loadedAt: Date.now() };
  return cache;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasWordBoundaryMatch(haystack: string, needle: string): boolean {
  // Arabic conjunctions and prepositions attach to the following word:
  // "والإسكان", "بالعقار", "فللهيئة". Treat those prefixes as part of
  // the boundary instead of rejecting an otherwise exact dictionary term.
  const attachedPrefix = needle.startsWith('ال') ? '[وف]?[بكل]?' : '';
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${attachedPrefix}${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u');
  return pattern.test(haystack);
}

function selectTopic(programId: string, haystack: string, matchedTerm: string, topics: TopicEntry[]): string | null {
  const articleTokens = new Set(tokens(haystack));
  const matchedTokens = new Set(tokens(matchedTerm));
  let best: { id: string; score: number } | null = null;
  for (const topic of topics) {
    if (topic.programId !== programId) continue;
    let overlap = 0;
    let matchedOverlap = 0;
    for (const token of topic.tokens) if (articleTokens.has(token)) overlap++;
    for (const token of topic.tokens) if (matchedTokens.has(token)) matchedOverlap++;
    const exactBonus = hasWordBoundaryMatch(haystack, normalizeArabic(topic.name)) ? 4 : 0;
    const score = exactBonus + overlap + matchedOverlap * 3;
    if (score > (best?.score ?? 0)) best = { id: topic.id, score };
  }
  return best && best.score >= 1 ? best.id : null;
}

export interface RelevanceResult {
  isRelevant: boolean;
  matchedKeyword: string | null;
  programId: string | null;
  topicId: string | null;
  score: number;
}

export async function checkRelevance(title: string, description: string | null): Promise<RelevanceResult> {
  const plainDescription = (description ?? '').replace(/<[^>]+>/g, ' ');
  const normalizedTitle = normalizeArabic(title);
  const haystack = normalizeArabic(`${title} ${plainDescription}`);
  const { entries, topics } = await loadMatchers();
  const titleMatch = entries.find((entry) => entry.normalized && hasWordBoundaryMatch(normalizedTitle, entry.normalized));
  const match = titleMatch ?? entries.find((entry) => entry.normalized && hasWordBoundaryMatch(haystack, entry.normalized));
  if (!match) return { isRelevant: false, matchedKeyword: null, programId: null, topicId: null, score: 0 };

  // Feed descriptions sometimes contain navigation or "related stories".
  // A generic property word found only there is too weak; only a distinctive
  // authority/program/service phrase may classify an otherwise vague title.
  if (!titleMatch && match.weight < 90) {
    return { isRelevant: false, matchedKeyword: null, programId: null, topicId: null, score: 0 };
  }

  // A personal appeal containing the word "rent" is not news about Ejar.
  // Keep broad rent terms only when the text also carries a contract,
  // regulatory, platform, or market context.
  if (match.programKey === 'ejar' && match.weight <= 90) {
    const personalAppeal = /(عائله|اسره|محتاج|مساعده|تبرع|سداد|متاخر|ظروف|التفاصيل الخاص)/u.test(haystack);
    const brandedContext = /(منصه ايجار|شبكه ايجار|ايجار بلس|ايجار توضح|اوضحت ايجار|ايجار (?:تضبط|تعلن|تطلق|تحذر|تحدد|تكشف|تتيح|تلزم|تدعو|تجيب))/u.test(haystack);
    const institutionalContext = /(توثيق|رقمي|الكتروني|نظام|تنظيم|لائحه|مؤشر|سوق ايجاري|قطاع ايجاري|هيئه|وزاره|برنامج|حساب المواطن|الموجر والمستاجر|العلاقه الايجاريه|السلوك الايجاري)/u.test(haystack);
    const foreignContext = /(مصر|المصري|ابوظبي|دبي|الامارات|قطر|الكويت|لبنان|اسبانيا|امريكا|واشنطن|فنزويلا|فيتنام|اوروبا)/u.test(haystack);
    const saudiContext = /(السعوديه|المملكه|الرياض|جده|مكه|المدينه|الدمام|الخبر|القصيم|جازان|تبوك|عسير|الشرقيه)/u.test(haystack);
    const corporateLease = /(شركه|توقع عقد|الغاء ترسيه|ارض|مبني|بق?يمه|مركز بيانات|مدرسه)/u.test(haystack);
    if (!brandedContext && (personalAppeal || !institutionalContext
      || (foreignContext && !saudiContext) || corporateLease)) {
      return { isRelevant: false, matchedKeyword: null, programId: null, topicId: null, score: 0 };
    }
  }

  // Broad property words in a Saudi monitoring feed should not surface an
  // unrelated overseas story. Explicit authority/program/service phrases
  // remain accepted regardless of geography.
  if (match.programKey === 'rega' && match.weight <= 65) {
    const foreignContext = /(الصين|الصينيه|امريكا|الولايات المتحده|بريطانيا|اوروبا|روسيا|الهند|تركيا|مصر|الامارات|دبي|ايفرجراند)/u.test(haystack);
    const saudiContext = /(السعوديه|المملكه|الرياض|جده|مكه|المدينه|الدمام|الخبر|القصيم|جازان|تبوك|عسير|الشرقيه|الماجديه)/u.test(haystack);
    if (foreignContext && !saudiContext) {
      return { isRelevant: false, matchedKeyword: null, programId: null, topicId: null, score: 0 };
    }
  }
  return {
    isRelevant: true,
    matchedKeyword: match.term,
    programId: match.programId,
    // Topic assignment is based on the headline only. Feed descriptions may
    // contain related links and generic service words that would otherwise
    // attach a correct article to an unrelated complaint topic.
    topicId: selectTopic(match.programId, normalizedTitle, match.term, topics),
    score: match.weight,
  };
}

export function clearRelevanceCache() {
  cache = null;
}
