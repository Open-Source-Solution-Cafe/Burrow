# Burrow — Audit Remediation Report

**Remediation Date:** 2026-11-13  
**Target Repository:** `d:\Burrow-private-public\Burrow` (`master`)  
**Baseline Audited Commit:** `d080d24` (`AUDIT_REPORT.md` — initial status `FAIL` with 16 findings)  
**Remediation Status:** **`PASS`** — All 16 findings (`FINDING-001` through `FINDING-016`) remediated, covered by automated regression tests, and independently verified.

---

## 1. Summary Matrix (All 16 Findings)

| Finding | Severity | Area | Status | Commit | Key Regression Tests |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `FINDING-001` | P0 | `demo-reset.mjs` production & `CI` wipe bypass + SQL interpolation | **Resolved** | `6ea935b` | `tests/unit/cloudflare-deploy.test.ts` |
| `FINDING-002` | P0 | Cross-environment staging bypass (`--staging --name=burrow`) | **Resolved** | `6ea935b` | `tests/unit/cloudflare-deploy.test.ts` |
| `FINDING-003` | P0 | Weak Docker Compose fallback secrets & `.env.example` crash loop | **Resolved** | `6ea935b` | `tests/unit/database-target.test.ts` (`config` & Docker smoke test) |
| `FINDING-004` | P1 | `pnpm check` ESLint warnings & missing CI workflow | **Resolved** | `1a48c05` | `pnpm check` (`eslint --max-warnings=0`), `.github/workflows/ci.yml` |
| `FINDING-005` | P1 | Orphaned storage objects on notepad/file/remote resets | **Resolved** | `b2e7da8` | `tests/unit/upload-cleanup.contract.test.ts`, `tests/api/storage.test.ts` |
| `FINDING-006` | P1 | Worker entrypoint & `buildSecretPlan` dropping OAuth & webhook bindings | **Resolved** | `9367355` | `tests/unit/cloudflare-deploy.test.ts`, `tests/unit/auth-config.test.ts` |
| `FINDING-007` | P1 | Any authenticated user triggering `POST /api/system/update` | **Resolved** | `9367355` | `tests/unit/system-version.test.ts`, `tests/adapters/http-smoke-node.test.ts` |
| `FINDING-008` | P1 | Worker 100 MB upload buffering & `Content-Length`-only `bodyLimit` | **Resolved** | `b2e7da8` | `src/core/middleware/security.test.ts`, `tests/unit/upload-cleanup.contract.test.ts` |
| `FINDING-009` | P1 | Better Auth global rate-limit bucket & header IP spoofing | **Resolved** | `9367355` | `src/core/middleware/security.test.ts`, `tests/api/security.test.ts` |
| `FINDING-010` | P2 | Fail-open CLI parser on typos (`--stage`, `--staging=false`) | **Resolved** | `6ea935b` | `tests/unit/cloudflare-deploy.test.ts`, `tests/unit/database-target.test.ts` |
| `FINDING-011` | P2 | `inventory-storage.mjs` hardcoding `'burrow'` on `--staging` | **Resolved** | `1a48c05` | `tests/unit/storage-inventory.test.ts` |
| `FINDING-012` | P2 | Stale `bootstrap_state` `'claimed'` lock with mistyped email | **Resolved** | `1a48c05` | `tests/adapters/bootstrap-cases.ts`, `tests/api/security.test.ts`, `tests/adapters/http-smoke-node.test.ts` |
| `FINDING-013` | P2 | Missing `--config` flag & missing env tag in rollback logs | **Resolved** | `1a48c05` | `scripts/deploy.mjs`, `package.json`, `docs/DEPLOYMENT_AND_UPGRADES.md` |
| `FINDING-014` | P2 | `.env` binding leakage into Worker tests & no Postgres HTTP smoke test | **Resolved** | `1a48c05` | `vitest.config.ts`, `tests/adapters/http-smoke-node.test.ts` |
| `FINDING-015` | P3 | Unthrottled invite probe endpoints (`userExists` enumeration) | **Resolved** | `1a48c05` | `tests/api/security.test.ts` |
| `FINDING-016` | P3 | `listByProject()` over-fetching full document `content` column | **Resolved** | `1a48c05` | `tests/adapters/http-smoke-node.test.ts`, `tests/adapters/notepad.contract.test.ts` |

---

## 2. Finding-by-Finding Remediation Evidence

### `FINDING-001` — `scripts/demo-reset.mjs` Production Safeguards & SQL Escaping (P0)
1. **Original Defect:** `scripts/demo-reset.mjs` treated `--force` or `process.env.CI` as sufficient authorization to wipe the production D1 database `'burrow'` and interpolated `DEMO_EMAIL` directly into SQL literals.
2. **Remediation Implemented (`6ea935b`):**
   - Added centralized `assertDemoResetAllowed` (`scripts/lib.mjs`) requiring both an explicit non-production/dedicated target flag (`--demo` or `--staging`) and explicit `BURROW_DEMO_RESET_CONFIRM=RESET-DEMO-BURROW` for non-interactive remote demo resets. Removed automatic `CI` / `--force` bypasses on production targets.
   - Added `validateDemoEmail` and SQL single-quote escaping (`escapeSqlLiteral`) in `buildDemoSeedSql` (`scripts/demo-reset.mjs`).
   - Updated `.github/workflows/demo-reset.yml` to pass `--demo` and `BURROW_DEMO_RESET_CONFIRM`.
3. **Regression Tests:** `tests/unit/cloudflare-deploy.test.ts` verifies `demo-reset.mjs` aborts with an error when targeting production without authorization even with `CI=true` and `--force`, and rejects malformed/SQL-injectable `DEMO_EMAIL` values.
4. **Verification:** Executed safely via mocked/unit checks (never executed against live Cloudflare production or demo resources); tests pass.
5. **Residual Risk:** Low. Automated scheduled runs rely on repository CI secrets for `CLOUDFLARE_API_TOKEN` scoping; production D1 reset remains blocked without explicit confirmation tokens.

### `FINDING-002` — Cross-Environment Staging Guard Bypass (`--staging --name=burrow`) (P0)
1. **Original Defect:** Combining `--staging` with `--name=burrow` (or overriding `--db=burrow` / `--bucket=burrow-files`) allowed `profile.isStaging = true` to bypass production confirmation gates while operating on production resources.
2. **Remediation Implemented (`6ea935b`):** Added `assertEnvironmentTargetIsolation` and hardened `resolveRemoteProfile` (`scripts/lib.mjs`) so any staging profile resolving to a production Worker name, D1 database name, R2 bucket name, or `CLOUDFLARE_DOMAIN` throws immediately before executing Wrangler commands. Similarly rejects production overrides targeting staging resource names.
3. **Regression Tests:** `tests/unit/cloudflare-deploy.test.ts` tests `--staging --name=burrow`, `--staging --db=burrow`, `--staging --bucket=burrow-files`, and production flags attempting to target staging names.
4. **Verification:** Passed in Vitest unit suite (`pnpm check`).
5. **Residual Risk:** Low. Assumes default production resource prefixes remain `burrow` / `burrow-files` as declared in `wrangler.jsonc`.

### `FINDING-003` — Weak Docker Compose Fallback Secrets & Crash Loop (P0)
1. **Original Defect:** `docker-compose.yml` hardcoded predictable fallback `BETTER_AUTH_SECRET` and `BOOTSTRAP_TOKEN` strings accepted by `src/server/config.ts`, while `cp .env.example .env && docker compose up` crashed on boot because `.env.example` defaulted `BETTER_AUTH_URL=http://localhost:3005` under `NODE_ENV=production`.
2. **Remediation Implemented (`6ea935b`):**
   - Removed all hardcoded fallback secrets from `docker-compose.yml` and upgraded the PostgreSQL service to `postgres:17-alpine`.
   - Added the old fallback strings and common placeholders to the placeholder denylists in `src/server/config.ts` and `src/core/adapters/auth.ts`.
   - Added `ALLOW_LOCAL_DOCKER_EVAL=true` support (`src/server/config.ts`, `src/server/index.ts`, `.env.example`, `README.md`, `docs/DEPLOYMENT_AND_UPGRADES.md`) generating ephemeral cryptographic credentials per boot strictly when bound to localhost, while non-localhost/public deployments continue rejecting weak/placeholder/localhost URLs and missing secrets.
   - Corrected broken README links (`docker-compose.yml`) and Compose service names (`postgres`, `burrow`) in `docs/DEPLOYMENT_AND_UPGRADES.md`.
3. **Regression Tests & Live Smoke Test:** Unit tests in `tests/unit/database-target.test.ts` verify placeholder rejection and localhost eval vs strict production validation. Independently verified Docker Compose Quick Start from zero config via isolated project `burrow-audit-verify`: container booted `postgres:17-alpine` + `burrow`, generated ephemeral `BOOTSTRAP_TOKEN`, and returned `200 OK` on `/api/health` and `/api/auth/config`, followed by full `down -v --rmi local` cleanup.
4. **Residual Risk:** Low. If an operator leaves `ALLOW_LOCAL_DOCKER_EVAL=true` intentionally while using a non-localhost `BETTER_AUTH_URL`, config validation still rejects weak secrets and enforces strict public URL origin checks.

### `FINDING-004` — ESLint Warnings & Missing CI Workflow (P1)
1. **Original Defect:** `pnpm check` failed on 7 `no-console` ESLint warnings in `src/server/index.ts`, `scripts/check.mjs` lacked `--max-warnings=0`, and `.github/workflows/` had no test/lint CI workflow.
2. **Remediation Implemented (`1a48c05`):** Added `/* eslint-disable no-console */` to CLI entrypoint `src/server/index.ts`, updated `scripts/check.mjs` to execute `eslint --max-warnings=0 .`, and created `.github/workflows/ci.yml` running `check-decoupling.mjs`, `check-licenses.mjs`, `pnpm run check:sqlite`, and `vitest run --project worker`.
3. **Verification:** `pnpm exec eslint --max-warnings=0 .` and full `pnpm check` exited `0` with zero errors and zero warnings.
4. **Residual Risk:** None for local gate; `.github/workflows/ci.yml` triggers in GitHub Actions upon push/PR.

### `FINDING-005` — Orphaned Storage Objects on Deletions & Resets (P1)
1. **Original Defect:** `NotepadService.permanentDeleteNotepad` ignored returned `coverKey` values, `ProjectService.permanentDeleteProject` failed without retry on transient errors, there was no explicit `DELETE` route for registered project files, and remote reset scripts wiped `project_files` without checking/cleaning R2.
2. **Remediation Implemented (`b2e7da8`):**
   - Added `unregister()` to `IProjectFileRepository` (`d1` and `postgres` implementations) and shared `deleteStorageObjectWithRetry` (`src/core/shared/storage-cleanup.ts`).
   - Updated `NotepadService.permanentDeleteNotepad` to clean up unreferenced `coverKey` values (`countByStorageKey === 0 && countByCoverKey === 0`) while preserving registered Media Library files per contract (`tests/api/storage.test.ts`).
   - Added `DELETE /api/workspaces/:wid/projects/:pid/files/:key` (`src/core/routes/project-files.ts`) requiring `editor`, blocking active notepad covers (`409 file_in_use`), and deleting the storage object *before* unregistering the database row when refcount `<= 1` so failures leave metadata intact for safe retry.
   - Added `inspectOrCleanRemoteR2References` in `scripts/lib.mjs`, invoked by `scripts/reset.mjs` and `scripts/demo-reset.mjs` (deleting objects with `--clean-r2`, warning otherwise).
3. **Regression Tests:** `tests/unit/upload-cleanup.contract.test.ts` (retry on transient delete, DB preservation when storage deletion fails, `409 file_in_use`, unregistered cover cleanup) and `tests/api/storage.test.ts` (end-to-end R2 file deletion and cover guard in Miniflare).
4. **Residual Risk:** Low. If storage deletion fails twice in async notepad/project hard-delete hooks, structured `console.error` logs the key so `pnpm run inventory:storage` can reconcile orphans.

### `FINDING-006` — Worker Entrypoint & `buildSecretPlan` Missing OAuth & Webhook Bindings (P1)
1. **Original Defect:** `src/worker/index.ts`, `src/worker/env.ts`, `src/core/adapters/db/d1/index.ts`, and `buildSecretPlan()` omitted `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SELF_UPDATE_WEBHOOK_URL`, `TRUST_PROXY`, and `TRUSTED_PROXIES`.
2. **Remediation Implemented (`9367355`):** Added the optional bindings to `Bindings` (`src/worker/env.ts`), forwarded them in `createD1Infrastructure` / `createPostgresInfrastructure` (`env` bundle passed to `createCoreApp`), and added optional forwarding in `buildSecretPlan` (`scripts/lib.mjs`).
3. **Regression Tests:** `tests/unit/auth-config.test.ts` and `tests/unit/cloudflare-deploy.test.ts` verify forwarding and secret-plan generation without forcing self-hosters to supply unused OAuth keys.
4. **Residual Risk:** None.

### `FINDING-007` — Unprivileged Users Triggering `POST /api/system/update` (P1)
1. **Original Defect:** Any authenticated workspace member (including an invited `viewer` or owner of a secondary workspace) could invoke `POST /api/system/update`.
2. **Remediation Implemented (`9367355`):** Added `isInstanceOwner(userId)` to `IWorkspaceRepository` (implemented in D1/SQLite and PostgreSQL workspace repositories against `bootstrap_state.status = 'complete' AND bootstrap_state.user_id = userId` verified with owner role on `bootstrap_state.workspace_id`), and enforced `403 forbidden` on `POST /api/system/update` (`src/core/routes/system.ts`) for any other user.
3. **Regression Tests:** `tests/unit/system-version.test.ts` and `tests/adapters/http-smoke-node.test.ts` (SQLite & PostgreSQL).
4. **Residual Risk:** Low. If an operator manually alters `bootstrap_state` in SQL rather than using bootstrap signup/recovery, update authorization follows `bootstrap_state.user_id`.

### `FINDING-008` — Worker 100 MB Upload Buffering & Header-Only `bodyLimit` (P1)
1. **Original Defect:** `bodyLimit` inspected only the optional `Content-Length` header, allowing chunked or spoofed-header payloads to stream unboundedly into memory, and Worker uploads allowed 100 MB despite Cloudflare Workers' 128 MB isolate limit.
2. **Remediation Implemented (`b2e7da8`):**
   - Upgraded `bodyLimit()` (`src/core/middleware/security.ts`) to wrap `c.req.raw.body` in a streaming byte-counting `TransformStream` for mutating methods (`POST`/`PUT`/`PATCH`/`DELETE`), aborting immediately with HTTP `413` (`payload_too_large`) when bytes exceed `maxBytes` regardless of `Content-Length`.
   - Exported `WORKER_MAX_UPLOAD_BYTES` (`25 * 1024 * 1024`) and `isCloudflareWorkersRuntime` (`src/shared/uploadPolicy.ts`) and enforced the 25 MB cap on both `bodyLimit` (`src/core/app.ts`) and upload/policy routes (`src/core/routes/project-files.ts`) when executing on Workers.
3. **Regression Tests:** `src/core/middleware/security.test.ts` (chunked stream without `Content-Length` and spoofed `Content-Length` -> `413`) and `tests/unit/upload-cleanup.contract.test.ts` (`WORKER_MAX_UPLOAD_BYTES` enforcement).
4. **Residual Risk:** None for Worker OOM up to 25 MB; Node/Docker deployments retain the full 100 MB ceiling.

### `FINDING-009` — Better Auth Global Rate-Limit Bucket & Header IP Spoofing (P1)
1. **Original Defect:** Client IP headers were ignored (`no-trusted-ip` warning causing all users to share one Better Auth rate-limit bucket), while direct `X-Forwarded-For`/`CF-Connecting-IP` trust without `TRUST_PROXY` allows spoofing on Node.
2. **Remediation Implemented (`9367355`):** Implemented trusted-proxy `resolveClientIp` (`src/core/middleware/security.ts`) respecting `CF-Connecting-IP` on Cloudflare Workers and honoring `X-Forwarded-For` on Node only when `TRUST_PROXY=true` (and optional `TRUSTED_PROXIES`), stamped normalized `x-burrow-client-ip` onto Better Auth requests (`src/core/app.ts`), configured Better Auth `rateLimit.customStorage` backed by the `verification` table across SQLite/D1/PostgreSQL (`createVerificationRateLimitStorage` in `src/core/adapters/auth.ts`), and secured CSRF `Origin` checks against unverified `X-Forwarded-Host`.
3. **Regression Tests:** `src/core/middleware/security.test.ts` and `tests/api/security.test.ts` (`x-burrow-client-ip` isolation, spoofed header rejection, zero Better Auth `no-trusted-ip` warnings).
4. **Residual Risk:** Low. Node reverse-proxy operators behind nginx/Caddy must set `TRUST_PROXY=true` so proxied clients receive distinct rate-limit buckets.

### `FINDING-010` — Fail-Open CLI Argument Parser (P2)
1. **Original Defect:** Unknown or malformed CLI flags (e.g., `--stage`, `--env=stage`, `--staging=false`) were silently ignored and defaulted to production.
2. **Remediation Implemented (`6ea935b`):** Replaced ad-hoc flag checks with strict centralized `parseCliArgs` (`src/server/database-target.ts`) enforcing `KNOWN_CLI_FLAGS`, `--flag=value` syntax validation, missing-value detection, contradictory flag rejection (`--staging` with `--env=production`), and strict `resolveEnvironmentName` validation in `scripts/lib.mjs`.
3. **Regression Tests:** `tests/unit/database-target.test.ts` and `tests/unit/cloudflare-deploy.test.ts`.
4. **Residual Risk:** None.

### `FINDING-011` — `scripts/inventory-storage.mjs` Hardcoded Production Database `'burrow'` (P2)
1. **Original Defect:** Running `inventory:storage -- --remote --staging` executed `wrangler d1 execute burrow` instead of `burrow-staging` with `wrangler.staging.local.jsonc`.
2. **Remediation Implemented (`1a48c05`):** Exported `resolveInventoryTarget` and `resolveInventoryD1Execution` in `scripts/inventory-storage.mjs` using `resolveRemoteProfile` and `getWranglerConfigArgs({ profile })`, passing `profile.dbName` to `wrangler d1 execute`.
3. **Regression Tests:** `tests/unit/storage-inventory.test.ts` verifies `--remote --staging` selects `burrow-staging` and `wrangler.staging.local.jsonc`.
4. **Residual Risk:** None.

### `FINDING-012` — Stale `bootstrap_state` `'claimed'` Lock Recovery (P2)
1. **Original Defect:** A failed or mistyped initial bootstrap claim permanently wedged `bootstrap_state` in `status = 'claimed'` with no self-service or operator-token reset path, requiring manual SQL edits.
2. **Remediation Implemented (`1a48c05`):** Added `resetBootstrapClaim` to `IWorkspaceRepository` (D1/SQLite and PostgreSQL, plus `releaseBootstrap` on PostgreSQL) and added `{ bootstrapToken, resetClaim: true }` support to `POST /api/auth/bootstrap/recover` (`src/core/app.ts`) resetting `'claimed'` back to `'empty'` only when zero workspaces exist and the `BOOTSTRAP_TOKEN` matches in constant time. Documented in `docs/BOOTSTRAP_RECOVERY.md`.
3. **Regression Tests:** `tests/adapters/bootstrap-cases.ts` (SQLite, D1, PostgreSQL), `tests/api/security.test.ts`, and `tests/adapters/http-smoke-node.test.ts`.
4. **Residual Risk:** None. Once workspace `1` exists, `resetClaim` rejects with `409 bootstrap_unavailable`.

### `FINDING-013` — Missing `--config` & Env Metadata in Wrangler Docs/Rollback Log (P2)
1. **Original Defect:** Direct `wrangler d1` and `wrangler tail` commands omitted `--config wrangler.local.jsonc` / `--config wrangler.staging.local.jsonc`, and `.deploy-log/rollbacks.log` omitted which environment/DB produced each bookmark.
2. **Remediation Implemented (`1a48c05`):** Updated `scripts/deploy.mjs` rollback log entries to include `[${profile.envName}:${dbName}]`, added `--config wrangler.local.jsonc` and `logs:staging` to `package.json`, and updated `docs/DEPLOYMENT_AND_UPGRADES.md`.
3. **Verification:** Inspected generated scripts, `package.json`, and `docs/DEPLOYMENT_AND_UPGRADES.md`; `tsc -b` and `eslint --max-warnings=0` pass.
4. **Residual Risk:** None.

### `FINDING-014` — Worker Test `.env` Leakage & Missing PostgreSQL HTTP Smoke Tests (P2)
1. **Original Defect:** Miniflare test bindings in `vitest.config.ts` could inherit optional developer `.env` secrets, and HTTP route tests ran only against Worker/D1.
2. **Remediation Implemented (`1a48c05`):** Explicitly isolated `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SELF_UPDATE_WEBHOOK_URL`, `TRUST_PROXY`, and `TRUSTED_PROXIES` to `''` in `vitest.config.ts`, and created `tests/adapters/http-smoke-node.test.ts` exercising the full Hono HTTP app (`createCoreApp`) against both SQLite and PostgreSQL 17.
3. **Verification:** Both SQLite and PostgreSQL HTTP smoke tests pass inside `pnpm check`.
4. **Residual Risk:** None.

### `FINDING-015` — Invite Token Enumeration Probe Protection (P3)
1. **Original Defect:** Unauthenticated `GET /api/invites/info/:token` and `POST /api/invites/accept` lacked route-level rate limiting.
2. **Remediation Implemented (`1a48c05`):** Applied per-IP `rateLimiter` (`30 req/min` on `GET /api/invites/info/:token` and `20 req/min` on `POST /api/invites/accept`) in `src/core/app.ts` using trusted client IP resolution.
3. **Regression Tests:** `tests/api/security.test.ts` verifies repeated probes return `429 rate_limit_exceeded`.
4. **Residual Risk:** None; tokens remain 128+ bit high-entropy nanoid strings.

### `FINDING-016` — `listByProject()` Over-Fetching Document `content` JSON (P3)
1. **Original Defect:** `listByProject()` in D1 and PostgreSQL notepad repositories ran `SELECT *` for sidebar tree listings, transferring every full BlockNote `content` column over the wire even though tree metadata discards it.
2. **Remediation Implemented (`1a48c05`):** Switched `listByProject()` in `src/core/adapters/db/d1/repositories/notepad.ts` and `src/core/adapters/db/postgres/repositories/notepad.ts` to project metadata columns only and return `content: '[]'`, leaving full content loading on `findByIdInScope()` / `getContent()`.
3. **Regression Tests:** `tests/adapters/http-smoke-node.test.ts` and `tests/adapters/notepad.contract.test.ts` confirm `listByProject()` returns `content: '[]'` while `GET .../notepads/:id` returns saved document content.
4. **Residual Risk:** None.

---

## 3. Independent Verification Results (Post-Remediation)

All checks below ran after all code, test, and configuration changes were applied on `master`:

1. **`pnpm check`** (`node scripts/check.mjs`): **PASSED (`exit 0`)**
   - `tsc -b`: **0 errors**
   - `scripts/check-basalt.mjs`: **OK**
   - `scripts/check-licenses.mjs`: **418 packages scanned, 0 violations, 0 allowlisted**
   - `scripts/check-decoupling.mjs`: **400 files scanned, 0 violations, 8 allowlisted**
   - `eslint --max-warnings=0 .`: **0 errors, 0 warnings**
   - `vitest run`: **133/133 test files passed, 751/751 tests passed, 0 failed, 0 skipped** (covering `unit`, `worker` Miniflare D1/R2 API tests, `sqlite` in-memory/node tests, and `postgres` 17 integration/HTTP smoke tests)
2. **Isolated Docker Compose Quick-Start Smoke Test (`burrow-audit-verify`)**: **PASSED (`exit 0`)**
   - Command: `docker compose --env-file <empty> -p burrow-audit-verify up -d --build` (no `.env` secrets)
   - Result: `postgres:17-alpine` healthy -> `burrow` container applied migrations, generated ephemeral `BOOTSTRAP_TOKEN`, listened on `3005` (mapped to `3019`), returned `GET /api/health` -> `{"ok":true,...}` and `GET /api/auth/config` -> `{"signupMode":"bootstrap-or-invite","emailPasswordEnabled":true,"magicLinkEnabled":false,"oauthProviders":[]}`
   - Cleanup: `docker compose --env-file <empty> -p burrow-audit-verify down -v --rmi local` removed all test containers, network, volumes, and image cleanly.
