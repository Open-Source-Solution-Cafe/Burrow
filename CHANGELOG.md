# Changelog

All notable changes to the Burrow self-hosted project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Database Integrity Constraints & Composite Keys (Phases 1-3)**: Added PostgreSQL migration `0009_integrity_constraints.sql` and SQLite migration `0013_integrity_constraints.sql` establishing strict referential integrity across all database runtimes:
  - Phase 1: Foreign keys on user references (`members.user_id`, `card_assignees.user_id`, `edit_locks.user_id`, `notifications.user_id`, `notifications.actor_id`) with `ON DELETE CASCADE`. Authorship fields (`workspaces.created_by`, `notepads.created_by`, `project_files.created_by`, `invites.invited_by`) made nullable with `ON DELETE SET NULL`.
  - Phase 2: Prevention of cross-scope drift via composite unique keys and composite foreign keys: `projects (id, workspace_id)`, `notepads (project_id, workspace_id) REFERENCES projects(id, workspace_id)`, `boards (project_id, workspace_id) REFERENCES projects(id, workspace_id)`, `board_columns (id, board_id)`, and `cards (column_id, board_id) REFERENCES board_columns(id, board_id)`. Enforced `cards.kind = 'card'` with composite foreign key `(notepad_id, kind) REFERENCES notepads(id, kind)`.
  - Phase 3: Cleanup triggers on `notepads`, `cards`, `boards`, and `"user"` deleting orphaned polymorphic target references in `notepad_links`.
  - *Migration Safety Note*: Applied non-destructive schema adjustments (`ALTER TABLE ... NOT VALID` in PostgreSQL and index/trigger creations in SQLite) ensuring zero downtime, safe execution against existing databases, and atomic rollback guarantees.
- **Application-wide Multilingual Support (i18n)**: Expanded translations across all user interfaces, including navigation rails, sidebars, project home, my tasks, trash, workspace and project settings, member management, invite redemption, boards (kanban, list, calendar views, card detail panels, comments), notepads tree, command palette, media library, and rich document editors.
- **Basalt Left Rail Language Switcher & Panel Controls**: Added a dedicated `LanguageToggle` button directly on the primary left icon rail right next to the theme toggle for instant one-click language cycling (EN, ES, FR), an embedded `LanguageSelector` in the sidebar panel footer, and full localization across all sidebar contextual panels.
- **Reactive Translation Hook & Parity Testing**: Integrated `useTranslation` with `Intl` date formatting and synchronous external store updates, accompanied by automated dictionary key parity validation across English, Spanish, and French.

### Changed

### Deprecated

### Removed

### Fixed
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

