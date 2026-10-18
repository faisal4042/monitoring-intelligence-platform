/**
 * Card layout: CardData + template → pages of drawing operations. Pure (the
 * only dependency is the injected `measure`), so geometry, pagination and
 * bounds are unit-testable, and preview, PNG and PDF paint the very same list.
 *
 * Arrangement follows the legacy card: header band, profile card, figures,
 * latest interactions, patterned footer strip. Every colour, font, size,
 * spacing, switch and label comes from the template (theme.ts); with the
 * default template the card is the phase 2 card.
 *
 * Deliberate differences from the legacy card: every figure is its own
 * labelled tile (no dominant-sentiment verdict the platform does not define),
 * text is measured only after the font loaded, long words and links break
 * instead of overflowing, nothing is cut silently, and the same content is
 * drawn in every output.
 *
 * Pagination (A4): a post card moves whole to the next page when it fits
 * there; one taller than a full page is split between lines, each part
 * labelled («تابع» / «يتبع في الصفحة التالية»). The section heading never
 * ends a page alone.
 */
import { DEFAULT_CARD_TEMPLATE, type CardTemplateConfig } from '@mip/shared';
import { fmtCompact, fmtDate, fmtDateTime, fmtNum } from '../format';
import { over, resolveTheme, tint, type CardTheme, type ImageSize } from './theme';
import { baseDir, fitLine, wrapText } from './text';
import {
  A4_SIZES, type Align, type CardData, type CardFormat, type CardLayout, type CardLink, type CardPage,
  type CardPost, type DrawItem, type Measure, type TextDir,
} from './types';

const POST_GAP = 10;
const MIN_SPLIT_LINES = 3;
const MIN_TILE = 112;

/** X post links and profile links the card may make clickable; anything else is shown as text only. */
export const safePostUrl = (u: string | null | undefined) => (u && /^https:\/\/x\.com\/i\/status\/\d{1,25}$/.test(u) ? u : null);
export const safeProfileUrl = (u: string | null | undefined) => (u && /^https:\/\/x\.com\/[A-Za-z0-9_]{1,50}$/.test(u) ? u : null);

/** A Riyadh calendar day key (YYYY-MM-DD) as `07 أكتوبر 2026`, the same way the period picker shows it. */
const dayKey = (key: string) => fmtDate(`${key}T12:00:00+03:00`);

export function rangeLabel(d: CardData): string {
  if (d.range.preset === 'all') return 'كل الفترات';
  const { fromDate, toDate } = d.range;
  if (fromDate && toDate) return fromDate === toDate ? dayKey(fromDate) : `${dayKey(fromDate)} – ${dayKey(toDate)}`;
  return `${fmtDate(d.current.from)} – ${fmtDate(d.current.to)}`;
}

const SENTIMENT_KEYS = ['positive', 'neutral', 'negative', 'unclassified'] as const;

interface Placed { items: DrawItem[]; links: CardLink[] }
interface Block {
  height: number;
  draw(y: number): Placed;
  /** Moves to the next page together with the block after it (headings). */
  keepWithNext?: boolean;
  /** Splittable blocks: a head that fits `avail`, or null when not even a readable part fits. */
  split?(avail: number): { head: Block; tail: Block | null } | null;
  /** The least height this block needs at the top of a page (its first readable part). */
  minHeight?: number;
}

class Ctx {
  constructor(public measure: Measure, public t: CardTheme, public left: number, public width: number) {}
  get right() { return this.left + this.width; }
  f(weight: number, size: number) { return this.t.font(weight, size); }

  text(x: number, y: number, text: string, font: string, color: string, maxWidth: number, lineHeight: number, dir: TextDir = baseDir(text), align?: Align): DrawItem {
    return { kind: 'text', x, y, text, font, color, maxWidth, lineHeight, dir, align: align ?? (dir === 'rtl' ? 'right' : 'left') };
  }

  /** A pill whose right edge is at `right`; returns its width. Text is shortened to fit `maxWidth`. */
  pill(right: number, y: number, label: string, ink: string, fill: string, maxWidth: number, out: DrawItem[], h = 22) {
    const padX = 10;
    const pf = this.f(this.t.weights.label, this.t.sizes.small);
    const text = fitLine(label, maxWidth - padX * 2, pf, this.measure);
    const w = Math.min(maxWidth, Math.ceil(this.measure(text, pf)) + padX * 2);
    out.push({ kind: 'rect', x: right - w, y, w, h, r: h / 2, fill, stroke: ink, lineWidth: 0.75 });
    out.push(this.text(right - w / 2, y + (h - 14) / 2, text, pf, ink, w - padX * 2, 14, baseDir(text), 'center'));
    return w;
  }
}

// ── Blocks ────────────────────────────────────────────────────────────────────

interface Chip { label: string; ink: string; fill: string; stroke: string }

/** NHC chips: taller, bolder pills that wrap onto further rows instead of overflowing. */
function chipRows(c: Ctx, chips: Chip[], width: number, font: string) {
  const rows: Array<Array<Chip & { w: number }>> = chips.length ? [[]] : [];
  let used = 0;
  for (const chip of chips) {
    const w = Math.min(width, Math.ceil(c.measure(chip.label, font)) + 32);
    if (used && used + 10 + w > width) { rows.push([]); used = 0; }
    rows[rows.length - 1].push({ ...chip, label: fitLine(chip.label, w - 32, font, c.measure), w }); used += (used ? 10 : 0) + w;
  }
  return rows;
}
function drawChipRow(c: Ctx, row: Array<Chip & { w: number }>, right: number, y: number, h: number, font: string, out: DrawItem[]) {
  let x = right;
  const lh = Math.round(c.t.sizes.small * 1.6);
  for (const chip of row) {
    out.push({ kind: 'rect', x: x - chip.w, y, w: chip.w, h, r: h / 2, fill: chip.fill, stroke: chip.stroke, lineWidth: 1.5 });
    out.push(c.text(x - chip.w / 2, y + (h - lh) / 2, chip.label, font, chip.ink, chip.w - 32, lh, baseDir(chip.label), 'center'));
    x -= chip.w + 10;
  }
}
const CHIP_H = 34;

/** NHC profile: avatar, handle, name, bio, then chips for the leading sentiment, followers and the period's figures. */
function nhcProfileBlock(c: Ctx, d: CardData): Block {
  const { t } = c;
  const a = d.account;
  const s = d.figures.sentiment;
  const R = t.avatar.show ? t.avatar.size : 0;
  const pad = t.innerPad + 14;
  const textRight = c.right - pad - (R ? R * 2 + 30 : 0);
  const textWidth = textRight - (c.left + pad);
  const handle = `@${a.username}`;
  const verified = t.show.verifiedBadge && a.is_verified === true;
  const F = {
    handle: c.f(t.weights.title, t.sizes.handle), name: c.f(600, t.sizes.name),
    bio: c.f(t.weights.body, t.sizes.small + 1), chip: c.f(600, t.sizes.small + 2),
  };
  const lh = { handle: Math.round(t.sizes.handle * 1.35), name: Math.round(t.sizes.name * 1.5), bio: Math.round((t.sizes.small + 1) * 1.7) };
  const name = t.show.displayName ? a.display_name ?? (a.seen ? null : 'لم يُجمع أي منشور من هذا الحساب بعد') : null;
  const bio = t.show.bio && a.author_bio ? wrapText(a.author_bio, textWidth, F.bio, c.measure, 2) : null;

  const tone = (key: 'positive' | 'neutral' | 'negative' | 'unclassified') => t.sentiment[key];
  const first: Chip[] = [];
  // The leading sentiment is stated only when enough posts carry one (the same threshold the figures use).
  if (d.figures.posts > 0 && s.reliable) {
    const lead = (['neutral', 'negative', 'positive'] as const).reduce((m, k) => (s[k] > s[m] ? k : m), 'neutral' as 'neutral' | 'negative' | 'positive');
    first.push({ label: tone(lead).label, ink: tone(lead).ink, fill: t.colors.surface, stroke: tone(lead).ink });
  }
  if (t.show.followers && a.followers_count !== null)
    first.push({ label: `${fmtCompact(a.followers_count)} متابع`, ink: t.colors.indicator, fill: t.pillFill, stroke: t.pillFill });
  if (t.show.program && d.program)
    first.push({ label: d.program.name_ar, ink: t.colors.indicator, fill: t.colors.surface, stroke: tint(t.colors.indicator, 0.6) });
  const values = { posts: d.figures.posts, relevant: d.figures.relevant, positive: s.positive, neutral: s.neutral, negative: s.negative, unclassified: s.unclassified };
  const names = { posts: 'تفاعل', relevant: 'ذو صلة', positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي', unclassified: 'غير مصنف' };
  const second: Chip[] = !t.show.figures ? [] : t.stats.filter((k) => k !== 'unclassified' || values.unclassified > 0).map((k) => {
    const plain = k === 'posts' || k === 'relevant';
    const ink = plain ? t.colors.indicator : tone(k).ink;
    const fill = plain ? t.pillFill : tone(k).fill;
    return { label: `${fmtNum(values[k])} ${names[k]}`, ink, fill, stroke: plain ? fill : tint(ink, 0.72) };
  });
  const rows = [...chipRows(c, first, textWidth, F.chip), ...chipRows(c, second, textWidth, F.chip)];
  const contentH = lh.handle + 4 + (name ? lh.name + 2 : 0) + (bio ? bio.lines.length * lh.bio + 10 : 4) + rows.length * (CHIP_H + 10);
  const height = Math.max(R * 2 + pad * 2, contentH + pad * 2 - 10);

  return {
    height,
    draw(y) {
      const items: DrawItem[] = [];
      const links: CardLink[] = [];
      items.push({ kind: 'rect', x: c.left, y, w: c.width, h: height, r: t.radius, fill: t.colors.surface, stroke: t.colors.border, lineWidth: 2 });
      if (R) {
        const fb = avatarFallback(c, a.username, a.display_name);
        const cx = c.right - pad - R, cy = y + height / 2;
        items.push({ kind: 'rect', x: cx - R - 8, y: cy - R - 8, w: (R + 8) * 2, h: (R + 8) * 2, r: R + 8, fill: tint(t.colors.border, 0.45), stroke: t.colors.border, lineWidth: 1.5 });
        items.push({ kind: 'avatar', cx, cy, r: R, shape: t.avatar.shape, initial: fb.initial, tone: t.colors.header, ring: '#ffffff', font: c.f(700, Math.round(R * 0.8)) });
      }
      let ty = y + Math.max(pad - 4, (height - contentH) / 2);
      const handleMax = textWidth - (verified ? 30 : 0);
      const handleText = fitLine(handle, handleMax, F.handle, c.measure);
      items.push(c.text(textRight, ty, handleText, F.handle, t.colors.title, handleMax, lh.handle, 'ltr', 'right'));
      const hw = c.measure(handleText, F.handle);
      const url = safeProfileUrl(a.x_url);
      if (url) links.push({ x: textRight - hw, y: ty, w: hw, h: lh.handle, url });
      if (verified) items.push({ kind: 'verified', cx: textRight - hw - 16, cy: ty + lh.handle / 2, r: 10, color: '#1d9bf0' });
      ty += lh.handle + 4;
      if (name) {
        const line = fitLine(name, textWidth, F.name, c.measure);
        items.push(c.text(textRight, ty, line, F.name, over(t.colors.surface, t.colors.text, 0.85), textWidth, lh.name, baseDir(line), 'right'));
        ty += lh.name + 2;
      }
      if (bio) {
        bio.lines.forEach((line, i) => items.push(c.text(textRight, ty + i * lh.bio, line, F.bio, t.colors.muted, textWidth, lh.bio, baseDir(a.author_bio!), 'right')));
        ty += bio.lines.length * lh.bio + 10;
      } else ty += 4;
      for (const row of rows) { drawChipRow(c, row, textRight, ty, CHIP_H, F.chip, items); ty += CHIP_H + 10; }
      return { items, links };
    },
  };
}

function avatarFallback(c: Ctx, username: string, name: string | null) {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
  return { initial: ([...(name ?? username)][0] ?? '?').toUpperCase(), tone: c.t.avatarTones[h % c.t.avatarTones.length] };
}

function profileBlock(c: Ctx, d: CardData): Block {
  const { t } = c;
  const a = d.account;
  const R = t.avatar.show ? t.avatar.size : 0;
  const cardPad = t.innerPad + 4;
  const textRight = c.right - cardPad - (R ? R * 2 + 22 : 0);
  const textLeft = c.left + cardPad;
  const textWidth = textRight - textLeft;
  const handle = `@${a.username}`;
  const verified = t.show.verifiedBadge && a.is_verified === true;
  const handleMax = textWidth - (verified ? 26 : 0);
  const F = {
    handle: c.f(t.weights.title, t.sizes.handle), name: c.f(t.weights.label, t.sizes.name),
    bio: c.f(t.weights.body, t.sizes.small), meta: c.f(t.weights.body, t.sizes.small),
  };

  // Measure first: the card is as tall as its content or the avatar, whichever is larger.
  const name = t.show.displayName ? a.display_name ?? (a.seen ? null : 'لم يُجمع أي منشور من هذا الحساب بعد') : null;
  const bio = t.show.bio && a.author_bio ? wrapText(a.author_bio, textWidth, F.bio, c.measure, 2) : null;
  const pills: Array<{ label: string; ink: string; fill: string }> = [];
  if (t.show.followers) pills.push(a.followers_count !== null
    ? { label: `${fmtNum(a.followers_count)} متابع`, ink: t.colors.title, fill: t.pillFill }
    : { label: 'المتابعون: غير متوفر', ink: t.colors.muted, fill: '#f3f4f6' });
  if (t.show.program) pills.push(d.program
    ? { label: `البرنامج الأكثر ارتباطاً: ${d.program.name_ar}`, ink: t.colors.title, fill: t.pillFill }
    : { label: 'غير مرتبط ببرنامج في الفترة', ink: t.colors.muted, fill: '#f3f4f6' });
  // Pills wrap onto further rows rather than overflow.
  const pillFont = c.f(t.weights.label, t.sizes.small);
  const pillRows: Array<typeof pills> = pills.length ? [[]] : [];
  let rowWidth = 0;
  for (const p of pills) {
    const w = Math.min(textWidth, c.measure(p.label, pillFont) + 20);
    if (rowWidth && rowWidth + 8 + w > textWidth) { pillRows.push([]); rowWidth = 0; }
    pillRows[pillRows.length - 1].push(p); rowWidth += (rowWidth ? 8 : 0) + w;
  }
  const snapshot = t.show.profileSnapshot && a.profile_updated_at ? `بيانات الملف كما جُمعت في ${fmtDate(a.profile_updated_at)}` : null;
  const lh = t.lineHeight;
  const contentH = lh.handle + 2 + (name ? lh.name + 2 : 0) + (bio ? bio.lines.length * lh.small + 6 : 0) + pillRows.length * 30 + (snapshot ? lh.small + 2 : 0);
  const height = Math.max(R * 2 + cardPad * 2, contentH + cardPad * 2);

  return {
    height,
    draw(y) {
      const items: DrawItem[] = [];
      const links: CardLink[] = [];
      items.push({ kind: 'rect', x: c.left, y, w: c.width, h: height, r: t.radius, fill: t.colors.surface, stroke: t.colors.border, lineWidth: 1.25 });
      if (R) {
        const fb = avatarFallback(c, a.username, a.display_name);
        items.push({ kind: 'avatar', cx: c.right - cardPad - R, cy: y + height / 2, r: R, shape: t.avatar.shape, initial: fb.initial, tone: fb.tone,
          ring: '#ffffff', font: c.f(700, Math.round(R * 0.8)) });
      }
      let ty = y + Math.max(cardPad, (height - contentH) / 2);
      const handleText = fitLine(handle, handleMax, F.handle, c.measure);
      items.push(c.text(textRight, ty, handleText, F.handle, t.colors.title, handleMax, lh.handle, 'ltr', 'right'));
      const hw = c.measure(handleText, F.handle);
      const url = safeProfileUrl(a.x_url);
      if (url) links.push({ x: textRight - hw, y: ty, w: hw, h: lh.handle, url });
      if (verified) items.push({ kind: 'verified', cx: textRight - hw - 14, cy: ty + lh.handle / 2, r: 9, color: '#1d9bf0' });
      ty += lh.handle + 2;
      if (name) {
        // Right-aligned whatever its direction: a name starting with a Latin letter must not run past the card.
        const nameLine = fitLine(name, textWidth, F.name, c.measure);
        items.push(c.text(textRight, ty, nameLine, F.name, a.display_name ? t.colors.muted : t.colors.muted, textWidth, lh.name, baseDir(nameLine), 'right'));
        ty += lh.name + 2;
      }
      if (bio) {
        bio.lines.forEach((line, i) => items.push(c.text(textRight, ty + i * lh.small, line, F.bio, t.colors.muted, textWidth, lh.small, baseDir(a.author_bio!), 'right')));
        ty += bio.lines.length * lh.small + 6;
      }
      for (const row of pillRows) {
        let px = textRight;
        for (const p of row) px -= c.pill(px, ty + 2, p.label, p.ink, p.fill, textWidth, items) + 8;
        ty += 30;
      }
      if (snapshot) items.push(c.text(textRight, ty, fitLine(snapshot, textWidth, F.meta, c.measure), F.meta, t.colors.muted, textWidth, lh.small));
      return { items, links };
    },
  };
}

function figuresBlock(c: Ctx, d: CardData): Block | null {
  const { t } = c;
  if (!t.show.figures) return null;
  const fig = d.figures;
  const s = fig.sentiment;
  const pad = t.innerPad;
  const innerLeft = c.left + pad;
  const innerRight = c.right - pad;
  const innerW = innerRight - innerLeft;
  const F = {
    title: c.f(t.weights.title, t.sizes.section), meta: c.f(t.weights.body, t.sizes.small),
    label: c.f(t.weights.label, t.sizes.small), value: c.f(t.weights.title, t.sizes.stat), note: c.f(t.weights.body, t.sizes.small),
  };
  const values = { posts: fig.posts, relevant: fig.relevant, positive: s.positive, neutral: s.neutral, negative: s.negative, unclassified: s.unclassified };
  const labels = t.design.statLabels;
  const tiles = t.stats.map((key) => {
    const tone = key === 'posts' ? { ink: t.colors.title, fill: t.pillFill } : key === 'relevant' ? t.relevance.relevant : t.sentiment[key];
    return { key, label: labels[key], value: values[key], ink: tone.ink, fill: tone.fill };
  });
  // As many tiles per row as keep each at least MIN_TILE wide; the rest wrap to further rows.
  const tileGap = 8;
  const cols = Math.max(1, Math.min(t.design.statColumns, tiles.length, Math.floor((innerW + tileGap) / (MIN_TILE + tileGap))));
  const rows = Math.ceil(tiles.length / cols);
  const tileW = (innerW - tileGap * (cols - 1)) / cols;
  const labelLh = Math.round(t.sizes.small * 1.35);
  const labelLines = tiles.map((tile) => wrapText(tile.label, tileW - 16, F.label, c.measure, 2).lines);
  const valueLh = Math.round(t.sizes.stat * 1.3);
  const tileH = tiles.length ? 12 + Math.max(...labelLines.map((l) => l.length)) * labelLh + 6 + valueLh + 10 : 0;
  const titleLh = Math.round(t.sizes.section * 1.4);
  const noteLh = t.lineHeight.small;

  const notes = !t.show.figureNotes ? [] : [
    '«ذات صلة» جزء من الإجمالي ولا يُجمع معه. المشاعر الأربع تقسيم لإجمالي المنشورات، ومجموعها يساوي الإجمالي.',
    fig.posts > 0 && !s.reliable
      ? `المنشورات الموسومة بمشاعر (${fmtNum(s.sample)}) أقل من الحد الأدنى (${fmtNum(fig.minSentimentSample)})، فلا يُعتمد توزيعها نسباً.`
      : null,
    fig.humanReviewed > 0 ? `${fmtNum(fig.humanReviewed)} منها راجعها موظف رصد، وتُعتمد قيم مراجعته بدل التصنيف الآلي.` : null,
  ].filter((n): n is string => Boolean(n));
  const noteBlocks = notes.map((n) => wrapText(n, innerW, F.note, c.measure).lines);
  const bar = t.show.sentimentBar && fig.posts > 0;
  const showRange = t.show.range;
  const height = pad + titleLh + 6 + rows * tileH + (rows - 1) * tileGap + (bar ? 22 : 0) + (noteBlocks.length ? 10 : 0)
    + noteBlocks.reduce((h, l) => h + l.length * noteLh, 0) + pad;

  return {
    height,
    draw(y) {
      const items: DrawItem[] = [];
      items.push({ kind: 'rect', x: c.left, y, w: c.width, h: height, r: t.radius, fill: t.colors.surface, stroke: t.colors.border, lineWidth: 1.25 });
      let ty = y + pad;
      items.push(c.text(innerRight, ty, fitLine(t.design.figuresTitle, innerW / 2, F.title, c.measure), F.title, t.colors.title, innerW / 2, titleLh));
      if (showRange) {
        const period = fitLine(`نطاق الرصد: ${rangeLabel(d)}${d.programFilter ? ` · ${d.programFilter.name_ar}` : ''}`, innerW / 2 - 8, F.meta, c.measure);
        items.push(c.text(innerLeft, ty + (titleLh - noteLh) / 2, period, F.meta, t.colors.muted, innerW / 2 - 8, noteLh, 'rtl', 'left'));
      }
      ty += titleLh + 6;
      tiles.forEach((tile, i) => {
        const row = Math.floor(i / cols), col = i % cols;
        const x = innerRight - (col + 1) * tileW - col * tileGap;
        const yy = ty + row * (tileH + tileGap);
        items.push({ kind: 'rect', x, y: yy, w: tileW, h: tileH, r: Math.min(10, t.radius), fill: tile.fill, stroke: tile.fill });
        labelLines[i].forEach((line, li) => items.push(c.text(x + tileW - 8, yy + 10 + li * labelLh, line, F.label, tile.ink, tileW - 16, labelLh)));
        const value = fitLine(fmtNum(tile.value), tileW - 16, F.value, c.measure);
        items.push(c.text(x + tileW - 8, yy + tileH - 10 - valueLh, value, F.value, tile.ink, tileW - 16, valueLh, 'ltr', 'right'));
      });
      ty += rows * tileH + (rows - 1) * tileGap;
      if (bar) {
        // Stacked bar, right to left: positive, neutral, negative, unclassified — widths are shares of all posts.
        ty += 10;
        let x = innerRight;
        items.push({ kind: 'rect', x: innerLeft, y: ty, w: innerW, h: 10, r: 5, fill: t.divider });
        for (const k of SENTIMENT_KEYS) {
          const w = (s[k] / fig.posts) * innerW;
          if (w <= 0) continue;
          x -= w;
          items.push({ kind: 'rect', x, y: ty, w, h: 10, r: 0, fill: k === 'unclassified' ? t.sentiment.unclassified.fill : t.sentiment[k].ink });
        }
        ty += 12;
      }
      if (noteBlocks.length) ty += 10;
      for (const lines of noteBlocks) {
        lines.forEach((line, i) => items.push(c.text(innerRight, ty + i * noteLh, line, F.note, t.colors.muted, innerW, noteLh, 'rtl')));
        ty += lines.length * noteLh;
      }
      return { items, links: [] };
    },
  };
}

function headingBlock(c: Ctx, d: CardData): Block {
  const { t } = c;
  if (t.style === 'nhc') {
    const font = c.f(600, t.sizes.section), lh = Math.round(t.sizes.section * 1.5);
    return { height: lh, keepWithNext: true,
      draw: (y) => ({ items: [c.text(c.right, y, fitLine(t.design.interactionsTitle, c.width, font, c.measure), font, t.colors.muted, c.width, lh)], links: [] }) };
  }
  const shown = d.recent.length;
  const scope = d.recentScope === 'relevant' ? 'ذات الصلة فقط' : 'جميع المنشورات المرصودة';
  const sub = d.recentLimit === 0
    ? 'لم يُطلب عرض أي تفاعل في هذه البطاقة.'
    : `معروض ${fmtNum(shown)} من أصل ${fmtNum(d.recentAvailable)} — ${scope}، الأحدث أولاً.`;
  const F = { title: c.f(t.weights.title, t.sizes.section), sub: c.f(t.weights.body, t.sizes.small + 1) };
  const titleLh = Math.round(t.sizes.section * 1.4);
  const subLh = Math.round((t.sizes.small + 1) * 1.5);
  const subLines = wrapText(sub, c.width, F.sub, c.measure).lines;
  const height = titleLh + 2 + subLines.length * subLh;
  return {
    height, keepWithNext: true,
    draw(y) {
      const items: DrawItem[] = [c.text(c.right, y, fitLine(t.design.interactionsTitle, c.width, F.title, c.measure), F.title, t.colors.title, c.width, titleLh)];
      subLines.forEach((line, i) => items.push(c.text(c.right, y + titleLh + 2 + i * subLh, line, F.sub, t.colors.muted, c.width, subLh, 'rtl')));
      return { items, links: [] };
    },
  };
}

function emptyBlock(c: Ctx, d: CardData): Block | null {
  const { t } = c;
  const msg = !d.account.seen ? 'لم يُرصد لهذا الحساب أي منشور في المنصة بعد.'
    : d.recentAvailable === 0 ? (d.recentScope === 'relevant' ? 'لا توجد منشورات ذات صلة ضمن نطاق الرصد.' : 'لا توجد منشورات مرصودة ضمن نطاق الرصد.')
    : null;
  if (!msg) return null;
  const F = c.f(t.weights.body, t.sizes.body);
  const lh = t.lineHeight.body;
  const lines = wrapText(msg, c.width - 40, F, c.measure).lines;
  const height = 24 + lines.length * lh + 24;
  return {
    height,
    draw(y) {
      const items: DrawItem[] = [{ kind: 'rect', x: c.left, y, w: c.width, h: height, r: Math.min(12, t.radius), fill: t.colors.page, stroke: t.colors.border, lineWidth: 1.25, dash: [6, 4] }];
      lines.forEach((line, i) => items.push(c.text(c.left + c.width / 2, y + 24 + i * lh, line, F, t.colors.muted, c.width - 40, lh, 'rtl', 'center')));
      return { items, links: [] };
    },
  };
}

/** Badges for one post, right to left; every one states a stored value, none is inferred. */
function postBadges(t: CardTheme, p: CardPost) {
  const sentiment = p.sentiment_group ? t.sentiment[p.sentiment_group] : t.sentiment.unclassified;
  const relevance = p.relevance === 'relevant' ? t.relevance.relevant : p.relevance ? t.relevance.other : t.relevance.none;
  const out: Array<{ label: string; ink: string; fill: string }> = [
    { label: sentiment.label, ink: sentiment.ink, fill: sentiment.fill },
    { label: relevance.label, ink: relevance.ink, fill: relevance.fill },
  ];
  if (p.human_reviewed) out.push({ label: 'مراجَع بشرياً', ink: t.colors.title, fill: t.pillFill });
  if (p.is_reply) out.push({ label: 'رد', ink: t.colors.muted, fill: '#f3f4f6' });
  else if (p.is_quote) out.push({ label: 'اقتباس', ink: t.colors.muted, fill: '#f3f4f6' });
  return out;
}

function postBlock(c: Ctx, p: CardPost, index: number, total: number): Block {
  const { t } = c;
  const P = { pad: 14, row: 26, program: Math.round(t.sizes.small * 1.6), divider: 10, cont: 24, more: 22, link: 22 };
  const F = { body: c.f(t.weights.body, t.sizes.body), small: c.f(t.weights.body, t.sizes.small) };
  const LH = t.lineHeight.body;
  const smallLh = t.lineHeight.small;
  const inner = c.width - P.pad * 2;
  const text = p.text.trim() ? p.text : '(منشور بلا نص)';
  const dir = baseDir(text);
  const lines = wrapText(text, inner, F.body, c.measure).lines;
  const url = t.show.postLinks ? safePostUrl(p.url) : null;
  const programLine = t.show.postProgram && p.program_name ? `البرنامج: ${p.program_name}` : null;

  const piece = (from: number, to: number): Block => {
    const first = from === 0;
    const last = to === lines.length;
    const top = P.pad + (first ? P.row + (programLine ? P.program : 0) + P.divider : P.cont);
    const bottom = (last ? (url ? P.link : 0) : P.more) + P.pad;
    const height = top + (to - from) * LH + bottom;
    const block: Block = {
      height,
      minHeight: Math.min(height, top + Math.min(lines.length - from, MIN_SPLIT_LINES) * LH + P.more + P.pad),
      draw(y) {
        const items: DrawItem[] = [];
        const links: CardLink[] = [];
        const right = c.right - P.pad;
        const left = c.left + P.pad;
        items.push({ kind: 'rect', x: c.left, y, w: c.width, h: height, r: Math.min(10, t.radius), fill: t.colors.surface, stroke: t.colors.border, lineWidth: 1 });
        let ty = y + P.pad;
        if (first) {
          const date = fmtDateTime(p.posted_at);
          const dateW = Math.min(c.measure(date, F.small), inner / 3);
          items.push(c.text(left, ty + (20 - smallLh) / 2, fitLine(date, inner / 3, F.small, c.measure), F.small, t.colors.muted, inner / 3, smallLh, 'rtl', 'left'));
          if (t.show.postBadges) {
            let bx = right;
            const room = inner - dateW - 12;
            for (const b of postBadges(t, p)) {
              if (right - bx + 40 > room) break;
              bx -= c.pill(bx, ty, b.label, b.ink, b.fill, room - (right - bx), items, 20) + 6;
            }
          }
          ty += P.row;
          if (programLine) {
            items.push(c.text(right, ty, fitLine(programLine, inner, F.small, c.measure), F.small, t.colors.muted, inner, smallLh));
            ty += P.program;
          }
          items.push({ kind: 'line', x1: left, y1: ty + 3, x2: right, y2: ty + 3, color: t.divider, width: 1 });
          ty += P.divider;
        } else {
          items.push(c.text(right, ty, `تابع — التفاعل ${fmtNum(index + 1)} من ${fmtNum(total)}`, F.small, t.colors.muted, inner, smallLh));
          ty += P.cont;
        }
        const align = t.design.align === 'auto' ? (dir === 'rtl' ? 'right' : 'left') : t.design.align;
        const textX = align === 'right' ? right : align === 'left' ? left : (right + left) / 2;
        lines.slice(from, to).forEach((line, i) => items.push(c.text(textX, ty + i * LH, line, F.body, t.colors.text, inner, LH, dir, align)));
        ty += (to - from) * LH;
        if (!last) {
          items.push(c.text(left, ty + 4, 'يتبع في الصفحة التالية ←', F.small, t.colors.muted, inner, smallLh, 'rtl', 'left'));
        } else if (url) {
          const label = 'رابط المنشور:';
          const lw = c.measure(label, F.small);
          items.push(c.text(right, ty + 4, label, F.small, t.colors.muted, lw + 1, smallLh, 'rtl', 'right'));
          const shown = fitLine(url.replace(/^https:\/\//, ''), inner - lw - 10, F.small, c.measure);
          items.push(c.text(left, ty + 4, shown, F.small, t.colors.link, inner - lw - 10, smallLh, 'ltr', 'left'));
          links.push({ x: left, y: ty + 2, w: Math.ceil(c.measure(shown, F.small)), h: smallLh + 2, url });
        }
        return { items, links };
      },
      split(avail) {
        if (height <= avail) return { head: block, tail: null };
        const chrome = top + P.more + P.pad;
        const n = Math.floor((avail - chrome) / LH);
        if (n < MIN_SPLIT_LINES || n >= to - from) return null;
        return { head: piece(from, from + n), tail: piece(from + n, to) };
      },
    };
    return block;
  };
  return piece(0, lines.length);
}

/** `17/10/2026` in Riyadh time, as the NHC card shows post dates. */
const shortDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));

/** NHC interaction card: sentiment pill and date, divider, text, then the post's programme as a quiet tag. The whole card links to the post in the PDF. */
function nhcPostBlock(c: Ctx, p: CardPost, index: number, total: number): Block {
  const { t } = c;
  const P = { pad: 18, row: 36, divider: 16, cont: 26, more: 24 };
  const F = { body: c.f(t.weights.body, t.sizes.body), small: c.f(t.weights.body, t.sizes.small + 1), chip: c.f(600, t.sizes.small + 1), tag: c.f(t.weights.body, t.sizes.small) };
  const LH = t.lineHeight.body;
  const smallLh = Math.round((t.sizes.small + 1) * 1.6);
  const inner = c.width - P.pad * 2;
  const text = p.text.trim() ? p.text : '(منشور بلا نص)';
  // Replies start with @handles; the paragraph is Arabic when most of its letters are (not by its first letter).
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length, latin = (text.replace(/@\w+/g, '').match(/[A-Za-z]/g) ?? []).length;
  const dir: TextDir = arabic >= latin && arabic > 0 ? 'rtl' : baseDir(text);
  const lines = wrapText(text, inner, F.body, c.measure).lines;
  const url = t.show.postLinks ? safePostUrl(p.url) : null;
  const tag = t.show.postProgram && p.program_name ? p.program_name : null;
  const tagLh = Math.round(t.sizes.small * 1.7);
  const sentiment = p.sentiment_group ? t.sentiment[p.sentiment_group] : t.sentiment.unclassified;
  const grey = { ink: t.colors.muted, fill: '#f3f4f6', stroke: '#f3f4f6' };
  const chips: Chip[] = !t.show.postBadges ? [] : [
    { label: sentiment.label, ink: sentiment.ink, fill: t.colors.surface, stroke: sentiment.ink },
    ...(p.human_reviewed ? [{ label: 'مراجَع بشرياً', ink: t.colors.indicator, fill: t.pillFill, stroke: t.pillFill }] : []),
    ...(p.is_reply ? [{ label: 'رد', ...grey }] : p.is_quote ? [{ label: 'اقتباس', ...grey }] : []),
  ];

  const piece = (from: number, to: number): Block => {
    const first = from === 0;
    const last = to === lines.length;
    const top = P.pad + (first ? P.row + P.divider : P.cont);
    const bottom = (last ? (tag ? tagLh + 8 : 0) : P.more) + P.pad;
    const height = top + (to - from) * LH + bottom;
    const block: Block = {
      height,
      minHeight: Math.min(height, top + Math.min(lines.length - from, MIN_SPLIT_LINES) * LH + P.more + P.pad),
      draw(y) {
        const items: DrawItem[] = [];
        const right = c.right - P.pad, left = c.left + P.pad;
        items.push({ kind: 'rect', x: c.left, y, w: c.width, h: height, r: Math.min(18, t.radius), fill: t.colors.surface, stroke: t.colors.border, lineWidth: 1.5 });
        let ty = y + P.pad;
        if (first) {
          const date = shortDate(p.posted_at);
          items.push(c.text(left, ty + (30 - smallLh) / 2, date, F.small, over(t.colors.surface, t.colors.text, 0.75), inner / 3, smallLh, 'ltr', 'left'));
          const dateW = c.measure(date, F.small);
          const row = chipRows(c, chips, inner - dateW - 16, F.chip)[0] ?? [];
          drawChipRow(c, row, right, ty, 30, F.chip, items);
          ty += P.row;
          items.push({ kind: 'line', x1: c.left + 1, y1: ty + 2, x2: c.right - 1, y2: ty + 2, color: t.divider, width: 1.5 });
          ty += P.divider;
        } else {
          items.push(c.text(right, ty, `تابع — التفاعل ${fmtNum(index + 1)} من ${fmtNum(total)}`, F.small, t.colors.muted, inner, smallLh));
          ty += P.cont;
        }
        const align = t.design.align === 'auto' ? (dir === 'rtl' ? 'right' : 'left') : t.design.align;
        const textX = align === 'right' ? right : align === 'left' ? left : (right + left) / 2;
        lines.slice(from, to).forEach((line, i) => items.push(c.text(textX, ty + i * LH, line, F.body, t.colors.text, inner, LH, dir, align)));
        ty += (to - from) * LH;
        if (!last) items.push(c.text(left, ty + 4, 'يتبع في الصفحة التالية ←', F.small, t.colors.muted, inner, smallLh, 'rtl', 'left'));
        else if (tag) items.push(c.text(right, ty + 8, fitLine(tag, inner, F.tag, c.measure), F.tag, t.colors.muted, inner, tagLh));
        return { items, links: url && first ? [{ x: c.left, y, w: c.width, h: height, url }] : [] };
      },
      split(avail) {
        if (height <= avail) return { head: block, tail: null };
        const n = Math.floor((avail - (top + P.more + P.pad)) / LH);
        if (n < MIN_SPLIT_LINES || n >= to - from) return null;
        return { head: piece(from, from + n), tail: piece(from + n, to) };
      },
    };
    return block;
  };
  return piece(0, lines.length);
}

// ── Pages ────────────────────────────────────────────────────────────────────

/** The logo's box: its height from the template, its width from the image's own proportions, never wider than a third of the page. */
function logoBox(t: CardTheme, width: number, headerH: number) {
  if (!t.logo) return null;
  const h = t.logo.height;
  const w = Math.min((width - t.pad * 2) / 3, (h * t.logo.size.width) / t.logo.size.height);
  const hh = Math.min(h, (w * t.logo.size.height) / t.logo.size.width);
  const x = t.logo.position === 'start' ? width - t.pad - t.design.logoMargin - w : t.pad + t.design.logoMargin;
  return { x, y: (headerH - 3 - hh) / 2, w, h: hh };
}

/** NHC header: logo on the left, a thin divider, then «title · subtitle» with the issue date and period under it. */
function nhcHeaderItems(c: Ctx, d: CardData, width: number, issuedDate: string): { items: DrawItem[]; height: number } {
  const { t } = c;
  const h = t.headerHeight;
  const items: DrawItem[] = [{ kind: 'rect', x: 0, y: 0, w: width, h, r: 0, fill: t.colors.header }];
  const logo = logoBox(t, width, h + 3);
  let x = t.pad;
  if (logo) {
    items.push({ kind: 'image', key: 'logo', ...logo, x: t.pad + t.design.logoMargin, fit: 'contain', opacity: 1 });
    x = t.pad + t.design.logoMargin + logo.w + 22;
    items.push({ kind: 'line', x1: x, y1: h * 0.22, x2: x, y2: h * 0.78, color: over(t.colors.header, '#ffffff', 0.22), width: 1.5 });
    x += 22;
  }
  const avail = width - t.pad - x;
  const titleF = c.f(600, t.sizes.headerTitle), metaF = c.f(t.weights.body, t.sizes.small + 1), rangeF = c.f(t.weights.body, t.sizes.small);
  const titleLh = Math.round(t.sizes.headerTitle * 1.5), metaLh = Math.round((t.sizes.small + 1) * 1.6), rangeLh = Math.round(t.sizes.small * 1.6);
  const title = [t.text.headerTitle.trim(), t.text.headerSubtitle.trim()].filter(Boolean).join('  ·  ');
  const rows: Array<{ text: string; font: string; color: string; lh: number; dir: TextDir }> = [
    { text: title, font: titleF, color: t.colors.headerText, lh: titleLh, dir: 'ltr' },
    ...(t.show.issueDate ? [{ text: issuedDate, font: metaF, color: t.colors.headerMuted, lh: metaLh, dir: 'rtl' as const }] : []),
    ...(t.show.range ? [{ text: `نطاق الرصد: ${rangeLabel(d)}${d.programFilter ? ` · ${d.programFilter.name_ar}` : ''}`, font: rangeF, color: t.colors.headerMuted, lh: rangeLh, dir: 'rtl' as const }] : []),
  ];
  let y = (h - rows.reduce((sum, r) => sum + r.lh + 2, -2)) / 2;
  for (const r of rows) { items.push(c.text(x, y, fitLine(r.text, avail, r.font, c.measure), r.font, r.color, avail, r.lh, r.dir, 'left')); y += r.lh + 2; }
  return { items, height: h };
}

function headerItems(c: Ctx, d: CardData, width: number, first: boolean, issued: string, issuedDate: string): { items: DrawItem[]; height: number } {
  const { t } = c;
  if (first && t.style === 'nhc') return nhcHeaderItems(c, d, width, issuedDate);
  const h = first ? t.headerHeight : 48;
  const items: DrawItem[] = [
    { kind: 'rect', x: 0, y: 0, w: width, h, r: 0, fill: t.colors.header },
    ...(t.style === 'nhc' ? [] : [{ kind: 'rect' as const, x: 0, y: h - 3, w: width, h: 3, r: 0, fill: t.colors.accent }]),
  ];
  const logo = first ? logoBox(t, width, h) : null;
  // The side the logo sits on gives up its width to it.
  const rightEdge = width - t.pad - (logo && t.logo!.position === 'start' ? logo.w + t.design.logoMargin + 16 : 0);
  const leftEdge = t.pad + (logo && t.logo!.position === 'end' ? logo.w + t.design.logoMargin + 16 : 0);
  const half = (rightEdge - leftEdge) / 2 - 8;
  const small = c.f(t.weights.body, t.sizes.small);
  const smallLh = t.lineHeight.small;
  if (logo) items.push({ kind: 'image', key: 'logo', ...logo, fit: 'contain', opacity: 1 });
  if (first) {
    const titleF = c.f(t.weights.title, t.sizes.headerTitle);
    const titleLh = Math.round(t.sizes.headerTitle * 1.3);
    const sub = t.text.headerSubtitle.trim();
    const block = titleLh + (sub ? 4 + smallLh : 0);
    const ty = (h - 3 - block) / 2;
    const title = fitLine(t.text.headerTitle, half, titleF, c.measure);
    items.push(c.text(rightEdge, ty, title, titleF, t.colors.headerText, half, titleLh, baseDir(title), 'right'));
    if (sub) {
      const s = fitLine(sub, half, small, c.measure);
      items.push(c.text(rightEdge, ty + titleLh + 4, s, small, t.colors.headerMuted, half, smallLh, baseDir(s), 'right'));
    }
    const meta = [
      t.show.issueDate ? { text: `تاريخ الإصدار: ${issued}`, color: t.colors.headerText } : null,
      t.show.range ? { text: `نطاق الرصد: ${rangeLabel(d)}`, color: t.colors.headerMuted } : null,
    ].filter((m): m is { text: string; color: string } => Boolean(m));
    const my = (h - 3 - meta.length * (smallLh + 6)) / 2;
    meta.forEach((m, i) => items.push(c.text(leftEdge, my + i * (smallLh + 6), fitLine(m.text, half, small, c.measure), small, m.color, half, smallLh, 'rtl', 'left')));
  } else {
    const label = fitLine(`${t.text.headerTitle} · ⁦@${d.account.username}⁩ (تابع)`, half, small, c.measure);
    items.push(c.text(width - t.pad, (h - 3 - smallLh) / 2, label, small, t.colors.headerText, half, smallLh, 'rtl', 'right'));
    if (t.show.range)
      items.push(c.text(t.pad, (h - 3 - smallLh) / 2, fitLine(`نطاق الرصد: ${rangeLabel(d)}`, half, small, c.measure), small, t.colors.headerMuted, half, smallLh, 'rtl', 'left'));
  }
  return { items, height: h };
}

function footerItems(c: Ctx, width: number, y: number, page: number | null, pages: number | null): DrawItem[] {
  const { t } = c;
  const h = t.footerHeight;
  const half = (width - t.pad * 2) / 2 - 8;
  const small = c.f(t.weights.body, t.sizes.small);
  const smallLh = t.lineHeight.small;
  const ink = t.background.footerPattern === 'leaves' ? t.colors.accent : over(t.colors.footer, t.colors.accent, 0.22);
  const items: DrawItem[] = [{ kind: 'pattern', style: t.background.footerPattern, x: 0, y, w: width, h, base: t.colors.footer, ink }];
  // «vines»: the NHC strip image over the footer colour (the colour alone shows if the image did not load).
  if (t.background.footerPattern === 'vines') items.push({ kind: 'image', key: 'footer', x: 0, y, w: width, h, fit: 'cover', opacity: 1 });
  const footer = t.text.footerText.trim();
  if (t.show.footerText && footer)
    items.push(c.text(width - t.pad, y + (h - smallLh) / 2, fitLine(footer, half, small, c.measure), small, t.colors.footerText, half, smallLh, baseDir(footer), 'right'));
  if (t.show.pageNumbers && page !== null && pages !== null)
    items.push(c.text(t.pad, y + (h - smallLh) / 2, `صفحة ${fmtNum(page)} من ${fmtNum(pages)}`, small, t.colors.footerText, half, smallLh, 'rtl', 'left'));
  return items;
}

export interface LayoutOptions {
  format: CardFormat;
  measure: Measure;
  /** The template to draw with; the built-in card when omitted. */
  template?: CardTemplateConfig;
  /** Natural sizes of the template's images, when they loaded; a missing one is simply not drawn. */
  images?: { logo?: ImageSize | null; background?: ImageSize | null };
  issuedAt?: string;
}

export function layoutCard(d: CardData, { format, measure, template = DEFAULT_CARD_TEMPLATE, images = {}, issuedAt }: LayoutOptions): CardLayout {
  const t = resolveTheme(template, images);
  const size = format === 'png' ? { width: t.pngWidth, height: null } : A4_SIZES[format];
  const width = size.width;
  const c = new Ctx(measure, t, t.pad, width - t.pad * 2);
  const issued = fmtDateTime(issuedAt ?? d.generatedAt);
  const issuedDate = fmtDate(issuedAt ?? d.generatedAt);
  const nhc = t.style === 'nhc';
  const postGap = nhc ? 16 : POST_GAP;

  const blocks: Block[] = [];
  let figures = figuresBlock(c, d);
  // On A4 a very tall single-column statistic group must fit a fresh page.
  // Increase responsive columns instead of clipping figures or the footer.
  if (size.height !== null) {
    const maxHeight = size.height - t.footerHeight - 16 - (48 + 18);
    for (let columns = t.design.statColumns + 1; figures && figures.height > maxHeight && columns <= 6; columns++)
      figures = figuresBlock(new Ctx(measure, { ...t, design: { ...t.design, statColumns: columns } }, c.left, c.width), d);
  }
  const posts: Block[] = [];
  for (const section of t.design.sections) {
    if (!section.show) continue;
    if (section.key === 'profile') blocks.push(nhc ? nhcProfileBlock(c, d) : profileBlock(c, d));
    else if (section.key === 'figures' && figures) blocks.push(figures);
    else if (section.key === 'interactions' && t.show.interactions) {
      blocks.push(headingBlock(c, d));
      const empty = emptyBlock(c, d); if (empty) blocks.push(empty);
      d.recent.forEach((p, i) => posts.push((nhc ? nhcPostBlock : postBlock)(c, p, i, d.recent.length)));
      blocks.push(...posts);
    } else if (section.key === 'summary' || section.key === 'additional') {
      const title = section.key === 'summary' ? t.design.summaryTitle : t.design.additionalTitle;
      const text = section.key === 'summary' ? t.design.summaryText : t.design.additionalText;
      if (text.trim()) {
        const font = c.f(t.weights.body, t.sizes.body), lh = t.lineHeight.body;
        const lines = wrapText(text, c.width - t.innerPad * 2, font, measure).lines;
        blocks.push({ height: lh * (lines.length + 1) + t.innerPad * 2,
          draw(y) { const items: DrawItem[] = [{ kind: 'rect', x: c.left, y, w: c.width, h: lh * (lines.length + 1) + t.innerPad * 2, r: t.radius, fill: t.colors.surface }];
            [title, ...lines].forEach((line, i) => items.push(c.text(c.right - t.innerPad, y + t.innerPad + i * lh, fitLine(line, c.width - t.innerPad * 2, font, measure), font, t.colors.text, c.width - t.innerPad * 2, lh, baseDir(line), 'right')));
            return { items, links: [] }; } });
      }
    }
  }

  type Draft = { items: DrawItem[]; links: CardLink[]; y: number; top: number; headerH: number };
  const pages: Draft[] = [];
  const open = () => {
    const header = headerItems(c, d, width, pages.length === 0, issued, issuedDate);
    const top = header.height + (nhc ? 30 : 18);
    pages.push({ items: header.items, links: [], y: top, top, headerH: header.height });
  };
  const place = (b: Block, gap: number) => {
    const page = pages[pages.length - 1];
    const placed = b.draw(page.y);
    page.items.push(...placed.items); page.links.push(...placed.links);
    page.y += b.height + gap;
  };
  open();

  // Content ends above the footer strip on A4; the continuous PNG simply grows.
  const bottom = size.height === null ? Infinity : size.height - t.footerHeight - 16;
  for (let i = 0; i < blocks.length; i++) {
    let b: Block | null = blocks[i];
    const gap = posts.includes(b) ? postGap : t.gap;
    const next = blocks[i + 1];
    while (b) {
      const page = pages[pages.length - 1];
      const avail = bottom - page.y;
      const atTop = page.y === page.top;
      const needed = b.height + (b.keepWithNext && next ? t.gap + (next.minHeight ?? next.height) : 0);
      if (needed <= avail) { place(b, gap); b = null; continue; }
      if (!b.split) {
        // Unsplittable blocks start the next page; at a page top they are placed as they are.
        if (atTop) { place(b, gap); b = null; } else open();
        continue;
      }
      // Whole on a fresh page when it fits there; otherwise fill this page and carry on.
      const fullPage = bottom - (48 + 18);
      if (!atTop && b.height <= fullPage) { open(); continue; }
      const parts = b.split(avail);
      if (!parts) { if (atTop) { place(b, gap); b = null; } else open(); continue; }
      place(parts.head, gap);
      b = parts.tail;
      if (b) open();
    }
  }

  const n = pages.length;
  const out: CardPage[] = pages.map((p, i) => {
    const height = size.height ?? Math.ceil(p.y - (posts.length ? postGap : t.gap) + (nhc ? 30 : 18) + t.footerHeight);
    // Background layers under everything: page colour, optional image, optional drawn decoration (below the header band).
    const below: DrawItem[] = [{ kind: 'rect', x: 0, y: 0, w: width, h: height, r: 0, fill: t.colors.page }];
    const bodyY = p.headerH, bodyH = height - p.headerH - t.footerHeight;
    if (t.design.gradient) below.push({ kind: 'gradient', x: 0, y: bodyY, w: width, h: bodyH, start: t.colors.page, end: t.design.gradientEnd, horizontal: t.design.gradientDirection === 'horizontal', opacity: t.design.gradientOpacity });
    if (t.background.image && t.background.imageOpacity > 0)
      below.push({ kind: 'image', key: 'background', x: 0, y: bodyY, w: width, h: bodyH, fit: 'cover', opacity: t.background.imageOpacity });
    if (t.background.image && t.design.imageDim > 0) below.push({ kind: 'gradient', x: 0, y: bodyY, w: width, h: bodyH, start: '#000000', end: '#000000', horizontal: false, opacity: t.design.imageDim });
    if (t.background.decoration !== 'none' && t.background.decorationOpacity > 0)
      below.push({ kind: 'decoration', style: t.background.decoration, x: 0, y: bodyY, w: width, h: bodyH, color: t.colors.accent, opacity: t.background.decorationOpacity });
    const footer = footerItems(c, width, height - t.footerHeight, size.height === null ? null : i + 1, size.height === null ? null : n);
    return { width, height, items: [...below, ...p.items, ...footer], links: p.links };
  });
  return { format, pages: out };
}

/** Every item's box, for bounds checks: text by its measured width at its alignment. */
export function itemBounds(item: DrawItem, measure: Measure): { x: number; y: number; w: number; h: number } {
  switch (item.kind) {
    case 'rect': case 'pattern': case 'image': case 'decoration': case 'gradient': return { x: item.x, y: item.y, w: item.w, h: item.h };
    case 'line': return { x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2), w: Math.abs(item.x2 - item.x1), h: Math.abs(item.y2 - item.y1) };
    case 'avatar': case 'verified': return { x: item.cx - item.r, y: item.cy - item.r, w: item.r * 2, h: item.r * 2 };
    case 'text': {
      const w = measure(item.text, item.font);
      const x = item.align === 'right' ? item.x - w : item.align === 'center' ? item.x - w / 2 : item.x;
      return { x, y: item.y, w, h: item.lineHeight };
    }
  }
}
