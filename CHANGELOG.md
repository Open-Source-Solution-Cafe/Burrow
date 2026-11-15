# Changelog

All notable changes to the Burrow self-hosted project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

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
