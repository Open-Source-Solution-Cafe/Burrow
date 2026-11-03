# Media support plan (SQLite)

Status: A, B, and C implemented; SQLite gate and production build passed.
Scope: SQLite development/runtime only. PostgreSQL and deployment work are deferred.
SQLite's canonical schema/repositories live under `db/d1` and are shared by the
Node runtime; changes there support SQLite. No PostgreSQL implementation changed
and no existing files were deleted.

## Existing foundation

- `src/core/routes/project-files.ts` accepts authenticated, project-scoped image
  uploads (PNG, JPEG, WebP, GIF, SVG; 5 MB), validates image bytes, registers
  metadata, and serves private files.
- SQLite has a `project_files` registry and local filesystem storage.
- BlockNote's default media blocks use `createMediaUploader`. The `/media`,
  `/image`, and `/video` commands open the Upload / Project library / Link picker.
- Content references and file authorization are project-scoped. Preserve that
  boundary for every media picker, URL, and read route.

## Product behavior

1. In the editor, let editors insert an image by choosing a local file. Reuse
   project-scoped upload and return its authenticated URL to the image block.
2. Add a media insertion chooser with **Upload**, **Project library**, and
   **Link** options. The library is scoped to the current project and lets users
   reuse registered assets without duplicating bytes.
3. Support external video links first for YouTube. Render only recognized,
   normalized provider URLs in an embed; treat other valid URLs as links. Never
   iframe arbitrary hosts.
4. Preserve existing image blocks and cover images. Keep viewer permissions
   read-only and surface upload failures in the UI.

## Implementation checklist

### A. Editor upload (first slice)

- [x] Configure BlockNote's `uploadFile` using the current workspace/project route.
- [x] Use multipart `FormData`; do not set the multipart content type manually.
- [x] Return the API's project-scoped file URL and show a toast on failure.
- [x] Add unit/API coverage for editor upload request shape where feasible; retain
  the existing API tests for authentication, size, MIME, bytes, and scope.

### B. SQLite project library

- [x] Add a project-scoped list endpoint over `project_files`, with deterministic
  ordering and editor/viewer read semantics consistent with project access.
- [x] Add filename and byte size to SQLite file metadata via
  an additive migration. Keep existing rows readable with nullable/defaulted
  metadata; update the SQLite adapter contract cases.
- [x] Build a picker that previews, searches, and inserts existing images. Reuse
  each registered key; don't copy or cross-link project files.
- [x] Defer deletion until references can be tracked and safe orphan cleanup is
  explicit.

### C. External video links

- [x] Add a pure URL normalizer/parser with tests for supported URL variants,
  malformed values, and hostile schemes/hosts.
- [x] Store normalized provider identity and video ID in a custom content block (or
  canonical URL only if BlockNote content compatibility makes that simpler).
- [x] Initially allow YouTube; add other providers only after explicit review.
- [x] Render with a restrictive iframe policy (`youtube-nocookie.com` where
  supported, `title`, `allow`, `referrerPolicy`, and sandbox/permissions as
  compatible). Keep a normal outbound link fallback.

### D. Broader media types (later)

- [ ] Decide supported audio/video/document formats, per-type size limits, storage
  delivery and download behavior, and preview strategy before enabling upload.
- [ ] Extend SQLite validation and metadata deliberately; do not trust browser MIME
  declarations or file extensions.

## Acceptance criteria

- Image upload works from the editor, then survives reload and displays via the
  authenticated project file route.
- Another project/workspace cannot list, insert, or fetch the asset.
- Viewer accounts cannot upload; upload failures are visible and don't silently
  lose the user's editor content.
- Existing image and cover content remains readable.
- Library selection inserts an existing asset without a second upload.
- Only supported video URLs produce embeds; unsupported URLs remain safe links.
- SQLite migrations, API/unit/adapter coverage, `pnpm check:sqlite`, and production
  build pass. No browser/UI automation unless explicitly requested.

## Handoff

### File attachments and upload settings (2026-11-01)

- Card drawer correction: render the native attachment panel in BlockNote's
  registered, themed body portal with fixed positioning. The default editor
  portal sits inside the drawer's scrolling/overflow-hidden ancestors, which
  can clip the upload controls. Preserve the same scoped uploader and block ID.
  Browser interaction remains manually unverified; no UI automation requested.
- User clarified no chooser opens: replaced label activation with a real button
  that synchronously clicks the file input. Removed the policy-query success
  gate that left the chooser disabled when settings failed to load. Cached
  policy still supplies client validation when available; server validation
  remains authoritative for every upload. Only active uploads disable choosing.

- Follow-up correction: Add file now uses an app-styled `EditorFilePanel` with
  the existing shared upload control and policy retry states instead of the
  native Upload/Embed panel. Uploads update the clicked block, generic files stay
  file attachments, and mismatched image/audio/video uploads switch block type.
  Insertion callback failures now surface a toast. Theme startup also restores
  the saved choice before rendering instead of relying on a CSP-blocked inline
  script. No browser automation ran; visual/click acceptance remains manual.
  Final `pnpm check:sqlite` passed (54 files / 299 tests; 62 tests skipped),
  current typecheck and production build passed; existing warnings remain.

- Follow-up requested: allow file attachments, configure project upload size and
  permitted types in Settings, and restore the upload area after failures.
- Keep policy project scoped and owner editable; readers can inspect policy.
  Preserve existing image validation and private project authorization.
- Use BlockNote's existing React file block renderers so upload completion and
  rejection both clear loading state. Keep one uploader for editor and library.
- Added PDF, UTF-8 text/CSV, ZIP/Office containers, MP4/WebM, and MP3/Ogg/WAV
  attachments alongside existing images. Validate binary signatures/text before
  storage; document/archive downloads use attachment disposition.
- Settings exposes supported type checkboxes and a project maximum up to 100 MB
  (default 5 MB). Policy persists privately under the project storage prefix,
  is excluded from file inventory, and is removed on project deletion.
- Picker/library accepts configured types and inserts file blocks for attachments.
  Existing images retain previews. Client validation reports errors before upload;
  server policy remains authoritative for native editor uploads.
- Production build and `pnpm check:sqlite` passed: 53 test files / 296 tests;
  two files / 62 tests skipped for SQLite selection. Existing seven lint warnings
  and large build chunk warning remain. No browser/UI automation ran.

### Media controls and dedicated library follow-up (2026-11-01)

- [x] Give YouTube blocks keyboard-accessible width controls in a compact
  options popover. Persist `widthPercent`; legacy videos default to 100%.
- [x] Add Remove video with in-app confirmation, editor undo, error toasts, and
  current edit-permission checks. Invalid video blocks are removable too.
- [x] Add the scoped `/w/:workspaceId/p/:projectId/library` page and a persistent
  Project library link below the project selector in both sidebar layouts.
- [x] Link to the library from project overview. Reuse the same upload control,
  gallery, account-scoped query key, and project invalidation with the picker.
- [x] Support filename search, image previews/open links, upload progress,
  empty/error/retry states, and viewer browsing with editor-only upload.
- [x] Add width boundary/invalid-value unit cases and the library route helper
  contract. Targeted tests passed; production build passed.
- [x] Combined `pnpm check:sqlite` passed typecheck, Basalt, lint (seven existing
  warnings), and 50 test files / 278 tests. SQLite selection skipped two files
  and 62 tests. Production build passed with the existing large-chunk warning.

Native image blocks retain BlockNote's existing hover resize handles and block
menu removal. YouTube now has explicit controls because its custom iframe block
does not use BlockNote's native resizable-file wrapper. No browser/UI automation
was requested or run, so interaction and playback still need manual acceptance.

Design correction (2026-11-01): removed the permanent video toolbar and separate
outbound-link row. A small options button overlays the centered player; it appears
on hover/focus for fine pointers and remains available on touch. Width, outbound
link, and removal live in its popover, which dismisses on outside interaction,
focus exit, or Escape. The library uses a compact header/upload button, quieter
search, image-led tiles, and subtle filenames/sizes. Shared picker behaviors and
scope remain intact. Production build and `pnpm check:sqlite` passed (50 files /
278 tests; existing seven lint warnings and build chunk warning). No browser/UI
automation ran; visual acceptance remains manual.

Resize-drag correction (2026-11-01): the options anchor captures the video's
width when opened and remains fixed while the player resizes beneath it. Pointer,
mouse, and touch starts are isolated from the editor; native control dragging is
disabled, and the range input captures its pointer across iframe boundaries.
The input's native range behavior remains enabled. Nine width tests, production
build, and `pnpm check:sqlite` passed (50 files / 278 tests; existing warnings).
No browser/UI automation ran; drag interaction remains manually unverified.

Implemented 2026-11-01:

- A: captured upload scope, multipart requests, local scoped URLs, and visible
  HTTP/network/malformed-response failures. Eight uploader unit tests passed.
- B: `GET /api/workspaces/:wid/projects/:pid/media`, newest-first ordering,
  filename/byte-size metadata, and migration `0012_project_file_details.sql`.
  SQLite runtime applies sorted SQL files at startup. Existing rows retain null
  display metadata. The picker searches and inserts existing images without upload.
- C: validated YouTube IDs in a `youtube` block, exact provider parsing,
  privacy-enhanced player, safe web-link fallback, and page CSP permitting only
  the player origin. Twenty-six parser and two middleware unit cases passed.
- Real SQLite endpoint contract covers anonymous/viewer/editor access, scoped
  lists and file reads, legacy rows, uploaded metadata, and ordering. Targeted
  SQLite endpoint + adapter tests passed (two passed; PostgreSQL case skipped).
- Production build passed with the existing large-chunk warning.
  `pnpm check:sqlite` passed typecheck, Basalt, lint (seven existing warnings),
  and 49 test files / 269 tests; two files and 62 tests skipped by the SQLite
  selection. No browser/UI automation ran; visual and
  playback acceptance remains unverified.

Next session: consult the verification above before proceeding to D. Run only SQLite
checks for this workstream; PostgreSQL remains deferred by user instruction.
