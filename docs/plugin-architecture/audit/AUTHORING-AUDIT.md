# Burrow Plugin Authoring Audit (`AUTHORING.md` Walkthrough)

*Walkthrough performed 2026-11-22 in an isolated scratch workspace (`scratch/external-plugin-test`) using only the public `Burrow` repo and `pnpm pack` of `packages/sdk`.*

---

## 1. Summary Metrics

| Metric | Observed Result |
| :--- | :--- |
| **Scaffolding method** | Manual copy-paste of `packages/plugins/_template` (`README.md:3`). **No `create-burrow-plugin` CLI exists.** |
| **Time to first compiling external plugin** | **~15–20 minutes** (blocked repeatedly by missing `hono`/`react`/`tsconfig.json`, raw `.ts` SDK export, and undocumented UI wiring). |
| **Time to running locally against Burrow** | **Blocked without editing Burrow core source** (`src/worker/index.ts`, `src/web/main.tsx`, `vite.config.ts`) — external plugins have no config/registry discovery. |
| **`@burrow/sdk` publishability** | **FAIL** (`pnpm pack` emits raw `src/index.ts` with no `dist/` JS/d.ts, no `files` whitelist, and breaks Node ESM with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). |

---

## 2. Step-by-Step Walkthrough & Friction Log

### Step 1: Scaffold from `packages/plugins/_template`
- Copied `packages/plugins/_template` to `scratch/external-plugin-test`.
- **Friction 1 (No CLI / incomplete template):** `_template` (`packages/plugins/_template/`) contains only `package.json`, `README.md`, and `src/index.ts`. It lacks `tsconfig.json`, `src/web.tsx`, a test file, and `"./web"` in `package.json` `exports`.
- **Friction 2 (Copyleft default in template):** `_template/package.json:5` sets `"license": "AGPL-3.0-or-later"` and `"private": true`, which surprises community authors expecting MIT/Apache-2.0 for plugins.

### Step 2: Build a Small Full-Stack Plugin
Built a sample plugin (`id: 'audit-sample'`) with a route (`/workspaces/:wid/items`), `task.created` subscriber, prefixed table (`plugin_audit_sample_items`), `/audit-stamp` slash command, `audit-sample` card type (`renderTileBadge` + `renderPanelSection`), and sidebar panel.
- **Friction 3 (Missing peer/runtime dependencies):** Running `tsc` immediately failed:
  `error TS2307: Cannot find module 'hono' or its corresponding type declarations.`
  `_template/package.json` only lists `"@burrow/sdk": "workspace:*"`—it worked inside the Burrow monorepo solely due to pnpm hoisting! External authors must guess and manually install `hono`, `react`, `@types/react`, `lucide-react`, and `typescript`.
- **Friction 4 (No UI to create custom `cardType` cards):** Searched `src/web/` (`git grep cardType src/web/`). `KanbanView.tsx:121-126` and `CardPanel.tsx:45,130-133` **read** `card.cardType` to render plugin badges/sections, **but neither `QuickAddCard.tsx` nor `CardPanel.tsx` lets a user select or change `cardType` in the UI!** Creating a custom-typed card is only possible via direct HTTP `POST` (`{ cardType: 'audit-sample' }`).
- **Friction 5 (Hardcoded CSS/Basalt coupling):** `AUTHORING.md:66` warns authors to use `--surface`, `--surface2`, `--line`, `--text`, `--muted`, `--accent` and `theme-radius-*` (`scripts/check-basalt.mjs`), **but** `@burrow/sdk` provides no CSS token type/constants or UI primitives—authors must read `src/web/index.css` and `src/web/components/ui/` to match Burrow's styling.
- **Friction 6 (`AUTHORING.md` omissions):** `AUTHORING.md` does not document `ctx.middleware.{requireIdentity,requireWorkspace,requireRole}` typing (they are typed as `unknown` in `packages/sdk/src/index.ts:151-155`, forcing `as MiddlewareHandler` casts), does not document `ctx.db` Postgres incompatibility, and still states `sdkVersion: '^0.4.0'` with D1-only examples.

### Step 3: Local Dev Loop, Registration, Testing & Debugging
- **Friction 7 (No external registration mechanism):** `src/worker/index.ts:112` exports `createApp()` with zero plugins; `src/server/index.ts:97` calls `createCoreApp(...)` with zero plugins (Node/Postgres server ignores plugins completely); `src/web/main.tsx:3` calls `mountBurrowWeb()` with zero plugins. An external developer **cannot** test their plugin against a local Burrow instance without cloning and editing `Burrow/src/worker/index.ts` and `Burrow/src/web/main.tsx` (or building a custom wrapper app importing `@burrow/worker` and `@burrow/web`, which are also unpublished workspace packages!).
- **Friction 8 (Testing requires internal repo setup):** `AUTHORING.md:70` points to `tests/api/plugin-authoring-showcase.test.ts`, which relies on Burrow's internal `vitest.config.ts`, `cloudflare:test`, `TEST_MIGRATIONS`, and monorepo `resolve.alias`. There is no standalone test helper in `@burrow/sdk`.
- **Friction 9 (Opaque errors & no hot-reload contract):** Changing server plugin migrations requires restarting `wrangler dev` / `ensureWorkerRuntimeEnv`; `PluginRouteMiddleware` types are `unknown`, and `PluginEventBus` errors omit plugin IDs in logs.

### Step 4: External Package & `@burrow/sdk` Publishability Check
Ran `pnpm --dir Burrow/packages/sdk pack` and installed `burrow-sdk-0.4.0.tgz` into `scratch/external-plugin-test`.

| Check | Result | Exact Output / Evidence |
| :--- | :--- | :--- |
| **`pnpm pack` tarball contents** | **FAIL** | Contains only `package/package.json`, `package/tsconfig.json`, `package/src/index.ts`, `package/LICENSE`. No `dist/*.js`, no `dist/*.d.ts`, no `"files"` field in `packages/sdk/package.json`. |
| **`exports` & runtime Node import** | **FAIL** | `packages/sdk/package.json:7-10` sets `"exports": { ".": "./src/index.ts" }`, while `src/index.ts:1` exports a runtime value (`export const BURROW_SDK_VERSION = '0.4.0'`). Importing `@burrow/sdk` in Node 22+ throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING: Stripping types is currently unsupported for files under node_modules`. |
| **`tsc` with `moduleResolution: "bundler"`** | **PASS (after manual deps)** | Passes **only** after manually creating `tsconfig.json` and installing `hono`, `react`, `@types/react`, `typescript`. |
| **`tsc` with `moduleResolution: "nodenext"`** | **FAIL** | Fails (`TS2835`) on extensionless relative imports and ships raw `.ts` without `.d.ts` declaration maps. |
| **Workspace-only imports in `@burrow/sdk`** | **PASS** | `packages/sdk/src/index.ts` has zero `workspace:*` or `../../../` imports (`dependencies: {}`). (Note: `@burrow/core`, `@burrow/web`, `@burrow/worker` DO use `../../../src/...` relative paths outside their package roots and are NOT publishable as standalone packages.) |
| **Version sync** | **PARTIAL** | `@burrow/sdk` is `0.4.0` while root `Burrow` is `0.5.0`; `scripts/check-version.mjs` does not check `packages/sdk/package.json`. |

---

## 3. Places Where Core Source Had to Be Read

| Question Needed While Authoring | Why `AUTHORING.md` + `@burrow/sdk` Were Insufficient | Core File Read |
| :--- | :--- | :--- |
| How do `requireIdentity`, `requireWorkspace`, `requireRole` work & what Hono context vars (`userId`, `workspaceId`, `role`) do they set? | Typed as `unknown` in `ServerPluginContext.middleware` (`packages/sdk/src/index.ts:151-155`). | `src/core/middleware/session.ts:19-69`, `src/core/app.ts:66-73` |
| How do users actually create a card with my custom `cardType`? | Not mentioned in `AUTHORING.md` or `@burrow/sdk`. | `src/web/components/boards/QuickAddCard.tsx`, `KanbanView.tsx:121`, `CardPanel.tsx:130` (discovered no UI exists) |
| What is the SQL dialect, placeholder style, and what SQL statements are blocked? | `AUTHORING.md:13-22` omits CTE/`SELECT` rules and Postgres status. | `src/core/plugins/plugin-db.ts:174-292` |
| How does `PluginDb.execute()` map `lastRowId` / `changes` and is `RETURNING` supported? | `execute()` vs `first()` for `RETURNING` not documented. | `src/core/plugins/plugin-db.ts:320-353` |
| Which CSS custom properties & utility classes pass Basalt checks? | Only named briefly in `AUTHORING.md:66`. | `scripts/check-basalt.mjs`, `packages/plugins/estimation/src/web.tsx` |
| How are plugin routes mounted and how is `mountPath` scoped? | `AUTHORING.md:49` only shows default `ctx.route(app)`. | `src/core/plugins/loader.ts:85-92`, `src/core/app.ts:1001-1003` |

---

## 4. Open Questions

1. Should `@burrow/sdk` remain strictly types-only (removing `export const BURROW_SDK_VERSION` or emitting a tiny compiled `dist/index.js` + `dist/index.d.ts` via `tsup`/`tsc`) so Node/bundler consumers both work?
2. Should `hono` and `react` be declared as optional `peerDependencies` on `@burrow/sdk` (or should `@burrow/sdk` re-export typed Hono middleware signatures without forcing `hono` on web-only plugins)?
