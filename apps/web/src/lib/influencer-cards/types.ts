/**
 * Influencer card types: the API payload (GET /influencers/:id/card), the
 * output formats, and the display list the layout produces and every output
 * (preview, PNG, PDF) paints.
 */

export type CardScope = 'all' | 'relevant';

export interface CardPost {
  id: string;
  x_post_id: string;
  posted_at: string;
  text: string;
  url: string | null;
  is_reply: boolean;
  is_quote: boolean;
  relevance: string | null;
  sentiment: string | null;
  sentiment_group: 'positive' | 'neutral' | 'negative' | null;
  human_reviewed: boolean;
  program_id: string | null;
  program_name: string | null;
}

export interface CardData {
  range: { preset: string; from: string | null; to: string | null; fromDate: string | null; toDate: string | null };
  current: { from: string; to: string };
  programFilter: { id: string; key: string; name_ar: string; color: string | null } | null;
  generatedAt: string;
  account: {
    id: string; username: string; notes: string | null;
    x_author_id: string | null; display_name: string | null; author_bio: string | null;
    followers_count: number | null; is_verified: boolean | null; profile_updated_at: string | null;
    x_url: string; seen: boolean; avatar: string | null;
  };
  figures: {
    posts: number; relevant: number; classified: number; humanReviewed: number;
    sentiment: { positive: number; neutral: number; negative: number; unclassified: number; sample: number; reliable: boolean };
    minSentimentSample: number;
  };
  program: { id: string; key: string; name_ar: string; color: string | null; posts: number } | null;
  recent: CardPost[];
  recentLimit: number;
  recentScope: CardScope;
  recentAvailable: number;
}

/** `png` is one continuous card (width from the template); the A4 formats are paginated for PDF. */
export type CardFormat = 'png' | 'a4-portrait' | 'a4-landscape';

/** A4 page sizes in CSS pixels (96 dpi). A4 is 210 × 297 mm. */
export const A4_SIZES = {
  'a4-portrait': { width: 794, height: 1123 },
  'a4-landscape': { width: 1123, height: 794 },
} as const;

export type TextDir = 'rtl' | 'ltr';
export type Align = 'right' | 'left' | 'center';
export type ImageKey = 'avatar' | 'logo' | 'background' | 'footer';

/** One drawing operation; coordinates are CSS pixels inside its page. */
export type DrawItem =
  | { kind: 'gradient'; x: number; y: number; w: number; h: number; start: string; end: string; horizontal: boolean; opacity: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill?: string; stroke?: string; lineWidth?: number; dash?: number[] }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | {
      kind: 'text'; x: number; y: number; text: string; font: string; color: string; align: Align; dir: TextDir;
      /** The box the text was laid out in; its measured width never exceeds `maxWidth`. */
      maxWidth: number; lineHeight: number;
    }
  | { kind: 'avatar'; cx: number; cy: number; r: number; shape: 'circle' | 'rounded'; initial: string; tone: string; ring: string; font: string }
  | { kind: 'verified'; cx: number; cy: number; r: number; color: string }
  | { kind: 'image'; key: Exclude<ImageKey, 'avatar'>; x: number; y: number; w: number; h: number; fit: 'contain' | 'cover'; opacity: number }
  | { kind: 'decoration'; style: 'lattice' | 'dots' | 'diagonal'; x: number; y: number; w: number; h: number; color: string; opacity: number }
  | { kind: 'pattern'; style: 'lattice' | 'diagonal' | 'plain' | 'leaves' | 'vines'; x: number; y: number; w: number; h: number; base: string; ink: string };

/** A clickable area for the PDF; preview and PNG show the same text but cannot click. */
export interface CardLink { x: number; y: number; w: number; h: number; url: string }

export interface CardPage { width: number; height: number; items: DrawItem[]; links: CardLink[] }

export interface CardLayout { format: CardFormat; pages: CardPage[] }

/** Text width for a CSS font string; the browser's canvas in the app, a stub in unit tests. */
export type Measure = (text: string, font: string) => number;
