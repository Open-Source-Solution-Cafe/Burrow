# Changelog

All notable changes to the Burrow self-hosted project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **One-Click "Deploy to Cloudflare" Button & Zero-Input Worker Initialization (`README.md`, `.env.example`, `src/worker/bootstrap.ts`, `src/worker/d1-migrations.ts`, `src/worker/index.ts`, `src/core/app.ts`, `src/web/pages/Login.tsx`, `docs/CLOUDFLARE_DEPLOY_BUTTON.md`)**: Added the **Deploy to Cloudflare** button (`deploy.workers.cloudflare.com`) to `README.md`, commented out `.env.example` variables so Cloudflare's deploy wizard requires zero manual env inputs, added automatic first-boot D1 migration execution (`d1_migrations`), dynamic HTTPS origin derivation for `BETTER_AUTH_URL` (ignoring localhost placeholders on HTTPS traffic), D1-persisted CSPRNG `BETTER_AUTH_SECRET` generation (`_worker_runtime_config`), and atomic first-user Owner claiming when `BOOTSTRAP_TOKEN` is omitted (`bootstrapTokenRequired: false` on `GET /api/auth/config`, locking immediately to `403 invite_required` after the first workspace is created).
- **Multi-Workspace Selection for Workspace ZIP Export (`DataPortabilitySection.tsx`, `markdownPortability.ts`, `notionImporter.ts`)**: Added a **Workspaces to Export** checklist in **Settings → Features & System** allowing workspace `owner`s to select any combination of their owned, export-enabled workspaces (with **Select All Exportable** / **Current Workspace Only** quick actions and direct links to `#features` for owned workspaces without export enabled), packaging multi-workspace selections into a single ZIP (`burrow-multi-workspace-backup.json` + `workspaces/<slug>/...`) with multi-workspace backup migration support while keeping personal GDPR exports independent in **Profile & Account**.
- **Personal GDPR Data Export (`GET /api/account/export`, `ICardRepository.listCommentsByUser`, Settings → Profile & Account)**: Added an always-on personal data export (`schemaVersion: 'burrow-personal-export-v1'`) accessible to every authenticated user regardless of workspace role or feature flags, served with `Cache-Control: private, no-store` (and `Content-Disposition: attachment` with `?download=1`) alongside a **Download My Data (.json)** button in Settings.
- **Profile Display Name Rectification (`Settings → Profile & Account`, `useUpdateProfileName`)**: Added an inline **Display Name** editor (`Save Name`) backed by Better Auth's `POST /api/auth/update-user` endpoint.
- **Configurable Legal Links & Privacy Documentation (`GET /api/auth/config`, `PRIVACY_POLICY_URL`, `TERMS_OF_SERVICE_URL`, `docs/PRIVACY_AND_GDPR.md`)**: Exposed optional validated `http:`/`https:` legal URLs (hidden when unset; unsafe schemes sanitized to `null`) on `/login` and Settings → Profile & Account alongside a strictly-necessary session cookies disclosure, and documented self-hosted GDPR compliance controls.
- **Workspace Feature Flags (`src/shared/featureFlags.ts`, `src/core/routes/feature-flags.ts`, Settings → Features & Labs)**: Added per-workspace and instance-level feature flags (`workspaceExport`, `notionImport`, `publicSharing`, `instanceMigration`), all shipping dormant (`false` by default) and enforced on both API routes and frontend UI.
  - *Migration Note*: Added `workspaces.feature_flags` (`text`, default `'{}'`) via `migrations/0003_add_workspace_feature_flags.sql` and `migrations/postgres/0003_add_workspace_feature_flags.sql` (additive, backward-compatible).
- **Self-Hosted Core Update UX (`src/core/routes/system.ts`, `SystemUpdateSection.tsx`)**: Added GitHub `/tags` fallback, `?refresh=1` cache bypass, `releaseNotesUrl` metadata, and a runtime-aware **System & Core Updates** card in Settings (hidden when `allowSelfUpdate` is `false`).
- **One-Click Full Workspace Export, Lossless Backup, Notion ZIP Importer & GDPR Erasure (`workspace-export.ts`, `DataPortabilitySection.tsx`)**: Added `GET /api/workspaces/:wid/export`, `POST /api/workspaces/:wid/projects/:pid/import`, `POST /api/workspaces/import-bundle`, `DELETE /api/workspaces/:wid` (owner-confirmed workspace deletion with storage cleanup), self-service **Delete Account** in Settings, client-side ZIP assembly (`fflate`), and Notion Markdown + CSV ZIP parsing.
- **Opt-In Public Read-Only Share Links (`public-shares.ts`, `SharePopover.tsx`, `/s/$token`)**: Added per-page and per-board **"Publish to web (read-only)"** toggles (preserving the share token when toggling off and back on, rotating only on explicit link reset), `X-Robots-Tag: noindex, nofollow`, strict member/comment stripping, and a scoped public media proxy (`/api/public/shares/:token/files/:key`).
  - *Migration Note*: Added `public_shares` table via `migrations/0004_add_public_shares.sql` / `migrations/postgres/0004_add_public_shares.sql` and `public_shares.enabled` via `migrations/0005_add_public_share_enabled.sql` / `migrations/postgres/0005_add_public_share_enabled.sql` (additive, backward-compatible).

### Changed
- **Multi-Workspace Personal Export & Owner-Only Workspace ZIP Exports (`src/core/app.ts`, `src/core/routes/workspace-export.ts`, `ProfileView.tsx`, `DataPortabilitySection.tsx`)**: Added optional `?workspaceId=...` scoping and `workspaceName` enrichment on `GET /api/account/export` (with a workspace selector in **Profile & Account** for multi-workspace accounts), redacted internal workspace/project/card IDs on comments from former workspaces (`formerWorkspace: true`) while preserving authored text for GDPR Art. 15, and restricted all workspace and project ZIP exports (`GET /api/workspaces/:wid/export`) strictly to workspace `owner`s (with a clickable link to **Profile & Account** for non-owners).
- **Settings & Profile Separation + Sidebar Footer Cleanup (`ProfileView.tsx`, `SettingsView.tsx`, `Sidebar.tsx`, `router.tsx`, `CommandPalette.tsx`)**: Split personal **Profile & Account** (`/w/:workspaceId/profile`, with `/profile` redirect) into its own dedicated page separate from tabbed **Workspace & Projects** and **Features & System** settings (`/w/:workspaceId/settings`, preserving `#features` deep links); added **Profile & Account** directly to the account menu and Command Palette, and removed the inline language switcher from the bottom-left sidebar footer (keeping it in the account menu, Profile & Account, and Command Palette).
- **Documentation & Open-Source Positioning (`README.md`, `CONTRIBUTING.md`)**: Clarified upfront product scope and differentiators (zero per-seat caps, uncapped Kanban/List/Calendar views, native email/password authentication, and Cloudflare Workers or Docker hosting), added an explicit permanent open-source commitment under `AGPL-3.0-or-later` alongside transparency on `CLA.md`, and aligned `CONTRIBUTING.md` with `.github/PULL_REQUEST_TEMPLATE.md` (external PR status and `master` branch workflow).

### Deprecated

### Removed

### Fixed
- **Preserve Workspace Feature Flags & Project Upload Policies in Backups (`workspace-export.ts`, `markdownPortability.ts`, `DataPortabilitySection.tsx`)**: Included workspace `featureFlags` and custom project `uploadPolicy` in `GET /api/workspaces/:wid/export` (`burrow-backup.json`) and restored both automatically during `POST /api/workspaces/:wid/projects/:pid/import` and `POST /api/workspaces/import-bundle` migrations.
- **Linux Script Execution (`lib.mjs`)**: Fixed `isNodeScript` detection in `scripts/lib.mjs` so extensionless native binaries such as Linux `process.execPath` (`node`) are executed directly rather than parsed as JavaScript files, resolving the `tests/unit/sqlite-migrations.test.ts` CI failure.
- **Scheduled Remote Demo Reset (`demo-reset.yml`, `demo-reset.mjs`)**: Allowed `scripts/demo-reset.mjs` to authorize explicitly confirmed `--confirm=<worker-name>` demo targets alongside `--demo` environments, cleared `rate_limits` and `pending_storage_deletions` during resets, and updated `.github/workflows/demo-reset.yml` fallback secret bindings and confirmation flags.

### Security
- **Dependency Vulnerability Remediation (`package.json`, `pnpm-lock.yaml`)**: Upgraded `hono` (`^4.13.19`), `@hono/node-server` (`^2.1.11`), `vitest` (`^4.1.12`), `wrangler` (`^4.165.0`), and `@cloudflare/workers-types` (`^5.20261118.1`), and added `pnpm.overrides` for `@vitest/mocker` (`^4.1.12`), `esbuild` (`^0.28.2`), `minimatch` (`^11.0.1`), `sharp` (`^0.35.5`), and `undici` (`^7.30.1`), clearing all 32 `pnpm audit` advisories while keeping permissive dependency licenses (`check-licenses.mjs`: 453 packages, 0 violations).

## [0.2.0] - 2026-11-15

### Added
- **Multilingual Interface (i18n)**: Full English, Spanish, and French localization across navigation, boards, notepads, settings, and sidebar language controls.
- **Deployment & Recovery Guides**: Added deployment, upgrade, and bootstrap recovery documentation alongside isolated Cloudflare staging profile support (`--staging`).
- **Project File Deletion**: Added project file deletion with active cover-image protection and retryable storage cleanup.
- **Bootstrap Recovery & CI**: Added self-service bootstrap claim reset support and automated GitHub Actions CI verification.

### Changed
- **Default Theme & Resizable Sidebar**: Set `Modern Dark` as the default theme and added a persisted resizable sidebar width.
- **Unified Media Frame & Notepad Layout**: Expanded the default notepad canvas (`max-w-[1200px]`), unified YouTube embeds and uploaded media/file blocks behind a reusable `<MediaBlockFrame>` container with side-drag resizing and Left/Center/Right alignment, and added type badges and delete controls in the Project Media Library.
- **Onboarding & Upgrade UX**: Improved the Cloudflare setup/upgrade workflow, README documentation, and `PostgreSQL 17` Docker Compose configuration.
- **Query & Theme Refinements**: Slimmed sidebar notepad list queries and refined Kanban card styling.

### Fixed
- **CI Test Determinism**: Provided fallback test `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` bindings in `vitest.config.ts` for clean CI checkouts, aligned GitHub Actions Node.js to `22.22.0`, and disabled probabilistic opportunistic pruning in the rate-limit adapter test fixture.
- **Document Media Playback & Selection**: Fixed media insertion to create inline `video` and `audio` blocks for uploaded/library media, added touch- and desktop-friendly media options triggers (`⋯`) and custom right-click handling on notepads, and updated file-serving CSP headers so raster images, audio, and video play inline when opened in a new tab.
- **Mobile Task View & Translations**: Improved responsive layout on `My Tasks` and completed missing UI translations.
- **Storage & Cascade Handling**: Cleaned up orphaned media objects on permanent deletions and fixed project cascade delete edge cases.
- **Error Handling & Lint Compliance**: Improved cross-package HTTP error normalization, resolved lint warnings, and added missing Worker OAuth/webhook bindings.

### Security
- **Deployment & Docker Hardening**: Added strict staging/production environment isolation, confirmation guards on destructive CLI operations, and removed static fallback secrets in favor of ephemeral localhost evaluation tokens.
- **Authentication, Rate Limiting & Upload Protections**: Upgraded `better-auth` (`1.7.25`) and core dependencies, restricted instance updates to the instance owner, added persistent database-backed rate limiting with trusted-proxy IP resolution, and enforced streaming upload size limits.
- **Database Integrity**: Added declarative foreign keys and referential integrity constraints across baseline and additive migrations.
  - *Migration Note*: Additive migration `0001_rate_limits_and_cleanup.sql` (SQLite/D1 and PostgreSQL) creates new rate-limit and cleanup-queue tables safely without locking or modifying existing data.

## [0.1.0] - 2026-11-06

### Added
- **100% Standalone Self-Hosted Architecture**: Zero external hosted dependencies; boots out of the box with `docker compose up` using Email & Password alone.
- **Dual Database Runtimes**: First-class support for both SQLite and PostgreSQL with automated parity migrations and contract test suites.
- **Neutral Extension Seams**: Added `AccessPolicy` and neutral `GET /api/auth/config` runtime hooks.
- **Optional Auth Providers**: Graceful integration for Magic Link (via `RESEND_API_KEY`) and Google OAuth (`GOOGLE_CLIENT_ID`), completely hidden in the UI when unconfigured.
- **Internationalization (i18n)**: Multi-language support covering English, Spanish, and French.
- **License & Decoupling Automated Guards**: Built-in CI scripts (`check-decoupling.mjs`, `check-licenses.mjs`, and `check.mjs`) to verify permissive dependency licensing and architectural purity.
