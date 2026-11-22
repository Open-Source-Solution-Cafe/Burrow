# Plugin Architecture Implementation Progress

**Started**: 2026-11-22
**Branch**: `feat/plugin-architecture`

## Baseline Repository Hashes (Do Not Modify `master` / `main`)
- `Burrow` `master`: `c26d0ae41d7ec2f2caf3fc8ec87b7678c043f057`
- `burrow-cloud` `main`: `d025c14c53d5e308d23953995a7ad192576001b9`
- `burrow-cloud` `wip/pre-plugin-snapshot`: `d74e3980c3ac59b184d80386e7377bb9a41b23bd`

## Step Log

| Step | Repo | Status | Commit | Notes |
| :--- | :--- | :--- | :--- | :--- |
| 0.1 Git branch setup & plan docs | Both | Done | pending | Created `wip/pre-plugin-snapshot` in `burrow-cloud`, `feat/plugin-architecture` in both repos, and `docs/plugin-architecture/*`. |
| 1.1 Clean cloud/demo leaks | Burrow | Pending | - | - |
| 1.2 Workspace package split | Burrow | Pending | - | - |
| 1.3 `@burrow/sdk` types & manifest | Burrow | Pending | - | - |
| 1.4 Typed event bus (`before`/`after`) | Burrow | Pending | - | - |
| 1.5 `createApp({ plugins })` & route mount | Burrow | Pending | - | - |
| 1.6 `AuthProvider.getPublicConfig()` & Login | Burrow | Pending | - | - |
| 1.7 `plugin_migrations` & `PluginDb` | Burrow | Pending | - | - |
| 1.8 Manifest validation loader | Burrow | Pending | - | - |
| 1.9 Phase 1 tests & `hello` plugin | Burrow | Pending | - | - |
| 2.1 `@burrow/web` composition & pin sync | Both | Pending | - | - |
| 2.2 Port cloud features to D1 plugins | burrow-cloud | Pending | - | - |
| 2.3 Replace path sniffing & raw HTML admin | burrow-cloud | Pending | - | - |
| 2.4 `burrow-cloud` Vite bundle + web plugins | burrow-cloud | Pending | - | - |
| 2.5 `wrangler.jsonc` & `legacy/` archive | burrow-cloud | Pending | - | - |
| 3.1 Unify slash command registry | Burrow | Pending | - | - |
| 3.2 Open `@` mention kinds | Burrow | Pending | - | - |
| 3.3 `cards.card_type` & Kanban UI slots | Burrow | Pending | - | - |
| 3.4 Sidebar & Settings slots | Burrow | Pending | - | - |
| 3.5 Dogfood `publicSharing` & `workspaceExport` | Burrow | Pending | - | - |
| 3.6 `AUTHORING.md`, `_template`, `estimation` plugin | Burrow | Pending | - | - |
| 4.1 `UNTRUSTED.md` design doc | Burrow | Pending | - | - |
| Finish: Quality gates, handoff, push | Both | Pending | - | - |
