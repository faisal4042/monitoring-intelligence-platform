---
name: RADAR 360 — منصة الرصد MIP
description: Arabic-first enterprise monitoring platform in the Ithra United identity
colors:
  ithra-navy: "#0e2a47"
  ithra-teal: "#1fb5b5"
  ithra-cyan: "#18a8d8"
  ithra-blue-depth: "#1a3c66"
  ithra-soft-gray: "#d9e1ea"
  ithra-light-neutral: "#f4f7fa"
  ithra-text-gray: "#6b7c93"
  white: "#ffffff"
  surface-3-light: "#eaf0f5"
  border-strong-light: "#c2cedb"
  text-muted-light: "#52637a"
  text-subtle-light: "#5c6d84"
  surface-dark: "#12304f"
  surface-sidebar-dark: "#0b2239"
  border-dark: "#23466f"
  border-strong-dark: "#2f5a86"
  text-muted-dark: "#c5d1de"
  text-subtle-dark: "#a9b7c7"
  status-success: "#036b4e"
  status-warning: "#8a5005"
  status-danger: "#b42318"
  status-danger-solid: "#c8322b"
  status-danger-solid-hover: "#a3241e"
  status-success-tint: "#059669"
  status-warning-tint: "#d97706"
  status-danger-tint: "#dc2626"
  status-success-tint-dark: "#22c55e"
  status-warning-tint-dark: "#f59e0b"
  status-danger-tint-dark: "#ef4444"
  primary-hover-dark: "#3cc2c2"
  status-success-dark: "#4ade80"
  status-warning-dark: "#fbbf24"
  status-danger-dark: "#f87171"
  status-info-dark: "#6ccbec"
  source-x: "#14171a"
  source-news: "#2a5fb8"
  source-youtube: "#c81e1e"
  source-comment: "#9c5308"
  source-story: "#a8385f"
  chart-1: "#1fb5b5"
  chart-2: "#e07b39"
  chart-3: "#2a6fd1"
  chart-4: "#c24d7a"
  chart-1-dark: "#18a2a2"
  chart-2-dark: "#d17a2e"
  chart-3-dark: "#4c82db"
  chart-4-dark: "#cc5888"
typography:
  display:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 400
    lineHeight: 1.3
  page-title:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.4
  section:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.5
  card:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  stat:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.3
  kpi:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.2
  body:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 300
    lineHeight: 1.6
  table:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 300
    lineHeight: 1.5
  caption:
    fontFamily: "Cocon Next Arabic, IBM Plex Sans Arabic, Noto Sans Arabic, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 300
    lineHeight: 1.5
rounded:
  mark: "3px"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ithra-navy}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "0.55rem 1rem"
    height: "2.5rem"
  button-primary-hover:
    backgroundColor: "{colors.ithra-blue-depth}"
    textColor: "{colors.white}"
  button-primary-dark:
    backgroundColor: "{colors.ithra-teal}"
    textColor: "{colors.ithra-navy}"
    rounded: "{rounded.md}"
  button-ghost:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ithra-navy}"
    rounded: "{rounded.md}"
    padding: "0.55rem 1rem"
    height: "2.5rem"
  button-ghost-hover:
    backgroundColor: "{colors.surface-3-light}"
  button-danger:
    backgroundColor: "{colors.status-danger-solid}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ithra-navy}"
    rounded: "{rounded.md}"
    padding: "0.6rem 0.8rem"
    height: "2.75rem"
  card:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.lg}"
  chip-selected:
    backgroundColor: "{colors.ithra-navy}"
    textColor: "{colors.white}"
    rounded: "{rounded.pill}"
---

# Design System: RADAR 360

## Overview

An operational, Arabic-first (RTL) enterprise SaaS for media monitoring, in the Ithra United corporate identity. Calm Deep Navy and light neutrals carry the structure; teal is a precise accent for indicators, focus and selection. Screens are dense and scannable: queues, tables, KPI tiles and charts, not marketing layouts. Source of truth for tokens: `code/apps/web/src/styles.css` (semantic CSS variables, light and dark). Binding brand notes: `code/docs/ithra-branding.md`. This file records the incumbent system; refine within it, do not replace it.

## Colors

- Components use **semantic tokens** (`--surface`, `--surface-2`, `--surface-3`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-ink`, `--primary-bg`, `--selected-bg`, `--status-*`), never raw hex and never raw Tailwind hues (`text-red-600`, `bg-emerald-500`, …).
- Light: page Light Neutral `#f4f7fa`, cards white, text Deep Navy, secondary text `#52637a` (Text Gray `#6b7c93` only at 24px+). Dark: page Deep Navy, cards `#12304f`, sidebar `#0b2239`, text white.
- Teal `#1fb5b5` is for fills, indicators, focus halo and selection. In dark mode `--accent-soft` is teal 10% and `--status-danger-soft` red 12%, so their own ink stays at 4.5:1 on cards. Accent **text** uses `--accent-ink` (Royal Blue Depth on light, teal on dark).
- Status colours (success, warning, danger, info) are reserved for states, never decoration or chart series. The `*-tint` values are only the bases of the `--status-*-soft` color-mix backgrounds, never used directly. Light values are deepened so status text passes 4.5:1 on its own soft tint (success #036B4E, warning #8A5005); dark info is the cyan tint #6CCBEC. `--status-danger-solid` is #C8322B in both themes (white label 5.3:1).
- Small secondary text: `--text-muted` #52637A, `--text-subtle` #5C6D84 (5.3:1 on white, 4.6:1 on `--surface-3`). Text Gray #6B7C93 stays 24px+ only.
- Source identity (X, news, YouTube video, YouTube comment, story) uses `--src-*` tokens (solid, white label ≥4.5:1) and `--src-*-ink` (text on the 12% soft tint), redefined under `.dark`. Story uses the chart rose, never purple.
- **Solid colours only. No gradients** anywhere, including buttons, cards, charts, loading skeletons and backgrounds. Dark `--primary-bg` is solid teal (#1FB5B5, hover #3CC2C2) with a Deep Navy label; the `--ithra-gradient` token is removed. Exceptions: the legibility scrim over playing video, and the hatch pattern for “unclassified”.
- Logo indigo `#4A54AE` and off-palette purples are never UI colours.
- Exceptions, recorded in `.impeccable/config.json` with reasons: black letterboxing and scrims over playing video and thumbnails (media, not UI chrome); the exported influencer-card artwork (its own template palette, an image not UI); tab underlines (3px indicator on the active tab); the queue card source stripe (owner decision 2026-10-19, theme-aware `--src-*-line`, ≥3:1 against the card).
- Charts: categorical order teal, orange, blue, rose (light and dark variants in the frontmatter). Sentiment is blue (positive) ↔ red (negative) with neutral grey; "unclassified" is hatched.

## Typography

- One family for Arabic and English: Cocon Next Arabic (licensed files pending), with IBM Plex Sans Arabic as the fallback that must actually be loaded.
- Weights: Light 300 for body (set on `body`), tables and captions; Regular 400 for headings, KPIs and buttons. No faux bold. Every heavier utility (`font-medium` … `font-black`, `--fw-strong`) resolves to 400; hierarchy comes from size and colour. Only Plex 300 and 400 are loaded (`main.tsx`).
- Scale (tokens `--fs-*`): display 36, KPI 28, page title 24, stat 20 (secondary figures and dialog titles), section 17, card 15, body 14, table 13, caption 12px. **Minimum 12px**; never 10–11px. One exception: the search field on phones stays 16px so iOS does not zoom on focus.
- Line height 1.6 for Arabic, 1.4 for Latin and LTR runs. Wrap handles, URLs, emails and numbers in `dir="ltr"` with logical alignment.
- No letter-spacing on Arabic text (it breaks cursive joins); no uppercase English eyebrows.

## Layout

- RTL with logical properties only (`ps-/pe-/ms-/me-/start/end`), never left/right utilities.
- App shell: collapsible right-side sidebar in four task groups (العمل اليومي، الرصد، التحليل، الإعداد) plus the collapsible «الإدارة» group, one distinct icon per destination; a sticky top bar shows the page title and one consolidated system-status indicator (`components/SystemStatus.tsx`: «جمع إكس: موقوف / يعمل / تجريبي / تشغيل جاف»; a stop outranks the run mode; reason, mode, last request, monthly usage and «استئناف الجمع» live in its panel). The emergency stop stays visible while collection runs. The agent availability control reads «حالتي: …». The monthly budget meter shows only when a limit is set.
- Spacing on a 4px grid (4/8/12/16/24/32). Card padding 16–24px; dense tables use 8–12px cell padding.
- Desktop-first operational density; must remain usable down to 320px with 16px side gutters, no horizontal page scroll, and tables scrolling inside their own container.
- Quotas and budgets: with no limit set, say «بلا حد» / «لا يوجد حد شهري» instead of ∞ or a 0% bar.
- Dashboards: KPI tile row, then charts, then detail tables. Empty states collapse or explain the next step rather than leaving large blank boxes: one quiet line with an info icon on a `--surface-2` well, solid 1px border, never dashed placeholder boxes.

## Elevation & Depth

- Two shadows only: `--shadow-sm` for cards and `--shadow-lg` for modals and drawers. Borders (`--border`) do most of the separation work.
- Overlay `--overlay` behind modals and drawers.

## Shapes

- Radii: 8px (small controls, tags), 12px (buttons, inputs), 16px (cards, panels), pill (chips, status badges). Micro marks under 16px (legend swatches, indicator bars, key caps) use `--radius-mark` 3px. No other radii.
- Icons: lucide-react, 16–18px inline, stroke style; icon-only buttons need an Arabic `aria-label`.

## Components

- **Buttons:** `<Button variant size>` (`components/ui/Button.tsx`): primary (Deep Navy / white in light; solid teal / Deep Navy in dark), ghost (surface + border), danger (solid danger), quiet (text action, no border until hover). Sizes md 40px and sm 32px (40px on touch screens); icon-only buttons require an Arabic `aria-label`. Hand-written `btn-*` classes are being migrated to it page by page.
- **Inputs:** 44px height, 12px radius, focus = navy ring + teal halo.
- **Cards:** surface-raised, 1px border, 16px radius, `--shadow-sm`.
- **Badges and chips:** pill radius, soft status backgrounds (`--status-*-soft`) with status text; selected chip = `--selected-bg` / `--selected-fg`. Use `<Badge tone>` (`components/ui/Badge.tsx`): neutral, accent, info, success, warning, danger (`solid` for danger only). Programme labels use `<ProgramChip>` (`components/ui/ProgramChip.tsx`): the user-chosen programme colour as a dot, the name in text colour, because programme colours carry no contrast guarantee.
- **Interaction cards (queue and live):** author, time, text, media, classification tags, then at most two visible actions (queue: «استلام» or «إغلاق التفاعل», then «التفاصيل»; live: «التفاصيل» and the ticket) with everything else in «المزيد» (`components/ui/OverflowMenu.tsx`, portalled so cards never clip it; only actions allowed right now are listed). Zero-value engagement metrics are hidden.
- **Tables:** 13px text, sticky header, row hover `--surface-3`, numeric columns tabular, right-aligned per RTL logic.
- **Charts (ECharts):** RTL-aware axes, legends always visible, tooltips in Arabic with LTR numbers, a table view for every chart.

## Do's and Don'ts

- Do use semantic tokens and shared components; don't add raw hex, Tailwind hue utilities or one-off radii.
- Do keep a single, non-contradictory system-status indicator; don't stack conflicting badges.
- Do keep Arabic copy natural and consistent (رصد إكس، رصد يوتيوب; «إكس» and «يوتيوب» in labels and copy; recognised product and format names such as Power BI, Excel, ZIP, RSS, HTTP and the search operators AND/OR/NOT stay as written); don't mix English labels into Arabic navigation or show raw codes (env flags, permission keys, severity keys) without an Arabic label.
- Don't use gradients, glows, glassmorphism or decorative purple/indigo.
- Don't put teal text on white or white text on teal.
- Don't use text below 12px or bold weights outside the token scale.
