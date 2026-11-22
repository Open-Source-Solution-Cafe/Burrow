# Burrow Plugin Architecture Feasibility Audit

*Generated 2026-11-22 prior to `feat/plugin-architecture` implementation.*

## Verdict: **Feasible with changes**

Public `Burrow` already has a clean one-way decoupling boundary (`scripts/check-decoupling.mjs`), neutral adapter interfaces (`AuthProvider`, `IStorageAdapter`, `IEmailProvider`, `ILockAdapter`, `ISearchAdapter` in `src/core/infrastructure/types.ts` and `src/core/adapters/`), and a Hono app factory (`createCoreApp` in `src/core/app.ts`), so adopting a build-time plugin architecture on Cloudflare Workers + D1 is viable. Four gaps required remediation: (1) `burrow-cloud` was a Node/PostgreSQL app using PL/pgSQL, `FOR UPDATE` locks, and triggers on core tables (`burrow-cloud/src/cloud-schema/extensions.sql`); (2) core lacked an event bus, plugin migration/loader infrastructure, and had closed unions/hard FKs across `@` mentions (`notepad_links`), slash menus, card types, and `Sidebar`; (3) `createWorkerApp` (`src/worker/index.ts`) and the Vite SPA (`src/web/router.tsx`, `src/web/main.tsx`) were statically wired; and (4) untrusted third-party plugins require Workers for Platforms + sandboxed `<iframe>` isolation rather than in-process execution.

---

## 1. Cloud Leakage Findings (Baseline)
- `src/core/policy.ts`: Documented `httpError(402, ...)` and quota/DB trigger error mapping, plus `allowSelfUpdate?()` for managed fleets.
- `src/core/infrastructure/types.ts`: Lines 437 & 445 used `"tenant scope"` wording (allowlisted in `scripts/decoupling-allowlist.json`).
- `src/core/routes/workspace-export.ts`: Line 632 contained `Self-Hosted -> Remote / Cloud`.
- `src/core/app.ts` & `src/core/adapters/auth.ts`: Hardcoded Better Auth `emailAndPassword`, `magicLink`, `github`/`google` social providers, and `RESEND_API_KEY`/`GOOGLE_CLIENT_ID`/`GITHUB_CLIENT_ID`/`PRIVACY_POLICY_URL`/`TERMS_OF_SERVICE_URL` directly inside `/api/auth/config`.
- `src/web/pages/Login.tsx`: Narrowed `oauthProviders[].kind` to `'social'` and hardcoded `burrow.osscafe.com` / `osscafe.com` demo host/credentials.
- `src/worker/index.ts`, `src/worker/env.ts`, `src/core/adapters/db/d1/index.ts`: Hardcoded `DB`/`FILES`/env bindings with no `plugins` or adapter override parameters.
- `src/core/routes/system.ts` & `src/web/components/settings/SystemUpdateSection.tsx`: Embedded `Open-Source-Solution-Cafe/Burrow` release feed URLs and Cloudflare/GitHub/GitLab webhook instructions.

---

## 2. Table of Seams

| Extension Point | Baseline File(s) | Effort | Risk | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `createApp({ plugins })` composition | `src/worker/index.ts`, `src/core/app.ts`, `src/core/adapters/db/d1/index.ts` | Med | Low | Refactor to accept `plugins`, adapter overrides, and `ExecutionContext`. |
| Core adapters (`AuthProvider`, `IStorageAdapter`, `IEmailProvider`) | `src/core/infrastructure/types.ts`, `src/core/adapters/{auth,storage/types,email}.ts`, `src/core/app.ts` | Low–Med | Med | Add `AuthProvider.getPublicConfig?()` so SSO plugins advertise OIDC/SAML and `SSO_ONLY`. |
| Server routes | `src/core/app.ts`, `src/core/middleware/session.ts` | Low | Low | Mount `/api/plugins/:id` reusing `createIdentityMiddleware`, `createExplicitWorkspaceMiddleware`, `requireRole`. |
| Event bus (`task.created`, `notepad.saved`, etc.) | `src/core/services/{cards,notepads}.ts`, `burrow-cloud/src/app.ts` | Med | Med | Sync `before*` guards + post-commit `after*` via `ctx.waitUntil` replaces middleware HTTP sniffing. |
| Prefixed tables & migrations (`plugin_<id>_*`) | `src/worker/bootstrap.ts`, `scripts/deploy.mjs`, `wrangler.jsonc` | Med | High | Wrangler uses one `migrations_dir`; track plugins in `plugin_migrations` + validate SQL in `PluginDb`. |
| Slash menu (`/`) | `src/shared/slash.ts`, `src/web/editor/suggestionItems.tsx`, `src/web/editor/NotepadEditor.tsx`, `src/web/components/boards/QuickAddCard.tsx` | Med | Low–Med | Unify disconnected `NotepadEditor` and `QuickAddCard` command lists around `src/shared/slash.ts`. |
| `@` tagging / mention sources | `src/shared/{blocks,extract,references}.ts`, `src/web/editor/{schema,suggestionItems}.tsx`, `src/core/routes/workspace-views.ts`, `src/core/adapters/db/d1/schema.ts` | High | High | Open `MentionKind` (`plugin:<id>:<type>`), pluggable `/suggest` + `/reference`, leave `notepad_links` untouched. |
| Kanban card model & card types | `src/core/adapters/db/d1/schema.ts`, `src/core/services/cards.ts`, `src/web/components/boards/views/KanbanView.tsx`, `src/web/components/boards/CardPanel.tsx` | Med–High | Med | Add `cards.card_type` (default `'task'`), plugin satellite tables referencing `cards(id) ON DELETE CASCADE`, tile/panel slots. |
| Notepad autosave & soft edit lock | `src/web/editor/saveLockController.ts`, `src/core/services/notepads.ts`, `src/core/adapters/db/d1/repositories/notepad.ts` | Med | High | Keep `saveContentBatch` atomic; plugins only receive post-commit `notepad.saved`. |
| Sidebar panels & UI routes | `src/web/components/layout/Sidebar.tsx`, `src/web/router.tsx`, `src/web/main.tsx` | Med | Low–Med | Replace closed `RailTab` union and static `router` with slot registries and `mountBurrowWeb({ plugins })`. |

---

## 3. Top Blockers, Ranked

1. `burrow-cloud` relied on Postgres/Node (`pgSchema('cloud')`, PL/pgSQL, `FOR UPDATE`, core triggers, `@hono/node-server`) rather than D1/Workers.
2. Closed `@` mention kinds and `notepad_links` STORED generated-column FKs + `CHECK = 1`.
3. Absence of a core event bus and `before*` policy hooks.
4. Static Worker, Auth config, and Web SPA wiring.
5. D1 single `migrations_dir` constraint, lack of SQLite table ACLs, and 10 GB single-DB cap.
6. Missing `cards.card_type` discriminator and dual slash command implementations.
