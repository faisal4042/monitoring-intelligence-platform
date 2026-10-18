/**
 * Advanced search — compiles the shared search AST into SQL fragments, one
 * dialect per entity. Every user value reaches PostgreSQL as a bound
 * parameter; identifiers and operators come only from this file. Nothing here
 * is ever sent to X.
 *
 * Text matching is substring matching on the normalized text (Arabic letter
 * forms unified, diacritics/tatweel removed, lower case), served by the
 * existing pg_trgm index on posts.text_normalized. Measured on 103k posts:
 * 2–4 ms for a page, ~25 ms for a 100k-row count; FTS ('simple') was 35–77 ms
 * and misses attached Arabic forms (بالإيجار), so it is not used.
 */
import { analyticsSql as sql, normalizeArabic } from '@mip/db';
import {
  canonicalValue, fieldUnavailable, findField, SEARCH_ENTITY_LABELS,
  type SearchEntity, type SearchNode,
} from '@mip/shared';
import { byInfluencer, type Fragment } from '../dashboard/base.js';

export class UnsupportedField extends Error {
  constructor(public field: string, message: string) { super(message); }
}
export class InvalidValue extends Error {}

/** Names resolved to ids before compiling (program/topic values are words, not ids). */
export interface Resolved { programs: Map<string, string[]>; topics: Map<string, string[]> }

const TRUE = sql`true`;
const FALSE = sql`false`;

/** LIKE pattern for a normalized needle; % and _ match literally. */
export const likeContains = (needle: string) => `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** The JS normalizer, refusing text that has nothing searchable left. */
export function normTerm(value: string): string {
  const n = normalizeArabic(value);
  if (!n) throw new InvalidValue(`"${value}" لا يحتوي حروفًا أو أرقامًا قابلة للبحث`);
  return n;
}

/**
 * SQL twin of normalizeArabic for columns that have no normalized copy
 * (news titles, names). Same letter folding; used with substring LIKE.
 */
export const normSql = (expr: Fragment) => sql`lower(regexp_replace(translate(regexp_replace(coalesce(${expr},''),'[ًٌٍَُِّْٰـ]','','g'),
  'أإآٱةىؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','ااااهيوي01234567890123456789'),'[^[:alnum:]#@_]+',' ','g'))`;

export const andAll = (parts: Fragment[]) => parts.length ? parts.reduce((a, b) => sql`${a} AND ${b}`) : TRUE;
const orAll = (parts: Fragment[]) => parts.length ? parts.reduce((a, b) => sql`(${a}) OR (${b})`) : FALSE;

export const cmp = (op: string) => ({ ':': sql`=`, '>': sql`>`, '<': sql`<`, '>=': sql`>=`, '<=': sql`<=` } as Record<string, Fragment>)[op];
export const boolOf = (field: string, value: string) => canonicalValue(findField(field)!, value) === 'true';
export const handle = (v: string) => v.trim().replace(/^@/, '').toLowerCase();

/** Riyadh calendar day → instant bounds. Riyadh has no DST, so +03:00 is exact all year. */
export function dayStart(date: string) { return new Date(`${date}T00:00:00+03:00`).toISOString(); }
export function dayEnd(date: string) { return new Date(new Date(`${date}T00:00:00+03:00`).getTime() + 86_400_000).toISOString(); }

/** Domain match on a URL column: exact host or any sub-domain of it. */
export function hostMatches(urlExpr: Fragment, domain: string) {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new InvalidValue(`نطاق غير صالح في site: ${domain}`);
  const host = sql`regexp_replace(lower(substring(${urlExpr} from '^[a-zA-Z]+://([^/:?#]+)')),'^www\\.','')`;
  return sql`(${host} = ${d} OR ${host} LIKE ${'%.' + d})`;
}

export interface Dialect {
  entity: SearchEntity;
  /** Normalized-text predicate for a term or phrase. */
  text(needle: string): Fragment;
  /** Field predicate; throw UnsupportedField when the entity has no such data. */
  field(name: string, op: string, value: string, resolved: Resolved): Fragment;
}

/** Walks the AST into one WHERE fragment, collecting positive text needles for relevance. */
export function compile(ast: SearchNode | null, d: Dialect, resolved: Resolved) {
  const needles: string[] = [];
  const walk = (n: SearchNode, negated: boolean): Fragment => {
    switch (n.type) {
      case 'and': return sql`(${andAll(n.children.map((c) => walk(c, negated)))})`;
      case 'or': return sql`(${orAll(n.children.map((c) => walk(c, negated)))})`;
      case 'not': return sql`NOT (${walk(n.child, !negated)})`;
      case 'term':
      case 'phrase': {
        const needle = normTerm(n.value);
        if (!negated) needles.push(needle);
        return d.text(needle);
      }
      case 'field': {
        const f = findField(n.field)!;
        const why = fieldUnavailable(f, d.entity);
        if (why) throw new UnsupportedField(f.name, why);
        return d.field(f.name, n.op, n.value, resolved);
      }
    }
  };
  return { where: ast ? walk(ast, false) : TRUE, needles: [...new Set(needles)].slice(0, 12) };
}

/** Values of program:/topic: fields anywhere in the tree. */
export function collectNames(ast: SearchNode | null) {
  const programs = new Set<string>(); const topics = new Set<string>();
  const walk = (n: SearchNode) => {
    if (n.type === 'and' || n.type === 'or') n.children.forEach(walk);
    else if (n.type === 'not') walk(n.child);
    else if (n.type === 'field' && n.field === 'program') programs.add(n.value);
    else if (n.type === 'field' && n.field === 'topic') topics.add(n.value);
  };
  if (ast) walk(ast);
  return { programs: [...programs], topics: [...topics] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves program keys/names and topic names (underscores = spaces) to ids. */
export async function resolveNames(ast: SearchNode | null): Promise<Resolved> {
  const { programs, topics } = collectNames(ast);
  const out: Resolved = { programs: new Map(), topics: new Map() };
  for (const v of programs) {
    const n = normalizeArabic(v.replace(/_/g, ' '));
    const rows = await sql<{ id: string }[]>`SELECT id FROM programs WHERE deleted_at IS NULL AND (
        ${UUID.test(v) ? v : null}::uuid = id OR lower(key) = ${v.toLowerCase()}
        OR ${normSql(sql`name_ar`)} = ${n} OR lower(coalesce(name_en,'')) = ${v.toLowerCase().replace(/_/g, ' ')})`;
    out.programs.set(v, rows.map((r) => r.id));
  }
  for (const v of topics) {
    const n = normalizeArabic(v.replace(/_/g, ' '));
    const rows = await sql<{ id: string }[]>`SELECT id FROM topics WHERE
        ${UUID.test(v) ? v : null}::uuid = id OR ${normSql(sql`name_ar`)} = ${n} OR lower(coalesce(name_en,'')) = ${v.toLowerCase().replace(/_/g, ' ')}`;
    out.topics.set(v, rows.map((r) => r.id));
  }
  return out;
}

const idsIn = (col: Fragment, ids: string[] | undefined) => ids?.length ? sql`${col} = ANY(${sql.array(ids)}::uuid[])` : FALSE;
const num = (v: string) => Number(v);

// ── Posts ───────────────────────────────────────────────────────────────────
// Aliases: b = effective interaction (dashboard/base.ts), p = posts, a = authors, m = latest metrics.

const ENGAGEMENT = sql`(coalesce(m.like_count,0)+coalesce(m.repost_count,0)+coalesce(m.reply_count,0)+coalesce(m.quote_count,0))`;
export const postsEngagement = ENGAGEMENT;
const official = (username: Fragment) => sql`EXISTS (SELECT 1 FROM programs opr, unnest(opr.official_accounts) oa
  WHERE opr.deleted_at IS NULL AND lower(ltrim(oa,'@')) = lower(${username}))`;
const tracked = (username: Fragment) => sql`EXISTS (SELECT 1 FROM tracked_influencers ti WHERE ti.is_active AND lower(ti.username) = lower(${username}))`;
const reviewOf = (postId: Fragment, v: string) => v === 'none'
  ? sql`NOT EXISTS (SELECT 1 FROM queue_items qi WHERE qi.interaction_type='post' AND qi.post_id = ${postId})`
  : sql`EXISTS (SELECT 1 FROM queue_items qi WHERE qi.interaction_type='post' AND qi.post_id = ${postId}
      AND ${v === 'done' ? sql`qi.status = 'completed'` : sql`qi.status <> 'completed'`})`;
const SENT_GROUP: Record<string, string[]> = { positive: ['very_positive', 'positive'], negative: ['negative', 'very_negative'], neutral: ['neutral'] };

export const postsDialect: Dialect = {
  entity: 'posts',
  text: (n) => sql`p.text_normalized LIKE ${likeContains(n)}`,
  field(name, op, value, r) {
    const v = canonicalValue(findField(name)!, value) ?? value;
    switch (name) {
      case 'site': return sql`EXISTS (SELECT 1 FROM unnest(p.urls) u WHERE ${hostMatches(sql`u`, value)})`;
      case 'lang': return sql`p.lang = ${v}`;
      case 'platform': return v === 'x' ? TRUE : FALSE;
      case 'user': return sql`lower(a.username) = ${handle(value)}`;
      case 'mention': return sql`EXISTS (SELECT 1 FROM unnest(p.mentions) mn WHERE lower(ltrim(mn,'@')) = ${handle(value)})`;
      case 'hashtag': {
        const tag = value.replace(/^#/, '');
        return sql`(EXISTS (SELECT 1 FROM unnest(p.hashtags) h WHERE lower(ltrim(h,'#')) = ${tag.toLowerCase()})
          OR p.text_normalized LIKE ${likeContains('#' + normTerm(tag))})`;
      }
      case 'followers': return sql`coalesce(a.followers_count,0) ${cmp(op)} ${num(value)}`;
      case 'verified': return boolOf(name, value) ? sql`coalesce(a.is_verified,false)` : sql`NOT coalesce(a.is_verified,false)`;
      case 'influencer': return boolOf(name, value) ? byInfluencer('b') : sql`NOT ${byInfluencer('b')}`;
      case 'official': return boolOf(name, value) ? official(sql`a.username`) : sql`NOT ${official(sql`a.username`)}`;
      case 'program': return idsIn(sql`b.program_id`, r.programs.get(value));
      case 'topic': return sql`(${idsIn(sql`b.topic_id`, r.topics.get(value))} OR ${idsIn(sql`b.subtopic_id`, r.topics.get(value))})`;
      case 'classification': return sql`b.intent = ${v}`;
      case 'sentiment':
        if (v === 'unclassified') return sql`b.sentiment IS NULL`;
        return sql`b.sentiment = ANY(${sql.array(SENT_GROUP[v] ?? [v])}::text[])`;
      case 'relevance': return v === 'unclassified' ? sql`b.relevance IS NULL` : sql`b.relevance = ${v}`;
      case 'classified': return boolOf(name, value) ? sql`b.classified` : sql`NOT b.classified`;
      case 'excluded': {
        const ex = sql`(b.status = 'filtered_out' OR b.relevance IN ('irrelevant','advertisement','spam'))`;
        return boolOf(name, value) ? ex : sql`NOT ${ex}`;
      }
      case 'linked': {
        const story = sql`EXISTS (SELECT 1 FROM signal_story_members sm WHERE sm.post_id = b.id)`;
        const topic = sql`(b.topic_id IS NOT NULL OR b.subtopic_id IS NOT NULL)`;
        return v === 'topic' ? topic : v === 'story' ? story : v === 'any' ? sql`(${topic} OR ${story})` : sql`NOT (${topic} OR ${story})`;
      }
      case 'has':
        if (v === 'image') return sql`EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = b.id AND pm.posted_at = b.posted_at AND pm.type = 'photo')`;
        if (v === 'video') return sql`EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = b.id AND pm.posted_at = b.posted_at AND pm.type IN ('video','animated_gif'))`;
        if (v === 'link') return sql`cardinality(p.urls) > 0`;
        return sql`p.has_media`;
      case 'engagement': return sql`${ENGAGEMENT} ${cmp(op)} ${num(value)}`;
      case 'likes': return sql`coalesce(m.like_count,0) ${cmp(op)} ${num(value)}`;
      case 'reposts': return sql`coalesce(m.repost_count,0) ${cmp(op)} ${num(value)}`;
      case 'replies': return sql`coalesce(m.reply_count,0) ${cmp(op)} ${num(value)}`;
      case 'after': return sql`b.posted_at >= ${dayStart(value)}::timestamptz`;
      case 'before': return sql`b.posted_at < ${dayEnd(value)}::timestamptz`;
      case 'collected_after': return sql`p.collected_at >= ${dayStart(value)}::timestamptz`;
      case 'collected_before': return sql`p.collected_at < ${dayEnd(value)}::timestamptz`;
      case 'collection_reason':
        if (v === 'keyword') return sql`cardinality(p.matched_keywords) > 0`;
        if (v === 'query') return sql`p.query_id IS NOT NULL`;
        return byInfluencer('b');
      case 'post_id': return sql`(p.x_post_id = ${value} OR p.id::text = ${value.toLowerCase()})`;
      case 'review': return reviewOf(sql`b.id`, v);
    }
    throw new UnsupportedField(name, `الحقل ${name}: غير متاح في ${SEARCH_ENTITY_LABELS.posts}`);
  },
};

// ── News ────────────────────────────────────────────────────────────────────
// Aliases: n = news_articles, s = news_sources.

/** Normalized title + description, computed once per row in the FROM subquery (column n.nt). */
export const NEWS_TEXT = normSql(sql`coalesce(n.title,'') || ' ' || coalesce(n.description,'')`);
const NEWS_DATE = sql`coalesce(n.published_at, n.discovered_at)`;
export const newsDate = NEWS_DATE;

export const newsDialect: Dialect = {
  entity: 'news',
  text: (n) => sql`n.nt LIKE ${likeContains(n)}`,
  field(name, op, value, r) {
    const v = canonicalValue(findField(name)!, value) ?? value;
    switch (name) {
      case 'site': return sql`(${hostMatches(sql`n.url`, value)} OR ${hostMatches(sql`s.base_url`, value)})`;
      case 'source': {
        const needle = likeContains(normTerm(value));
        return sql`(${normSql(sql`s.name_ar`)} LIKE ${needle} OR lower(coalesce(s.name_en,'')) LIKE ${likeContains(value.toLowerCase())}
          OR ${normSql(sql`n.publisher_name`)} LIKE ${needle})`;
      }
      // Source country only, as recorded on the source — never inferred from language or text.
      case 'country': return v === 'SA' ? sql`(upper(s.country) IN ('SA','KSA') OR s.country = 'السعودية')` : FALSE;
      case 'lang': return sql`n.language = ${v}`;
      case 'platform': return v === 'news' ? TRUE : FALSE;
      case 'program': return idsIn(sql`n.program_id`, r.programs.get(value));
      case 'topic': return idsIn(sql`n.topic_id`, r.topics.get(value));
      case 'excluded': return boolOf(name, value) ? sql`n.is_relevant IS NOT TRUE` : sql`n.is_relevant IS TRUE`;
      case 'has':
        if (v === 'image') return sql`n.image_url IS NOT NULL`;
        if (v === 'link') return TRUE;
        throw new UnsupportedField('has', 'الأخبار لا تسجل الفيديو أو الوسائط؛ المتاح has:image و has:link');
      case 'after': return sql`${NEWS_DATE} >= ${dayStart(value)}::timestamptz`;
      case 'before': return sql`${NEWS_DATE} < ${dayEnd(value)}::timestamptz`;
      case 'collected_after': return sql`n.discovered_at >= ${dayStart(value)}::timestamptz`;
      case 'collected_before': return sql`n.discovered_at < ${dayEnd(value)}::timestamptz`;
      case 'updated_after': return sql`n.updated_at >= ${dayStart(value)}::timestamptz`;
      case 'updated_before': return sql`n.updated_at < ${dayEnd(value)}::timestamptz`;
    }
    throw new UnsupportedField(name, `الحقل ${name}: غير متاح في ${SEARCH_ENTITY_LABELS.news}`);
  },
};

// ── Accounts ────────────────────────────────────────────────────────────────
// Alias: a = authors.

const ACCOUNT_TEXT = normSql(sql`coalesce(a.display_name,'') || ' ' || coalesce(a.username,'') || ' ' || coalesce(a.description,'')`);

export const accountsDialect: Dialect = {
  entity: 'accounts',
  text: (n) => sql`${ACCOUNT_TEXT} LIKE ${likeContains(n)}`,
  field(name, op, value) {
    const v = canonicalValue(findField(name)!, value) ?? value;
    switch (name) {
      case 'user': return sql`lower(a.username) = ${handle(value)}`;
      case 'followers': return sql`coalesce(a.followers_count,0) ${cmp(op)} ${num(value)}`;
      case 'verified': return boolOf(name, value) ? sql`coalesce(a.is_verified,false)` : sql`NOT coalesce(a.is_verified,false)`;
      case 'influencer': return boolOf(name, value) ? tracked(sql`a.username`) : sql`NOT ${tracked(sql`a.username`)}`;
      case 'official': return boolOf(name, value) ? official(sql`a.username`) : sql`NOT ${official(sql`a.username`)}`;
      case 'platform': return v === 'x' ? TRUE : FALSE;
      case 'updated_after': return sql`a.updated_at >= ${dayStart(value)}::timestamptz`;
      case 'updated_before': return sql`a.updated_at < ${dayEnd(value)}::timestamptz`;
    }
    throw new UnsupportedField(name, `الحقل ${name}: غير متاح في ${SEARCH_ENTITY_LABELS.accounts}`);
  },
};

// ── Tickets (internal monitoring queue items — not CRM tickets) ─────────────
// Aliases: q = queue_items, p = posts, a = authors, c = post_classifications, ps = post_sentiments.

export const ticketsDialect: Dialect = {
  entity: 'tickets',
  text: (n) => sql`(p.text_normalized LIKE ${likeContains(n)} OR ${normSql(sql`q.story_snapshot->>'title_ar'`)} LIKE ${likeContains(n)})`,
  field(name, op, value, r) {
    const v = canonicalValue(findField(name)!, value) ?? value;
    switch (name) {
      case 'status':
        if (v === 'open') return sql`q.status <> 'completed'`;
        if (v === 'assigned') return sql`q.status IN ('assigned','in_progress')`;
        return sql`q.status = ${v}`;
      case 'review': return v === 'pending' ? sql`q.status <> 'completed'` : v === 'done' ? sql`q.status = 'completed'` : FALSE;
      case 'priority': return sql`q.priority = ${v}`;
      case 'section': return sql`q.section = ${v}`;
      case 'program': return idsIn(sql`q.program_id`, r.programs.get(value));
      case 'topic': return sql`(${idsIn(sql`c.topic_id`, r.topics.get(value))} OR ${idsIn(sql`c.subtopic_id`, r.topics.get(value))})`;
      case 'classification': return sql`c.intent::text = ${v}`;
      case 'sentiment':
        if (v === 'unclassified') return sql`ps.label IS NULL`;
        return sql`ps.label::text = ANY(${sql.array(SENT_GROUP[v] ?? [v])}::text[])`;
      case 'user': return sql`lower(a.username) = ${handle(value)}`;
      case 'followers': return sql`coalesce(a.followers_count,0) ${cmp(op)} ${num(value)}`;
      case 'influencer': return boolOf(name, value) ? sql`q.section = 'influencer'` : sql`q.section <> 'influencer'`;
      case 'platform': return v === 'x' ? TRUE : FALSE;
      case 'post_id': return sql`(p.x_post_id = ${value} OR p.id::text = ${value.toLowerCase()})`;
      case 'ticket_id':
        if (!/^[0-9a-f-]{4,36}$/i.test(value)) throw new InvalidValue('معرف التذكرة يتكون من أحرف وأرقام سداسية (أول 8 خانات تكفي)');
        return sql`q.id::text LIKE ${value.toLowerCase().replace(/[\\%_]/g, '') + '%'}`;
      // Who acted: the current assignee or whoever closed it, by e-mail name or full name.
      case 'action_by': {
        const who = handle(value);
        return sql`EXISTS (SELECT 1 FROM users u WHERE u.id IN (q.assignee_id, q.completed_by)
          AND (lower(split_part(u.email,'@',1)) = ${who} OR ${normSql(sql`u.full_name`)} LIKE ${likeContains(normTerm(value))}))`;
      }
      case 'after': return sql`q.entered_at >= ${dayStart(value)}::timestamptz`;
      case 'before': return sql`q.entered_at < ${dayEnd(value)}::timestamptz`;
      case 'updated_after': return sql`q.updated_at >= ${dayStart(value)}::timestamptz`;
      case 'updated_before': return sql`q.updated_at < ${dayEnd(value)}::timestamptz`;
    }
    throw new UnsupportedField(name, `الحقل ${name}: غير متاح في ${SEARCH_ENTITY_LABELS.tickets}`);
  },
};

export const DIALECTS: Record<SearchEntity, Dialect> = {
  posts: postsDialect, news: newsDialect, accounts: accountsDialect, tickets: ticketsDialect,
};
