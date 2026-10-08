# Ithra United — identity in MIP

MIP (منصة الرصد) is a product of **Ithra United Business Services — إثراء المتحدة لخدمات الأعمال**. The binding reference is *Ithra United — Visual Identity Guidelines v1.0* (October 2026). This page records how the platform applies it.

The product name stays **منصة الرصد MIP**; the Ithra logo is the corporate identity beside it. No alternative MIP logo exists — do not create one.

## Logo

Only the supplied files are used, byte-for-byte (`apps/web/src/assets/brand/`):

| File | Source file | Version | Use |
|---|---|---|---|
| `ithra-horizontal-color.png` | `IThra logo - Wide.png` (1009×285) | Horizontal, full colour | Sidebar and mobile login on light surfaces |
| `ithra-horizontal-negative.png` | `ncolored3.png` (1243×353) | Horizontal, negative | Sidebar on Deep Navy (dark mode) |
| `ithra-stacked-negative.png` | `ncolored2.png` (796×539) | Stacked, negative | Login identity panel (Deep Navy) |

Use `<BrandLogo>` (`components/BrandLogo.tsx`); it picks the file per theme in CSS and never renders below the minimum width.

| Rule | Value |
|---|---|
| Minimum on screen | Horizontal 160px · Stacked 110px · Vertical 80px · Symbol 32px |
| Clear space | X = height of "h" in "ithra" on all sides (≈17px at the sidebar's 184px) |
| Background | Full colour on White / Light Neutral; negative on Deep Navy |
| Never | Rotate, skew, recolour, fade, add shadow/glow/blur, crop, rebuild from text or shapes, place on low contrast |

When the sidebar collapses, the logo is hidden, not shrunk. Not supplied (and therefore not used): a standalone symbol (needed for a favicon), a full-colour stacked or vertical version, single-colour and all-white versions. Request them from Marketing; do not crop the horizontal logo.

## Colour

Tokens live at the top of `apps/web/src/styles.css`. Components use semantic tokens, never raw hex.

**Official palette**: `--ithra-navy #0E2A47`, `--ithra-teal #1FB5B5`, `--ithra-cyan #18A8D8`, `--ithra-blue-depth #1A3C66`, `--ithra-soft-gray #D9E1EA`, `--ithra-light-neutral #F4F7FA`, `--ithra-text-gray #6B7C93`, white, and `--ithra-gradient` (teal → cyan).

**`#4A54AE` (logo indigo) is never a UI colour** — not for text, buttons, links, charts, icons or selection.

| Semantic token | Light | Dark |
|---|---|---|
| `--surface-2` (page) | Light Neutral #F4F7FA | Deep Navy #0E2A47 |
| `--surface` / `--surface-raised` (cards, inputs) | White | #12304F |
| `--surface-3` (hover, wells) | #EAF0F5 | Royal Blue Depth #1A3C66 |
| `--surface-sidebar` | White | #0B2239 |
| `--border` / `--border-strong` | Soft Gray #D9E1EA / #C2CEDB | #23466F / #2F5A86 |
| `--text` | Deep Navy | White |
| `--text-muted` (small secondary text) | #52637A | #C5D1DE |
| `--text-subtle` (placeholders, 24px+) | Text Gray #6B7C93 | #A9B7C7 |
| `--accent` (fills, indicators) | Teal | Teal |
| `--accent-ink` (accent text, icons) | Royal Blue Depth | Teal |
| `--accent-soft` (tinted backgrounds) | Teal 12% | Teal 16% |
| `--primary-bg` / `--primary-fg` | Deep Navy / White | Teal gradient / Deep Navy |
| `--selected-bg` / `--selected-fg` | Deep Navy / White | Teal / Deep Navy |
| `--focus-ring` + `--focus-halo` | Royal Blue Depth + teal halo | Teal + teal halo |
| `--status-success / warning / danger / info` | #047857 / #9A5A06 / #B42318 / Royal Blue | #4ADE80 / #FBBF24 / #F87171 / Cyan |

The Tailwind `brand-*` scale resolves to these per theme (50–300 teal tints, 400–500 teal, 600 accent ink, 700 strong ink), and `slate-*` is re-tinted from the identity neutrals, so existing utilities follow the identity.

Two accessibility extensions, not new hues: `#52637A` (a deeper Text Gray, 6.1:1) for small secondary text, because the guide limits Text Gray to 24px and larger; and dark card surfaces `#12304F` / `#0B2239`, steps between Deep Navy and Royal Blue Depth.

### Contrast (WCAG AA, computed)

| Pair | Ratio | Use |
|---|---|---|
| White on Deep Navy | 14.6 | All text |
| Deep Navy on Light Neutral | 13.6 | All text |
| Teal on Deep Navy | 5.8 (5.3 on #12304F) | Text and accents |
| Deep Navy on Teal / Cyan | 5.8 / 5.3 | Button labels |
| Royal Blue Depth on White | 11.2 | Accent text in light mode |
| #52637A on White / Light Neutral | 6.1 / 5.7 | Small secondary text |
| Text Gray on White | 4.3 | 24px+ only |
| White on Teal | 2.5 | **Never** for text |

Teal buttons always take Deep Navy labels. Teal is never small text on white.

### Charts

Validated categorical order (teal, orange, blue, rose), light `#1FB5B5 #E07B39 #2A6FD1 #C24D7A`, dark `#18A2A2 #D17A2E #4C82DB #CC5888` — passes lightness, chroma, colour-vision separation and normal-vision checks for adjacent series in both modes. In light mode teal and orange sit under 3:1 against white, so charts keep legends, direct labels and a table view. Sentiment uses blue (positive) ↔ red (negative) with a neutral grey; "unclassified" is hatched. Status colours are reserved for states and never used as series.

## Typography

Brand face: **Cocon Next Arabic** (Arabic and English), Light 300 for body/captions, Regular 400 for headings/buttons; no faux bold.

**Status: the licensed font files were not supplied**, so the face is listed first in `--font-sans` (it is used where installed locally) and **IBM Plex Sans Arabic** (Google Fonts) is the temporary fallback. When the licensed web files arrive: add them under `apps/web/src/assets/brand/fonts/` with `@font-face` (300, 400 only), and add the `font-cocon` class to `<html>` — heavier utilities then resolve to 400.

Until then, heavier weights are capped at 600 (`--font-weight-semibold/bold/extrabold/black`, `--fw-strong`).

| Token | Size | Use |
|---|---|---|
| `--fs-page-title` | 24px | Page title |
| `--fs-section` | 17px | Section heading |
| `--fs-card` | 15px | Card heading |
| `--fs-body` | 14px | Body |
| `--fs-table` | 13px | Table text |
| `--fs-caption` | 12px | Captions, labels |
| `--fs-kpi` | 28px | KPI numbers |

The guide's 56 / 36 / 24 / 16 scale is for documents and marketing; the platform uses the operational sizes above. Line height: Arabic 1.6, English 1.4.

## Components

Buttons (`.btn-primary`, `.btn-ghost`, `.btn-danger`), inputs (`.input`, `.input-shell`), `.card`, `.badge`, status pills (`.status-pill--info|warning|success|danger-solid`), queue status badges and tags, tabs, chips (`.dash-chip`), drawers (`.queue-drawer`), modals (`.modal-overlay` + `.modal-card`), tables (`.th`, `.td`, `.dash-table`) and focus states all read the tokens above. Overlays use navy (`--overlay`), never black.

Shell: the sidebar carries the logo (184px, clear space kept), then "منصة الرصد MIP / منصة الرصد والتحليل". The active item has a teal indicator, a soft teal wash and text in the text colour. The sidebar collapses to icons on desktop (logo hidden) and becomes an off-canvas menu on mobile. The header shows "منصة الرصد / <page>", the collection mode and stop state, alerts and the emergency stop.

## Adding a page

1. Use `.page-heading` (eyebrow, `h1`, description) and `.card` sections.
2. Colours from tokens only: `var(--text)`, `var(--text-muted)`, `var(--accent-ink)`, `var(--accent-soft)`, `var(--status-*)`; or Tailwind `brand-*` / `slate-*`; or `bg-(--token)` arbitrary values.
3. Primary action `.btn-primary`, secondary `.btn-ghost`, destructive `.btn-danger`.
4. Selected states: `--selected-bg` / `--selected-fg`. Never `bg-brand-600 text-white` (white on teal in dark mode).
5. No logo inside pages or cards.
6. Check both themes, and 390 / 768 / 1280 / 1440 widths with no horizontal scroll.
