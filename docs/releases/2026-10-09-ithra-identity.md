# Release snapshot — Ithra identity on main (2026-10-09)

Status: **candidate, not deployed.** Needs explicit approval before merging to `main` (a push to `main` deploys).

| | |
|---|---|
| Production now | `11599e9` — hotfix: monthly partition maintenance (Coolify deployment finished 2026-10-07 19:27Z) |
| Candidate branch | `release/ithra-identity-on-main` |
| Candidate base | `origin/main` @ `11599e9` |
| Database changes | **none** — `packages/db` and `apps/api` are byte-identical to `11599e9` |

## Commits (oldest first)

| SHA | Source | Subject |
|---|---|---|
| `4265890` | cherry-pick of `54f9a4f` | feat(brand): Ithra logo files and theme-aware BrandLogo |
| `a52856e` | cherry-pick of `b86689b` | feat(ui): Ithra design tokens, typography and themed components |
| `19afc88` | cherry-pick of `3443ec1` | feat(ui): corporate shell and login with the official logo |
| `8f587eb` | cherry-pick of `ee9c157` | feat(ui): bring every page onto the identity |
| `bea20d1` | cherry-pick of `ff6e023` | docs(brand): identity rules and tokens |
| `22b3faf` | cherry-pick of `711744c` | docs(brand): before/after visual review |
| `5a7bce5` | new | build(api): db:push/db:seed only when `RUN_DB_SETUP_ON_START=true` |

Conflict resolutions while porting from `feature/ithra-corporate-identity` (which sits on develop's RBAC/queue/dashboard work):

- `styles.css` — took the identity version whole. It also carries CSS for the queue and alert center, which main does not render; unused, harmless.
- `AppShell.tsx` — identity shell kept; dropped the `AlertCenter` import and the queue nav label (neither exists on main).
- `Users.tsx` — **kept main's version.** The identity version is built on the RBAC user-management API that main does not have. The page still picks up the identity through global tokens.
- `dashboard/ui.tsx`, `ChangePassword.tsx`, `MonitoringQueue.tsx` — not on main; changes dropped.
- `docs/brand-review` screenshots include queue/dashboard pages that are not part of this release.

## Changed files

`apps/web/**` (23 files: brand assets, `BrandLogo`, `AppShell`, `Avatar`, `PostCard`, 15 pages, `styles.css`), `docs/ithra-branding.md`, `docs/brand-review/**`, `Dockerfile.api`, `docker-compose.yaml`, `docker-compose.prod.yml`.

Not changed: `apps/api`, `apps/ai`, `packages/*` (including all migrations and `seed.ts`), `deploy/nginx.conf`, `Dockerfile.web`, `Dockerfile.ai`, volumes, service names.

## Images

Built by Coolify from the repo (no registry tags). Base images unchanged from `11599e9`: `node:22-bookworm-slim` (api), `node:22-alpine` + `nginxinc/nginx-unprivileged:1.27-alpine` (web), `python:3.12-slim` (ai), `pgvector/pgvector:pg16`, `redis:7-alpine`.

## Startup behaviour change

Before: the API container ran `pnpm db:push && pnpm db:seed` on every start. The seed deletes and re-inserts `role_permissions`.

After: both are skipped unless `RUN_DB_SETUP_ON_START=true`. The log line `db:push/db:seed skipped (RUN_DB_SETUP_ON_START is not true)` confirms it. Compose defaults the variable to `false`. A future release that needs migrations must set it deliberately, after a verified backup.

## Environment

No new required variables. Optional: `RUN_DB_SETUP_ON_START` (default `false`; Coolify may list it after parsing the compose file — leave it unset or `false`). All existing variables unchanged.

## Rollback

Code-only, because no schema or data changes:

1. Revert the merge on `main` (`git revert -m 1 <merge-sha>`) and push; trigger the Coolify deploy manually if auto-deploy does not fire (it did not on 2026-10-07). Pinning Coolify to a commit SHA would be a Coolify setting change — avoid it.
2. Note: `11599e9`'s API image runs `db:push && db:seed` on start again. Against the current schema `db:push` applies nothing; `db:seed` rewrites `role_permissions` to the same 94 rows (`84302aa6…`).
3. Check `https://monitoring.interactivedashboardpages.com/health` and Coolify `running:healthy`.
