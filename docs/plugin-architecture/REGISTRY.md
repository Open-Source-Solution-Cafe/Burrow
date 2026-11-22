# Burrow Plugin Registry & Security Review Standard

This document defines how plugins are packaged, submitted, validated locally without external CI, and reviewed before acceptance into the curated Burrow plugin registry.

> **Trust Model ([DECISIONS.md](./DECISIONS.md#d4-threat-model-and-trust-boundary))**: Self-hosted operators choose which curated or community plugins they install; the platform blocks common vulnerability classes by default. Shared multi-workspace hosting installs curated first-party plugins instance-wide only.

---

## 1. Registry Directory Layout

Each curated or community plugin lives under a dedicated package directory (e.g., `registry/<plugin-id>/` or `packages/plugins/<plugin-id>/`) with the following minimal structure:

```text
<plugin-id>/
  package.json        # Name, SemVer, approved license, pinned deps, ZERO install scripts
  pnpm-lock.yaml      # Required whenever non-workspace dependencies are declared
  manifest.json       # Static copy of PluginManifest for offline registry indexing/validation
  src/
    index.ts          # Server plugin definition exporting createPlugin() or default plugin
    client.ts         # Optional browser slot extensions (card types, panels, slash commands)
  migrations/         # Optional dialect-tagged SQLite / PostgreSQL DDL files
    0001_init.sql
  README.md           # Setup instructions, declared configKeys, and capability overview
```

---

## 2. Manifest Schema Requirements (`PluginManifest`)

Every plugin manifest must pass `validatePluginManifest()` (`src/core/plugins/manifest.ts`) and `pnpm run plugin:validate <dir>`:

| Field | Requirement | Purpose |
| :--- | :--- | :--- |
| `id` | `/^[a-z][a-z0-9-]{0,30}$/` | Unique plugin slug & SQL table prefix (`plugin_<id>_*`) |
| `name` | Non-empty string | Human-readable label shown in Settings → Plugins |
| `version` | Strict SemVer (`x.y.z`) | Migration tracking and UI display |
| `sdkVersion` | Valid SemVer range matching host `BURROW_SDK_VERSION` (`0.4.0`) | Host compatibility gate |
| `permissions` | Explicit allowlist of `Permission` tokens | Gates `ctx.db`, `ctx.route`, `ctx.storage`, UI slots |
| `dialects` | Array subset of `['sqlite', 'postgres']` | Refuses activation on unsupported database adapters |
| `dependencies` | Array of plugin IDs | Deterministic topological initialization ordering |
| `network` | Exact public hostnames (no `*`, IPs, ports, or paths) | `ctx.fetch` egress allowlist + SSRF protection |
| `configKeys` | Array matching `/^[A-Z][A-Z0-9_]{0,63}$/` | Scopes `ctx.config` to declared keys only |
| `coreTables` | Subset of allowlisted non-sensitive core tables | Grants PostgreSQL `SELECT` (never `token_hash`) & SQLite tripwire scope |

---

## 3. Automated Offline Validation Gate

Run locally (no GitHub Actions required) before submitting or accepting any plugin:

```bash
pnpm run plugin:validate <path-to-plugin-dir>
# Include online CVE check when lockfile is present:
pnpm run plugin:validate <path-to-plugin-dir> --audit
```

`scripts/plugin-validate.mjs` enforces:
1. Approved license (`MIT`, `Apache-2.0`, `BSD-*`, `ISC`, or `AGPL-3.0-or-later`) on the plugin and permissive licenses on dependencies.
2. Zero install-time lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`) in plugin or installed dependency manifests.
3. Exact dependency version pinning (`x.y.z`; no `*`, `latest`, ranges, or unpinned URLs) and lockfile presence.
4. Built-in offline advisory checks (plus optional `pnpm audit --prod`).
5. Static AST security rules from `@burrow/eslint-plugin`:
   - `@burrow/no-unsafe-eval`
   - `@burrow/no-unsanitized-html`
   - `@burrow/no-raw-fetch`
   - `@burrow/no-process-env`
   - `@burrow/no-string-sql`
   - `@burrow/no-child-process`
   - Unvalidated Hono / `ctx.route()` mutation handlers (requires `ctx.defineRoute` or `zValidator`).
6. SQL migration safety scan (forbids core auth/config tables, catalog introspection, `ATTACH`, `PRAGMA`, `COPY`).

---

## 4. Mandatory Security & Vulnerability Review Checklist

Reviewers MUST verify every item below before merging any plugin PR:

1. **SQL Injection & Database Scope (`db:own`)**
   - [ ] All queries use `ctx.db.query/first/execute(text, params)`, `ctx.db.sql\`...\``, or `ctx.db.table('name')` identifiers.
   - [ ] Zero string concatenation or raw template interpolation passed to `PluginDb`.
   - [ ] No SQL comments (`--`, `/*`), dollar quotes, `UNION SELECT`, `SELECT INTO`, or multi-statement queries.
   - [ ] Any read against non-sensitive core tables (`workspaces`, `projects`, `cards`, `boards`, `members`, `invites`) is declared explicitly in `manifest.coreTables`. *(Note: On SQLite/D1, `assertPluginSqlAllowed` is a best-effort tripwire for operator-trusted plugins; true database-level `NOLOGIN` role & schema isolation is enforced on PostgreSQL.)*
   - [ ] Tested on both `sqlite` and `postgres` when both dialects are declared in `manifest.dialects`.
2. **Cross-Site Scripting & CSP (`ui:register`, `cards:register`, `mentions:register`)**
   - [ ] UI renders plain escaped React text by default; any rich HTML passes through `sanitizePluginHtml()` (`@burrow/sdk`).
   - [ ] No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`, `eval`, or `new Function`.
   - [ ] Server routes do not attempt to weaken `Content-Security-Policy` headers.
3. **SSRF & Outbound Network Egress (`ctx.fetch`)**
   - [ ] Every external domain called by the plugin is explicitly declared in `manifest.network`.
   - [ ] Plugin uses `ctx.fetch(...)` exclusively (never global `fetch()`).
   - [ ] Redirect responses do not target private/link-local/metadata IP ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`).
4. **Authentication & Authorization (Anti-IDOR)**
   - [ ] Every route avoids `{ public: true }` (`routes:public`) unless unauthenticated webhooks/callbacks are strictly required and cryptographically verified (e.g., HMAC signature).
   - [ ] Authenticated routes enforce workspace membership and minimum role via `ctx.requireRole(...)` (`viewer` / `editor` / `owner`).
   - [ ] Object/resource lookups scoped via `ctx.requireWorkspaceAccess(table, resourceId, workspaceId)` to prevent cross-workspace IDOR.
5. **CSRF, CORS & Safe HTTP Semantics**
   - [ ] State-changing actions use `POST` / `PUT` / `PATCH` / `DELETE`, never `GET`.
   - [ ] Plugin does not set `Access-Control-Allow-Origin` or override core CSRF checks.
6. **Input Schema Validation**
   - [ ] Routes use `ctx.defineRoute({ method, path, schemas, handler })` with Zod schemas validating `params`, `query`, and JSON `body`.
7. **Storage Path Traversal & Upload Safety (`storage:own`)**
   - [ ] File operations use `ctx.storage` exclusively with logical keys (no `..`, leading `/`, `\`, or null bytes).
   - [ ] Uploaded MIME types exclude active executable content (`text/html`, `image/svg+xml`, JavaScript).
8. **Secrets & Logging Hygiene (`configKeys`, `ctx.log`)**
   - [ ] Sensitive credentials are declared in `manifest.configKeys` and read via `ctx.config` (never `process.env`).
   - [ ] Logging uses `ctx.log.info/warn/error` (auto-redacting secrets), never raw `console.log(process.env)` or secret echoing in error payloads.
9. **Resource Bounds & Resilience**
   - [ ] Event handlers and external calls stay bounded (respect handler timeouts and avoid unbounded fan-out on hot save paths).
   - [ ] Large list queries set explicit `LIMIT`s (never exceeding `PluginDb` default/max row caps).
10. **Supply Chain Hygiene**
    - [ ] Minimal dependency tree; exact pinned versions; lockfile present; zero `postinstall`/`install` hooks; clean `pnpm audit`.
11. **Consent & Admin Transparency**
    - [ ] `manifest.description`, `permissions`, `network`, and `configKeys` accurately reflect every capability presented in the workspace owner's consent summary (`Settings → Plugins`).
