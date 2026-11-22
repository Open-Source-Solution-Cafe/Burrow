# Architectural Decisions & Open Questions

All default assumptions below were adopted so implementation could proceed autonomously on `feat/plugin-architecture`. Items marked **Pending Owner** require explicit sign-off before merging to `master` / `main`.

---

## Adopted Default Assumptions

### D1. Postgres Adapter Policy (`Status: Pending Owner`)
- **Decision**: All plugin architecture features (plugin migrations, `PluginDb`, `plugin_<id>_*` tables, and `burrow-cloud` plugins) target **Cloudflare Workers + D1 (SQLite)** only.
- **Handling**: The existing Postgres adapter in `Burrow/src/core/adapters/db/postgres/` is left **frozen** (not extended for plugins, not deleted). Minimal parity files (`migrations/postgres/0006_add_card_type.sql` and `postgres/schema.ts` column parity) are maintained only where required by `scripts/check-sync.mjs` and `tests/unit/schema-parity.test.ts`.
- **Owner Action**: Decide whether to formally deprecate/remove the Node/Postgres runtime in `Burrow` or add Postgres plugin support later.

### D2. `burrow-cloud` Tenancy Topology on D1 (`Status: Pending Owner`)
- **Decision**: Port `burrow-cloud` to Cloudflare Workers + D1 plugins using a **single shared D1 database** for initial simplicity, with all cloud data access encapsulated inside plugin repositories/adapters (`plugin_cloud_*`) so migrating to **database-per-tenant** on D1 later only swaps the DB resolver.
- **Note**: A single D1 database on Workers Paid has a 10 GB maximum database size limit. Multi-tenant production scaling beyond 10 GB will require switching the adapter to D1 database-per-tenant (up to 50,000 D1 databases per account).
- **Owner Action**: Confirm single shared D1 vs. database-per-tenant provisioning prior to production SaaS launch.

### D3. `@burrow/sdk` Licensing (`Status: Pending Owner / Legal Review`)
- **Decision**: `packages/sdk/package.json` declares `"license": "MIT"` while the rest of public `Burrow` (`@burrow/core`, `@burrow/web`, `@burrow/worker`, `@burrow/plugins`, root `package.json`) remains `"AGPL-3.0-or-later"`.
- **Rationale**: Allows community and proprietary plugins (including `burrow-cloud`) to import `@burrow/sdk` TypeScript types and manifest definitions cleanly without copyleft license friction on type contracts.
- **Owner Action**: Legal / maintainer sign-off on dual/MIT licensing for `packages/sdk`.

### D4. First-Year Community Plugin Trust Model (`Status: Pending Owner`)
- **Decision**: Year 1 supports **curated build-time plugins** (submitted via PR, reviewed, and bundled into the Worker + Vite build). Runtime untrusted multi-tenant execution (Cloudflare Workers for Platforms + Outbound Workers + sandboxed `<iframe>` UI) is documented in `docs/plugin-architecture/UNTRUSTED.md` (Phase 4) without runtime implementation yet.
- **Owner Action**: Confirm whether curated build-time plugins are sufficient for initial release or if Phase 4 Workers for Platforms work should be scheduled next.

### D5. Core Domain Scope & Dogfooding Boundaries (`Status: Pending Owner`)
- **Decision**: Notepads (`notepads`, `notepads_fts`, `edit_locks`, `notepad_links`) and Core Kanban tables (`boards`, `board_columns`, `cards`) remain in core due to deep transactional and FK coupling (`cards(notepad_id, kind) -> notepads(id, kind)` and `saveContentBatch`). Dogfooding is applied to `burrow-cloud` plugins, `publicSharing`, `workspaceExport`, and the `estimation` showcase plugin (`cards.card_type = 'estimate'`).
- **Owner Action**: Confirm that keeping Notepads + Core Boards in core aligns with long-term product roadmap.

---

## Open Questions & Implementation Notes for Review

1. **Legacy Postgres/Node Removal in `burrow-cloud`**: Old Node/Postgres code (`server.ts`, `extensions.sql`, `migrator.ts`) has been preserved under `burrow-cloud/legacy/` per Phase 2.5. When should it be permanently removed?
2. **Typed RPC (`hc<AppType>`) vs. Plugin Routes**: Hono's compile-time `hc<AppType>` cannot infer dynamically mounted `/api/plugins/:id/*` routes. Plugin UI components use typed fetch wrappers or plugin-local `hc<PluginAppType>` clients (`hc<typeof pluginRouter>('/api/plugins/<id>')`). Is that pattern acceptable for community authors?
3. **Submodule vs. Published Package**: During branch development, `burrow-cloud` consumes `@burrow/*` from the pinned `vendor/burrow` git submodule via pnpm workspaces. Should `Burrow` publish `@burrow/sdk` to npm/GitHub Packages separately once `v0.5.0` ships?
