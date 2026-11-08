# Changelog

All notable changes to the Burrow self-hosted project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Sole Owner User Deletion Guards**: Added `user.deleteUser.beforeDelete` Better Auth lifecycle hook and database `BEFORE DELETE` trigger `trg_prevent_sole_owner_user_delete` preventing user deletion if the user is the sole owner of any workspace.
- **Line Ending Normalization**: Added `.gitattributes` enforcing consistent LF line endings across all files (`* text=auto eol=lf`).
- **Database Baseline Migration Squashing & Inline Integrity**: Squashed historical migration steps into a unified, zero-overhead baseline migration (`migrations/0000_baseline.sql` for SQLite/D1 and `migrations/postgres/0000_baseline.sql` for PostgreSQL) with all referential integrity constraints defined directly inline:
  - Composite unique constraint `projects (id, workspace_id)` and composite foreign keys on `notepads` and `boards` referencing `(project_id, workspace_id)`.
  - Composite foreign keys on `cards (column_id, board_id) REFERENCES board_columns(id, board_id)` and `(notepad_id, project_id, kind) REFERENCES notepads(id, project_id, kind)`.
  - Real foreign keys on user references: `members.user_id`, `card_assignees.user_id`, `edit_locks.user_id`, and `notifications.user_id` with `ON DELETE CASCADE`; `workspaces.created_by`, `notepads.created_by`, `project_files.created_by`, `invites.invited_by`, and `notifications.actor_id` with `ON DELETE SET NULL`.
  - Automatic cleanup triggers on `notepads`, `cards`, `boards`, and `"user"` deleting orphaned polymorphic target references in `notepad_links`.
- **Database Schema Parity Suite**: Added automated integration test (`tests/unit/schema-parity.test.ts`) validating that database schemas generated from migrations from scratch strictly match Drizzle schema definitions across tables, columns, nullability, primary keys, composite foreign keys, unique constraints, and triggers for both SQLite/D1 and PostgreSQL runtimes.
- **Application-wide Multilingual Support (i18n)**: Expanded translations across all user interfaces, including navigation rails, sidebars, project home, my tasks, trash, workspace and project settings, member management, invite redemption, boards (kanban, list, calendar views, card detail panels, comments), notepads tree, command palette, media library, and rich document editors.
- **Basalt Left Rail Language Switcher & Panel Controls**: Added a dedicated `LanguageToggle` button directly on the primary left icon rail right next to the theme toggle for instant one-click language cycling (EN, ES, FR), an embedded `LanguageSelector` in the sidebar panel footer, and full localization across all sidebar contextual panels.
- **Reactive Translation Hook & Parity Testing**: Integrated `useTranslation` with `Intl` date formatting and synchronous external store updates, accompanied by automated dictionary key parity validation across English, Spanish, and French.

### Changed
- **Decoupling Scanner Hardening**: Extended `scripts/check-decoupling.mjs` to detect `cloud_` prefixed identifiers and schema-qualified `cloud.` references across all schemas, migrations, and source files.

### Deprecated

### Removed

### Fixed
- **Cross-package Error Handling**: Hardened `isHttpError` in `core/services/errors.ts` to identify status and error codes duck-typed across dual-bundle and package boundaries, preventing unhandled 500 errors.
- **Auth Endpoint Rejection Handling**: Wrapped Better Auth route handler in `core/adapters/auth.ts` to cleanly catch and map lifecycle hook rejections to HTTP error responses.
- **Cascade Scope Delete Guard**: Updated PostgreSQL cascade delete triggers on `notepads` and `boards` to recognize when the parent project is being atomically deleted in the same cascade, preventing false-positive `scope_cascade_conflict` rejections during full project deletions.
- **Complete UI Translation Coverage**: Localized previously hardcoded English strings in `WorkspaceSwitcher` (workspaces header, creation modal, settings links), `ProjectSwitcher` (creation modal, dropdown options), member role tags (`OWNER`, `EDITOR`, `VIEWER`), keyboard shortcuts modal, filter controls, command palette footer, board column action buttons (`Add Column`, WIP limit menu), and card quick-add menus/toasts across English, Spanish, and French.

### Security

## [0.1.0] - 2026-11-06

### Added
- **100% Standalone Self-Hosted Architecture**: Zero external hosted dependencies; boots out of the box with `docker compose up` using Email & Password alone.
- **Dual Database Runtimes**: First-class support for both SQLite and PostgreSQL with automated parity migrations and contract test suites.
- **Neutral Extension Seams**: Added `AccessPolicy` and neutral `GET /api/auth/config` runtime hooks.
- **Optional Auth Providers**: Graceful integration for Magic Link (via `RESEND_API_KEY`) and Google OAuth (`GOOGLE_CLIENT_ID`), completely hidden in the UI when unconfigured.
- **Internationalization (i18n)**: Multi-language support covering English, Spanish, and French.
- **License & Decoupling Automated Guards**: Built-in CI scripts (`check-decoupling.mjs`, `check-licenses.mjs`, and `check.mjs`) to verify permissive dependency licensing and architectural purity.

