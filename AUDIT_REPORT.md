# Burrow — Independent Release-Readiness & Security Audit Report

**Audit Date:** 2026-11-13  
**Target Repository:** `d:\Burrow-private-public\Burrow` (Branch: `master`, HEAD: `d080d24`)  
**Audited Commits:** `38d845c` (`docs: restructure README, add deployment/button guides, and capture product screenshots`), `d080d24` (`feat(deploy): add staging isolation, upgrade migration & preflight guards, and production teardown protection`)  
**Auditor Role:** Principal Software Engineer, Security Auditor, and Site Reliability Engineer

---

## 1. Executive Summary

**Overall Release Status:** **`FAIL`**

While Burrow demonstrates strong engineering in its core data-access layer—specifically its workspace/project-scoped repository guards, lease-based document locking (`edit_locks` with atomic `version` fencing), and comprehensive Vitest suite (`132` test files / `724` tests passing across SQLite/D1 and PostgreSQL 17)—**the repository is NOT safe for public release in its current state**.

Independent verification uncovered **3 Critical (`P0`)**, **6 High (`P1`)**, **5 Medium (`P2`)**, and **2 Low (`P3`)** issues that directly contradict or undermine several prior completion claims:

1. **Production Database Wipe Bypass (`FINDING-001`, P0):** While `scripts/teardown.mjs` and `scripts/reset.mjs` enforce `--confirm-production-*` tokens, `scripts/demo-reset.mjs` was left completely unguarded. Worse, line 40 sets `const force = hasFlag('--force') || Boolean(process.env.CI);`. Running `pnpm run demo:reset -r` in any environment where `CI=1` or `CI=true` is set (standard across CI runners and many automated agent shells), or with `--force`, immediately wipes the **production** D1 database (`burrow`) without confirmation, drops pre-baseline tables, and seeds a public `demo@osscafe.com` / `demopassword123` Owner account. It also contains raw SQL string interpolation of `DEMO_EMAIL`.
2. **Cross-Environment Staging Guard Bypass (`FINDING-002`, P0):** `resolveRemoteProfile()` (`scripts/lib.mjs:107-108`) allows `--staging` to be combined with `--name=burrow` (the production Worker name). Because `profile.isStaging` is `true`, all production confirmation gates are bypassed. Running `node scripts/teardown.mjs -r --staging --force --name=burrow` executes `wrangler delete burrow --force` and deletes the live production Worker without any prompt or token check.
3. **Broken Docker Quick Start & Publicly Hardcoded Production Fallback Secrets (`FINDING-003`, P0):**
   - `docker-compose.yml:16-18` hardcodes fallback secrets (`burrow-selfhost-secret-key-32-bytes-minimum!!` and `burrow-bootstrap-token-initial-setup`) that are **not** in the production placeholder denylist (`src/server/config.ts:36-44`, `src/core/adapters/auth.ts:45-46`). Starting Docker Compose without overrides runs a production container with publicly known signing and bootstrap secrets.
   - Conversely, following the exact README Docker Quick Start (`cp .env.example .env && docker compose up -d --build`) causes an immediate **container crash loop** on boot because `.env.example:20` sets `BETTER_AUTH_URL=http://localhost:3005` while `docker-compose.yml:10` sets `NODE_ENV=production`, triggering `Error: BETTER_AUTH_URL cannot point to localhost or 127.0.0.1 in production` (`src/server/config.ts:67-69`).
4. **`pnpm check` Fails on ESLint Warnings (`FINDING-004`, P1):** Although all `724` Vitest tests pass (`pnpm test`), running the full verification gate (`pnpm check` / `pnpm exec eslint . --max-warnings=0`) **fails with exit code 1** due to 7 `no-console` warnings in `src/server/index.ts:113-130`. Furthermore, there is no CI workflow running tests, typechecks, or lint checks on pushes or pull requests (`.github/workflows/` only contains `demo-reset.yml`).
5. **Orphaned Storage Objects on Notepad Deletion & Remote Resets (`FINDING-005`, P1):** `NotepadService.permanentDeleteNotepad()` (`src/core/services/notepads.ts:369-373`) discards the `removed` array (`{ id, coverKey }`) returned by `repos.notepads.hardDelete()` and never deletes cover images or media files from storage. Additionally, `scripts/reset.mjs` and `scripts/demo-reset.mjs` wipe `project_files` rows in remote D1 without deleting objects from the remote R2 bucket.
6. **Cloudflare Worker Entrypoint Drops OAuth & Self-Update Bindings (`FINDING-006`, P1):** `src/worker/index.ts:19-29` and `buildSecretPlan()` (`scripts/lib.mjs:700-737`) omit `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SELF_UPDATE_WEBHOOK_URL`, breaking OAuth and self-update webhooks on Cloudflare Workers despite README and deployment guide claims.

---

## 2. Verified Claims

| # | Prior Completion Claim | Audit Status | Concrete Evidence (Files, Lines, & Verification Results) |
| :- | :--- | :---: | :--- |
| **1** | **README improvements and real application screenshots** | **PARTIAL / FAIL** | **Verified:** 6 real PNG screenshots exist in `docs/assets/screenshots/` (`27,662 B`–`86,449 B`) and are rendered in `README.md`.<br>**Failed:** `README.md:10` links to `./compose.yaml` (file does not exist; actual file is `docker-compose.yml`) and claims `PostgreSQL 17` (`README.md:10, 102`), whereas `docker-compose.yml:30` uses `postgres:16-alpine`. Following `README.md:97-99` (`cp .env.example .env` + `docker compose up -d --build`) crashes on startup (`src/server/config.ts:67-69`). `docs/DEPLOYMENT_AND_UPGRADES.md:188-193` references nonexistent Docker Compose service names `db` and `app` instead of `postgres` and `burrow`. |
| **2** | **Cloudflare installer preflight and secret handling** | **PARTIAL / FAIL** | **Verified:** `scripts/lib.mjs` implements preflight account/Wrangler checks and `buildSecretPlan()` preserves existing remote secrets (`wrangler secret list`) on upgrade unless `--rotate-secrets` is passed.<br>**Failed:** `buildSecretPlan()` (`scripts/lib.mjs:700-737`) and `src/worker/index.ts:19-29` completely omit `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SELF_UPDATE_WEBHOOK_URL`. |
| **3** | **Idempotent installation and safe upgrades** | **PASS WITH WARNINGS** | **Verified:** `scripts/setup.mjs` and `scripts/lib.mjs` (`reconcileAndApplyRemoteD1Migrations`) detect unrecorded baseline schemas (`repair-unrecorded-baseline`), verify `REQUIRED_BASELINE_TABLES`, and apply forward migrations without wiping data. Unit-tested in `tests/unit/cloudflare-deploy.test.ts`.<br>**Warning:** Rollback bookmarks in `scripts/deploy.mjs:123-126` are appended to `.deploy-log/rollbacks.log` without recording whether the bookmark belongs to `production` or `staging`. |
| **4** | **Staging/production isolation** | **FAIL** | **Verified:** `resolveRemoteProfile()` (`scripts/lib.mjs:81-137`) defaults staging to `burrow-staging`, `burrow-staging-files`, `wrangler.staging.local.jsonc`, and blocks attaching `CLOUDFLARE_DOMAIN` to staging.<br>**Failed:** Passing `--staging --name=burrow` is not blocked (`scripts/lib.mjs:107-108`), allowing staging commands to overwrite or delete the production Worker (`burrow`). Also, `scripts/inventory-storage.mjs:80` hardcodes `'burrow'` instead of `profile.dbName` when `--staging` is passed, and unrecognized flags (`--stage`, `--env=stage`, `--staging=false`) fail open (`scripts/lib.mjs:52-90`). |
| **5** | **Production teardown/reset safeguards** | **FAIL** | **Verified:** `scripts/teardown.mjs:98-127` and `scripts/reset.mjs:97-125` require `--confirm-production-teardown=DELETE-PRODUCTION-BURROW` and `--confirm-production-reset=RESET-PRODUCTION-BURROW`.<br>**Failed:** `scripts/demo-reset.mjs:40, 186-202` has **zero** production token guard and treats `process.env.CI` or `--force` as full authorization to wipe the production `burrow` D1 database. Also bypassed via `teardown.mjs -r --staging --force --name=burrow` (`FINDING-002`). |
| **6** | **Live R2 upload/download verification** | **NOT VERIFIED (Live) / PASS (Contract)** | **Verified:** `tests/adapters/storage.contract.test.ts` (9 tests) and `tests/api/storage.test.ts` verify byte-for-byte upload, download, Range requests, quota enforcement, and cross-workspace isolation against Miniflare's R2 runtime.<br>**Not Verified on Live R2:** Per Audit Rules 4, 6, and 8, no live write/delete operations were executed against the Cloudflare account (`wrangler.staging.local.jsonc` currently holds placeholder `00000000-0000-0000-0000-000000000000`, so no live staging Worker/R2 deployment is currently provisioned). |
| **7** | **SQLite and PostgreSQL migration testing** | **PASS WITH WARNINGS** | **Verified:** `tests/unit/sqlite-migrations.test.ts` tests forward migrations on both SQLite and live Docker `postgres:17` (`preserves existing workspace data, roles, content, and invariants across a forward PostgreSQL upgrade`), `tests/unit/schema-parity.test.ts` verifies DDL parity, and `tests/adapters/*-node.test.ts` runs all repository contract suites against both in-memory SQLite (`better-sqlite3`) and disposable `postgres:17` (`tests/adapters/node-setup.ts:53`).<br>**Warning:** Full API HTTP end-to-end tests (`tests/api/*.test.ts`) only execute against the Miniflare/D1 `worker` project, not against Node + PostgreSQL. |
| **8** | **Automated checks reporting 724 passing tests, zero failures, and zero skipped tests** | **PARTIAL / FAIL** | **Verified (`pnpm test`):** Independently executed `pnpm test` (`vitest run`): `132 passed (132)` test files, `724 passed (724)` tests, `0` failures, `0` skipped (`348.52s`).<br>**Failed (`pnpm check`):** `pnpm exec eslint . --max-warnings=0` (step 2 of `scripts/check.mjs`) **fails with exit code 1** due to 7 `no-console` warnings in `src/server/index.ts:113-130`. |
| **9** | **Two separate local commits for documentation and deployment improvements** | **PASS** | **Verified:** `git status --short --branch` confirms clean working tree on `master...origin/master [ahead 3]`. Commit `38d845c` contains documentation and 6 screenshot assets; commit `d080d24` contains deployment scripts, `.gitignore`, `wrangler.jsonc`, and deployment unit tests. No secrets are committed in tracked files. |

---

## 3. Findings

### `FINDING-001` — `scripts/demo-reset.mjs` Lacks Production Safeguards and Wipes Production D1 When `CI` Is Set or `--force` Is Passed

- **Severity:** **P0 (Critical)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [demo-reset.mjs](file:///d:/Burrow-private-public/Burrow/scripts/demo-reset.mjs#L36-L44)
  - [demo-reset.mjs](file:///d:/Burrow-private-public/Burrow/scripts/demo-reset.mjs#L77-L94)
  - [demo-reset.mjs](file:///d:/Burrow-private-public/Burrow/scripts/demo-reset.mjs#L186-L255)
  - [demo-reset.yml](file:///d:/Burrow-private-public/Burrow/.github/workflows/demo-reset.yml#L41-L42)
- **Root Cause:**
  Commit `d080d24` added `PRODUCTION_RESET_CONFIRMATION_TOKEN` (`RESET-PRODUCTION-BURROW`) to `scripts/reset.mjs` and `PRODUCTION_TEARDOWN_CONFIRMATION_TOKEN` (`DELETE-PRODUCTION-BURROW`) to `scripts/teardown.mjs`, and blocked `--force` in non-interactive mode on production. However, `scripts/demo-reset.mjs` was not given any production confirmation token or staging-only restriction. Worse, line 40 sets:
  ```js
  const force = hasFlag('--force') || Boolean(process.env.CI);
  ```
  And lines 193–202 skip the interactive prompt whenever `force` is truthy:
  ```js
  if (!force) {
    const answer = await ask(`  Wipe all data in "${targetLabel}" and re-seed demo data? [y/N]: `);
    ...
  }
  ```
  Then lines 242–255 call `reconcileAndApplyRemoteD1Migrations(..., { allowPreBaselineReset: true })` and execute `buildDemoSeedSql()`, which begins with `DELETE FROM project_files; DELETE FROM edit_locks; ... DELETE FROM "user";` against `profile.dbName` (which defaults to production `'burrow'`). Additionally, `buildDemoSeedSql()` (`lines 77-94`) interpolates `demoEmail` directly into raw SQL strings (`'${demoEmail}'`) without escaping single quotes.
- **Evidence:**
  - `scripts/demo-reset.mjs:40`: `const force = hasFlag('--force') || Boolean(process.env.CI);`
  - `scripts/demo-reset.mjs:186`: `const profile = resolveRemoteProfile({ env, defaultWorkerName: 'burrow' });`
  - `scripts/demo-reset.mjs:249`: `const seedSql = buildDemoSeedSql({ demoEmail, demoPasswordHash, nowSec, nowMs });`
- **Safe Reproduction Steps:**
  Inspect `scripts/demo-reset.mjs:36-44, 186-255` or run in a mocked test harness with `CI=true` and `--remote`: `demo-reset.mjs` resolves `profile.workerName = 'burrow'`, `profile.dbName = 'burrow'`, bypasses `ask()`, and invokes `wrangler d1 execute burrow --remote` with full table `DELETE` statements. *(Do not execute against live Cloudflare).*
- **User Impact:**
  Running `pnpm run demo:reset -r` inside any CI environment, automated coding agent (`CI=1`), or with `--force` against a production Cloudflare account **permanently destroys all production database rows** and creates a known-password Owner account (`demo@osscafe.com` / `demopassword123`) on the live production instance.
- **Recommended Minimal Fix:**
  1. Require an explicit `--confirm-production-reset=RESET-PRODUCTION-BURROW` token whenever `demo-reset.mjs` targets production `burrow` (or restrict `demo-reset.mjs` strictly to non-production/demo profiles), and remove automatic `Boolean(process.env.CI)` bypasses for production targets.
  2. Escape single quotes in `demoEmail` (`demoEmail.replace(/'/g, "''")`) and validate email format before building SQL.
- **Suggested Regression Test:**
  Add a unit test in `tests/unit/cloudflare-deploy.test.ts` verifying that `demo-reset.mjs --remote` with `CI=true` or `--force` throws before executing any Wrangler command when targeting production `burrow` without an explicit confirmation token.

---

### `FINDING-002` — Cross-Environment Guard Bypass via `--staging --name=burrow` Allows Unconfirmed Production Teardown or Rebinding

- **Severity:** **P0 (Critical)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [lib.mjs](file:///d:/Burrow-private-public/Burrow/scripts/lib.mjs#L106-L137)
  - [teardown.mjs](file:///d:/Burrow-private-public/Burrow/scripts/teardown.mjs#L90-L141)
  - [setup.mjs](file:///d:/Burrow-private-public/Burrow/scripts/setup.mjs#L52)
  - [deploy.mjs](file:///d:/Burrow-private-public/Burrow/scripts/deploy.mjs#L33)
- **Root Cause:**
  In `resolveRemoteProfile()` (`scripts/lib.mjs:107-115`):
  ```js
  const workerName = explicitName || (isStaging ? `${baseWorkerName}-staging` : baseWorkerName);
  const dbName = isStaging ? `${baseWorkerName}-staging` : baseWorkerName;
  const bucketName = isStaging ? `${baseWorkerName}-staging-files` : `${baseWorkerName}-files`;
  ```
  While lines 121–126 reject attaching the production custom domain to staging, there is **no check rejecting `workerName === baseWorkerName` when `isStaging === true`**.
  Because `teardown.mjs:98`, `reset.mjs:97`, `setup.mjs`, and `deploy.mjs` branch on `if (!profile.isStaging)` to enforce production confirmation tokens (`DELETE-PRODUCTION-BURROW`), passing `--staging --force --name=burrow` sets `profile.isStaging = true` and `profile.workerName = 'burrow'`.
- **Evidence:**
  In `scripts/teardown.mjs:124-140`:
  - `profile.isStaging` is `true`, so the `!profile.isStaging` block (`lines 98-123`) is skipped.
  - `force` (`--force`) is allowed because `profile.isStaging` is `true` (`line 124`).
  - Line 140 executes: `wrangler(['delete', profile.workerName, '--force'])` → `wrangler delete burrow --force`.
  Similarly, `node scripts/setup.mjs -r --staging --name=burrow` writes `name = "burrow"` into `wrangler.staging.local.jsonc` and deploys the staging configuration (bound to `burrow-staging` D1 and `burrow-staging-files` R2) over the live production Worker `burrow`.
- **Safe Reproduction Steps:**
  In Node:
  ```js
  import { resolveRemoteProfile } from './scripts/lib.mjs';
  console.log(resolveRemoteProfile({ args: ['--staging', '--name=burrow'], env: {} }));
  // Outputs: { environment: 'staging', isStaging: true, workerName: 'burrow', ... }
  ```
- **User Impact:**
  A command-line combination (`--staging --name=burrow`) completely bypasses production teardown protection and deletes or overwrites the production Cloudflare Worker without confirmation.
- **Recommended Minimal Fix:**
  In `resolveRemoteProfile()` (`scripts/lib.mjs:108`), enforce that when `isStaging` is `true`, `workerName` cannot equal `baseWorkerName` (must remain isolated from production resource names; likewise when `!isStaging`, `workerName` cannot end with `-staging`).
- **Suggested Regression Test:**
  In `tests/unit/cloudflare-deploy.test.ts`, assert that `resolveRemoteProfile({ args: ['--staging', '--name=burrow'], env: {} })` throws `/Cannot target production worker name "burrow" in staging mode/`.

---

### `FINDING-003` — `docker-compose.yml` Hardcodes Public Fallback Secrets Accepted by Production Validator, While `.env.example` Causes Production Container Crash Loop

- **Severity:** **P0 (Critical)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [docker-compose.yml](file:///d:/Burrow-private-public/Burrow/docker-compose.yml#L10-L30)
  - [.env.example](file:///d:/Burrow-private-public/Burrow/.env.example#L17-L24)
  - [config.ts](file:///d:/Burrow-private-public/Burrow/src/server/config.ts#L36-L70)
  - [auth.ts](file:///d:/Burrow-private-public/Burrow/src/core/adapters/auth.ts#L38-L49)
  - [README.md](file:///d:/Burrow-private-public/Burrow/README.md#L10)
  - [README.md](file:///d:/Burrow-private-public/Burrow/README.md#L97-L102)
  - [DEPLOYMENT_AND_UPGRADES.md](file:///d:/Burrow-private-public/Burrow/docs/DEPLOYMENT_AND_UPGRADES.md#L188-L193)
- **Root Cause:**
  1. **Public fallback secrets bypass production secret validation:**
     `docker-compose.yml:16-18` sets:
     ```yaml
     BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-burrow-selfhost-secret-key-32-bytes-minimum!!}
     BOOTSTRAP_TOKEN: ${BOOTSTRAP_TOKEN:-burrow-bootstrap-token-initial-setup}
     ```
     `src/server/config.ts:36-44` checks `INSECURE_SECRET_PLACEHOLDERS = new Set(['dev-secret-change-me-32-bytes-minimum!!', 'local-dev-secret-change-me'])` and `INSECURE_BOOTSTRAP_PLACEHOLDERS = new Set(['dev-bootstrap-token', 'test-bootstrap-token'])`. Neither fallback value from `docker-compose.yml` is in the denylist, and `burrow-selfhost-secret-key-32-bytes-minimum!!` is 45 characters (`>= 32`). Thus, running `docker compose up -d` without setting those variables boots a `NODE_ENV=production` instance with publicly committed signing and bootstrap secrets.
  2. **README Docker Quick Start crashes on startup:**
     `README.md:97-99` instructs users to copy `.env.example` to `.env` and run `docker compose up -d --build`. `.env.example:20` sets `BETTER_AUTH_URL=http://localhost:3005`, and `docker-compose.yml:15` sets `BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:3005}` with `NODE_ENV: production` (`line 10`). However, `loadConfig()` in `src/server/config.ts:67-69` throws:
     ```ts
     if (parsedAuthUrl.hostname === 'localhost' || parsedAuthUrl.hostname === '127.0.0.1') {
       throw new Error('BETTER_AUTH_URL cannot point to localhost or 127.0.0.1 in production');
     }
     ```
     Every self-hoster evaluating Docker Compose locally on `http://localhost:3005` hits an immediate startup crash loop.
  3. **README / Compose Mismatches:**
     - `README.md:10` links to `./compose.yaml` (file does not exist; actual file is `docker-compose.yml`) and claims `PostgreSQL 17` (`README.md:10, 102`), whereas `docker-compose.yml:30` uses `postgres:16-alpine`.
     - `docs/DEPLOYMENT_AND_UPGRADES.md:188-193` instructs running `docker compose exec -T db pg_dump ...` and `docker compose stop app`, whereas the services in `docker-compose.yml` are named `postgres` and `burrow`.
- **Evidence:**
  Verified directly in `docker-compose.yml:10-30`, `.env.example:17-24`, `src/server/config.ts:36-70`, and `docs/DEPLOYMENT_AND_UPGRADES.md:188-193`.
- **Safe Reproduction Steps:**
  Run `loadConfig()` in `tests/unit/env.test.ts` with `NODE_ENV=production`, `BETTER_AUTH_SECRET='burrow-selfhost-secret-key-32-bytes-minimum!!'`, `BOOTSTRAP_TOKEN='burrow-bootstrap-token-initial-setup'`, `BETTER_AUTH_URL='https://example.com'` (passes validation with public secrets!), and then with `BETTER_AUTH_URL='http://localhost:3005'` (throws `BETTER_AUTH_URL cannot point to localhost or 127.0.0.1 in production`).
- **User Impact:**
  Self-hosters either deploy with publicly known `BETTER_AUTH_SECRET` / `BOOTSTRAP_TOKEN` (allowing session forgery and initial Owner takeover) or experience an immediate crash loop when following the README Docker Quick Start on `localhost:3005`.
- **Recommended Minimal Fix:**
  1. Add `'burrow-selfhost-secret-key-32-bytes-minimum!!'` and `'burrow-bootstrap-token-initial-setup'` to `INSECURE_SECRET_PLACEHOLDERS` / `INSECURE_BOOTSTRAP_PLACEHOLDERS` in `src/server/config.ts` and `src/core/adapters/auth.ts`, and remove default secret fallbacks from `docker-compose.yml` (`${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET in .env}`).
  2. Allow `http://localhost:<port>` / `http://127.0.0.1:<port>` for local self-hosted Docker evaluation (or document/warn cleanly instead of hard-crashing when `BETTER_AUTH_URL` is intentionally set to `localhost`).
  3. Fix `README.md` link (`./docker-compose.yml`), PostgreSQL image (`postgres:17-alpine` or update badge), and service names (`postgres` / `burrow`) in `docs/DEPLOYMENT_AND_UPGRADES.md`.
- **Suggested Regression Test:**
  Add unit tests in `tests/unit/env.test.ts` verifying that `burrow-selfhost-secret-key-32-bytes-minimum!!` and `burrow-bootstrap-token-initial-setup` are rejected in production.

---

### `FINDING-004` — `pnpm check` Fails with Exit Code 1 Due to 7 ESLint Warnings in `src/server/index.ts`, and No CI Pipeline Enforces Checks

- **Severity:** **P1 (High)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [index.ts](file:///d:/Burrow-private-public/Burrow/src/server/index.ts#L113-L130)
  - [check.mjs](file:///d:/Burrow-private-public/Burrow/scripts/check.mjs#L19-L29)
  - [.github/workflows/demo-reset.yml](file:///d:/Burrow-private-public/Burrow/.github/workflows/demo-reset.yml)
- **Root Cause:**
  `scripts/check.mjs:21` runs `pnpm exec eslint . --max-warnings=0`. However, `src/server/index.ts:113-130` contains 7 `console.log(...)` calls without an `eslint-disable` comment, triggering 7 `no-console` warnings (`Only these console methods are allowed: warn, error`). Because there is no GitHub Actions CI workflow running `pnpm check` on pushes or pull requests (`.github/workflows/` only contains `demo-reset.yml`), this failure went undetected.
- **Evidence:**
  Command output from `pnpm exec eslint . --max-warnings=0`:
  ```text
  D:\Burrow-private-public\Burrow\src\server\index.ts
    113:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
    114:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
    115:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
    116:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
    119:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
    122:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
    130:3  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console

  ✖ 7 problems (0 errors, 7 warnings)
  ESLint found too many warnings (maximum: 0).
  ```
- **Safe Reproduction Steps:**
  Run `pnpm exec eslint . --max-warnings=0` or `pnpm check` in `d:\Burrow-private-public\Burrow`.
- **User Impact:**
  The repository's primary quality gate (`pnpm check`) fails out of the box, and regressions can be merged to `master` without automated CI verification.
- **Recommended Minimal Fix:**
  1. Add `/* eslint-disable no-console */` to the startup/shutdown log statements in `src/server/index.ts` (or allow `no-console` in `src/server/index.ts` in `eslint.config.js`).
  2. Add `.github/workflows/ci.yml` to run `pnpm check` on every push and pull request.
- **Suggested Regression Test:**
  Enforce `pnpm check` in `.github/workflows/ci.yml`.

---

### `FINDING-005` — Orphaned Storage Objects on Permanent Notepad Deletion, Project Deletion Partial Failure, and Remote Database Reset

- **Severity:** **P1 (High)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [notepads.ts](file:///d:/Burrow-private-public/Burrow/src/core/services/notepads.ts#L358-L373)
  - [notepad.ts (D1)](file:///d:/Burrow-private-public/Burrow/src/core/adapters/db/d1/repositories/notepad.ts#L277-L331)
  - [projects.ts](file:///d:/Burrow-private-public/Burrow/src/core/services/projects.ts#L187-L237)
  - [reset.mjs](file:///d:/Burrow-private-public/Burrow/scripts/reset.mjs#L149-L154)
  - [demo-reset.mjs](file:///d:/Burrow-private-public/Burrow/scripts/demo-reset.mjs#L249-L255)
- **Root Cause:**
  1. **Notepad permanent deletion ignores returned storage keys:**
     `repos.notepads.hardDelete()` (`src/core/adapters/db/d1/repositories/notepad.ts:277-331` and `postgres/repositories/notepad.ts:255-304`) queries and returns `HardDeletedNotepad[]` (`{ id, coverKey }`). Yet in `NotepadService.permanentDeleteNotepad()` (`src/core/services/notepads.ts:369-372`):
     ```ts
     const removed = await this.repos.notepads.hardDelete(args.notepadId, {
       workspaceId: args.workspaceId, projectId: args.projectId, actorUserId: args.actorUserId, minimumRole: 'owner',
     });
     if (removed === null) throw forbidden('forbidden', 'Owner access changed while deleting the notepad');
     ```
     `removed` is never iterated to delete `coverKey` from storage or `project_files`, leaving files orphaned in R2/S3/local storage and consuming project quota forever.
  2. **Project permanent deletion deletes DB rows before storage objects:**
     In `ProjectService.permanentDeleteProject()` (`src/core/services/projects.ts:187-237`), `this.repos.projects.hardDeleteGuarded()` deletes the project and cascades `project_files` rows in the database *first*, and then loops over `coverKeys` calling `this.storage!.delete(key)` via `Promise.allSettled`. If R2/S3 returns a transient error or the Worker invocation terminates early, the `project_files` records are already gone from the database, permanently orphaning the R2/S3 objects.
  3. **Remote D1 resets (`reset.mjs` / `demo-reset.mjs`) do not clean up R2:**
     `scripts/reset.mjs:149-154` and `scripts/demo-reset.mjs:249-255` execute `DELETE FROM project_files;` in remote D1, but never delete the objects from the remote R2 bucket (`burrow-files` / `burrow-staging-files`).
- **Evidence:**
  Inspect `src/core/services/notepads.ts:108-116, 358-373` (`NotepadService` does not accept `storage` or `projectFiles` in its constructor) and `scripts/reset.mjs:149-154`.
- **Safe Reproduction Steps:**
  1. Upload a cover image (`POST /api/workspaces/:w/projects/:p/files`), attach `coverKey` to a notepad, soft-delete the notepad, and call `DELETE /api/workspaces/:w/projects/:p/notepads/:id/permanent`.
  2. Inspect R2/local storage and `project_files`: the cover file remains in storage and `project_files`.
- **User Impact:**
  Deleted notepads and reset environments accumulate orphaned objects in R2/S3/local storage, inflating storage usage and permanently exhausting the 1 GB project storage quota (`PROJECT_STORAGE_QUOTA_BYTES`).
- **Recommended Minimal Fix:**
  1. Pass `storage` cleanup into `NotepadService.permanentDeleteNotepad()` to delete unreferenced `coverKey` objects.
  2. In `scripts/reset.mjs` and `scripts/demo-reset.mjs`, warn or purge objects in `profile.bucketName` when resetting a remote environment.
- **Suggested Regression Test:**
  Add a test in `tests/api/notepads-lifecycle.test.ts` verifying that permanently deleting a trashed notepad with a cover image removes or reconciles its storage object.

---

### `FINDING-006` — Cloudflare Worker Entrypoint (`src/worker/index.ts`) and `buildSecretPlan` Drop OAuth (`GOOGLE_*`, `GITHUB_*`) and `SELF_UPDATE_WEBHOOK_URL`

- **Severity:** **P1 (High)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [index.ts (Worker)](file:///d:/Burrow-private-public/Burrow/src/worker/index.ts#L5-L29)
  - [index.ts (D1 Infrastructure)](file:///d:/Burrow-private-public/Burrow/src/core/adapters/db/d1/index.ts#L21-L35)
  - [lib.mjs](file:///d:/Burrow-private-public/Burrow/scripts/lib.mjs#L700-L737)
  - [README.md](file:///d:/Burrow-private-public/Burrow/README.md#L148)
  - [DEPLOYMENT_AND_UPGRADES.md](file:///d:/Burrow-private-public/Burrow/docs/DEPLOYMENT_AND_UPGRADES.md#L155-L156)
- **Root Cause:**
  `createD1Infrastructure(db, env)` (`src/core/adapters/db/d1/index.ts:21-35`) accepts `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SELF_UPDATE_WEBHOOK_URL`. However, `createWorkerApp(env)` in `src/worker/index.ts:20-27` constructs an inline object containing only 6 properties:
  ```ts
  const infrastructure = createD1Infrastructure(db, {
    FILES: env.FILES,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BOOTSTRAP_TOKEN: env.BOOTSTRAP_TOKEN,
    RESEND_API_KEY: env.RESEND_API_KEY,
    EMAIL_FROM: env.EMAIL_FROM,
  });
  ```
  It never passes `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, or `SELF_UPDATE_WEBHOOK_URL` from `env`. Furthermore, `WorkerEnv` in `src/worker/index.ts:5-14` does not declare them, and `buildSecretPlan()` in `scripts/lib.mjs:700-737` never uploads them to Cloudflare Workers during `pnpm run setup -r`.
- **Evidence:**
  Compare `src/worker/index.ts:20-27` with `src/core/adapters/db/d1/index.ts:21-35` and `docs/DEPLOYMENT_AND_UPGRADES.md:155-156`.
- **Safe Reproduction Steps:**
  Call `createWorkerApp({ ...env, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })` and request `GET /api/auth/config`: `oauthProviders` returns `[]` instead of `[{ id: 'google', name: 'Google', kind: 'social' }]`.
- **User Impact:**
  Google OAuth, GitHub OAuth, and `SELF_UPDATE_WEBHOOK_URL` silently do not work on Cloudflare Workers deployments, contradicting `README.md:148` and `docs/DEPLOYMENT_AND_UPGRADES.md:155-156`.
- **Recommended Minimal Fix:**
  Forward `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SELF_UPDATE_WEBHOOK_URL` in `src/worker/index.ts:20-27`, add them to `WorkerEnv`, and include optional OAuth/webhook secrets in `buildSecretPlan()` (`scripts/lib.mjs`).
- **Suggested Regression Test:**
  Add a test in `tests/unit/auth-config.test.ts` calling `createWorkerApp(env)` with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` set on `env` and asserting `GET /api/auth/config` returns `oauthProviders` containing `'google'`.

---

### `FINDING-007` — Any Authenticated User (Including an Invited `viewer`) Can Trigger Instance-Wide `POST /api/system/update`

- **Severity:** **P1 (High)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [system.ts](file:///d:/Burrow-private-public/Burrow/src/core/routes/system.ts#L80-L136)
  - [workspaces.ts](file:///d:/Burrow-private-public/Burrow/src/core/routes/workspaces.ts#L48-L76)
- **Root Cause:**
  `POST /api/system/update` (`src/core/routes/system.ts:91-99`) checks whether the caller is an `'owner'` of *any* workspace:
  ```ts
  const userWorkspaces = await workspaces.listByUser(identity.userId);
  const isOwner = userWorkspaces.some((w) => w.role === 'owner');
  ```
  However, `POST /api/workspaces` (`src/core/routes/workspaces.ts:48-76`) allows **any** authenticated user—including a user invited only as a `viewer` to another user's workspace—to create a personal workspace where they are assigned `role: 'owner'`. Once they create a workspace, `userWorkspaces.some((w) => w.role === 'owner')` evaluates to `true`, allowing them to trigger the instance-wide `SELF_UPDATE_WEBHOOK_URL`.
- **Evidence:**
  Inspect `src/core/routes/system.ts:91-99` and `src/core/routes/workspaces.ts:48-76`.
- **Safe Reproduction Steps:**
  1. Invite a user as `viewer` to Workspace A.
  2. As that `viewer`, call `POST /api/workspaces` with `{ "name": "Temp" }` (returns `201`).
  3. Call `POST /api/system/update` as that user: authorization passes (`isOwner === true`) and triggers `SELF_UPDATE_WEBHOOK_URL`.
- **User Impact:**
  Privilege escalation from workspace `viewer` to instance-level system update trigger.
- **Recommended Minimal Fix:**
  Verify that `identity.userId` matches the instance bootstrap owner (`bootstrap_state.user_id`) or is an `'owner'` of the initial bootstrap workspace (`bootstrap_state.workspace_id`) before allowing `POST /api/system/update`.
- **Suggested Regression Test:**
  In `tests/unit/system-version.test.ts`, verify that a non-bootstrap user who creates a secondary workspace still receives `403 Forbidden` on `POST /api/system/update`.

---

### `FINDING-008` — 100 MB In-Memory Upload Buffering Exceeds Cloudflare Worker 128 MB RAM Limit, and `bodyLimit` Only Checks `Content-Length` Header

- **Severity:** **P1 (High)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [security.ts](file:///d:/Burrow-private-public/Burrow/src/core/middleware/security.ts#L26-L45)
  - [project-files.ts](file:///d:/Burrow-private-public/Burrow/src/core/routes/project-files.ts#L82-L115)
  - [uploadPolicy.ts](file:///d:/Burrow-private-public/Burrow/src/shared/uploadPolicy.ts#L1)
- **Root Cause:**
  1. `MAX_UPLOAD_BYTES` is set to `100 * 1024 * 1024` (100 MB) (`src/shared/uploadPolicy.ts:1`). In `POST /api/workspaces/:workspaceId/projects/:projectId/files` (`src/core/routes/project-files.ts:82, 107`), the route parses the full multipart body into memory via `await c.req.formData()` and then allocates a second buffer via `const bytes = new Uint8Array(await file.arrayBuffer())`. A 70–100 MB upload requires 140–250+ MB of heap memory inside the V8 isolate, exceeding the 128 MB Cloudflare Worker memory limit.
  2. `bodyLimit()` (`src/core/middleware/security.ts:26-45`) only inspects `c.req.header('content-length')`. If a request uses chunked transfer encoding without a `Content-Length` header, `bodyLimit()` does not cap the stream size before `c.req.json()` or `c.req.formData()` buffers the body into memory.
- **Evidence:**
  - `src/core/middleware/security.ts:35`: `const contentLength = c.req.header('content-length'); if (contentLength) { ... }`
  - `src/core/routes/project-files.ts:82`: `const formData = await c.req.formData();`
  - `src/core/routes/project-files.ts:107`: `const bytes = new Uint8Array(await file.arrayBuffer());`
- **Safe Reproduction Steps:**
  Send a POST request to `/api/workspaces/:w/invites` with a 3 MB body and no `Content-Length` header: `bodyLimit` allows the request through instead of returning `413`.
- **User Impact:**
  Large file uploads (e.g., 65–100 MB) permitted by the UI/API policy crash the Cloudflare Worker with an out-of-memory error, and chunked requests bypass `bodyLimit`.
- **Recommended Minimal Fix:**
  1. Enforce byte-counting on `c.req.raw.body` stream in `bodyLimit`.
  2. Lower the Worker direct-upload limit (e.g., 25–50 MB) or stream/multipart-upload directly to R2 without double-buffering `formData()` + `arrayBuffer()`.
- **Suggested Regression Test:**
  Add a unit test in `src/core/middleware/security.test.ts` sending a >2 MB `ReadableStream` body without a `Content-Length` header and asserting `413 payload_too_large`.

---

### `FINDING-009` — Better Auth Rate Limiting Falls Back to a Single Shared Global Bucket Because Client IP Headers Are Not Configured

- **Severity:** **P1 (High)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [auth.ts](file:///d:/Burrow-private-public/Burrow/src/core/adapters/auth.ts#L76-L123)
  - [security.ts](file:///d:/Burrow-private-public/Burrow/src/core/middleware/security.ts#L58-L92)
- **Root Cause:**
  1. In `createAuthProvider()` (`src/core/adapters/auth.ts:118-122`), `rateLimit: { enabled: true, window: 60, max: 100 }` is enabled, but `advanced.ipAddress.ipAddressHeaders` is not configured. Consequently, Better Auth cannot resolve the client IP on Cloudflare Workers (`cf-connecting-ip`) or behind Docker reverse proxies (`x-forwarded-for`), and emits on auth requests:
     `WARN [Better Auth]: Rate limiting could not determine a client IP and is falling back to a single shared per-path bucket.`
     All users across the entire instance share a single 100-request/minute bucket per auth path (allowing any unauthenticated attacker to lock out all legitimate logins/session checks with 100 requests/minute). Conversely, on Cloudflare Workers, Better Auth's default in-memory rate-limit store resets across isolate evictions/colo routing.
  2. In `csrfProtection()` (`src/core/middleware/security.ts:68-73`), `const forwardedHost = c.req.header('x-forwarded-host'); const requestHost = forwardedHost || new URL(c.req.url).host;`. When running the Node.js server directly without a reverse proxy stripping `X-Forwarded-Host`, `X-Forwarded-Host` is trusted unconditionally. Also, if a cross-origin POST omits both `Sec-Fetch-Site` and `Origin`, `csrfProtection` allows the request (`lines 58-92`).
- **Evidence:**
  Observed repeatedly in `pnpm test` stderr output (`task-21.log`):
  `WARN [Better Auth]: Rate limiting could not determine a client IP and is falling back to a single shared per-path bucket.`
- **Safe Reproduction Steps:**
  Send 101 `POST /api/auth/sign-in/email` requests from any IP without `advanced.ipAddress.ipAddressHeaders` configured: the 101st request from a completely different user/IP is rate-limited (`429`) because all requests share one bucket.
- **User Impact:**
  Trivial global authentication Denial-of-Service (100 requests/minute blocks sign-in for all users).
- **Recommended Minimal Fix:**
  Configure `advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] } }` in `src/core/adapters/auth.ts` (when behind trusted proxy / Cloudflare) and compare `Origin` against the configured `BETTER_AUTH_URL` origin rather than unvalidated `X-Forwarded-Host`.
- **Suggested Regression Test:**
  Verify in `tests/api/security.test.ts` that auth requests with distinct `cf-connecting-ip` headers do not share a single rate-limit bucket and do not emit the Better Auth IP warning.

---

### `FINDING-010` — CLI Argument Parser Fails Open on Typos (`--stage`, `--env=stage`) and Boolean Value Syntax (`--staging=false`, `--force=false`)

- **Severity:** **P2 (Medium)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [lib.mjs](file:///d:/Burrow-private-public/Burrow/scripts/lib.mjs#L52-L70)
  - [lib.mjs](file:///d:/Burrow-private-public/Burrow/scripts/lib.mjs#L81-L137)
  - [database-target.ts](file:///d:/Burrow-private-public/Burrow/src/server/database-target.ts#L22-L39)
- **Root Cause:**
  1. `_hasFlagIn(args, flag)` (`scripts/lib.mjs:60-62`) uses `args.some((a) => a === flag || a.startsWith(`${flag}=`))`. Thus, `--staging=false` or `--force=false` returns **`true`**.
  2. `resolveRemoteProfile()` (`scripts/lib.mjs:85-90`) only checks `envFlag === 'staging'`. Any other value (e.g., `--env=stage`, `--env=dev`, `--stage`) silently evaluates `isStaging = false` and **targets `production`**.
  3. Conversely, if `BURROW_DEPLOY_ENV=staging` is set in `.env`, passing `--env=production` on the CLI is ignored because `|| env.BURROW_DEPLOY_ENV === 'staging'` still forces `isStaging = true`.
  4. `_argValueFrom(args, flag)` (`scripts/lib.mjs:52-58`) returns `undefined` when a value-taking flag (`--name`, `--domain`, `--env`) is the final token without a value (e.g., `node scripts/setup.mjs -r --domain`), silently falling back to `env.CLOUDFLARE_DOMAIN`.
- **Evidence:**
  Inspect `scripts/lib.mjs:52-90`.
- **Safe Reproduction Steps:**
  Call `resolveRemoteProfile({ args: ['--env=stage'], env: {} })` → returns `environment: 'production'`. Call `_hasFlagIn(['--force=false'], '--force')` → returns `true`.
- **User Impact:**
  A minor CLI typo (`--stage` or `--env=stage`) silently redirects a staging operation to production.
- **Recommended Minimal Fix:**
  Validate all CLI flags against an explicit allowlist per script, reject unknown flags with an error, validate `--env` is strictly `'production'` or `'staging'`, and parse `=false` / `=0` correctly in `_hasFlagIn`.
- **Suggested Regression Test:**
  Add unit tests in `tests/unit/cloudflare-deploy.test.ts` for `--env=stage`, `--stage`, `--force=false`, and `--env=production` overriding `BURROW_DEPLOY_ENV=staging`.

---

### `FINDING-011` — `scripts/inventory-storage.mjs` Hardcodes Production Database `'burrow'` and Ignores `--staging`

- **Severity:** **P2 (Medium)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [inventory-storage.mjs](file:///d:/Burrow-private-public/Burrow/scripts/inventory-storage.mjs#L74-L81)
- **Root Cause:**
  In `scripts/inventory-storage.mjs:74-81`, `wranglerStorageArgs(args, env)` resolves `profile` via `resolveRemoteProfile`, which returns `d1Args: ['--remote', '--config', 'wrangler.staging.local.jsonc']` when `--staging` is passed. However, line 80 hardcodes `'burrow'` as the D1 database name:
  ```js
  ['d1', 'execute', 'burrow', ...d1Args, '--file', sqlFile, '--json']
  ```
  Because `wrangler.staging.local.jsonc` defines `database_name: "burrow-staging"` (not `"burrow"`), running `pnpm inventory:storage -- --remote --staging` fails or queries the wrong database.
- **Evidence:**
  Inspect `scripts/inventory-storage.mjs:80`.
- **Safe Reproduction Steps:**
  Inspect `scripts/inventory-storage.mjs:74-81` with `--remote --staging`.
- **User Impact:**
  Storage inventory verification cannot be run against remote staging D1 (`burrow-staging`).
- **Recommended Minimal Fix:**
  Export `dbName` from `wranglerStorageArgs()` and pass `dbName` instead of hardcoded `'burrow'` on line 80.
- **Suggested Regression Test:**
  Add a unit test in `tests/unit/storage-inventory.test.ts` verifying `wranglerStorageArgs(['--remote', '--staging'], {})` uses `dbName: 'burrow-staging'`.

---

### `FINDING-012` — `bootstrap_state` Permanently Locks to `claim_email` Before Account Creation Without Expiry or Self-Service Release on Mistyped Email

- **Severity:** **P2 (Medium)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [app.ts](file:///d:/Burrow-private-public/Burrow/src/core/app.ts#L358-L443)
  - [bootstrap-cases.ts](file:///d:/Burrow-private-public/Burrow/tests/adapters/bootstrap-cases.ts#L1-L90)
  - [BOOTSTRAP_RECOVERY.md](file:///d:/Burrow-private-public/Burrow/docs/BOOTSTRAP_RECOVERY.md#L29-L65)
- **Root Cause:**
  During initial signup (`POST /api/auth/sign-up/email`), if the request provides the valid `BOOTSTRAP_TOKEN`, `claimBootstrap(email)` sets `status = 'claimed'` and `claim_email = email` in `bootstrap_state`. While `POST /api/auth/bootstrap/recover` (`src/core/app.ts:413-443`) allows the authenticated user matching `claim_email` to complete bootstrap if workspace creation failed after account creation, if the initial operator mistyped their email or loses access before completing workspace creation (or attempts signup with a corrected email), `bootstrap_state` remains permanently locked to `claim_email` with no TTL and no CLI command to release the claim.
- **Evidence:**
  Inspect `src/core/app.ts:375-443` and `docs/BOOTSTRAP_RECOVERY.md:29-65`.
- **Safe Reproduction Steps:**
  Claim bootstrap with email `typo@example.com` and succeed at user creation, then lose the session or attempt initial signup with `correct@example.com` and the valid `BOOTSTRAP_TOKEN`: `claimBootstrap` returns `false` (`409 bootstrap_unavailable`).
- **User Impact:**
  Requires manual SQL intervention (`docs/BOOTSTRAP_RECOVERY.md`) if the initial bootstrap claim gets stuck or was claimed with a typo.
- **Recommended Minimal Fix:**
  Provide a `pnpm run bootstrap:release` CLI script or allow replacing an uncompleted `'claimed'` email when presenting the valid `BOOTSTRAP_TOKEN` (while `status !== 'completed'`).
- **Suggested Regression Test:**
  Add a test in `tests/api/bootstrap-recovery.test.ts` covering recovery when the claimed email had a typo before workspace completion.

---

### `FINDING-013` — Direct Wrangler Commands in `package.json` and Docs Fail Because `wrangler.jsonc` Omits `database_id`

- **Severity:** **P2 (Medium)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [package.json](file:///d:/Burrow-private-public/Burrow/package.json#L38)
  - [wrangler.jsonc](file:///d:/Burrow-private-public/Burrow/wrangler.jsonc#L11-L17)
  - [DEPLOYMENT_AND_UPGRADES.md](file:///d:/Burrow-private-public/Burrow/docs/DEPLOYMENT_AND_UPGRADES.md#L170-L177)
  - [deploy.mjs](file:///d:/Burrow-private-public/Burrow/scripts/deploy.mjs#L120-L127)
- **Root Cause:**
  Commit `d080d24` removed `database_id` from tracked `wrangler.jsonc` (`lines 11-17`) and moved it to gitignored `wrangler.local.jsonc` / `wrangler.staging.local.jsonc`. However:
  1. `docs/DEPLOYMENT_AND_UPGRADES.md:170-177` instructs operators to run `pnpm exec wrangler d1 time-travel info burrow --remote`, `pnpm exec wrangler d1 export burrow --remote ...`, and `pnpm exec wrangler d1 time-travel restore burrow ...` without `--config wrangler.local.jsonc`.
  2. `package.json:38` defines `"logs": "wrangler tail"`, which reads `wrangler.jsonc` instead of supporting `wrangler.local.jsonc` / `wrangler.staging.local.jsonc`.
  3. `scripts/deploy.mjs:123-126` appends Time Travel bookmarks (`${ts}  ${JSON.stringify(bookmark)}`) to `.deploy-log/rollbacks.log` without recording `profile.environment` (`production` vs `staging`) or `dbName`.
- **Evidence:**
  Inspect `wrangler.jsonc:11-17`, `docs/DEPLOYMENT_AND_UPGRADES.md:170-177`, and `scripts/deploy.mjs:123-126`.
- **Safe Reproduction Steps:**
  Compare `wrangler.jsonc` (no `database_id`) with the `wrangler d1` commands in `docs/DEPLOYMENT_AND_UPGRADES.md:170-177`.
- **User Impact:**
  Operators following the recovery documentation during an outage will run `wrangler d1` commands against `wrangler.jsonc` (missing `database_id`) or mix up staging and production Time Travel bookmarks in `.deploy-log/rollbacks.log`.
- **Recommended Minimal Fix:**
  Include `--config wrangler.local.jsonc` in `docs/DEPLOYMENT_AND_UPGRADES.md` commands, and tag `.deploy-log/rollbacks.log` entries with `[${profile.environment}:${dbName}]`.
- **Suggested Regression Test:**
  Verify rollback log format in `tests/unit/cloudflare-deploy.test.ts`.

---

### `FINDING-014` — Worker Tests Inherit `.env` OAuth/Webhook Bindings & API E2E Tests Do Not Cover PostgreSQL Runtime

- **Severity:** **P2 (Medium)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [vitest.config.ts](file:///d:/Burrow-private-public/Burrow/vitest.config.ts#L30-L50)
  - [vitest.config.ts](file:///d:/Burrow-private-public/Burrow/vitest.config.ts#L65-L76)
- **Root Cause:**
  1. In `vitest.config.ts:32-39`, `miniflare.bindings` explicitly resets `RESEND_API_KEY`, `EMAIL_FROM`, and `BOOTSTRAP_TOKEN`, but does not reset `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, or `SELF_UPDATE_WEBHOOK_URL`. Wrangler prints `Using secrets defined in .env` across worker test runs and passes any other `.env` secrets into `env`.
  2. While `tests/adapters/*-node.test.ts` (`database` project) executes repository contract tests against disposable Docker `postgres:17`, the HTTP API end-to-end suite (`tests/api/*.test.ts`) runs only against the Miniflare/D1 Worker app (`createWorkerApp`), leaving the Node HTTP server + `postgres` runtime (`src/server/index.ts` + `src/core/adapters/db/postgres/index.ts`) without full HTTP API end-to-end test execution.
- **Evidence:**
  Observed `Using secrets defined in .env` throughout `pnpm test` (`task-21.log`) and inspected `vitest.config.ts:30-76`.
- **Safe Reproduction Steps:**
  Set `SELF_UPDATE_WEBHOOK_URL` or OAuth vars in `.env` and run `pnpm test`: Miniflare loads `.env` (`Using secrets defined in .env`) into `worker` test environments.
- **User Impact:**
  Developer `.env` configuration can leak into `worker` test execution, and Node/PostgreSQL HTTP request wiring has no automated API-level integration suite.
- **Recommended Minimal Fix:**
  Explicitly set `GOOGLE_CLIENT_ID: ''`, `GOOGLE_CLIENT_SECRET: ''`, `GITHUB_CLIENT_ID: ''`, `GITHUB_CLIENT_SECRET: ''`, and `SELF_UPDATE_WEBHOOK_URL: ''` in `vitest.config.ts` `miniflare.bindings`, and add at least one HTTP smoke test against `createCoreApp(createPostgresInfrastructure(...))`.
- **Suggested Regression Test:**
  Verify `createCoreApp(createPostgresInfrastructure(...))` serves `/api/health`, signup/login, and workspace CRUD cleanly in `tests/adapters/node-setup.ts`.

---

### `FINDING-015` — Unauthenticated `GET /api/invites/info/:token` Exposes `userExists` Account Enumeration Flag

- **Severity:** **P3 (Low)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [app.ts](file:///d:/Burrow-private-public/Burrow/src/core/app.ts#L220-L234)
  - [invites.ts](file:///d:/Burrow-private-public/Burrow/src/core/services/invites.ts#L66-L89)
- **Root Cause:**
  `GET /api/invites/info/:token` is an unauthenticated public endpoint that returns `{ valid, token, email, role, workspaceId, workspaceName, userExists, expiresAt }`. While gated by a random invite token, there is no rate limiting on `/api/invites/info/:token` (Better Auth rate limiting only applies to `/api/auth/*`).
- **Evidence:**
  Inspect `src/core/app.ts:220-234` and `src/core/services/invites.ts:66-89`.
- **Safe Reproduction Steps:**
  Request `GET /api/invites/info/<valid-token>` without cookies: response includes `email` and `userExists: true | false`.
- **User Impact:**
  Low risk due to token entropy, but leaked or shared invite URLs reveal whether the invited email address already has an account on the instance.
- **Recommended Minimal Fix:**
  Add rate limiting to `/api/invites/*` routes.
- **Suggested Regression Test:**
  Verify throttling on repeated `/api/invites/info/:token` requests.

---

### `FINDING-016` — `listByProject()` Over-Fetches Full BlockNote `content` Column for Every Notepad When Building the Sidebar Tree

- **Severity:** **P3 (Low)**
- **Confidence Level:** **Confirmed**
- **Affected Files & Lines:**
  - [notepad.ts (D1)](file:///d:/Burrow-private-public/Burrow/src/core/adapters/db/d1/repositories/notepad.ts#L75-L92)
  - [notepad.ts (Postgres)](file:///d:/Burrow-private-public/Burrow/src/core/adapters/db/postgres/repositories/notepad.ts#L56-L71)
  - [project-resources.ts](file:///d:/Burrow-private-public/Burrow/src/core/routes/project-resources.ts#L181-L196)
- **Root Cause:**
  `GET /api/workspaces/:wid/projects/:pid/notepads` (`src/core/routes/project-resources.ts:181-196`) only returns metadata (`{ id, parentId, title, icon, position, isFavorite }`). However, both `d1/repositories/notepad.ts:78-90` and `postgres/repositories/notepad.ts:58-70` implement `listByProject()` using `db.select().from(notepads)` (`SELECT *`), fetching the full `content` JSON column (up to 1 MB per document) for every live notepad in the project from D1/PostgreSQL into Worker/Node memory and discarding it in JavaScript. *(Note: D1 query count and `IN (...)` parameter chunking in saves are properly bounded via `chunkByParamBudget` and verified in `tests/api/notepad-query-budget.contract.test.ts`.)*
- **Evidence:**
  Inspect `src/core/adapters/db/d1/repositories/notepad.ts:75-92` and `src/core/routes/project-resources.ts:181-196`.
- **Safe Reproduction Steps:**
  Create 200 notepads with 500 KB JSON bodies each in a project and call `GET /api/workspaces/:wid/projects/:pid/notepads`: D1/PostgreSQL reads ~100 MB of `content` rows into isolate memory just to serialize titles and positions.
- **User Impact:**
  Projects with many large documents can hit Cloudflare Worker 128 MB memory limits or high D1 rows-read/egress overhead simply loading the project sidebar.
- **Recommended Minimal Fix:**
  Add a metadata projection in `listByProject()` (or `listTreeByProject()`) that omits the `content` column.
- **Suggested Regression Test:**
  Verify in `tests/api/notepad-query-budget.contract.test.ts` that `GET .../notepads` does not select the `content` column.

---

## 4. Testing Evidence

### Commands Executed & Environment

- **Operating System:** Windows (PowerShell, Node.js / `pnpm`, Docker Engine)
- **Working Directory:** `d:\Burrow-private-public\Burrow`
- **Production Safety Guarantee:** Zero commands were executed with `--remote` against Cloudflare D1/R2/Workers. Production Worker `burrow` (`burrow.osscafe.com`) and D1 database `6f5a2f2a-7b27-4aef-a37a-43cbf12a0750` were untouched.

| Command Executed | Exit Code | Result Summary |
| :--- | :---: | :--- |
| `git status --short --branch` | `0` | `## master...origin/master [ahead 3]` (clean working tree, 0 modified/untracked files) |
| `git status --ignored -s` | `0` | Verified `.env`, `.tsbuild/`, `.wrangler/`, `dist/`, `node_modules/`, `wrangler.local.jsonc`, `wrangler.staging.local.jsonc` are properly gitignored |
| `git show --stat 38d845c` | `0` | Verified 9 files changed (docs + 6 PNG screenshots only) |
| `git show --stat d080d24` | `0` | Verified 8 files changed (`scripts/*`, `.gitignore`, `wrangler.jsonc`, `tests/unit/cloudflare-deploy.test.ts`) |
| `pnpm test` (`vitest run`) | `0` | **`132 passed (132)` test files, `724 passed (724)` tests, `0` failed, `0` skipped** (Duration: `348.52s`, including Miniflare D1/R2 and disposable Docker `postgres:17`) |
| `pnpm exec tsc --noEmit` | `0` | TypeScript compilation succeeded with 0 errors |
| `pnpm exec eslint . --max-warnings=0` | **`1`** | **FAILED:** `7 warnings` (`no-console` in `src/server/index.ts:113-130`) |
| `node scripts/check-decoupling.mjs` | `0` | `check: decoupling OK (398 files scanned, 0 violations, 8 allowlisted)` |
| `node scripts/check-licenses.mjs` | `0` | `check: licenses OK (418 packages scanned, 0 violations, 0 allowlisted)` |
| `node scripts/check-basalt.mjs` | `0` | `check: basalt OK` |

### Sanitized Test Output Summary

```text
> burrow@0.1.0 test D:\Burrow-private-public\Burrow
> vitest run

 RUN  v4.1.11 D:/Burrow-private-public/Burrow
 ...
 Test Files  132 passed (132)
      Tests  724 passed (724)
   Start at  11:56:53
   Duration  348.52s (transform 58.15s, setup 1027.89s, import 83.68s, tests 81.57s, environment 29ms)
```

```text
D:\Burrow-private-public\Burrow\src\server\index.ts
  113:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
  114:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
  115:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
  116:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
  119:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
  122:5  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
  130:3  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console

✖ 7 problems (0 errors, 7 warnings)
ESLint found too many warnings (maximum: 0).
```

### What Could Not Run / Remains Untested Live

1. **Live Cloudflare Staging Deployment & Live R2 Network Calls (`NOT VERIFIED`):**
   `wrangler.staging.local.jsonc` currently contains the placeholder `00000000-0000-0000-0000-000000000000` `database_id` (no remote staging D1/R2 resources are currently provisioned). Per Audit Rules 4, 6, 7, and 8, no live mutations were executed against Cloudflare; R2 and D1 behaviors were verified via `@cloudflare/vitest-pool-workers` (Miniflare D1 + R2) and mocked CLI unit tests (`tests/unit/cloudflare-deploy.test.ts`).
2. **Full HTTP API E2E Against Node + PostgreSQL (`NOT VERIFIED`):**
   While all repository contracts and PostgreSQL forward migrations were verified live against disposable Docker `postgres:17`, the HTTP API suite (`tests/api/*.test.ts`) executes only against `createWorkerApp` (Miniflare/D1), and Playwright browser E2E (`tests/e2e/**`, excluded in `vitest.config.ts:26`) was not run.

---

## 5. Risk Matrix

| Area | Risk Rating | Justification |
| :--- | :---: | :--- |
| **Deployment** | **Critical** | `demo-reset.mjs` wipes production D1 without confirmation when `CI` or `--force` is set (`FINDING-001`); `--staging --name=burrow` bypasses production teardown/deploy safeguards (`FINDING-002`); `docker-compose.yml` + `.env.example` either uses public secrets or crashes on startup (`FINDING-003`). |
| **Authentication** | **High** | `docker-compose.yml` fallback secrets are not in the production denylist (`FINDING-003`); Cloudflare Worker drops Google/GitHub OAuth and `SELF_UPDATE_WEBHOOK_URL` bindings (`FINDING-006`); any invited `viewer` can create a workspace and trigger `POST /api/system/update` (`FINDING-007`); Better Auth rate limiting shares a single global bucket across all users (`FINDING-009`). *(Core workspace RBAC and session/cookie handling are otherwise solid).* |
| **Database** | **Low** | Schema referential integrity (`ON DELETE CASCADE`, triggers, FTS5 sync, `check-invariants.sql`), lease-based locking (`edit_locks` with atomic version checks), D1 parameter chunking (`D1_SAFE_IN_VARS = 80`), and forward migrations across both SQLite and Docker `postgres:17` are well-engineered and pass all contract tests. |
| **Storage** | **High** | Permanent notepad deletion (`NotepadService.permanentDeleteNotepad`) discards returned `coverKey` values and leaks storage objects (`FINDING-005`); 100 MB in-memory upload buffering exceeds the 128 MB Cloudflare Worker memory limit (`FINDING-008`); remote D1 resets leave R2 objects orphaned (`FINDING-005`). *(Path traversal validation and cross-workspace download isolation are solid).* |
| **Recovery** | **Medium** | `reconcileAndApplyRemoteD1Migrations` safely repairs unrecorded baselines without data loss, and `README.md` / `docs/DEPLOYMENT_AND_UPGRADES.md` rightly note that D1 Time Travel does not back up R2 objects. However, `docs/DEPLOYMENT_AND_UPGRADES.md` uses wrong Docker Compose service names (`db`/`app`) and omits `--config wrangler.local.jsonc` (`FINDING-003`, `FINDING-013`), and `.deploy-log/rollbacks.log` does not distinguish staging from production bookmarks (`FINDING-013`). |

---

## 6. Recommended Fixes

### Must Fix Before Release (Release Blockers)

1. **`FINDING-001` (P0):** Require `--confirm-production-reset=RESET-PRODUCTION-BURROW` in `scripts/demo-reset.mjs` whenever targeting production `'burrow'` (or disallow production targets), remove `|| Boolean(process.env.CI)` auto-force on production, and escape/validate `demoEmail` in `buildDemoSeedSql()`.
2. **`FINDING-002` (P0):** In `resolveRemoteProfile()` (`scripts/lib.mjs:107-115`), forbid `workerName === baseWorkerName` when `isStaging === true`, and forbid `-staging` names when `isStaging === false`.
3. **`FINDING-003` (P0):**
   - Add `'burrow-selfhost-secret-key-32-bytes-minimum!!'` and `'burrow-bootstrap-token-initial-setup'` to `INSECURE_SECRET_PLACEHOLDERS` / `INSECURE_BOOTSTRAP_PLACEHOLDERS` in `src/server/config.ts` and `src/core/adapters/auth.ts`, and remove hardcoded secret defaults from `docker-compose.yml`.
   - Fix the `BETTER_AUTH_URL=http://localhost:3005` startup crash in `src/server/config.ts:67-69` so the README Docker Quick Start (`cp .env.example .env && docker compose up -d --build`) boots cleanly.
   - Fix `README.md:10` (`./docker-compose.yml` link and PostgreSQL 16 vs 17 version) and `docs/DEPLOYMENT_AND_UPGRADES.md:188-193` (`postgres` and `burrow` service names).
4. **`FINDING-004` (P1):** Fix the 7 `no-console` ESLint warnings in `src/server/index.ts:113-130` so `pnpm check` exits `0`, and add a `.github/workflows/ci.yml` workflow running `pnpm check`.
5. **`FINDING-005` (P1):** Delete storage objects (`coverKey` / `project_files`) when permanently deleting a notepad in `NotepadService.permanentDeleteNotepad()`, and clean up R2 objects (or warn) during `scripts/reset.mjs` and `scripts/demo-reset.mjs`.
6. **`FINDING-006` (P1):** Forward `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SELF_UPDATE_WEBHOOK_URL` in `src/worker/index.ts:19-29` and include optional OAuth/webhook secrets in `buildSecretPlan()` (`scripts/lib.mjs`).
7. **`FINDING-007` (P1):** Restrict `POST /api/system/update` (`src/core/routes/system.ts:91-99`) to the instance bootstrap owner (`bootstrap_state.user_id`) rather than any user who owns any workspace.
8. **`FINDING-008` (P1):** Lower `MAX_UPLOAD_BYTES` on Cloudflare Workers (or stream uploads without double-buffering `formData()` + `arrayBuffer()`) to stay within the 128 MB Worker memory limit, and enforce byte-stream counting in `bodyLimit()`.
9. **`FINDING-009` (P1):** Configure `advanced.ipAddress.ipAddressHeaders` (`['cf-connecting-ip', 'x-forwarded-for']`) in `src/core/adapters/auth.ts` so Better Auth rate limiting does not collapse all users into a single shared bucket.

### Should Fix Soon (Post-Blocker Hardening)

10. **`FINDING-010` (P2):** Harden CLI flag parsing in `scripts/lib.mjs` to reject unrecognized flags (`--stage`), reject invalid `--env` values (`--env=stage`), parse `--flag=false` as `false`, and let `--env=production` override `BURROW_DEPLOY_ENV=staging`.
11. **`FINDING-011` (P2):** Pass `profile.dbName` instead of hardcoded `'burrow'` in `scripts/inventory-storage.mjs:80`.
12. **`FINDING-012` (P2):** Allow re-claiming an incomplete `'claimed'` `bootstrap_state` when presenting the valid `BOOTSTRAP_TOKEN`, or add a `bootstrap:release` CLI helper.
13. **`FINDING-013` (P2):** Update `docs/DEPLOYMENT_AND_UPGRADES.md:170-177` to pass `--config wrangler.local.jsonc` to `wrangler d1` commands and tag `.deploy-log/rollbacks.log` entries with the target environment and database name.
14. **`FINDING-014` (P2):** Override `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SELF_UPDATE_WEBHOOK_URL` to `''` in `vitest.config.ts` `miniflare.bindings`, and add Node + PostgreSQL HTTP smoke coverage.

### Future Enhancements

15. **`FINDING-015` (P3):** Add rate limiting to `/api/invites/info/:token` and consider omitting `userExists` until after authentication or rate-limit verification.
16. **`FINDING-016` (P3):** Exclude the heavy `content` column from `listByProject()` in `d1/repositories/notepad.ts` and `postgres/repositories/notepad.ts`.

---

## 7. Final Release Decision

**Decision:** **`DO NOT RELEASE` (`FAIL`)**

Burrow's core application architecture, database invariants, lease-based document locking, and multi-workspace authorization guards are thoughtfully designed and backed by 724 passing tests across SQLite/D1 and Docker PostgreSQL 17. However, **9 release-blocking issues (`FINDING-001` through `FINDING-009`)**—most notably the unguarded production wipe path in `scripts/demo-reset.mjs`, the `--staging --name=burrow` production Worker deletion bypass, the broken/insecure Docker Compose defaults, the missing OAuth/webhook bindings in `src/worker/index.ts`, and the failing `pnpm check` ESLint step—must be resolved and regression-tested before cutting a public release.
