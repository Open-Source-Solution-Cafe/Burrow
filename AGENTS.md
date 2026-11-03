# Agent Rules & Guidelines

## Current media-support workstream

- Scope this work to the SQLite development/runtime implementation. Do not
  implement or verify PostgreSQL or D1 deployment changes as part of this media
  upgrade. SQLite's shared canonical schema/repositories live under `db/d1`;
  edits there are permitted for the Node SQLite runtime. Use `pnpm check:sqlite`
  as this workstream's required gate; PostgreSQL suites are deferred.
- Preserve existing files and legacy implementations; do not delete files for
  this workstream. Additive SQLite migrations and code are acceptable.
- Track cross-session decisions and checklist progress in
  `docs/MEDIA_SUPPORT_PLAN.md`.

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
