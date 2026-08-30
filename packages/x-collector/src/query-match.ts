/**
 * A small evaluator for X search-query syntax, used by the DEMO client so that
 * mock results actually respond to query quality.
 *
 * Without it, DEMO mode would return random samples and a carefully-built query
 * would score no better than a careless one — making the whole
 * Sandbox → improve → re-test loop meaningless before going live.
 *
 * Grammar (matching X's operator precedence):
 *   Expr   := AndSeq
 *   AndSeq := OrSeq (WS OrSeq)*        implicit AND
 *   OrSeq  := Atom (OR Atom)*
 *   Atom   := '(' Expr ')' | '-' Atom | '"phrase"' | term | key:value
 */

export type Node =
  | { t: 'and'; kids: Node[] }
  | { t: 'or'; kids: Node[] }
  | { t: 'not'; kid: Node }
  | { t: 'term'; v: string }
  | { t: 'filter'; k: string; v?: string };

type Token = { k: 'lparen' | 'rparen' | 'or' | 'minus' | 'text'; v?: string };

function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { out.push({ k: 'lparen' }); i++; continue; }
    if (ch === ')') { out.push({ k: 'rparen' }); i++; continue; }
    if (ch === '-') { out.push({ k: 'minus' }); i++; continue; }
    if (ch === '"') {
      const end = q.indexOf('"', i + 1);
      if (end === -1) { out.push({ k: 'text', v: q.slice(i + 1) }); break; }
      out.push({ k: 'text', v: q.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < q.length && !/[\s()"]/.test(q[j])) j++;
    const word = q.slice(i, j);
    out.push(word.toUpperCase() === 'OR' ? { k: 'or' } : { k: 'text', v: word });
    i = j;
  }
  return out;
}

function parse(tokens: Token[]): Node {
  let p = 0;
  const peek = () => tokens[p];

  function atom(): Node | null {
    const t = peek();
    if (!t) return null;
    if (t.k === 'minus') { p++; const inner = atom(); return inner ? { t: 'not', kid: inner } : null; }
    if (t.k === 'lparen') {
      p++;
      const e = andSeq();
      if (peek()?.k === 'rparen') p++;
      return e;
    }
    if (t.k === 'text') {
      p++;
      const v = t.v!;
      const colon = v.indexOf(':');
      // A colon only means a filter when it looks like one (is:, lang:, has:…)
      if (colon > 0 && !v.includes(' ')) {
        const k = v.slice(0, colon);
        if (['is', 'has', 'lang', 'from', 'to', 'url', 'entity', 'context'].includes(k)) {
          return { t: 'filter', k, v: v.slice(colon + 1) };
        }
      }
      return { t: 'term', v };
    }
    p++; // skip stray rparen/or
    return null;
  }

  function orSeq(): Node | null {
    const first = atom();
    if (!first) return null;
    const kids = [first];
    while (peek()?.k === 'or') {
      p++;
      const next = atom();
      if (next) kids.push(next);
    }
    return kids.length === 1 ? kids[0] : { t: 'or', kids };
  }

  function andSeq(): Node {
    const kids: Node[] = [];
    while (p < tokens.length && peek()?.k !== 'rparen') {
      const n = orSeq();
      if (n) kids.push(n); else break;
    }
    return kids.length === 1 ? kids[0] : { t: 'and', kids };
  }

  return andSeq();
}

/** Match X's own loose treatment of Arabic orthographic variants. */
function norm(s: string): string {
  return s
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ْـ]/g, '')
    .toLowerCase();
}

export interface MatchContext {
  text: string;
  lang?: string;
  isRetweet?: boolean;
  isReply?: boolean;
  hasLinks?: boolean;
  hasMedia?: boolean;
}

function evaluate(n: Node, ctx: MatchContext, text: string): boolean {
  switch (n.t) {
    case 'and': return n.kids.every((k) => evaluate(k, ctx, text));
    case 'or': return n.kids.some((k) => evaluate(k, ctx, text));
    case 'not': return !evaluate(n.kid, ctx, text);
    case 'term': return text.includes(norm(n.v));
    case 'filter':
      switch (`${n.k}:${n.v ?? ''}`) {
        case 'lang:ar': return (ctx.lang ?? 'ar') === 'ar';
        case 'is:retweet': return !!ctx.isRetweet;
        case 'is:reply': return !!ctx.isReply;
        case 'has:links': return !!ctx.hasLinks;
        case 'has:media': return !!ctx.hasMedia;
        default: return true;   // unknown filters do not exclude
      }
  }
}

export function compileMatcher(query: string): (ctx: MatchContext) => boolean {
  const ast = parse(tokenize(query));
  return (ctx) => evaluate(ast, ctx, norm(ctx.text));
}
