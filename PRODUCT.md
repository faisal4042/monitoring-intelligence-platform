# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Monitoring agents (موظفو الرصد):** work the monitoring queue all day: claim, classify, escalate, open tickets and close interactions. Dense, fast, keyboard-friendly screens matter more than visual flourish.
- **Supervisors (المشرفون):** watch team workload, SLA timers, reassignment and the supervisor board.
- **Analysts and managers (المحللون والإدارة):** read the dashboard, signals and stories, influencer analytics and the reports center; export reports.
- **System admins (مدير النظام):** users and roles (RBAC), keyword dictionaries, X queries, news sources, cost center and kill switches.

All users are Arabic speakers inside one organisation; the interface is Arabic-first, right-to-left.

## Product Purpose

RADAR 360 (product label in the UI: «منصة الرصد MIP») is an internal Arabic media-intelligence and monitoring platform. It collects public interactions about monitored programs (إيجار، الهيئة العامة للعقار، ملاك، البناء المستدام) from X, YouTube and news sources, filters noise, classifies relevance, topic and sentiment (rules → embeddings → LLM), and routes what matters into a staffed monitoring queue and tickets. Success means nothing important is missed, agents act on the right items quickly, and management gets a trustworthy picture.

## Operating Context

- Long working sessions on desktop monitors; supervisors also check from phones.
- Light and dark themes; many users work in dark mode.
- Mixed Arabic/English content: Arabic posts with English handles, URLs, hashtags and numbers.
- Real personal data appears in posts; masking rules exist for phones, emails and IBANs.

## Capabilities and Constraints

- Stack: React 19, TypeScript, Vite, Tailwind CSS 4, ECharts, lucide-react, TanStack Query, React Router 7. Frontend lives in `code/apps/web` (local v1) and `host-copy-20261019/code/apps/web` (copy of the host build).
- Pages: monitoring queue and agent workspace, supervisor/team board, dashboard, live monitoring (X), YouTube monitoring, signals and stories, advanced search, tickets, reports center, influencers (cards, accounts, posts), keywords, queries/sandbox, classification and topics, news and sources, cost center, admin and users.
- Styling is plain CSS component classes plus Tailwind utilities, with tokens in `apps/web/src/styles.css`. Shared `<Button>` and `<Badge>` live in `components/ui/` (added 2026-10-19); older hand-written `btn-*` buttons are migrated page by page.
- Logical properties only (ps-/pe-/ms-/me-/text-start), never left/right specific spacing.
- Undecided: final product name (folder says «رادار 360», UI says «منصة الرصد MIP»); availability of the licensed Cocon Next Arabic font files.

## Brand Commitments

- Corporate identity: Ithra United Business Services (إثراء المتحدة لخدمات الأعمال), Visual Identity Guidelines v1.0. Binding application notes: `code/docs/ithra-branding.md`.
- Use only the supplied logo files in `apps/web/src/assets/brand/`, through `<BrandLogo>`; never recolour, crop or rebuild the logo. `#4A54AE` (logo indigo) is never a UI colour.
- Official palette only (see DESIGN.md). **Solid colours only — no gradients** (owner decision 2026-10-19; the dark-mode gradient primary button was replaced by solid teal).
- Brand typeface Cocon Next Arabic, Light 300 / Regular 400, no faux bold.
- Do not redesign the application wholesale; refine within this identity.

## Evidence on Hand

- Real restored data (local DBs) and screenshots in `code/.run/`, `deployment-20261018/` and `code/docs/brand-review/`.
- Audit findings (2026-10-19): ~400 raw Tailwind status colours instead of status tokens, 49 hard-coded hex values, 170 bold weights, 32 uses of 10–11px text, 496 hand-written buttons, inconsistent radii, contradictory status badges in the top bar.
- No customer testimonials or marketing claims exist; do not fabricate any.

## Product Principles

1. Signal over noise: every screen should make the next important action obvious.
2. Density with clarity: operational screens favour compact, scannable layouts over decoration.
3. One source of truth for state: system status (collection on/off, live/demo, connection) must never contradict itself.
4. Arabic first: RTL, Arabic typography and Arabic copy are the default, not a translation.
5. Consistency over novelty: reuse tokens and shared components on every page.

## Accessibility & Inclusion

- WCAG 2.1 AA contrast in both themes (ratios computed in `docs/ithra-branding.md`); teal is never small text on white; white is never text on teal.
- Minimum text size 12px; touch targets at least 40px on mobile.
- Visible focus ring (navy ring + teal halo in light, teal in dark) on every interactive element.
- Charts keep legends, direct labels and a table view; status colours are reserved for states.
