/**
 * Influencer card templates: the configuration schema (validated identically
 * by the API before saving and by the web studio while editing), its default
 * (the built-in card), and the proposed permissions.
 *
 * A template is plain data — colours, enumerated fonts, bounded numbers,
 * switches, short plain-text labels and image asset ids. There is no field for
 * HTML, CSS, script, URLs or influencer data; text is drawn on a canvas as
 * text, and anything that looks like markup is refused anyway.
 */
import { z } from 'zod';

export const CARD_TEMPLATE_SCHEMA_VERSION = 1 as const;

/**
 * Proposed permissions (migration 0048 creates the rows, grants none).
 * Deliberately NOT part of PERMISSIONS / ALL_PERMISSIONS: admin is
 * ALL_PERMISSIONS and the seed rebuilds system roles from that list, so adding
 * them there would grant them to admin on the next seed. Granting is a separate,
 * approved RBAC change (see docs/influencer-cards/permissions.md).
 */
export const CARD_PERMISSIONS = {
  EXPORT: 'influencer_cards:export',
  TEMPLATES_READ: 'influencer_card_templates:read',
  TEMPLATES_MANAGE: 'influencer_card_templates:manage',
} as const;

export const CARD_ARABIC_FONTS = ['ibm-plex-sans-arabic', 'cairo', 'tajawal'] as const;
export const CARD_LATIN_FONTS = ['ibm-plex-sans-arabic', 'inter', 'cairo'] as const;
export const CARD_FONT_LABELS: Record<string, string> = {
  'ibm-plex-sans-arabic': 'IBM Plex Sans Arabic', cairo: 'Cairo', tajawal: 'Tajawal', inter: 'Inter',
};
export const CARD_STAT_KEYS = ['posts', 'relevant', 'positive', 'neutral', 'negative', 'unclassified'] as const;
export type CardStatKey = (typeof CARD_STAT_KEYS)[number];
export const CARD_STAT_LABELS: Record<CardStatKey, string> = {
  posts: 'إجمالي المنشورات المرصودة', relevant: 'منها ذات صلة', positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي', unclassified: 'غير مصنف',
};

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'لون HEX بصيغة ‎#RRGGBB');
/** Plain label text: no markup characters, no control characters, no bidi overrides. */
const plain = (max: number) => z.string().max(max, `الحد الأقصى ${max} حرفاً`)
  .refine((s) => !/[<>{}`\\]/.test(s), 'لا يُسمح برموز الوسوم أو الأكواد ( < > { } ` \\ )')
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001F\u007F‪-‮]/.test(s), 'لا يُسمح بمحارف التحكم');
const int = (min: number, max: number) => z.number().int().min(min, `الحد الأدنى ${min}`).max(max, `الحد الأقصى ${max}`);
const assetId = z.string().uuid().nullable();

export const CARD_SECTION_KEYS = ['profile', 'figures', 'summary', 'interactions', 'additional'] as const;
export const CARD_SECTION_LABELS: Record<(typeof CARD_SECTION_KEYS)[number], string> = {
  profile: 'صورة المؤثر والاسم ومعلومات الحساب', figures: 'الإحصائيات', summary: 'الملخص التوضيحي',
  interactions: 'أبرز التفاعلات', additional: 'المعلومات الإضافية',
};
export const CARD_STYLES = ['classic', 'nhc'] as const;
export const CARD_STYLE_LABELS: Record<(typeof CARD_STYLES)[number], string> = { classic: 'التصميم الكلاسيكي', nhc: 'هوية NHC' };
const designSchema = z.object({
  /** Arrangement of the card; optional so templates saved before it keep the classic card. */
  style: z.enum(CARD_STYLES).optional(),
  logoShow: z.boolean(), logoMargin: int(0, 24), defaultLogo: z.boolean(),
  align: z.enum(['auto', 'right', 'center', 'left']), statColumns: int(1, 6),
  gradient: z.boolean(), gradientEnd: hex, gradientDirection: z.enum(['vertical', 'horizontal']),
  gradientOpacity: z.number().min(0).max(1), imageDim: z.number().min(0).max(0.8),
  figuresTitle: plain(60), interactionsTitle: plain(60),
  summaryTitle: plain(60), summaryText: plain(500), additionalTitle: plain(60), additionalText: plain(500),
  statLabels: z.object({ posts: plain(50), relevant: plain(50), positive: plain(50), neutral: plain(50), negative: plain(50), unclassified: plain(50) }).strict(),
  sections: z.array(z.object({ key: z.enum(CARD_SECTION_KEYS), show: z.boolean() }).strict()).length(CARD_SECTION_KEYS.length)
    .refine(list => new Set(list.map(s => s.key)).size === CARD_SECTION_KEYS.length, 'يجب أن يرد كل قسم مرة واحدة'),
}).strict();
export const DEFAULT_CARD_DESIGN: z.infer<typeof designSchema> = {
  logoShow: true, logoMargin: 0, defaultLogo: false, align: 'auto', statColumns: 6,
  gradient: false, gradientEnd: '#dce8f2', gradientDirection: 'vertical', gradientOpacity: 1, imageDim: 0,
  figuresTitle: 'مؤشرات الفترة', interactionsTitle: 'أحدث التفاعلات المرصودة',
  summaryTitle: 'الملخص', summaryText: '', additionalTitle: 'معلومات إضافية', additionalText: '',
  statLabels: { ...CARD_STAT_LABELS },
  sections: CARD_SECTION_KEYS.map(key => ({ key, show: !['summary', 'additional'].includes(key) })),
};

export const cardTemplateConfigSchema = z.object({
  schemaVersion: z.literal(CARD_TEMPLATE_SCHEMA_VERSION),
  // Optional additive design settings preserve old schema-v1 published JSON.
  design: designSchema.optional(),
  colors: z.object({
    page: hex, header: hex, headerText: hex, headerMuted: hex, accent: hex,
    surface: hex, border: hex, title: hex, text: hex, muted: hex, link: hex,
    footer: hex, footerText: hex, indicator: hex,
    positive: hex, neutral: hex, negative: hex, unclassified: hex,
  }).strict(),
  typography: z.object({
    arabicFont: z.enum(CARD_ARABIC_FONTS),
    latinFont: z.enum(CARD_LATIN_FONTS),
    headerTitleSize: int(16, 28),
    handleSize: int(16, 28),
    nameSize: int(12, 18),
    bodySize: int(11, 16),
    smallSize: int(10, 13),
    statValueSize: int(16, 28),
    titleWeight: z.union([z.literal(500), z.literal(600), z.literal(700)]),
    bodyWeight: z.union([z.literal(400), z.literal(500)]),
    /** Body line height as a multiple of the body size. */
    lineHeight: z.number().min(1.4).max(2),
  }).strict(),
  logo: z.object({
    assetId,
    position: z.enum(['start', 'end']),
    /** Up to 120 px so a stacked brand logo (e.g. NHC with its Arabic tagline) stays legible. */
    height: int(20, 120),
  }).strict(),
  background: z.object({
    decoration: z.enum(['none', 'lattice', 'dots', 'diagonal']),
    decorationOpacity: z.number().min(0).max(0.3),
    imageAssetId: assetId,
    imageOpacity: z.number().min(0).max(0.5),
    footerPattern: z.enum(['lattice', 'diagonal', 'plain', 'leaves', 'vines']),
  }).strict(),
  avatar: z.object({
    show: z.boolean(),
    size: int(32, 72),
    shape: z.enum(['circle', 'rounded']),
  }).strict(),
  layout: z.object({
    padding: int(16, 48),
    gap: int(8, 24),
    radius: int(0, 24),
  }).strict(),
  stats: z.array(z.object({ key: z.enum(CARD_STAT_KEYS), show: z.boolean() }).strict()).length(CARD_STAT_KEYS.length)
    .refine((list) => new Set(list.map((s) => s.key)).size === CARD_STAT_KEYS.length, 'يجب أن يرد كل مؤشر مرة واحدة'),
  visibility: z.object({
    displayName: z.boolean(), bio: z.boolean(), verifiedBadge: z.boolean(), followers: z.boolean(),
    program: z.boolean(), profileSnapshot: z.boolean(),
    figures: z.boolean(), sentimentBar: z.boolean(), figureNotes: z.boolean(),
    issueDate: z.boolean(), range: z.boolean(),
    interactions: z.boolean(), postBadges: z.boolean(), postProgram: z.boolean(), postLinks: z.boolean(),
    footerText: z.boolean(), pageNumbers: z.boolean(),
  }).strict(),
  text: z.object({
    headerTitle: plain(40).refine((s) => s.trim().length > 0, 'عنوان الترويسة مطلوب'),
    headerSubtitle: plain(60),
    footerText: plain(120),
  }).strict(),
  output: z.object({
    pngWidth: z.union([z.literal(720), z.literal(820), z.literal(960), z.literal(1080)]),
    pngScale: z.union([z.literal(2), z.literal(3)]),
    pdfOrientation: z.enum(['portrait', 'landscape']),
  }).strict(),
}).strict();

export type CardTemplateConfig = z.infer<typeof cardTemplateConfigSchema>;
export const resolveCardDesign = (config: CardTemplateConfig) => config.design ?? DEFAULT_CARD_DESIGN;

/** The built-in card (phase 2's look): neutral identity, no logo, no third-party asset. */
export const DEFAULT_CARD_TEMPLATE: CardTemplateConfig = {
  schemaVersion: 1,
  colors: {
    page: '#f5f7f9', header: '#0e2a47', headerText: '#ffffff', headerMuted: '#b9c8d8', accent: '#1fb5b5',
    surface: '#ffffff', border: '#d9e2ea', title: '#0e2a47', text: '#1c2b3a', muted: '#5a6b7d', link: '#2a6fd1',
    footer: '#0e2a47', footerText: '#ffffff', indicator: '#0f766e',
    positive: '#1f5fb8', neutral: '#4f5f70', negative: '#b52f2f', unclassified: '#6b7684',
  },
  typography: {
    arabicFont: 'ibm-plex-sans-arabic', latinFont: 'ibm-plex-sans-arabic',
    headerTitleSize: 20, handleSize: 22, nameSize: 15, bodySize: 13, smallSize: 11, statValueSize: 22,
    titleWeight: 700, bodyWeight: 400, lineHeight: 1.6,
  },
  logo: { assetId: null, position: 'start', height: 40 },
  background: { decoration: 'none', decorationOpacity: 0.08, imageAssetId: null, imageOpacity: 0.12, footerPattern: 'lattice' },
  avatar: { show: true, size: 50, shape: 'circle' },
  layout: { padding: 28, gap: 14, radius: 14 },
  stats: CARD_STAT_KEYS.map((key) => ({ key, show: true })),
  visibility: {
    displayName: true, bio: true, verifiedBadge: true, followers: true, program: true, profileSnapshot: true,
    figures: true, sentimentBar: true, figureNotes: true, issueDate: true, range: true,
    interactions: true, postBadges: true, postProgram: true, postLinks: true, footerText: true, pageNumbers: true,
  },
  text: { headerTitle: 'بطاقة مؤثر', headerSubtitle: 'Influencer Card', footerText: 'أُعدّت من بيانات الرصد المخزّنة في المنصة' },
  output: { pngWidth: 820, pngScale: 2, pdfOrientation: 'portrait' },
};

/**
 * NHC Innovation — Customer Care identity: deep green header with the bundled NHC
 * logo, profile card with figure chips, interaction cards and the leaf footer.
 * Colours sampled from the approved NHC logo and reference card.
 */
export const NHC_CARD_TEMPLATE: CardTemplateConfig = {
  schemaVersion: 1,
  design: {
    ...DEFAULT_CARD_DESIGN, style: 'nhc', logoShow: true, defaultLogo: true,
    sections: CARD_SECTION_KEYS.map((key) => ({ key, show: ['profile', 'interactions'].includes(key) })),
  },
  colors: {
    page: '#f9fafc', header: '#0a4332', headerText: '#7ebb92', headerMuted: '#6f9a8c', accent: '#00a468',
    surface: '#ffffff', border: '#d5e7dc', title: '#0e2d1e', text: '#3c4b44', muted: '#949e9b', link: '#0a7a55',
    footer: '#0a4332', footerText: '#ffffff', indicator: '#0a4332',
    positive: '#2a9858', neutral: '#6b7183', negative: '#bb3939', unclassified: '#8a918f',
  },
  typography: {
    arabicFont: 'ibm-plex-sans-arabic', latinFont: 'ibm-plex-sans-arabic',
    headerTitleSize: 18, handleSize: 26, nameSize: 17, bodySize: 15, smallSize: 12, statValueSize: 22,
    titleWeight: 700, bodyWeight: 400, lineHeight: 1.75,
  },
  logo: { assetId: null, position: 'end', height: 96 },
  background: { decoration: 'none', decorationOpacity: 0.08, imageAssetId: null, imageOpacity: 0.12, footerPattern: 'vines' },
  avatar: { show: true, size: 64, shape: 'circle' },
  layout: { padding: 32, gap: 18, radius: 20 },
  // Order = chip order in the profile card (right to left).
  stats: (['posts', 'negative', 'positive', 'neutral', 'relevant', 'unclassified'] as const).map((key) => ({ key, show: key !== 'relevant' })),
  visibility: {
    displayName: true, bio: true, verifiedBadge: true, followers: true, program: true, profileSnapshot: false,
    figures: true, sentimentBar: false, figureNotes: false, issueDate: true, range: true,
    interactions: true, postBadges: true, postProgram: true, postLinks: true, footerText: false, pageNumbers: true,
  },
  text: { headerTitle: 'بطاقة مؤثر', headerSubtitle: 'Influencer Card', footerText: '' },
  output: { pngWidth: 820, pngScale: 2, pdfOrientation: 'portrait' },
};

/** What exports use when no template is published: the NHC identity card. */
export const BUILTIN_CARD_TEMPLATE = NHC_CARD_TEMPLATE;

/** Asset ids a configuration refers to (to check they exist before saving). */
export const cardTemplateAssetIds = (c: CardTemplateConfig) =>
  [c.logo.assetId, c.background.imageAssetId].filter((v): v is string => Boolean(v));

export const CARD_ASSET_LIMITS = {
  maxBytes: 1024 * 1024,
  minSide: 16,
  maxSide: 4096,
  types: ['image/png', 'image/jpeg', 'image/webp'] as const,
};

/** Field-level messages from a failed parse, keyed by dotted path. */
export function cardTemplateIssues(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path.join('.') || '_'] ??= issue.message;
  return out;
}
