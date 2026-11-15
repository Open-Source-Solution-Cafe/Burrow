# Burrow — Final Independent Security & Release Audit (Round 3)

**Audit Date:** 2026-11-14  
**Repository:** `d:\Burrow-private-public\Burrow`  
**Branch / HEAD:** `master` @ `6a0eacb` (`docs(audit): record audit remediation evidence and changelog entries`), plus **56 modified tracked files and 16 untracked files** in the working tree.  
**Auditor Role:** Independent Principal Security Engineer, SRE, and Senior Software Architect  

---

## 1. Executive Summary

**Overall Release Status:** **`FAIL`**

While the core security, deployment-isolation, rate-limiting, proxy-trust, and durable storage-cleanup remediations in the working tree address the architectural root causes from prior rounds, **the repository's mandatory verification gate (`pnpm check`) currently fails with exit code `1`** due to **9 unhandled promise rejections** (`APIError: Invalid email or password`) originating in `tests/api/rate-limit-worker.test.ts` under Miniflare (`workerd`). Because `.github/workflows/ci.yml` executes `pnpm exec vitest run`, the CI pipeline will also fail until resolved. Additionally, all Round 3 fixes currently exist only as uncommitted working-tree changes on top of `6a0eacb`, and neither hosted GitHub Actions nor live Cloudflare staging deployments were executed.

---

## 2. Previous Failure Verification

| Issue | Previous Status | Current Status | Evidence |
|---|---|---|---|
| Demo reset isolation | FAIL | **PASS** | [scripts/demo-reset.mjs](file:///d:/Burrow-private-public/Burrow/scripts/demo-reset.mjs#L58-L185), [scripts/lib.mjs](file:///d:/Burrow-private-public/Burrow/scripts/lib.mjs#L136-L435), [.github/workflows/demo-reset.yml](file:///d:/Burrow-private-public/Burrow/.github/workflows/demo-reset.yml#L35-L48), [wrangler.jsonc](file:///d:/Burrow-private-public/Burrow/wrangler.jsonc#L24-L41); verified via adversarial Node CLI & mocked Wrangler checks (`15/15` blocked/validated). |
| Docker security | FAIL | **PASS** | [docker-compose.yml](file:///d:/Burrow-private-public/Burrow/docker-compose.yml#L7-L19), [src/server/config.ts](file:///d:/Burrow-private-public/Burrow/src/server/config.ts#L13-L165), [src/server/index.ts](file:///d:/Burrow-private-public/Burrow/src/server/index.ts#L110-L141), [scripts/docker-init.mjs](file:///d:/Burrow-private-public/Burrow/scripts/docker-init.mjs#L17-L93); `tests/unit/docker-security.test.ts` (`4/4` passed) & `tests/unit/database-target.test.ts` (`13/13` passed). *(Live Compose build not re-run in Round 3.)* |
| Worker rate limiting | FAIL | **FAIL (Suite Error)** | Implementation in [src/core/adapters/rate-limit.ts](file:///d:/Burrow-private-public/Burrow/src/core/adapters/rate-limit.ts#L115-L250) and [src/core/adapters/auth.ts](file:///d:/Burrow-private-public/Burrow/src/core/adapters/auth.ts#L200-L373) persists counters in D1/SQLite/PostgreSQL across fresh Worker instances and fails closed (`503`). **However**, `tests/api/rate-limit-worker.test.ts` raises **9 unhandled rejections** (`APIError: Invalid email or password`) causing `vitest run` and `pnpm check` to exit `1`. |
| Proxy header trust | FAIL | **PASS** | [src/core/shared/ip.ts](file:///d:/Burrow-private-public/Burrow/src/core/shared/ip.ts#L121-L229), [src/core/middleware/security.ts](file:///d:/Burrow-private-public/Burrow/src/core/middleware/security.ts#L31-L117), [src/server/config.ts](file:///d:/Burrow-private-public/Burrow/src/server/config.ts#L115-L122); `hasVerifiedCloudflareEdge` requires `request.cf.colo`, and `TRUST_PROXY=true` in production requires `TRUSTED_PROXIES` CIDR/IP allowlist. |
| Storage cleanup | FAIL | **PASS** | [src/core/services/storage-cleanup.ts](file:///d:/Burrow-private-public/Burrow/src/core/services/storage-cleanup.ts#L45-L187), [migrations/0001_rate_limits_and_cleanup.sql](file:///d:/Burrow-private-public/Burrow/migrations/0001_rate_limits_and_cleanup.sql#L10-L24), [migrations/postgres/0001_rate_limits_and_cleanup.sql](file:///d:/Burrow-private-public/Burrow/migrations/postgres/0001_rate_limits_and_cleanup.sql#L9-L21), [src/core/routes/project-files.ts](file:///d:/Burrow-private-public/Burrow/src/core/routes/project-files.ts#L239-L277); `tests/adapters/storage-cleanup-node.test.ts` (`6/6` passed under SQLite FK enforcement & PostgreSQL 17). |
| CI configuration | FAIL | **FAIL (Blocked by Tests)** | [.github/workflows/ci.yml](file:///d:/Burrow-private-public/Burrow/.github/workflows/ci.yml#L1-L61) pins `pnpm@10.15.0`, Node `22.14.0`, `postgres:17-alpine`, `tsc -b`, `eslint --max-warnings=0`, decoupling/license checks, and `vitest run` (`tests/unit/ci-workflows.test.ts` `2/2` passed). Blocked because `vitest run` currently exits `1`, and no hosted CI run was observed. |
| Runtime upload detection | FAIL | **PASS** | [src/shared/uploadPolicy.ts](file:///d:/Burrow-private-public/Burrow/src/shared/uploadPolicy.ts#L1-L49), [src/core/middleware/security.ts](file:///d:/Burrow-private-public/Burrow/src/core/middleware/security.ts#L216-L275), [src/core/routes/system.ts](file:///d:/Burrow-private-public/Burrow/src/core/routes/system.ts#L70-L93), [src/web/pages/SettingsView.tsx](file:///d:/Burrow-private-public/Burrow/src/web/pages/SettingsView.tsx#L47); `tests/unit/runtime-upload-limits.test.ts` (`2/2` passed) & `tests/api/storage.test.ts` (`12/12` passed). |
| Bootstrap recovery | Warning | **PASS** | [src/core/app.ts](file:///d:/Burrow-private-public/Burrow/src/core/app.ts#L525-L592), [src/core/routes/system.ts](file:///d:/Burrow-private-public/Burrow/src/core/routes/system.ts#L114-L127), [src/core/adapters/db/d1/repositories/workspace.ts](file:///d:/Burrow-private-public/Burrow/src/core/adapters/db/d1/repositories/workspace.ts#L105-L120), [src/core/adapters/db/postgres/repositories/workspace.ts](file:///d:/Burrow-private-public/Burrow/src/core/adapters/db/postgres/repositories/workspace.ts#L59-L75); verified in `tests/api/bootstrap-recovery-edge.test.ts`, `tests/adapters/bootstrap-node.test.ts`, and `tests/adapters/http-smoke-node.test.ts`. |

---

## 3. New Findings

### `R3-001` — `pnpm check` and `vitest run` Fail with Exit Code 1 Due to 9 Unhandled Rejections in `tests/api/rate-limit-worker.test.ts`

- **Severity:** **P1 (Release Blocker)**
- **Affected Files & Lines:**
  - [tests/api/rate-limit-worker.test.ts](file:///d:/Burrow-private-public/Burrow/tests/api/rate-limit-worker.test.ts#L97-L176)
  - [src/core/adapters/auth.ts](file:///d:/Burrow-private-public/Burrow/src/core/adapters/auth.ts#L285-L372)
  - [.github/workflows/ci.yml](file:///d:/Burrow-private-public/Burrow/.github/workflows/ci.yml#L58-L61)
- **Root Cause:**
  Every invalid-password `POST /api/auth/sign-in/email` attempt executed inside `tests/api/rate-limit-worker.test.ts` (3 attempts in test 1, 6 attempts in test 2 = 9 total) triggers an unhandled `APIError: Invalid email or password` (`statusCode: 401`) rejection inside Better Auth (`better-auth/dist/api/routes/sign-in.mjs:334` / `@better-auth/core/dist/context/transaction.mjs:37`) in the Miniflare `workerd` runtime. Although the HTTP response returns `401` and the 5 test assertions pass, Vitest records `9 errors` and exits with code `1`.
- **Concrete Evidence:**
  - Full `pnpm check` exited with code `1`: `Test Files 140 passed (140) | Tests 784 passed (784) | Errors 9 errors`.
  - Isolated `pnpm exec vitest run --project worker tests/api/rate-limit-worker.test.ts` exited with code `1`: `Test Files 1 passed (1) | Tests 5 passed (5) | Errors 9 errors`.
- **Safe Reproduction Steps:**
  ```powershell
  cd d:\Burrow-private-public\Burrow
  pnpm exec vitest run --project worker tests/api/rate-limit-worker.test.ts
  ```
- **User Impact:**
  `pnpm check` and `.github/workflows/ci.yml` fail on every run, blocking automated CI verification and release tagging.
- **Minimal Recommended Correction:**
  Investigate and eliminate the unhandled `APIError` rejection path in Better Auth's `transaction.mjs` / `auth.handler` invocation under `workerd` (e.g., ensure no detached promise from `runWithAdapter` / `auth.handler` rejects unhandled on `401` responses in `tests/api/rate-limit-worker.test.ts`).
- **Missing Regression Coverage:**
  `pnpm check` must exit `0` with `0` unhandled errors across all Vitest projects (`unit`, `database`, `worker`).

### `R3-002` — Uncommitted Working Tree (56 Modified, 16 Untracked Files)

- **Severity:** **P2 (Operational / Release Hygiene)**
- **Affected Files:** 56 modified tracked files and 16 untracked files in `d:\Burrow-private-public\Burrow` on top of `6a0eacb`.
- **Evidence:** `git status` shows all Round 3 security, migration, and test changes are unstaged in the working tree.
- **Impact:** A tagged release or GitHub push from `HEAD` (`6a0eacb`) would omit all Round 3 fixes.

---

## 4. Verification Results

1. **`pnpm check`** (`node scripts/check.mjs`): **FAILED (`exit 1`)**
   - `tsc -b`: **0 errors** (source/build check passed)
   - `scripts/check-basalt.mjs`: **OK**
   - `scripts/check-licenses.mjs`: **418 packages scanned, 0 violations, 0 allowlisted**
   - `scripts/check-decoupling.mjs`: **415 files scanned, 0 violations, 8 allowlisted**
   - `eslint --max-warnings=0 .`: **0 errors, 0 warnings**
   - `vitest run` (`unit`, `database` [SQLite + PostgreSQL 17], `worker` [Miniflare D1/R2]): **140/140 test files passed, 784/784 tests passed, 0 skipped, 9 unhandled rejection errors (`exit 1`)**.
2. **Isolated Worker Rate-Limit Reproduction** (`pnpm exec vitest run --project worker tests/api/rate-limit-worker.test.ts`): **FAILED (`exit 1`)** — `5/5` tests passed, **9 unhandled errors** (`APIError: Invalid email or password`).
3. **Phase 2 Adversarial CLI & Mocked Wrangler Tests** (`node --input-type=module -e ...`): **PASSED (`15/15` assertions)** — verified `--staging --name=burrow`, `--staging --domain=burrow.osscafe.com`, `--env=stage`, `--stage`, `--staging --env=production`, `--demo --staging`, `--demo=false --env=demo`, `demo-reset -r` with `CI=true`/`--force`, `reset`/`teardown` on prod with `CI=true`/`--force`, `--force=false`, wrong Cloudflare account ID, and D1 UUID/name mismatch all fail closed.
4. **Phase 9 Read-Only Staging Inventory** (inspected `.env` keys safely without printing secrets & `wrangler.staging.local.jsonc`):
   - `CLOUDFLARE_ACCOUNT_ID`: `7293b063e3a1e07596adedfa2c895750`
   - Staging Worker: `burrow-staging`
   - Staging D1: `burrow-staging` (`95c63261-cd3c-4b4a-8ebf-3caff0156da7`, distinct from production `D1_DATABASE_ID` `6f5a2f2a-7b27-4aef-a37a-43cbf12a0750`)
   - Staging R2: `burrow-staging-files`
   - Staging Domain: `https://burrow-staging.opensourcesolutioncafe.workers.dev`
   - **Readiness:** Staging target is isolated from production by distinct Worker, D1 UUID, R2 bucket, and domain. Live staging deployment/mutation was **not** executed per audit rules.

---

## 5. Remaining Risks

- **Confirmed Defects:** `R3-001` (9 unhandled rejections in `tests/api/rate-limit-worker.test.ts` causing `pnpm check` exit code `1`); `R3-002` (uncommitted working tree).
- **Untested Behavior in Round 3:**
  - Hosted GitHub Actions workflow execution (`.github/workflows/ci.yml` and `.github/workflows/demo-reset.yml` have not been observed running on GitHub).
  - Live Cloudflare staging deployment, live D1 migrations (`0001_rate_limits_and_cleanup.sql`), and live R2 cleanup.
  - Live `docker compose up --build` smoke test for Round 3 working-tree changes (verified via source inspection and unit tests only).
- **Operational Concerns:** Operators deploying Node/Docker behind a reverse proxy must configure both `TRUST_PROXY=true` and `TRUSTED_PROXIES` (enforced fail-closed by `loadConfig`).

---

## 6. Final Release Decision

1. **Public GitHub Push:** **NO** — `pnpm check` fails with exit code `1` (`R3-001`), and the working tree changes are uncommitted (`R3-002`).
2. **Staging Deployment:** **NOT READY UNTIL `R3-001` & `R3-002` ARE RESOLVED** — Target isolation in `wrangler.staging.local.jsonc` and `.env` is properly separated from production, so once `R3-001` is fixed and committed, staging is safe to deploy and verify.
3. **Tagged Release:** **NO** — Blocked by `R3-001` and unverified hosted CI.
4. **Production Usage by External Users:** **NO** — Blocked until `pnpm check` passes cleanly (`exit 0`, `0` unhandled errors), hosted CI is green, and staging verification is completed.
