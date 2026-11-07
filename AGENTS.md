# Agent Rules & Guidelines

## #1 Priority: Standalone Self-Hosted Purity & Permissive Dependency Licensing

- **100% standalone self-hosted architecture.** When planning or implementing any feature in this repository, the #1 consideration is keeping `Burrow` completely self-contained, generic, and free of any external hosted-service dependencies or proprietary coupling.
- **Zero hosted-platform vocabulary.** Never introduce hosted-service, payment, or multi-account control-plane concepts or terminology into `src/`, `migrations/`, `tests/`, `scripts/`, or `docs/`. The automated decoupling guard (`node scripts/check-decoupling.mjs`) must always pass with 0 violations.
- **Zero-friction default configuration.** Self-hosted deployments must work out of the box with Email & Password alone (`docker compose up`). Optional integrations (Magic Link when `RESEND_API_KEY` is configured; OAuth when provider credentials like `GOOGLE_CLIENT_ID` are configured) must remain completely hidden in the UI when their environment variables are not set.
- **Permissive third-party dependencies only.** All npm dependencies must pass `node scripts/check-licenses.mjs` (no copyleft or unknown dependency licenses outside `scripts/license-allowlist.json`).
- **Workspace is always top-level.** `Workspace` (`/w/:workspaceId`) is the top-level container in the application UI and data model.

## First-Class Database Runtimes & Test Gates

- SQLite, Cloudflare D1, and PostgreSQL are all first-class supported database engines.
- The required standard gate is `pnpm check`, verifying both SQLite and PostgreSQL persistence suites (supported locally via Docker or `BURROW_TEST_POSTGRES_URL`, with `pnpm check:sqlite` available for SQLite-only local iterations).
- Repository and schema parity must be maintained across both engines. Any repository modification must ship with corresponding migrations (`migrations/` and `migrations/postgres/`) and shared contract test cases executed against both database adapters.

## UI Testing Instruction

- **Do NOT run browser/UI tests** (including browser subagents, Playwright tests, Puppeteer, or any other browser/UI test automation) unless explicitly requested by the user.
- **DO run API/unit/contract test suites when you touch covered code.** `pnpm exec vitest run <touched-file>` (or the nearest suite) is mandatory verification, not optional. The blanket ban on test suites was lifted 2026-09-25 after a missing-WHERE-clause regression shipped because only typecheck+build ran.
- **The full gate must be green before reporting done:** `pnpm check` (typecheck + basalt guard + eslint + all vitest suites). Never leave it red; a failing gate that everyone ignores is worse than no gate.

## Regression-Test Rule (learned 2026-09-25)

- **Every route/service change ships with an endpoint contract test** asserting its filter/shape semantics — especially "X must not appear in list Y after delete/restore". Tests live in `tests/api/` using the `createWorkerApp` + bootstrap-cookie harness; see `tests/api/notepads-tree.test.ts` as the reference example.
- **Every repository change ships with a contract case** in `tests/adapters/*.contract.test.ts`, executed against each adapter. Adapters must never disagree on filter semantics (D1 vs Postgres drift caused the 2026-09-25 sidebar-delete incident).
- **Shared interfaces carry doc comments stating filter semantics** (e.g. `INotepadRepository.listByProject` = live tree rows only). If you change what a method returns, update its doc comment in the same edit.

## UI Mutation Rule (learned 2026-09-25)

- **No silent mutations.** Every `useMutation` and every fire-and-forget `fetch` write must have an `onError`/catch path that surfaces a toast (sonner) — never `console.error`-only, never an unhandled rejection. Silent failures double every future debug session.
- **No native dialogs for destructive actions.** Use the in-app `ConfirmDialog` (`src/web/components/ui/ConfirmDialog.tsx`); `window.confirm`/`alert`/`prompt` are silently ignored in sandboxed/embedded contexts.

## Algorithmic Isolation & Thin UI Rule (learned 2026-09-25)

- **Decouple spatial/reorder/domain math from JSX.** Never embed complex coordinate math, drag-and-drop projections, cycle detection, or multi-step reordering algorithms directly in React components.
- **Extract to pure, headless modules.** Extract domain and spatial calculations into standalone `.ts` files (e.g. `treeProjection.ts`, `kanbanReorder.ts`).
- **Co-locate unit tests before touching UI.** Any algorithm module must have co-located unit tests (`*.test.ts`) covering all edge cases (empty states, boundaries, cycle/depth limits, invalid IDs) before or alongside UI integration.
- **Components are thin wrappers.** React components should only be responsible for rendering DOM/tokens and forwarding user gestures/events into the tested pure functions.

## Single Source of Truth & Zero Duplicate Implementations (learned 2026-10-26)

- **Zero duplicate implementations.** Whenever you encounter duplicate or copy-pasted implementations across different execution contexts (e.g. CLI scripts vs server vs worker, `dev` vs `start`, adapters vs handlers), NEVER maintain duplicate copies.
- **Refactor to pure, functional single implementations.** Extract shared logic into pure, functional modules (deterministic inputs/outputs, minimal side effects) that serve as the single source of truth across all call sites.
- **Eliminate divergent behavior and delete old code.** Never leave legacy or redundant implementations in place when unifying. All entry points (`pnpm dev`, `pnpm start`, `pnpm dev:worker`, CLI scripts, tests) must consume the exact same canonical code.

## Mobile UI Design & Compact Controls (learned 2026-11-03)

- **Slim, proportional controls over arbitrary 44px blocks.** Do not apply indiscriminate `min-h-[44px]` to small buttons, tag chips, assignee pills, or segmented tabs. Let shared UI components define sizes (`sm: h-7`, `md: h-8`).
- **No artificial mobile wrapping or internal line dividers.** Keep list item rows (such as team member lists or card action rows) continuous and side-by-side (`flex items-center justify-between`) rather than breaking actions onto stacked, divider-separated lines on mobile.
- **Palette & selection styling contrast.** Never use solid saturated highlight backgrounds for entire selection cards that clash with badges or child elements. Use elevated surfaces (`bg-[var(--surface2)]`) with sharp accent outlines (`border-[var(--accent)]`), styling query match `<mark>` tags explicitly for crisp contrast.

## Internal Routing & Canonical Links (learned 2026-11-03)

- **Zero hardcoded route paths in anchors.** Never use plain `<a href="...">` for internal app navigation, and never synthesize path strings (e.g., `${path}/notepads`) that do not exist in the TanStack router tree.
- **Always use `workspaceRoutes.ts` targets.** All internal links must use TanStack Router's `<Link>` or `navigate()` paired with canonical route helpers from `src/web/lib/workspaceRoutes.ts` (`projectTarget`, `notepadTarget`, `boardTarget`, `trashTarget`, `workspaceSettingsTarget`, etc.) to guarantee workspace isolation and prevent 404 "Not Found" errors.

## Parallel Subagent Instruction

- **Ongoing multi-workspace work:** Read and update `docs/MULTI_WORKSPACE_PROGRESS.md`
  when resuming or handing off this work. It records settled product decisions,
  verified progress, remaining migration work, and the mandatory code-economy review.
- **Minimal, live code:** Prefer small pure functions and composition. Every new
  production abstraction needs a current caller. Delete replaced implementations;
  do not leave speculative extension points, unused scaffolding, or TODO fallbacks.
  Favor readable, efficient code over compressed syntax or line-count targets.

- **Always parallelize large tasks.** If a task touches 3+ files, spans multiple independent areas/components, or has separable workstreams (e.g. foundation + feature areas, independent files, research + implementation), split it into parallel `subagent` workers instead of doing it sequentially.
- **Split by disjoint file sets.** Give each subagent an explicit ONLY-these-files scope so edits never overlap. Shared contracts (new APIs, token names, types) must be specified identically in every prompt, or built first by one agent before the others consume them.
- **Verify after merging.** Parallel agents' outputs can drift (e.g. TODO fallbacks, duplicated helpers). After they complete, always re-check ground truth yourself: typecheck, grep for leftovers, and run a build before reporting done.

## Versioning & Changelog Protocol (Learned 2026-11-06)

- **Update `CHANGELOG.md` on every completed task**: Whenever completing an issue, feature, bugfix, or refactor in `Burrow`, add a concise bullet under the relevant heading (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) inside the `## [Unreleased]` section of `CHANGELOG.md`.
- **Zero SaaS / hosted vocabulary in changelog entries**: Never mention `stripe`, `billing`, `enterprise`, `burrow-cloud`, `organization`, `org_id`, `tenant`, or `coolify` in `CHANGELOG.md`. Run `node scripts/check-decoupling.mjs` to ensure 0 violations.
- **Explicit migration notes**: If a task introduces or alters database migrations (`migrations/` or `migrations/postgres/`), add an entry noting the migration and runtime behavior.
- **Agent-driven release cut**: When asked to bump version or cut a release:
  1. Determine SemVer bump (`patch`, `minor`, `major`).
  2. Update `"version"` in `Burrow/package.json`.
  3. Clean up, polish, and promote the `## [Unreleased]` bullet points into `## [X.Y.Z] - YYYY-MM-DD`.
  4. Reset an empty `## [Unreleased]` template block at the top of `CHANGELOG.md`.
  5. Verify `node scripts/check-decoupling.mjs` and `pnpm check`.

