/**
 * Query AST → X search query string, plus a free (no API call) estimate of how
 * broad and how noisy the query is likely to be.
 *
 * KEYWORD_GROUP nodes are expanded at compile time from the dictionary, so
 * editing a keyword group updates every query that references it — no per-query
 * edits, no code changes (docs/ARCHITECTURE.md §4.3).
 */
import { sql } from '@mip/db';
import type { QueryNode, QueryEstimate } from '@mip/shared';

const MAX_QUERY_LENGTH = 512; // conservative; real cap comes from settings

interface GroupTerms {
  id: string;
  terms: Array<{ term: string; matchMode: string; type: string; noiseRate: number | null }>;
}

async function loadGroups(ids: string[]): Promise<Map<string, GroupTerms>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ group_id: string; term: string; match_mode: string; type: string; noise_rate: string | null }[]>`
    SELECT group_id, term, match_mode, type, noise_rate
    FROM keywords
    WHERE group_id = ANY(${ids}::uuid[]) AND is_active
    ORDER BY weight DESC, term`;

  const map = new Map<string, GroupTerms>();
  for (const r of rows) {
    if (!map.has(r.group_id)) map.set(r.group_id, { id: r.group_id, terms: [] });
    map.get(r.group_id)!.terms.push({
      term: r.term,
      matchMode: r.match_mode,
      type: r.type,
      noiseRate: r.noise_rate === null ? null : Number(r.noise_rate),
    });
  }
  return map;
}

function collectGroupIds(node: QueryNode, acc: string[] = []): string[] {
  if (node.op === 'KEYWORD_GROUP') acc.push(node.groupId);
  else if (node.op === 'AND' || node.op === 'OR') node.children.forEach((c) => collectGroupIds(c, acc));
  else if (node.op === 'NOT') collectGroupIds(node.child, acc);
  return acc;
}

/** A term with whitespace must be quoted or X will treat it as separate words. */
function renderTerm(term: string, matchMode: string): string {
  const t = term.trim();
  if (matchMode === 'hashtag') return `#${t.replace(/^#/, '')}`;
  if (matchMode === 'mention') return `@${t.replace(/^@/, '')}`;
  if (matchMode === 'from') return `from:${t.replace(/^@/, '')}`;
  if (matchMode === 'phrase' || t.includes(' ')) return `"${t.replace(/"/g, '')}"`;
  return t;
}

function render(node: QueryNode, groups: Map<string, GroupTerms>, depth = 0): string {
  switch (node.op) {
    case 'TERM': return renderTerm(node.value, 'term');
    case 'PHRASE': return `"${node.value.replace(/"/g, '')}"`;
    case 'HASHTAG': return `#${node.value.replace(/^#/, '')}`;
    case 'MENTION': return `@${node.value.replace(/^@/, '')}`;
    case 'FROM': return `from:${node.value.replace(/^@/, '')}`;
    case 'TO': return `to:${node.value.replace(/^@/, '')}`;

    case 'FILTER':
      return node.key === 'lang' ? `lang:${node.value ?? 'ar'}` : node.key;

    case 'KEYWORD_GROUP': {
      const g = groups.get(node.groupId);
      if (!g || g.terms.length === 0) return '';
      const isNegative = g.terms[0].type === 'negative';
      const parts = g.terms.map((t) => {
        const rendered = renderTerm(t.term, t.matchMode);
        return isNegative ? `-${rendered}` : rendered;
      });
      // Negative terms are ANDed (all must be absent); positives are ORed.
      return isNegative ? parts.join(' ') : parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
    }

    case 'NOT': {
      const inner = render(node.child, groups, depth + 1);
      if (!inner) return '';
      // X negates individual terms, not groups — expand a negated group.
      if (inner.startsWith('(') && inner.endsWith(')')) {
        return inner.slice(1, -1).split(' OR ').map((t) => `-${t.trim()}`).join(' ');
      }
      return `-${inner}`;
    }

    case 'AND': {
      const parts = node.children.map((c) => render(c, groups, depth + 1)).filter(Boolean);
      if (parts.length === 0) return '';
      if (parts.length === 1) return parts[0];
      const joined = parts.join(' ');
      return depth > 0 ? `(${joined})` : joined;
    }

    case 'OR': {
      const parts = node.children.map((c) => render(c, groups, depth + 1)).filter(Boolean);
      if (parts.length === 0) return '';
      if (parts.length === 1) return parts[0];
      return `(${parts.join(' OR ')})`;
    }
  }
}

export async function compileQuery(ast: QueryNode): Promise<string> {
  const groups = await loadGroups(collectGroupIds(ast));
  return render(ast, groups).replace(/\s+/g, ' ').trim();
}

// ─── Estimation (costs nothing — no API call) ──────────────────────

interface Counts { orTerms: number; andGroups: number; phrases: number; negatives: number; filters: number; noiseSum: number; noiseN: number }

function walk(node: QueryNode, groups: Map<string, GroupTerms>, c: Counts) {
  switch (node.op) {
    case 'OR':
      c.orTerms += node.children.length;
      node.children.forEach((n) => walk(n, groups, c));
      break;
    case 'AND':
      c.andGroups += 1;
      node.children.forEach((n) => walk(n, groups, c));
      break;
    case 'NOT':
      c.negatives += 1;
      walk(node.child, groups, c);
      break;
    case 'PHRASE':
      c.phrases += 1;
      break;
    case 'FILTER':
      c.filters += 1;
      break;
    case 'KEYWORD_GROUP': {
      const g = groups.get(node.groupId);
      if (!g) break;
      if (g.terms[0]?.type === 'negative') c.negatives += g.terms.length;
      else c.orTerms += g.terms.length;
      for (const t of g.terms) {
        if (t.noiseRate !== null) { c.noiseSum += t.noiseRate; c.noiseN += 1; }
        if (t.matchMode === 'phrase' || t.term.includes(' ')) c.phrases += 1;
      }
      break;
    }
    default:
      break;
  }
}

export async function estimateQuery(ast: QueryNode, maxResults = 50): Promise<QueryEstimate> {
  const groups = await loadGroups(collectGroupIds(ast));
  const compiled = render(ast, groups).replace(/\s+/g, ' ').trim();

  const c: Counts = { orTerms: 0, andGroups: 0, phrases: 0, negatives: 0, filters: 0, noiseSum: 0, noiseN: 0 };
  walk(ast, groups, c);

  // Breadth: OR terms widen; AND groups, phrases, negatives and filters narrow.
  // Each factor is bounded so no single one can floor the score. An unbounded
  // phrase penalty made every well-built query read as 0/100, which is useless
  // as a signal.
  let breadth = 25 + Math.min(c.orTerms * 5, 60);
  breadth -= Math.min(c.andGroups * 8, 20);
  breadth -= Math.min(c.phrases * 1.5, 12);
  breadth -= Math.min(c.negatives * 1.5, 15);
  breadth -= Math.min(c.filters * 4, 10);
  breadth = Math.max(1, Math.min(100, breadth));

  // Historical noise comes from our own labelled data and improves over time.
  const historicalNoise = c.noiseN > 0 ? c.noiseSum / c.noiseN : 0.35;
  const negativeCoverage = Math.min(1, c.negatives / 12);
  const noiseRisk = Math.max(0, Math.min(100, breadth * (1 - negativeCoverage * 0.6) * (0.5 + historicalNoise)));

  const warnings: QueryEstimate['warnings'] = [];

  if (c.andGroups === 0 && c.orTerms > 3) {
    warnings.push({
      severity: 'critical',
      messageAr: `الاستعلام يحتوي ${c.orTerms} حداً بـ OR بلا أي مجموعة AND — اتساع مرتفع جداً وخطر ضجيج عالٍ. أضف مجموعة AND لتضييق النطاق.`,
    });
  }
  if (c.negatives === 0) {
    warnings.push({
      severity: 'warning',
      messageAr: 'لا توجد كلمات مستبعدة. الكلمات السالبة هي أرخص وسيلة لخفض التكلفة — كل نتيجة غير مرتبطة حصة محروقة.',
    });
  }
  if (!compiled.includes('-is:retweet')) {
    warnings.push({
      severity: 'warning',
      messageAr: 'لم يُستبعد إعادات النشر (-is:retweet). استبعادها يخفض الحجم عادةً 40-60% بلا فقدان معلومة.',
    });
  }
  if (!compiled.includes('lang:')) {
    warnings.push({ severity: 'info', messageAr: 'لم تُحدَّد اللغة. إضافة lang:ar تستبعد نتائج غير عربية مجاناً.' });
  }
  if (compiled.length > MAX_QUERY_LENGTH) {
    warnings.push({
      severity: 'critical',
      messageAr: `طول الاستعلام ${compiled.length} حرفاً ويتجاوز الحد (${MAX_QUERY_LENGTH}). قسّمه إلى استعلامين.`,
    });
  }
  if (compiled.length === 0) {
    warnings.push({ severity: 'critical', messageAr: 'الاستعلام فارغ — أضف كلمة واحدة على الأقل.' });
  }

  return {
    breadthScore: Math.round(breadth * 10) / 10,
    noiseRiskScore: Math.round(noiseRisk * 10) / 10,
    // Broad queries fill the page; narrow ones return far less than the cap.
    estimatedUnitsPerRun: Math.max(1, Math.round(maxResults * (0.2 + (breadth / 100) * 0.8))),
    compiledLength: compiled.length,
    warnings,
  };
}
