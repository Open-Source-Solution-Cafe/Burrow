# Multi-workspace implementation checklist

Status: **in progress — local SQLite development; rollout is not ready**.
Started: 2026-10-26. This file is the durable handoff across chats/sessions.

## Resume here

Resize gesture correction (2026-11-01): YouTube options anchor now stays fixed
while the player resizes. Slider pointer capture and mouse/touch/drag isolation
prevent editor/native drag interference. SQLite gate passed (50 files / 278 tests)
and production build passed. No browser/UI automation ran; manual drag acceptance
remains outstanding. Details in `docs/MEDIA_SUPPORT_PLAN.md`.

Media design correction (2026-11-01): persistent YouTube toolbar replaced with
hover/focus options overlay; touch keeps the compact trigger visible. Width,
open-link, and removal live in a dismissible popover. Library header/upload and
gallery styling are quieter; no new API/storage behavior. `pnpm check:sqlite`
passed (50 files / 278 tests); production build passed. No browser testing ran.

Media follow-up (2026-11-01): YouTube blocks now have persisted width controls
and explicit removal outside the iframe. A dedicated project library page is
linked below the project selector in both sidebar layouts and from project
overview; gallery/upload/query logic is shared with the editor picker.
`pnpm check:sqlite` passed (50 files / 278 tests), and production build passed.
No browser/UI automation ran; see `docs/MEDIA_SUPPORT_PLAN.md` for manual
acceptance limits. PostgreSQL remains deferred; no files were deleted.

Media work checkpoint (2026-11-01): `docs/MEDIA_SUPPORT_PLAN.md` records completed
A/B/C implementation (editor images, scoped project library, YouTube links).
SQLite-only gate passed: 49 files / 269 tests; production build passed. The new
additive `0012_project_file_details.sql` migration is applied by the canonical
SQLite startup migration runner. No PostgreSQL implementation changed, no files
were deleted, and no browser/UI automation ran. This media checkpoint does not
complete the remaining multi-workspace rollout/operational acceptance tasks.

Read this file and `AGENTS.md`, inspect `git status`, then verify the current
implementation before picking the next unchecked item. Do not equate a report
with completed integration. Update this file with commands/results after each
verified slice. Do not mark a phase complete while its tests fail or callers
still use a replaced implementation.

Current checkpoint (2026-10-31): account identity, workspace membership, and
project ownership flow independently through account/workspace APIs,
`/w/:workspaceId` client routes, scoped project requests, query keys, and editor
save/lock handoffs. Multi-membership, workspace management, invitation flows,
scoped project files, structural write guards, and migration plumbing are
implemented. The SQLite-focused acceptance sweep passes (21 files / 51 tests),
SQLite migration/dev-runtime tests pass (17 tests), and `pnpm check:data` passes
all 13 invariants against `dist/local-ui-test/burrow.db`, the isolated current-
schema database clone used by the local UI. Typecheck and production build pass.
The local UI is available at `http://localhost:3005`. No browser automation has
run.

Lifecycle checkpoint: notepad soft-delete and permanent delete are subtree
commands. Board and note restore groups use deletion-operation IDs, preserve
independently deleted descendants, and report ambiguous legacy groups. Atomic
board starter creation and guarded project deletion have shared contracts.

## Completion estimate

Approximately **80% of the full accepted scope** is implemented. This is an
effort-weighted estimate, not a test percentage. Core scope enforcement,
multi-workspace APIs/client behavior, and SQLite persistence are substantially
implemented. Remaining work is focused on SQLite integration acceptance,
operational migration readiness, and the final review gates. Multi-workspace
rollout is not yet ready.

## Accepted product decisions

- An account may own or join multiple workspaces; roles belong to memberships.
- Any signed-in user may create a workspace. Account registration stays
  bootstrap/invite-only. Zero-membership accounts can create or join a workspace.
- Projects inherit workspace membership; there is no private-project ACL.
- Content references, embeds, backlinks, tags, and media stay project-scoped.
  User mentions are workspace-scoped.
- Explicit workspace Search, My Tasks, and Notifications may aggregate projects;
  results carry their actual target scope.
- First release includes create, switch, rename, invite, manage roles, remove, and
  leave. There is no permanent workspace deletion. The last owner must promote
  another owner before leaving; owner protection must be atomic.
- Migration uses a maintenance window. Existing cross-project reference text is
  retained, but previews/navigation/backlinks are disabled and reported.
- Sidebar hierarchy: workspace name/switcher in the top header, with workspace
  settings and creation in its menu; a separate project selector sits below it
  above Favorites. Project page headings retain the project name. Both selectors
  remain available while editing notes, viewing boards, or changing sidebar tabs.

## Code economy review

- [ ] Every new production function/type/module has a current caller.
- [ ] Replaced implementations and obsolete branches are removed in the same
      integrated slice; migration shims are named with a removal condition.
- [ ] One implementation owns each domain rule. Prefer small pure functions and
      composition; keep side effects in adapters/entrypoints.
- [ ] No speculative framework, generic repository, unnecessary class,
      pass-through service, optional safety check, TODO fallback, or unused hook.
- [ ] Reduce repeated computation/queries as well as repeated source.
- [ ] UI forwards gestures to tested headless logic; mutations surface failures.
- [ ] Public repository contracts document scope and live/trash/filter semantics.
- [ ] Targeted API/unit/adapter tests, full `pnpm check`, build, and obsolete-import
      searches pass. No browser/UI automation unless the user requests it.

The boxes above are a reusable review checklist, not aggregate project progress.

## Phase 1 — canonical foundation and trustworthy verification

- [x] Repair test-runner startup; do not skip suites or weaken assertions.
- [x] Infer Hono RPC types from the actual core route graph and remove parallel
      application code maintained only for types.
- [x] Use one SQLite schema for generation, runtime persistence, and test fixtures.
- [x] Unify duplicate document parsers, ordering/parameter helpers, and constants.
- [x] Replace tests importing obsolete services/adapters with tests of live core
      services, repositories, or endpoints; preserve rollback coverage.
- [x] Delete obsolete routes/services/middleware/adapters/helpers after moving
      callers to canonical implementations.
- [x] Remove unused conflicting entity models; canonical live types retain
      millisecond numbers (BetterAuth internal dates are adapter-managed).
- [x] Share runtime-neutral auth/storage/email configuration.
- [x] Unify SQLite migration execution, development launching, and script target
      resolution; seed/check/reset target the selected runtime's real database.

## Phase 2 — scope and atomic persistence

- [x] Separate authenticated account identity from verified workspace/project
      access and remove process-global authorization caching. Tenant routes
      resolve explicit scope; obsolete single-membership API aliases are removed.
- [x] Require explicit workspace/project scope on tenant repository reads, writes,
      child traversal, tags, comments, subtasks, summaries, and locks.
- [x] Require both scope IDs for parent/child traversal. One canonical walker
      detects cycles; live and lifecycle visibility stay distinct.
- [x] Validate membership/role and write preconditions in atomic mutation commands
      for boards, columns, cards, notes, tags, projects, and memberships.
- [x] Revalidate member role/removal actors at commit and protect the last owner,
      including concurrent changes.
- [x] Revalidate project create/update/archive/move/delete authorization at the
      write boundary. Order writes use guarded snapshots and bounded retries.
- [x] Unify workspace provisioning, invite acceptance, guarded membership changes,
      content save, card/board creation, and subtree lifecycle commands.
- [x] Use atomic card creation/content save and remove optional sequential fallbacks.
- [x] Make bootstrap reservation/completion retry-safe and provide token-protected
      recovery with operator guidance.
- [x] Consume invitations and add memberships atomically; validate stored account
      email/expiration and preserve existing same-workspace roles on retry.
- [x] Keep account identity independent of legacy workspace context. Explicit
      workspace selection and account listing are the active client flow.
- [x] Resolve membership from the requested workspace. Remove the old global
      membership lookup and one-membership middleware.
- [x] Scope lock-holder metadata and card/board assignees to current workspace
      members; redact foreign holder identity.
- [x] Guard content save/lock ownership and remove optional atomic-save fallback.
- [x] Use deletion-operation IDs for restore groups; preserve independently
      deleted descendants and report ambiguous legacy groups.
- [x] Enforce scope agreement in SQLite writes with structural guards and triggers;
      migrations do not relocate corrupt existing rows.
- [x] Scope notifications, assignments, locks, references, tags, summaries, and
      media to their owning workspace/project and live source records.
- [x] Exclude inconsistent workspace/project relationships from live/trash lists
      and prevent corrupt parent relationships from cascading across scope.

## Phase 3 — workspace capability and client integration

- [x] Add account identity, workspace list/create, and invite info/acceptance APIs.
- [x] Add scoped workspace context, rename, leave, membership, invitation, project,
      task, notification, search, and suggestion APIs.
- [x] Use explicit workspace project lists and scoped project mutations.
- [x] Remove single-membership aliases from project resource, project, view, and
      session routes. API tests assert removed paths return 404.
- [x] Prevent project home, palette, trash, switcher, and settings from silently
      falling back to another project or a stale selection.
- [x] Scope every project resource, reference, trash, upload, and file request by
      workspace/project membership and ownership.
- [x] Make bootstrap/signup and authenticated workspace creation retry-safe.
      Zero-membership sign-in offers recovery and workspace creation.
- [x] Preserve other memberships on invite acceptance; keep same-workspace retries
      from changing the existing role.
- [x] Start SPA routes at `/w/:workspaceId`; workspace selection is per-tab URL
      state, never an ambient mutable cookie for writes.
- [x] Use one scoped route builder and include account/workspace/project in query
      keys, mutations, invalidations, and optimistic rollback.
- [x] Extract a tested editor save/lock/timer controller; flush before switching,
      release old locks with original scope, and surface failed saves.
- [x] Consolidate tag mutations/auth/invite flows, correct notification routing,
      remove pathname parsing, and handle empty workspace/project states.
- [x] Register project-owned file metadata, validate image bytes, scope media URLs,
      prevent cross-project reuse, and retain shared keys until no registration
      references the bytes.
- [x] Use private/no-store delivery for authenticated files and resolve legacy file
      links only when one registered project can be identified and authorized.

## Phase 4 — SQLite acceptance and migration readiness

- [x] Share endpoint/repository contract cases with the Node/SQLite adapter.
      Latest sweep: 21 files / 51 tests passed.
- [x] Cover dual membership, concurrent tabs/delayed saves, revocation, mixed IDs,
      files/links/tags/trash isolation, and correct workspace aggregates.
- [x] Cover invite/owner races, atomic rollback, unrelated deletion timestamps,
      cache rollback scope, empty states, and migration fixtures.
- [x] Add structural preflight checks, per-project legacy cover registration, and
      a read-only object inventory for missing/unregistered stored objects.
- [ ] Exercise the full workspace management flow in the local UI against the
      isolated SQLite clone; record any defects and fix them before acceptance.
- [ ] Pause writes, back up SQLite DB/file metadata, run migrations, validate, then
      enable multi-membership. Old code must not read new data.
- [x] Document maintenance, backup, migration validation, operational diagnostics,
      and compatible code+data rollback in `docs/BOOTSTRAP_RECOVERY.md`.
- [ ] Run final targeted tests, `pnpm check`, build, SQLite migration/invariant
      checks, and obsolete/unscoped implementation searches.
- [x] Run `pnpm check:sqlite` and record its result. This uses the canonical check
      script for typecheck, Basalt, lint, unit/headless tests, and SQLite adapter
      cases. Other runtime/API suites are outside this command; a passing result
      does not establish their acceptance.

## Verified SQLite work (2026-10-31)

- Sidebar workspace/project hierarchy: split the combined dropdown into a
  workspace header/menu and project selector above Favorites in both theme
  layouts. Context changes keep the selectors available; workspace overview no
  longer implies the first project is selected. Workspace menu owns creation
  and settings; project menu owns project selection/creation. Scope-routing,
  query, and editor handoff checks passed (20 tests), `pnpm check:sqlite` passed
  (45 files / 232 tests), and production build passed. Existing lint/chunk
  warnings remain; no browser automation ran.

- `pnpm check:sqlite` — passed typecheck, Basalt, lint (seven existing warnings),
  and 45 test files / 232 tests. Cases for other adapters remain excluded by the
  SQLite selection. This does not replace API acceptance or the full check gate.
- `pnpm inventory:storage` against the isolated local UI SQLite/upload paths —
  passed: zero registered keys, stored objects, missing objects, or orphans.
  A populated production upload inventory still needs verification.

- `pnpm exec vitest run --config dist/vitest-all-adapter-sqlite.config.mts` —
  **21 files passed; 51 tests passed**.
- `pnpm exec vitest run tests/unit/sqlite-migrations.test.ts
  tests/unit/dev-runtime.test.ts` — **2 files passed; 17 tests passed**.
- `SQLITE_PATH=dist/local-ui-test/burrow.db pnpm check:data` — **13 invariant
  queries passed**. The database is an isolated current-schema clone used by the
  local UI; `data/burrow.db` was not modified by this preflight.
- `pnpm exec tsc -b --pretty false` — passed.
- `pnpm build` — passed; Vite emitted the existing large-chunk warning.
- Local UI: `http://localhost:3005`; no browser automation ran.

## Handoff

- Theme reload correction (2026-11-01): the security policy blocks inline
  scripts, so the HTML initializer never restored the saved theme. Startup now
  applies the existing canonical theme functions before rendering React; removed
  duplicate HTML logic. Headless restoration cases cover all three themes.

- File upload follow-up (2026-11-01): project upload policies are scoped by
  workspace/project, owner editable, and readable by project members. Settings
  uses account-scoped query keys. General attachments reuse the canonical
  uploader, private file routes, and library. React file renderers replace core
  renderers to clear loading after failed uploads; no parallel upload
  implementation or browser automation was added. See MEDIA_SUPPORT_PLAN.md
  for supported formats and final verification.

Keep this task focused on Node/SQLite implementation and acceptance. The isolated
local UI database passes the invariant preflight. Next, complete manual feature
acceptance against that running UI, address any SQLite defects found, then finish
the SQLite migration/backup review and final local gate. Do not mark rollout ready
until those items are complete.
