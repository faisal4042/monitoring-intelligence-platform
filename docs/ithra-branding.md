# Ithra United — identity in MIP

MIP (منصة الرصد) is a product of **Ithra United Business Services — إثراء المتحدة لخدمات الأعمال**. The binding reference is *Ithra United — Visual Identity Guidelines v1.0* (October 2026). This page records how the platform applies it and agrees with `DESIGN.md` at the repository root (2026-10-19); where they differ, `DESIGN.md` wins.

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

When the sidebar collapses, the logo is hidden, not shrunk. Not supplied (and therefore not used): a standalone symbol, a full-colour stacked or vertical version, single-colour and all-white versions. **Favicon: deferred** until Marketing supplies an approved symbol (owner decision 2026-10-19); do not crop the horizontal logo to make one.

## Colour

Tokens live at the top of `apps/web/src/styles.css`. Components use semantic tokens, never raw hex and never raw Tailwind hues (`text-red-600`, `bg-emerald-500`, …).

**Official palette**: `--ithra-navy #0E2A47`, `--ithra-teal #1FB5B5`, `--ithra-cyan #18A8D8`, `--ithra-blue-depth #1A3C66`, `--ithra-soft-gray #D9E1EA`, `--ithra-light-neutral #F4F7FA`, `--ithra-text-gray #6B7C93`, white.

**Solid colours only — no gradients** (owner decision 2026-10-19): buttons, cards, charts, loading skeletons and backgrounds are flat. The `--ithra-gradient` token was removed. Exceptions: the scrim over playing video, and the hatch pattern for “unclassified” in charts.

**`#4A54AE` (logo indigo) is never a UI colour**, and neither is any off-palette purple.

| Semantic token | Light | Dark |
|---|---|---|
| `--surface-2` (page) | Light Neutral #F4F7FA | Deep Navy #0E2A47 |
| `--surface` / `--surface-raised` (cards, inputs) | White | #12304F |
| `--surface-3` (hover, wells) | #EAF0F5 | Royal Blue Depth #1A3C66 |
| `--surface-sidebar` | White | #0B2239 |
| `--border` / `--border-strong` | Soft Gray #D9E1EA / #C2CEDB | #23466F / #2F5A86 |
| `--text` | Deep Navy | White |
| `--text-muted` (small secondary text) | #52637A | #C5D1DE |
| `--text-subtle` (hints, placeholders) | #5C6D84 | #A9B7C7 |
| `--accent` (fills, indicators) | Teal | Teal |
| `--accent-ink` (accent text, icons) | Royal Blue Depth | Teal |
| `--accent-soft` (tinted backgrounds) | Teal 12% | Teal 10% |
| `--primary-bg` / `--primary-fg` | Deep Navy / White | Solid Teal (hover #3CC2C2) / Deep Navy |
| `--selected-bg` / `--selected-fg` | Deep Navy / White | Teal / Deep Navy |
| `--focus-ring` + `--focus-halo` | Royal Blue Depth + teal halo | Teal + teal halo |
| `--status-success / warning / danger / info` | #036B4E / #8A5005 / #B42318 / Royal Blue | #4ADE80 / #FBBF24 / #F87171 / #6CCBEC |
| `--status-danger-solid` (white label) | #C8322B | #C8322B |

The Tailwind `brand-*` scale resolves to these per theme, and `slate-*` is re-tinted from the identity neutrals.

**Source identity** (X, news, YouTube video, YouTube comment, story): `--src-*` solid (white label ≥ 4.5:1), `--src-*-ink` (text on the 12% tint) and `--src-*-line` (stripes and dots: solid on light, the light ink on dark, ≥ 3:1 against the card). Story uses the chart rose, never purple. All are redefined under `.dark`, so they follow the platform's theme switch, not the operating system.

Accessibility extensions, not new hues: #52637A and #5C6D84 for small secondary text (the guide limits Text Gray to 24px and larger), deepened status inks so status text passes 4.5:1 on its own tint, and dark card surfaces #12304F / #0B2239.

### Contrast (WCAG AA, computed)

| Pair | Ratio | Use |
|---|---|---|
| White on Deep Navy | 14.6 | All text |
| Deep Navy on Light Neutral | 13.6 | All text |
| Teal on Deep Navy | 5.8 (5.3 on #12304F) | Text and accents |
| Deep Navy on Teal / Cyan | 5.8 / 5.3 | Button labels |
| Royal Blue Depth on White | 11.2 | Accent text in light mode |
| #52637A on White / Light Neutral | 6.1 / 5.7 | Small secondary text |
| #5C6D84 on White / #EAF0F5 | 5.3 / 4.6 | Hints and placeholders |
| White on #C8322B | 5.3 | Danger buttons and the “stopped” indicator |
| Text Gray on White | 4.3 | 24px+ only |
| White on Teal | 2.5 | **Never** for text |

### Charts

Categorical order (teal, orange, blue, rose), light `#1FB5B5 #E07B39 #2A6FD1 #C24D7A`, dark `#18A2A2 #D17A2E #4C82DB #CC5888`. Charts keep legends, direct labels and a table view. Sentiment is blue (positive, `#2A6FD1` / `#4C82DB`) ↔ red (negative, `#D03B3B` / `#E66767`) with a neutral grey on every chart, dashboard included; “unclassified” is hatched. Status colours are never series. Report charts read the same palette (`useChartColors`). Chart labels are at least 12px and Regular 400.

## Typography

Brand face: **Cocon Next Arabic** (Arabic and English), Light 300 for body/tables/captions, Regular 400 for headings/KPIs/buttons; no faux bold.

**Status: the licensed font files were not supplied.** The face is listed first in `--font-sans` and **IBM Plex Sans Arabic** (bundled from `@fontsource`, weights **300 and 400 only**, loaded in `main.tsx`) is the fallback. `body` is set to 300. Every heavier utility (`font-medium` … `font-black`, `--fw-strong`) resolves to 400; hierarchy comes from size and colour. When the licensed files arrive, add them under `apps/web/src/assets/brand/fonts/` with `@font-face` (300, 400).

| Token | Size | Use |
|---|---|---|
| `--fs-display` | 36px | Login headline |
| `--fs-kpi` | 28px | KPI numbers |
| `--fs-page-title` | 24px | Page title |
| `--fs-stat` | 20px | Secondary figures, dialog titles |
| `--fs-section` | 17px | Section heading |
| `--fs-card` | 15px | Card heading |
| `--fs-body` | 14px | Body |
| `--fs-table` | 13px | Table text |
| `--fs-caption` | 12px | Captions, labels — the minimum |

Browser defaults are reset to the scale: `<small>` is 12px (not 80%) and `<th>` is Regular 400. Line height: Arabic 1.6, English 1.4. No letter-spacing on Arabic text (it breaks cursive joins), and no uppercase English eyebrows. Wrap handles, URLs and numbers in `dir="ltr"` / `<bdi>`.

## Shapes

Radii: 8px (`--radius-sm`), 12px (`--radius`), 16px (`--radius-lg`), pill; micro marks under 16px use `--radius-mark` 3px. Tailwind `rounded-*` utilities map onto the same scale. Two shadows only: `--shadow-sm` and `--shadow-lg`.

## Components

- **Buttons:** `<Button variant size>` (`components/ui/Button.tsx`): primary, ghost, danger, quiet; md 40px, sm 32px (40px on touch screens); icon-only buttons need an Arabic `aria-label`. The `btn-*` classes remain the implementation underneath.
- **Badges:** `<Badge tone>` (`components/ui/Badge.tsx`): neutral, accent, info, success, warning, danger (`solid` for danger only); pill radius.
- **Programme labels:** `<ProgramChip>` (`components/ui/ProgramChip.tsx`): programme colour as a dot, name in text colour.
- **Overflow menu «المزيد»:** `components/ui/OverflowMenu.tsx`, keyboard menu pattern, portalled so cards never clip it.
- **System status:** one indicator in the top bar (`components/SystemStatus.tsx`): «جمع إكس: موقوف / يعمل / تجريبي / تشغيل جاف». Its panel shows the stop reason, run mode, last request to X, monthly usage and «استئناف الجمع» (permission-gated, behind a confirmation dialog). The emergency stop button stays visible while collection runs. The agent's availability reads «حالتي: …».
- Inputs (`.input`), `.card`, tabs, chips, drawers, modals (`.modal-overlay` + `.modal-card`), tables (`.th`, `.td`, `.dash-table`) and focus states all read the tokens above. Overlays use navy (`--overlay`), never black.

Shell: the sidebar carries the logo (184px, clear space kept), then «منصة الرصد MIP / منصة الرصد والتحليل», then four task groups (العمل اليومي، الرصد، التحليل، الإعداد) and the collapsible «الإدارة» group, one distinct icon per destination. Labels are Arabic: «رصد إكس», «رصد يوتيوب»; the platform is written «إكس» and «يوتيوب» in all copy. The active item has a teal indicator, a soft teal wash and text in the text colour. The monthly budget meter appears only when a limit is set.

## Adding a page

1. Use `.page-heading` (Arabic eyebrow, `h1`, description) and `.card` sections.
2. Colours from tokens only: `var(--text)`, `var(--text-muted)`, `var(--accent-ink)`, `var(--accent-soft)`, `var(--status-*)`; or `bg-(--token)` / `text-(--token)` utilities.
3. Actions with `<Button>`: primary, ghost, danger; statuses with `<Badge>`.
4. Selected states: `--selected-bg` / `--selected-fg`. Never white on teal.
5. Empty states: one quiet line with the next step, not a tall dashed box.
6. No logo inside pages or cards.
7. Check both themes, and 390 / 768 / 1280 / 1440 widths with no horizontal scroll.
