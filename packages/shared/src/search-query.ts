/**
 * Advanced search — the internal search language, its AST and the field
 * catalogue. Shared by the API (compiles to SQL) and the web app (chips,
 * suggestions, syntax errors).
 *
 * Deliberately separate from query-ast.ts: that AST is the contract of the X
 * collection compiler and is never produced here. Nothing in this module talks
 * to X; a search string is never sent to the X API.
 *
 * Grammar (tightest binding first):
 *   1. comma groups   a, b, c          → a OR b OR c (one word group)
 *   2. exclusion      -a   NOT a       → applies to the next group
 *   3. AND            a AND b   a b    → explicit or implied by a space
 *   4. OR             a OR b
 * Parentheses override all of the above. AND / OR / NOT are operators only in
 * capitals; lower-case "and"/"or" are ordinary words. A hyphen excludes only at
 * the start of a token (`-إعلان`); inside a word (`co-op`, `ثنائي-اللغة`) it is
 * part of the word. `"…"` is an exact phrase. `name:value` is a field when
 * `name` is in the catalogue; numbers take `>`, `<`, `>=`, `<=`.
 */

export const SEARCH_LIMITS = { maxLength: 500, maxNodes: 60, maxDepth: 8 } as const;

export type SearchEntity = 'posts' | 'news' | 'accounts' | 'tickets';
export const SEARCH_ENTITIES: SearchEntity[] = ['posts', 'news', 'accounts', 'tickets'];
export const SEARCH_ENTITY_LABELS: Record<SearchEntity, string> = {
  posts: 'المنشورات', news: 'الأخبار', accounts: 'الحسابات', tickets: 'تذاكر الطابور',
};

export type CompareOp = ':' | '>' | '<' | '>=' | '<=';
export interface Span { start: number; end: number }

export type SearchNode =
  | { type: 'and'; children: SearchNode[] }
  | { type: 'or'; children: SearchNode[] }
  | { type: 'not'; child: SearchNode; span: Span }
  | { type: 'term'; value: string; span: Span }
  | { type: 'phrase'; value: string; span: Span }
  | { type: 'field'; field: string; op: CompareOp; value: string; raw: string; span: Span };

export class SearchSyntaxError extends Error {
  constructor(message: string, public position: number) { super(message); }
}

// ── Field catalogue ─────────────────────────────────────────────────────────

export type FieldKind = 'domain' | 'enum' | 'number' | 'date' | 'bool' | 'id' | 'user' | 'text';

export interface FieldDef {
  name: string;
  aliases?: string[];
  kind: FieldKind;
  label: string;
  example: string;
  /** Allowed values for enum/bool fields; keys are canonical, values are accepted spellings. */
  values?: Record<string, string[]>;
  /** Entities that hold this data. */
  entities: SearchEntity[];
  /** Why the field cannot work, per entity (or for all). Shown instead of pretending. */
  unavailable?: Partial<Record<SearchEntity | 'all', string>>;
  group: 'content' | 'account' | 'classification' | 'engagement' | 'dates' | 'workflow' | 'source';
}

const BOOL = { true: ['true', 'yes', '1', 'نعم'], false: ['false', 'no', '0', 'لا'] };

export const SEARCH_FIELDS: FieldDef[] = [
  { name: 'site', kind: 'domain', label: 'نطاق الرابط', example: 'site:spa.gov.sa', entities: ['posts', 'news'], group: 'source',
    unavailable: { accounts: 'لا روابط للحسابات', tickets: 'استخدم تبويب المنشورات للروابط' } },
  { name: 'source', kind: 'text', label: 'المصدر الإخباري', example: 'source:سبق', entities: ['news'], group: 'source',
    unavailable: { posts: 'كل المنشورات من X؛ استخدم platform:x أو collection_reason:' } },
  { name: 'country', kind: 'enum', label: 'الدولة', example: 'country:SA', entities: ['news'], group: 'source',
    values: { SA: ['sa', 'ksa', 'السعودية', 'saudi'] },
    unavailable: { posts: 'لا توجد بيانات موقع موثوقة للحسابات؛ لا تُستنتج الدولة من اللغة', accounts: 'حقل الموقع فارغ لكل الحسابات المجمعة' } },
  { name: 'lang', aliases: ['language'], kind: 'enum', label: 'اللغة', example: 'lang:ar', entities: ['posts', 'news'], group: 'content',
    values: { ar: ['ar', 'عربي', 'arabic'], en: ['en', 'english', 'انجليزي'] } },
  { name: 'platform', kind: 'enum', label: 'المنصة', example: 'platform:x', entities: ['posts', 'news', 'accounts', 'tickets'], group: 'source',
    values: { x: ['x', 'twitter', 'تويتر', 'اكس'], news: ['news', 'web', 'اخبار', 'أخبار'] } },
  { name: 'user', aliases: ['from'], kind: 'user', label: 'الحساب', example: 'user:@REGA_KSA', entities: ['posts', 'accounts', 'tickets'], group: 'account' },
  { name: 'mention', kind: 'user', label: 'إشارة', example: 'mention:@REGA_KSA', entities: ['posts'], group: 'content' },
  { name: 'hashtag', kind: 'text', label: 'وسم', example: 'hashtag:إيجار', entities: ['posts'], group: 'content' },
  { name: 'followers', kind: 'number', label: 'المتابعون', example: 'followers:>10000', entities: ['posts', 'accounts', 'tickets'], group: 'account' },
  { name: 'verified', kind: 'bool', label: 'موثّق', example: 'verified:true', values: BOOL, entities: ['posts', 'accounts'], group: 'account' },
  { name: 'influencer', kind: 'bool', label: 'مؤثر متابَع', example: 'influencer:true', values: BOOL, entities: ['posts', 'accounts', 'tickets'], group: 'account' },
  { name: 'official', kind: 'bool', label: 'حساب رسمي لبرنامج', example: 'official:true', values: BOOL, entities: ['posts', 'accounts'], group: 'account' },
  { name: 'program', kind: 'text', label: 'البرنامج', example: 'program:إيجار', entities: ['posts', 'news', 'tickets'], group: 'classification' },
  { name: 'topic', kind: 'text', label: 'الموضوع / التصنيف', example: 'topic:التجديد_التلقائي', entities: ['posts', 'news', 'tickets'], group: 'classification' },
  { name: 'classification', aliases: ['intent'], kind: 'enum', label: 'نوع التفاعل', example: 'classification:شكوى', entities: ['posts', 'tickets'], group: 'classification',
    values: { complaint: ['complaint', 'شكوى', 'شكاوى'], inquiry: ['inquiry', 'استفسار'], suggestion: ['suggestion', 'اقتراح'], praise: ['praise', 'إشادة', 'اشاده'],
      news: ['news', 'خبر'], experience: ['experience', 'تجربة'], warning: ['warning', 'تحذير'], issue: ['issue', 'مشكلة'], request: ['request', 'طلب'], other: ['other', 'أخرى'] } },
  { name: 'sentiment', kind: 'enum', label: 'المشاعر', example: 'sentiment:negative', entities: ['posts', 'tickets'], group: 'classification',
    values: { positive: ['positive', 'إيجابي', 'ايجابي'], negative: ['negative', 'سلبي'], neutral: ['neutral', 'محايد'],
      very_positive: ['very_positive'], very_negative: ['very_negative'], unclassified: ['unclassified', 'none', 'غير_مصنف'] },
    unavailable: { news: 'لا يوجد تحليل مشاعر للأخبار' } },
  { name: 'relevance', kind: 'enum', label: 'حالة الارتباط', example: 'relevance:relevant', entities: ['posts'], group: 'classification',
    values: { relevant: ['relevant', 'مرتبط'], irrelevant: ['irrelevant', 'غير_مرتبط'], advertisement: ['advertisement', 'ad', 'إعلان'], spam: ['spam'],
      unknown: ['unknown', 'غير_محدد'], unclassified: ['unclassified', 'none'] } },
  { name: 'classified', kind: 'bool', label: 'مصنَّف', example: 'classified:false', values: BOOL, entities: ['posts'], group: 'classification' },
  { name: 'excluded', kind: 'bool', label: 'مستبعد', example: 'excluded:true', values: BOOL, entities: ['posts', 'news'], group: 'classification' },
  { name: 'linked', kind: 'enum', label: 'مرتبط بموضوع أو قضية', example: 'linked:story', entities: ['posts'], group: 'classification',
    values: { topic: ['topic', 'موضوع'], story: ['story', 'قضية', 'قصة'], any: ['any', 'true'], none: ['none', 'false'] } },
  { name: 'has', kind: 'enum', label: 'يحتوي', example: 'has:image', entities: ['posts', 'news'], group: 'content',
    values: { image: ['image', 'photo', 'صورة'], video: ['video', 'فيديو'], link: ['link', 'links', 'url', 'رابط'], media: ['media'] } },
  { name: 'engagement', kind: 'number', label: 'إجمالي التفاعل', example: 'engagement:>100', entities: ['posts'], group: 'engagement' },
  { name: 'likes', kind: 'number', label: 'الإعجابات', example: 'likes:>100', entities: ['posts'], group: 'engagement' },
  { name: 'reposts', kind: 'number', label: 'إعادات النشر', example: 'reposts:>50', entities: ['posts'], group: 'engagement' },
  { name: 'replies', kind: 'number', label: 'الردود', example: 'replies:>20', entities: ['posts'], group: 'engagement' },
  { name: 'views', kind: 'number', label: 'المشاهدات', example: 'views:>10000', entities: [], group: 'engagement',
    unavailable: { all: 'X لا يعيد عدد المشاهدات في مستوى الوصول الحالي؛ الحقل فارغ لكل المنشورات' } },
  { name: 'after', kind: 'date', label: 'نُشر بعد (شاملًا)', example: 'after:2026-10-01', entities: ['posts', 'news', 'tickets'], group: 'dates',
    unavailable: { accounts: 'استخدم تبويب المنشورات للتواريخ' } },
  { name: 'before', kind: 'date', label: 'نُشر قبل (شاملًا)', example: 'before:2026-10-10', entities: ['posts', 'news', 'tickets'], group: 'dates',
    unavailable: { accounts: 'استخدم تبويب المنشورات للتواريخ' } },
  { name: 'collected_after', kind: 'date', label: 'جُمع بعد', example: 'collected_after:2026-10-01', entities: ['posts', 'news'], group: 'dates' },
  { name: 'collected_before', kind: 'date', label: 'جُمع قبل', example: 'collected_before:2026-10-10', entities: ['posts', 'news'], group: 'dates' },
  { name: 'updated_after', kind: 'date', label: 'حُدّث بعد', example: 'updated_after:2026-10-01', entities: ['news', 'tickets', 'accounts'], group: 'dates',
    unavailable: { posts: 'لا يوجد تاريخ تحديث للمنشورات؛ استخدم collected_after' } },
  { name: 'updated_before', kind: 'date', label: 'حُدّث قبل', example: 'updated_before:2026-10-10', entities: ['news', 'tickets', 'accounts'], group: 'dates',
    unavailable: { posts: 'لا يوجد تاريخ تحديث للمنشورات؛ استخدم collected_before' } },
  { name: 'collection_reason', kind: 'enum', label: 'سبب الجمع', example: 'collection_reason:keyword', entities: ['posts'], group: 'source',
    values: { keyword: ['keyword', 'كلمة'], query: ['query', 'استعلام'], influencer: ['influencer', 'مؤثر'] } },
  { name: 'post_id', kind: 'id', label: 'معرف المنشور', example: 'post_id:1843…', entities: ['posts', 'tickets'], group: 'content' },
  { name: 'review', kind: 'enum', label: 'حالة المراجعة', example: 'review:pending', entities: ['posts', 'tickets'], group: 'workflow',
    values: { pending: ['pending', 'open', 'قيد'], done: ['done', 'completed', 'closed', 'مكتمل'], none: ['none', 'لا'] } },
  { name: 'status', kind: 'enum', label: 'حالة التذكرة', example: 'status:open', entities: ['tickets'], group: 'workflow',
    values: { open: ['open', 'مفتوح'], new: ['new', 'جديد'], assigned: ['assigned', 'مسند'], escalated: ['escalated', 'مصعد'], completed: ['completed', 'closed', 'مغلق'] },
    unavailable: { posts: 'استخدم review: لحالة مراجعة المنشور' } },
  { name: 'priority', kind: 'enum', label: 'أولوية التذكرة', example: 'priority:high', entities: ['tickets'], group: 'workflow',
    values: { normal: ['normal', 'عادي'], high: ['high', 'عالي', 'عالية'] } },
  { name: 'section', kind: 'enum', label: 'قسم الطابور', example: 'section:influencer', entities: ['tickets'], group: 'workflow',
    values: { general: ['general', 'عام'], influencer: ['influencer', 'مؤثرين'], story: ['story', 'قصص'] } },
  { name: 'action_by', kind: 'user', label: 'نفّذ الإجراء', example: 'action_by:ahmed', entities: ['tickets'], group: 'workflow' },
  { name: 'ticket_id', aliases: ['tid'], kind: 'id', label: 'معرف التذكرة', example: 'ticket_id:3f2a9c1b', entities: ['tickets'], group: 'workflow' },
  { name: 'severity', kind: 'enum', label: 'الخطورة', example: 'severity:high', entities: [], group: 'workflow',
    unavailable: { all: 'لا يوجد حقل خطورة في الطابور؛ الحقل الحقيقي المتاح هو priority:' } },
  { name: 'rating', kind: 'number', label: 'التقييم', example: 'rating:5', entities: [], group: 'workflow',
    unavailable: { all: 'لا توجد تقييمات في المنصة ولا تكامل CRM' } },
];

const FIELD_INDEX = new Map<string, FieldDef>();
for (const f of SEARCH_FIELDS) for (const n of [f.name, ...(f.aliases ?? [])]) FIELD_INDEX.set(n, f);
export const findField = (name: string) => FIELD_INDEX.get(name.toLowerCase());

/** Why a field does not work for an entity, or null when it does. */
export function fieldUnavailable(f: FieldDef, entity: SearchEntity): string | null {
  if (f.unavailable?.all) return f.unavailable.all;
  if (f.entities.includes(entity)) return null;
  return f.unavailable?.[entity] ?? `الحقل ${f.name}: غير متاح في ${SEARCH_ENTITY_LABELS[entity]}`;
}

/** Canonical enum/bool value, or null when the spelling is not accepted. */
export function canonicalValue(f: FieldDef, value: string): string | null {
  if (!f.values) return value;
  const v = value.trim().toLowerCase().replace(/^#/, '');
  for (const [key, spellings] of Object.entries(f.values)) {
    if (key.toLowerCase() === v || spellings.some((s) => s.toLowerCase() === v)) return key;
  }
  return null;
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

type Tok =
  | { t: 'lp' | 'rp' | 'comma' | 'dash'; pos: number; end: number }
  | { t: 'op'; v: 'AND' | 'OR' | 'NOT'; pos: number; end: number }
  | { t: 'word'; v: string; pos: number; end: number }
  | { t: 'phrase'; v: string; pos: number; end: number }
  | { t: 'field'; name: string; op: CompareOp; v: string; raw: string; pos: number; end: number };

const SPACE = /\s/;
const STOP = /[\s(),،"“”]/;

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const atTokenStart = () => out.length === 0 || ['lp', 'comma', 'op', 'dash'].includes(out[out.length - 1].t) || SPACE.test(input[i - 1] ?? ' ');
  while (i < input.length) {
    const c = input[i];
    if (SPACE.test(c)) { i++; continue; }
    if (c === '(') { out.push({ t: 'lp', pos: i, end: i + 1 }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp', pos: i, end: i + 1 }); i++; continue; }
    if (c === ',' || c === '،') { out.push({ t: 'comma', pos: i, end: i + 1 }); i++; continue; }
    if (c === '"' || c === '“' || c === '”') {
      const close = input.slice(i + 1).search(/["“”]/);
      if (close < 0) throw new SearchSyntaxError('علامة اقتباس غير مغلقة — أغلق العبارة بـ "', i);
      const v = input.slice(i + 1, i + 1 + close);
      if (!v.trim()) throw new SearchSyntaxError('عبارة فارغة بين علامتي الاقتباس', i);
      out.push({ t: 'phrase', v, pos: i, end: i + close + 2 });
      i += close + 2; continue;
    }
    // A leading hyphen excludes only when it starts a token and is followed by something.
    if (c === '-' && atTokenStart() && input[i + 1] && !SPACE.test(input[i + 1]) && input[i + 1] !== '-') {
      out.push({ t: 'dash', pos: i, end: i + 1 }); i++; continue;
    }
    let j = i;
    while (j < input.length && !STOP.test(input[j])) j++;
    let word = input.slice(i, j);
    const m = /^([A-Za-z_]+):(.*)$/.exec(word);
    if (m && findField(m[1])) {
      let raw = m[2];
      let end = j;
      // field:"quoted value"
      if (raw === '' && input[j] === '"') {
        const close = input.slice(j + 1).indexOf('"');
        if (close < 0) throw new SearchSyntaxError(`قيمة الحقل ${m[1]} تبدأ باقتباس غير مغلق`, j);
        raw = input.slice(j + 1, j + 1 + close);
        end = j + close + 2;
      }
      const cmp = /^(>=|<=|>|<)?(.*)$/.exec(raw)!;
      const op = (cmp[1] ?? ':') as CompareOp;
      const v = cmp[2].trim();
      if (!v) throw new SearchSyntaxError(`الحقل ${m[1]}: يحتاج قيمة، مثال: ${findField(m[1])!.example}`, i);
      out.push({ t: 'field', name: findField(m[1])!.name, op, v, raw: input.slice(i, end), pos: i, end });
      i = end; continue;
    }
    if (m && !/^https?$/i.test(m[1]) && m[2] !== '' && !m[2].startsWith('//')) {
      const near = suggestFields(m[1]).slice(0, 3).map((f) => f.name);
      throw new SearchSyntaxError(`حقل غير معروف: ${m[1]}${near.length ? ` — هل تقصد ${near.join(' أو ')}؟` : ''}`, i);
    }
    if (word === 'AND' || word === 'OR' || word === 'NOT') { out.push({ t: 'op', v: word, pos: i, end: j }); i = j; continue; }
    // Punctuation glued to a word's edges is not part of it (؟ ! . : ; …).
    word = word.replace(/^[^\p{L}\p{N}#@_]+|[^\p{L}\p{N}_]+$/gu, '');
    if (word) out.push({ t: 'word', v: word, pos: i, end: j });
    i = j;
  }
  return out;
}

// ── Parser ──────────────────────────────────────────────────────────────────

export interface ParsedSearch { ast: SearchNode | null; nodes: number }

/**
 * Parses a search string. Throws SearchSyntaxError with an Arabic message and
 * the offending position. An empty query parses to `ast: null` (match all).
 */
export function parseSearch(input: string): ParsedSearch {
  if (input.length > SEARCH_LIMITS.maxLength) throw new SearchSyntaxError(`الاستعلام أطول من ${SEARCH_LIMITS.maxLength} حرفًا`, SEARCH_LIMITS.maxLength);
  const toks = tokenize(input);
  let k = 0;
  let nodes = 0;
  const peek = () => toks[k];
  const count = <T extends SearchNode>(n: T): T => {
    if (++nodes > SEARCH_LIMITS.maxNodes) throw new SearchSyntaxError(`الاستعلام يحتوي أكثر من ${SEARCH_LIMITS.maxNodes} شرطًا`, peek()?.pos ?? input.length);
    return n;
  };
  const flat = (type: 'and' | 'or', parts: SearchNode[]): SearchNode =>
    parts.length === 1 ? parts[0] : { type, children: parts.flatMap((p) => (p.type === type ? p.children : [p])) };

  function orExpr(depth: number): SearchNode {
    const parts = [andExpr(depth)];
    while (peek()?.t === 'op' && (peek() as { v: string }).v === 'OR') {
      const at = peek()!.pos; k++;
      if (!peek() || peek()!.t === 'rp') throw new SearchSyntaxError('OR يحتاج شرطًا بعده', at);
      parts.push(andExpr(depth));
    }
    return flat('or', parts);
  }
  function andExpr(depth: number): SearchNode {
    const parts = [unary(depth)];
    for (;;) {
      const t = peek();
      if (!t || t.t === 'rp' || (t.t === 'op' && t.v === 'OR')) break;
      if (t.t === 'op' && t.v === 'AND') {
        k++;
        if (!peek() || peek()!.t === 'rp') throw new SearchSyntaxError('AND يحتاج شرطًا بعده', t.pos);
      }
      if (peek()?.t === 'comma') throw new SearchSyntaxError('فاصلة في غير موضعها — الفاصلة تفصل كلمات مجموعة واحدة', peek()!.pos);
      parts.push(unary(depth));
    }
    return flat('and', parts);
  }
  function unary(depth: number): SearchNode {
    const t = peek();
    if (t && (t.t === 'dash' || (t.t === 'op' && t.v === 'NOT'))) {
      k++;
      if (!peek() || peek()!.t === 'rp' || peek()!.t === 'op') throw new SearchSyntaxError(t.t === 'dash' ? 'الشرطة للاستبعاد تحتاج كلمة ملاصقة لها، مثل -إعلان' : 'NOT يحتاج شرطًا بعده', t.pos);
      const child = group(depth);
      return count({ type: 'not', child, span: { start: t.pos, end: spanEnd(child) } });
    }
    return group(depth);
  }
  function group(depth: number): SearchNode {
    const parts = [primary(depth)];
    while (peek()?.t === 'comma') {
      const at = peek()!.pos; k++;
      const n = peek();
      if (!n || n.t === 'comma' || n.t === 'rp' || n.t === 'op') throw new SearchSyntaxError('الفاصلة يجب أن تتبعها كلمة', at);
      parts.push(primary(depth));
    }
    return flat('or', parts);
  }
  function primary(depth: number): SearchNode {
    const t = peek();
    if (!t) throw new SearchSyntaxError('الاستعلام ينتهي قبل اكتمال الشرط', input.length);
    if (t.t === 'lp') {
      if (depth >= SEARCH_LIMITS.maxDepth) throw new SearchSyntaxError(`الأقواس متداخلة أكثر من ${SEARCH_LIMITS.maxDepth} مستويات`, t.pos);
      k++;
      if (peek()?.t === 'rp') throw new SearchSyntaxError('قوسان فارغان', t.pos);
      const inner = orExpr(depth + 1);
      if (peek()?.t !== 'rp') throw new SearchSyntaxError('قوس غير مغلق — أضف )', t.pos);
      k++;
      return inner;
    }
    if (t.t === 'rp') throw new SearchSyntaxError('قوس إغلاق بلا قوس فتح', t.pos);
    if (t.t === 'comma') throw new SearchSyntaxError('فاصلة في غير موضعها', t.pos);
    if (t.t === 'op') throw new SearchSyntaxError(`${t.v} في غير موضعه — ضع شرطًا قبله وبعده`, t.pos);
    k++;
    const span = { start: t.pos, end: t.end };
    if (t.t === 'word') return count({ type: 'term', value: t.v, span });
    if (t.t === 'phrase') return count({ type: 'phrase', value: t.v, span });
    if (t.t === 'field') {
      validateField(t.name, t.op, t.v, t.pos);
      return count({ type: 'field', field: t.name, op: t.op, value: t.v, raw: t.raw, span });
    }
    throw new SearchSyntaxError('رمز غير متوقع', t.pos);
  }

  if (!toks.length) return { ast: null, nodes: 0 };
  const ast = orExpr(0);
  if (k < toks.length) {
    const t = toks[k];
    throw new SearchSyntaxError(t.t === 'rp' ? 'قوس إغلاق بلا قوس فتح' : 'رمز غير متوقع', t.pos);
  }
  return { ast, nodes };
}

function spanEnd(n: SearchNode): number {
  if ('span' in n) return n.span.end;
  return spanEnd(n.children[n.children.length - 1]);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validateField(name: string, op: CompareOp, value: string, pos: number) {
  const f = findField(name)!;
  if (op !== ':' && f.kind !== 'number') throw new SearchSyntaxError(`المقارنة ${op} تعمل مع الحقول الرقمية فقط، والحقل ${name} ليس رقميًا`, pos);
  if (f.kind === 'number' && !/^\d{1,12}$/.test(value)) throw new SearchSyntaxError(`الحقل ${name} يحتاج رقمًا صحيحًا، مثال: ${f.example}`, pos);
  if (f.kind === 'date') {
    if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new SearchSyntaxError(`تاريخ غير صالح في ${name} — استخدم YYYY-MM-DD، مثال: ${f.example}`, pos);
  }
  if ((f.kind === 'enum' || f.kind === 'bool') && f.values && !canonicalValue(f, value)) {
    throw new SearchSyntaxError(`قيمة غير معروفة للحقل ${name}: ${value} — القيم المتاحة: ${Object.keys(f.values).join('، ')}`, pos);
  }
  if (f.kind === 'id' && !/^[A-Za-z0-9-]{4,64}$/.test(value)) throw new SearchSyntaxError(`معرف غير صالح في ${name}`, pos);
}

// ── Helpers for the UI ──────────────────────────────────────────────────────

/** Field names (and aliases) starting with — or close to — what was typed. */
export function suggestFields(prefix: string): FieldDef[] {
  const p = prefix.toLowerCase();
  const starts = SEARCH_FIELDS.filter((f) => [f.name, ...(f.aliases ?? [])].some((n) => n.startsWith(p)));
  if (starts.length || p.length < 3) return starts;
  return SEARCH_FIELDS.filter((f) => f.name.includes(p.slice(0, 3)));
}

/** Source span of any node (groups span from their first to their last child). */
export function spanOf(n: SearchNode): Span {
  if ('span' in n) return n.span;
  return { start: spanOf(n.children[0]).start, end: spanOf(n.children[n.children.length - 1]).end };
}

/**
 * Top-level conditions shown as removable chips, each with its source span.
 * A parenthesised group's span covers its inner text; removal also drops the
 * surrounding parentheses (see removeSpan).
 */
export function topLevelConditions(ast: SearchNode | null): Array<{ node: SearchNode; span: Span }> {
  if (!ast) return [];
  const list = ast.type === 'and' ? ast.children : [ast];
  return list.map((node) => ({ node, span: spanOf(node) }));
}

/** Removes one condition from the query text by its span, tidying spaces and dangling operators. */
export function removeSpan(input: string, span: Span): string {
  let { start, end } = span;
  // Take enclosing parentheses with the condition: "(a OR b)" goes as a whole.
  while (input.slice(0, start).trimEnd().endsWith('(') && input.slice(end).trimStart().startsWith(')')) {
    start = input.slice(0, start).trimEnd().length - 1;
    end = input.length - input.slice(end).trimStart().length + 1;
  }
  return (input.slice(0, start) + ' ' + input.slice(end))
    .replace(/\s+(AND|OR)\s*$/, '').replace(/^\s*(AND|OR)\s+/, '').replace(/\s{2,}/g, ' ').trim();
}

/** Appends `field:value` (quoted when needed) to a query. */
export function addCondition(input: string, field: string, value: string, op: CompareOp = ':'): string {
  const v = /[\s(),"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
  const cond = `${field}${op === ':' ? ':' : `:${op}`}${v}`;
  return input.trim() ? `${input.trim()} ${cond}` : cond;
}
