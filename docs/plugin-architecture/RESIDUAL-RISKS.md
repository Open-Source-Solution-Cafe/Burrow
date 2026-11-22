# Residual Risks — Burrow Plugin Architecture

This document records the security boundaries that **cannot** be eliminated inside an in-process JavaScript/TypeScript plugin runtime, the threat model assumption that governs them, and the compensating platform controls that remain enforced.

## Trust Model

Third-party Burrow plugins are **installed at the instance operator's discretion**. Because server plugins execute in the same Node.js or Cloudflare Worker JavaScript context as core application code (no separate OS process or isolated VM per plugin), malicious JS code intentionally installed by an operator cannot be sandboxed from the language runtime itself.

Accordingly, Burrow focuses on:
1. Preventing **careless-plugin vulnerabilities** (unvalidated routes, SSRF, XSS, SQL injection, cross-plugin storage leaks, accidental secret logging, unconsented activation).
2. Enforcing **database-level containment on PostgreSQL** (separate non-login schema `_owner`, dedicated `LOGIN` `_role` pool without `SET ROLE` escalation, short-lived `_migrator`, locked `search_path`, revoked `PUBLIC`/system-catalog access, strict allowlisted `coreTables` grants).

## Accepted In-Process Residual Risks

| Risk | Why It Cannot Be Fixed In-Process | Compensating Controls | Verification |
| --- | --- | --- | --- |
| Direct access to `process.env`, `globalThis.fetch`, `globalThis`, Node built-ins (`node:fs`, `node:child_process`), or `import()` / `require()` from loaded JS code | Server plugins are imported as regular ES modules into the host Node/Worker runtime; ECMAScript modules share process globals and `process.env`. | 1. Static supply-chain audit (`pnpm run plugin:validate` and `@burrow/eslint-plugin`) flags raw `process.env`, `globalThis['fetch']`, dynamic imports, unsafe `eval`/Function, native child-process modules, and unverified lifecycle scripts before installation.<br>2. Runtime context wrappers strip `ctx.env` / `ctx.infra` / Hono `c.env` and block `CORE_RESERVED_CONFIG_KEYS` from `ctx.config` to stop accidental leakage through SDK APIs.<br>3. `PLUGINS_DISABLED` skips plugin `setup()` and migrations at startup. | [`tests/redteam/residual/in-process-escape.test.ts`](../../tests/redteam/residual/in-process-escape.test.ts) (`pnpm exec vitest run --config vitest.residual.config.ts`) |
| SQLite / Cloudflare D1 shared-engine scope | SQLite and Cloudflare D1 do not provide database users, schemas, `GRANT`/`REVOKE`, or row-level engine isolation inside a single SQLite file / D1 binding. | 1. `assertPluginSqlAllowed` AST + statement guard restricts SQLite/D1 plugin SQL to the plugin's `plugin_<id>_*` table prefix and explicitly allowlisted `coreTables`.<br>2. Deployments requiring database-enforced multi-plugin isolation must use PostgreSQL, where each plugin executes on a dedicated `LOGIN` role pool inside its own schema. | [`tests/security/postgres-isolation-node.test.ts`](../../tests/security/postgres-isolation-node.test.ts) |
| Prototype mutation or CPU starvation from synchronous loops inside loaded JS handlers | Single-threaded JS execution shares `Object.prototype` and CPU event loop turns across synchronous functions. | Route handlers are bounded by wall-clock timeouts (`pluginRouteTimeoutMs` -> `504`), event handlers are bounded by listener caps and promise timeouts (`emitBefore`/`emitAfter`), and outgoing payloads/manifests are cloned and frozen before untrusted inspection. | [`tests/security/`](../../tests/security/) |
