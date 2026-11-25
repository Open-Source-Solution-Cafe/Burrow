# Third-Party Untrusted Plugin Execution Architecture (Design Document)

> [!NOTE]
> **Status**: Phase 4 design specification (`Status: Pending Owner`). Year 1 plugins use curated PR review and build-time composition (`DECISIONS.md` D4). This document specifies the runtime isolation architecture when third-party untrusted plugins are enabled.

---

## 1. Three-Tier Trust Model

| Tier | Distribution | Server Execution | UI Execution | Permission Surface |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1 (Curated)** | Reviewed PR into `packages/plugins/*` or pinned package | Bundled in main Worker (`createApp({ plugins })`) | Bundled via `mountBurrowWeb({ plugins })` | Declared `PluginManifest` capabilities enforced by loader & `PluginDb` |
| **Tier 2 (Isolated Worker)** | Uploaded bundle deployed to dispatch namespace | Cloudflare **Workers for Platforms** isolate + Outbound Worker | Proxied REST/RPC + sandboxed `<iframe>` | Capability RPC bridge + per-invocation `cpuMs` / `subRequests` limits |
| **Tier 3 (Web-Only / Client)** | JSON manifest + isolated client script | Optional webhooks via Outbound proxy | `<iframe sandbox="allow-scripts">` (`null` origin) | `MessageChannel` capability RPC only (`insertText`, scoped read APIs) |

---

## 2. Server Isolation: Cloudflare Workers for Platforms

Untrusted server plugins run inside a Cloudflare Workers for Platforms **dispatch namespace** (`env.PLUGIN_DISPATCH`), physically isolated in separate V8 isolates from Burrow's core Worker.

### Execution Topology

```text
Incoming HTTP / Event
  │
  ▼
Burrow Core Worker (Dynamic Dispatch Worker)
  │  1. Validates session, workspace role, and plugin manifest permissions
  │  2. Binds scoped Capability RPC Stub (PluginDb façade, NO raw env.DB or env.FILES)
  │  3. Dispatches with strict per-invocation resource caps
  ▼
Dispatch Namespace ("production") ──► Plugin User Worker (Untrusted Mode)
  │                                        │
  │                                        ▼ (global fetch intercepted)
  └────────────────────────────────► Outbound Worker
                                           • Blocks raw connect() sockets
                                           • Enforces URL allowlists & SSRF blocks
                                           • Logs egress audit trail
```

### Verified Cloudflare Platform Constraints & Pricing

Per Cloudflare's official documentation ([Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/) and [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)):

- **Workers for Platforms Paid Plan**: starts at **$25/month** base subscription.
  - **Requests**: 20 million requests/month included, **+$0.30** per additional million. Notice Cloudflare bills **1 request** across the `Dynamic Dispatch Worker -> User Worker -> Outbound Worker` chain.
  - **CPU Time**: 60 million CPU ms/month included, **+$0.02** per additional million CPU ms (billed across all participating Workers in the chain).
  - **Scripts**: 1,000 scripts included (**+$0.02** per additional script) inside a single shared dispatch namespace (recommended over one namespace per customer).
- **Isolation Guarantees**:
  - Dispatch namespace scripts run in **untrusted mode** by default: no shared cache with zone Workers and no sensitive `request.cf` fields exposed.
  - **Custom Per-Invocation Limits**: The dispatcher supplies `limits: { cpuMs, subRequests }` on `env.dispatcher.get(workerName, {}, { limits })` to prevent runaway CPU loops or subrequest bombs.
  - **Outbound Worker Enforcement**: Attaching an Outbound Worker intercepts every external `fetch()` call (enforcing private-IP SSRF prevention and host allowlists) and disables raw TCP `connect()` sockets inside untrusted scripts.
- **D1 Limits**:
  - **Database Size**: 10 GB max per DB (Workers Paid) / 500 MB (Free).
  - **Parameters & SQL Size**: 100 bound parameters per statement, 100 KB SQL statement length.
  - **Batch Accounting**: `db.batch()` counts as **1 query** against the per-invocation limit (1,000 queries on Paid / 50 on Free).
  - **Foreign Keys**: `PRAGMA foreign_keys = OFF` is disallowed; table rebuilds require `PRAGMA defer_foreign_keys = ON`.

---

## 3. Data & Capability Isolation

1. **No Raw `DB` or `FILES` Bindings**: Untrusted Workers **never** receive Cloudflare `DB` (D1) or `FILES` (R2) bindings directly.
2. **Scoped RPC Façade (`WorkerEntrypoint`)**: Core exposes a service binding RPC stub implementing:
   - `pluginDb.query / execute / batch`: Re-validates SQL strictly against `plugin_<id>_*` on the trusted side **before** executing against D1, or routes untrusted plugin state to a dedicated per-plugin Durable Object SQLite store / isolated D1 database for zero shared-table blast radius.
   - `emitEvent` / `deliverEvent`: Pushes signed, serialized snapshots of `task.created` or `notepad.saved` into the plugin Worker via `ctx.waitUntil` without exposing core request headers or auth cookies.
3. **Host Allowlist**: Manifests add optional `allowedEgressHosts?: string[]`; Outbound Workers reject any `fetch()` not on that workspace-approved host list plus all RFC-1918 / link-local / loopback ranges.

---

## 4. UI Isolation: Sandboxed `<iframe>` + `MessageChannel`

Untrusted UI plugins must **never** share Burrow's React tree or origin DOM (which would expose session cookies, CSRF tokens, or sibling workspace state):

1. **Null-Origin Sandbox**: Render UI contributions inside `<iframe sandbox="allow-scripts">` (never adding `allow-same-origin`!). Set strict `Content-Security-Policy` headers on plugin frame assets.
2. **Typed RPC over `MessageChannel`**:
   - Host creates a dedicated `MessageChannel`, passes `port2` on initial handshake with granted capabilities only (`editor.insertText`, `ui.showToast`, scoped plugin route `fetchProxy`).
   - All host-to-iframe DOM mutations (e.g., Kanban tile badges, card panel sections, slash modals) pass pure declarative descriptors or render inside the sandboxed frame with explicit postMessage height synchronization.
3. **Audit & Kill Switch**: Workspace owners must explicitly enable third-party runtime plugins in **Settings → Features & Labs**, with per-workspace disablement immediately revoking dispatch invocations and iframe mounts.
