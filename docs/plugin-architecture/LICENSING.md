# Plugin SDK & Ecosystem Licensing (`LICENSING.md`)

**Date**: 2026-11-22  
**Status**: Checks 1 & 2 Verified · Check 3 Pending Legal Counsel Sign-Off

---

## 1. Package License Matrix

| Package | Path | License | Notes |
| :--- | :--- | :--- | :--- |
| **`@burrow/sdk`** | `packages/sdk` | **`MIT`** | Pure contract types (`PluginManifest`, `ServerPluginContext`, `BurrowWebPlugin`) & zero-dependency SDK utilities (`sql`, `sanitizePluginHtml`, `sanitizePluginProps`, `formatPluginConsentSummary`). |
| **`@burrow/eslint-plugin`** | `packages/eslint-plugin` | **`MIT`** | Standalone ESLint AST security rules for plugin authors (`@burrow/no-*`). |
| **`@burrow/core`** | `packages/core` | **`AGPL-3.0-or-later`** | Core Hono runtime, persistence, SSRF/storage/DB isolation enforcement. |
| **`@burrow/web`** | `packages/web` | **`AGPL-3.0-or-later`** | Core React SPA shell, router integration, and plugin slot renderer. |
| **`@burrow/worker`** | `packages/worker` | **`AGPL-3.0-or-later`** | Cloudflare Workers & D1 runtime adapter. |
| **`@burrow/plugins`** | `packages/plugins/*` | **`AGPL-3.0-or-later`** | First-party built-in and example plugins (`public-sharing`, `workspace-export`, `estimation`, `hello`, `_template`). |

---

## 2. Three Required Verification Checks (D3)

### Check 1 — Clean-Room Separation from AGPL Core (`VERIFIED`)
- **`packages/sdk/src/index.ts`**: Contains zero external dependencies (`dependencies` omitted/empty in `packages/sdk/package.json`) and zero imports from `@burrow/core` or `src/`.
  - Core enforcement modules — `src/core/plugins/safe-fetch.ts` (SSRF IP/DNS/redirect validation), `src/core/plugins/plugin-storage.ts` (path confinement & upload rules), `src/core/plugins/postgres-isolation.ts` (PostgreSQL role/schema ACLs), `src/core/plugins/plugin-db.ts` (SQL guard), `src/core/plugins/logger.ts` (secret redaction), and `scripts/plugin-validate.mjs` (supply-chain & audit validator) — reside exclusively inside AGPL core (`src/` / `scripts/`).
  - The SDK contains only interface contracts (`ServerPluginContext`, `PluginDb`, `PluginStorage`, etc.) and clean-room utilities written specifically inside `packages/sdk/src/index.ts` (`sql`, `buildPluginTableIdentifier`, `sanitizePluginHtml`, `sanitizePluginProps`, `describePluginCapabilities`, `formatPluginConsentSummary`).
- **`packages/eslint-plugin/src/index.js`**: Contains zero imports from `@burrow/core` or `src/`; all six rules operate purely on standard ESLint AST nodes.

### Check 2 — Authorship & Contributor Consent (`VERIFIED`)
- Git commit history across `packages/sdk` and `packages/eslint-plugin` (`git log --format="%an <%ae>" -- packages/sdk packages/eslint-plugin`) confirms a single author:
  - `Teelon Mitchell <28550464+Teelon@users.noreply.github.com>`
- Future external contributions to the repository are governed by [CLA.md](../../CLA.md) Section 2.2, granting project maintainers copyright rights to sublicense and distribute contributions under open-source or dual-license terms.

### Check 3 — AGPL Derivative-Work Boundary (`PENDING LEGAL COUNSEL SIGN-OFF`)
- **Plugins importing only `@burrow/sdk` (and checked with `@burrow/eslint-plugin`)**: Depend solely on the MIT-licensed interface package and standalone SDK helpers at build/typecheck time and receive capabilities (`ctx.db`, `ctx.fetch`, `ctx.storage`, `ctx.log`, `ctx.defineRoute`) at runtime via dependency injection (`setup(ctx)`).
- **Plugins importing `@burrow/core`, `@burrow/web`, or `@burrow/worker` directly**: Import AGPL-3.0-or-later code directly and therefore must comply with `AGPL-3.0-or-later` unless licensed separately by the copyright holder under [CLA.md](../../CLA.md).
- **Legal Question Remaining for Counsel**: Confirm whether third-party or proprietary plugins that import only `@burrow/sdk` stay outside AGPL derivative-work scope while plugins importing `@burrow/core` internals fall inside AGPL copyleft scope (and verify the exact license header/notice text to publish with `@burrow/sdk` on npm).

---

## 3. Public npm Publishing Readiness (`0.x` Unstable)
- Registry lookup (`2026-11-22`) confirmed zero published packages under `@burrow/sdk` (`HTTP 404`) or `@burrow/eslint-plugin` (`HTTP 404`), and `0` results for `@burrow/*` search queries.
- However, the unscoped `burrow` npm package already exists (maintainer `vjpr`), and `https://www.npmjs.com/org/burrow` returns `HTTP 403` unauthenticated.
- **Pre-publish Action**: Verify ownership or claim status of the `@burrow` npm scope before publishing `0.x` releases to public npm (or select an available alternate scope if `@burrow` is unavailable). Once verified and red-team findings are resolved, publish `@burrow/sdk` and `@burrow/eslint-plugin` as `0.x` (marked unstable API).
