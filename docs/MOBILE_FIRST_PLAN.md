# Mobile-First Redesign Plan & Checklist

Status: **in progress — Phases 1 through 5 initial implementations completed and verified; dev server running**.
Started: 2026-11-03. This file is the durable handoff across chats/sessions.

## Architectural Guidelines & Standards

Follows `~/.agents/skills/mobile-first-design`:
1. **Foundation Breakpoint**: Design and verify from **320px minimum screen width** (iPhone SE, small mobile devices) progressively scaling up to tablet (768px) and desktop (1024px+).
2. **Touch Targets**: Minimum **44x44px** hit target for all interactive elements (buttons, toggles, icon triggers, list items) with at least 8px spacing.
3. **No Silent Zoom on iOS**: All text inputs (`<input>`, `<textarea>`, `<select>`) must have font-size $\ge 16\text{px}$ (`text-base sm:text-sm`) on mobile viewports to prevent iOS Safari from automatically zooming into the field upon focus.
4. **Mobile Keyboard Attributes**: Proper `autoComplete`, `inputMode`, `autoCapitalize`, and `spellCheck` flags configured for optimal mobile typing and password autofill.
5. **Safe-Area Insets & Dynamic Viewport**: Leverage `viewport-fit=cover` and dynamic viewport units `min-h-[100dvh]` with `env(safe-area-inset-top)` / `env(safe-area-inset-bottom)`.

---

## Phase Checklist

### Phase 1: Authentication Pages (Completed)
- [x] **Viewport & Container**:
  - [x] Update `index.html` viewport meta tag with `viewport-fit=cover`.
  - [x] Wrap `Login.tsx` in `min-h-[100dvh]` with safe-area padding (`px-4 py-6 sm:p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-[calc(1.5rem+env(safe-area-inset-top))]`).
  - [x] Wrap `InviteAccept.tsx` in `min-h-[100dvh]` with safe-area padding.
  - [x] Reduce card padding from rigid `p-8` to `p-5 sm:p-8` on both pages (increasing usable screen width on 320px devices by ~19%).
- [x] **Input & Typography Improvements**:
  - [x] Ensure all input fields have `text-base sm:text-sm` (preventing iOS Safari auto-zoom).
  - [x] Set `inputMode="email"`, `autoCapitalize="none"`, `spellCheck="false"` on email fields.
  - [x] Set `autoComplete="current-password"` / `autoComplete="new-password"` on password fields.
  - [x] Set `autoComplete="name"` and `autoCapitalize="words"` on name fields.
- [x] **Touch Targets & Visual Polish**:
  - [x] Demo credentials banner: compact mobile layout, comfortable $\ge 44\text{px}$ touch target for "Auto-fill".
  - [x] Sign In / Sign Up toggle: $\ge 44\text{px}$ hit area with clear touch feedback.
  - [x] InviteAccept segmented control: responsive padding/font to avoid label truncation on narrow screens ($\le 360\text{px}$).
  - [x] Copy token code-box: wrap comfortably with responsive copy button.
  - [x] "Without workspace" state: full-width touch-friendly button stack.
- [x] **Verification**:
  - [x] `pnpm check:sqlite` green (54 passed, 2 skipped).
  - [x] Dev server launched and verified on `http://127.0.0.1:3005/`.

---

### Phase 2: Global Shell & Layout
- [x] **Viewport Metadata**:
  - [x] Update `index.html` viewport meta tag with `viewport-fit=cover`.
- [x] **Mobile Header (`AppShell.tsx`)**:
  - [x] Add safe-area top padding `pt-[env(safe-area-inset-top)]`.
  - [x] Display current workspace/project breadcrumb.
  - [x] Add quick-action icons (search trigger, notifications bell).
- [x] **Mobile Drawer & Sidebar (`AppShell.tsx` & `Sidebar.tsx`)**:
  - [x] Restrict drawer container to `max-w-[min(320px,85vw)] w-full` to prevent viewport overflow.
  - [x] Add auto-close on navigation (NotepadTree, boards, projects, settings).
  - [x] Basalt 2-tier sidebar adaptation: collapse rail + secondary panel into a single unified mobile drawer with tab switcher or back navigation.
  - [x] Add dedicated close (`X`) button in Basalt mobile drawer.
  - [x] Safe viewport positioning for bottom account menu popover (`left-2 right-2` / max width `calc(100vw - 2rem)`).

---

### Phase 3: Boards & Views
- [x] **ListView (`ListView.tsx`)**:
  - [x] Replace 5-column rigid CSS grid on mobile with responsive touch-friendly stacked card rows using `md:contents`.
  - [x] Inline mobile task metadata and tag controls.
- [x] **CalendarView (`CalendarView.tsx`)**:
  - [x] Replace month squish on mobile with compact indicator cells (`min-h-16 sm:min-h-28`) and readable chips (`text-[10px] sm:text-[11px]`).
- [x] **CardPanel (`CardPanel.tsx`)**:
  - [x] Add backdrop overlay with tap-to-dismiss on mobile viewports.
  - [x] Add `pb-[calc(0.5rem+env(safe-area-inset-bottom))]` for iPhone home indicator.
  - [x] Fix mobile priority overflow: stack label above control on mobile (`flex-col sm:flex-row`), enable `fullWidth` with responsive segment padding (`px-1 sm:px-2.5 text-[11px] sm:text-[12px]`) so all 4 priority levels (`LOW`, `MEDIUM`, `HIGH`, `URGENT`) fit with zero horizontal clipping.
  - [x] Fix mobile assignees and tags vertical crowding: change from rigid `w-28` 2-column layout to responsive stacked flow (`flex-col sm:flex-row`), allowing member chips and tag badges to wrap horizontally across 100% of the drawer width.
  - [x] Reduce outer padding from rigid `p-6` / `p-4` to `px-3.5 py-4 sm:p-6` / `p-3 sm:p-4`, reclaiming ~30px of horizontal canvas space on small screens.
  - [x] Subtask touch polish in `SubtasksSection.tsx`: compact drag grip (`w-7 h-10`), toggle button (`w-8 h-10`), and delete button (`w-8 h-10`) with touch-visible delete button (`opacity-70 sm:opacity-0 sm:group-hover:opacity-100`) and tap-to-rename support, expanding subtask title text width by >60px to prevent awkward word wrapping.
- [x] **KanbanView (`KanbanView.tsx` & `BoardView.tsx`)**:
  - [x] Board Header Title recovery: replaced bulky `+ ADD COLUMN` button on mobile with a compact icon button (`<span className="hidden sm:inline">Add Column</span>`), recovering >120px so board titles are never squashed into "Spri...".
  - [x] View Switcher prominence: moved the View Switcher (`Kanban | List | Calendar`) out of the overflowing horizontal filter scroll track and into a prominent top subheader row on mobile, giving 1-tap view switching.
  - [x] Responsive column width: changed rigid `w-[300px]` to `w-[calc(100vw-3rem)] max-w-[320px] sm:w-[300px] md:w-[320px]`, giving columns clean margins and a deliberate next-column peek that invites horizontal swipe navigation.
  - [x] Touch-friendly column actions: changed column menu (`...`) and collapse button from `opacity-0 group-hover:opacity-100` to `opacity-100 sm:opacity-0 sm:group-hover:opacity-100`, making rename, WIP limits, and column delete accessible on touch devices.
  - [x] Drag gesture tuning: increased PointerSensor activation distance from 5px to 8px to prevent accidental drag capture during vertical or horizontal scrolling.
  - [x] QuickAddCard polish: reduced chip remove buttons from 44px to compact touch-friendly buttons and set input font to 16px on mobile to avoid iOS Safari auto-zoom.

---

### Phase 4: Notepad Editor (`NotepadEditor.tsx` & `DocumentOutline.tsx`)
- [x] **Header Bar**:
  - [x] Clean, non-colliding single-row header (`h-12 sm:h-14`) eliminating the 7-control squeeze bug.
  - [x] Dedicated `‹ Notepads` back breadcrumb for 1-tap navigation back to project notepads.
  - [x] Hide duplicated title in header on mobile (`hidden sm:inline`).
  - [x] Hide prominent yellow desktop `SHARE` button on mobile (`hidden sm:flex`).
  - [x] Subtle status indicator (diamond dot + compact text).
  - [x] $\ge 44\text{px}$ touch targets on favorite star and action menu.
- [x] **Metadata & Canvas Layout**:
  - [x] Relocate `{tagsNode}` from crowded header to natural metadata row directly beneath the document title.
  - [x] Mobile full-bleed document canvas (`chamfer-none sm:chamfer-lg`, `border-0 sm:border`) eliminating wasteful desktop double-card inset.
  - [x] Safe-area bottom padding (`pb-24`) preventing keyboard overlap.
  - [x] Responsive tag search with $\ge 16\text{px}$ input font to prevent iOS Safari auto-zoom.
- [x] **Actions & Outlines**:
  - [x] Mobile slide-up bottom sheet for `DocumentOutline` with backdrop dismiss and 1-tap auto-scroll + sheet close.
  - [x] Native `navigator.share` integration in document action menu (`···`) with clipboard fallback.

---

### Phase 5: Workspace Settings, Members & Trash
- [x] **AccountHome (`router.tsx`)**:
  - [x] Responsive padding, 100dvh safe-area container, and $\ge 16\text{px}$ inputs.
- [x] **ProjectHome (`ProjectHome.tsx`)**:
  - [x] Responsive padding (`px-4 py-6 sm:px-6 sm:py-8`) and touch-friendly quick action buttons.
- [x] **MembersSettings (`MembersSettings.tsx`)**:
  - [x] Vertically stacked invite form controls on mobile (`flex-col sm:flex-row`).
  - [x] Stacked member row actions (role dropdown + delete button).
- [x] **SettingsView (`SettingsView.tsx`)**:
  - [x] Responsive layout padding (`px-3.5 py-5 sm:py-8 sm:px-6`) and card padding (`p-4 sm:p-6`).
  - [x] Stacked workspace rename form controls on mobile (`flex-col sm:flex-row`).
- [x] **MyTasksView (`MyTasksView.tsx`)**:
  - [x] Full-width stacked filter controls on mobile (`SegmentedControl` + project `Select`).
  - [x] Touch-accessible snooze button (`opacity-70 sm:opacity-0 sm:group-hover:opacity-100`).
- [x] **TrashView (`TrashView.tsx`)**:
  - [x] Responsive filter tabs and stacked action buttons for trashed items.
- [ ] **ProjectMediaLibrary (`ProjectMediaLibrary.tsx`)**:
  - [ ] Responsive grid layout and touch-friendly upload button.

---

## Log & Progress Record
- **2026-11-03**:
  - Created plan and checklist document in `docs/MOBILE_FIRST_PLAN.md`.
  - Added `viewport-fit=cover` to `index.html`.
  - Implemented Phase 1 in `src/web/pages/Login.tsx` and `src/web/pages/InviteAccept.tsx` (100dvh safe-area layouts, `p-5 sm:p-8` responsive cards, 16px inputs to prevent iOS zoom, mobile autofill attributes, enlarged touch targets).
  - Configured `scripts/dev-runtime.mjs` for development environment and started dev server at `http://127.0.0.1:3005`.
  - Implemented Phase 2 updates: `AppShell.tsx` (safe-area padding, mobile search button, drawer max-width constraint) and `Sidebar.tsx` (mobile close button, responsive account menu popover).
  - Implemented Phase 3 updates: `CardPanel.tsx` (backdrop overlay with tap-to-dismiss, safe-area inset bottom), `ListView.tsx` (stacked responsive card layout via `md:contents`), and `CalendarView.tsx` (responsive compact cells and chips).
  - Redesigned Notepad Editor for mobile (`NotepadEditor.tsx` & `DocumentOutline.tsx`):
    - Resolved header collision and overlapping yellow button bug.
    - Added touch-friendly `‹ Notepads` back link.
    - Moved tags below the title on the document canvas.
    - Replaced floating dropdown outline with a mobile slide-up bottom sheet with backdrop.
    - Added native `navigator.share` support with automatic clipboard fallback.
    - Full-bleed mobile canvas without awkward double-boxed card margins.
    - Fixed Save Status & Error Recovery: Removed raw text ("Retry save", "Discard", "Saved", "Saving…") from the top mobile header bar to guarantee zero text collisions. Replaced with fixed 14px status indicator and dedicated full-width Save Error Recovery Banner in document canvas.
    - Added `interactive-widget=resizes-content` to `index.html` viewport meta tag for mobile keyboard support.
  - Implemented Phase 5 updates: `MembersSettings.tsx` (stacked invite form and member rows), `TrashView.tsx` (stacked trashed items and controls), `ProjectHome.tsx`, and `router.tsx` (`AccountHome`).
  - Redesigned Kanban Card Drawer & Subtasks for Mobile (`CardPanel.tsx`, `SubtasksSection.tsx`, `SegmentedControl.tsx`):
    - Eliminated priority button clipping on mobile screens by stacking label and control, enabling `fullWidth`, and applying responsive segment padding so all options (LOW, MEDIUM, HIGH, URGENT) fit comfortably without right-edge truncation.
    - Replaced rigid `w-28` 2-column properties grid with responsive layout: Assignee chips and Tag badges now wrap naturally across full drawer width instead of stacking in a cramped 1-per-line column.
    - Reduced drawer margins from `p-6` to `px-3.5 py-4 sm:p-6` and properties container to `p-3 sm:p-4`, recovering ~30px of usable width on 320px–360px phones.
    - Compacted SubtaskRow control buttons (drag handle, status diamond toggle, delete button) and added touch-visible delete action and tap-to-rename, doubling available width for subtask titles so items like "Set up GitHub Actions cron schedule" don't wrap awkwardly.
  - Optimized Kanban Board Screen and Auxiliary Views (`BoardView.tsx`, `KanbanView.tsx`, `QuickAddCard.tsx`, `MyTasksView.tsx`, `SettingsView.tsx`):
    - Recovered >120px in the Board Header by converting the huge `+ ADD COLUMN` button to a responsive compact icon button on mobile, preventing board names from truncating to "Spri...".
    - Brought the View Switcher (`Kanban | List | Calendar`) out from the end of the overflowing filter track into a prominent top subheader row on mobile viewports for 1-tap switching.
    - Sized Kanban columns responsively (`w-[calc(100vw-3rem)] max-w-[320px] sm:w-[300px]`) with a clean swipe peek for adjacent columns.
    - Made column menu actions (`...`) and collapse controls accessible on touch screens (`opacity-100 sm:opacity-0`).
    - Tuned drag activation distance to 8px to prevent touch jitter during board scrolling.
    - Made snooze button touch-visible in MyTasksView and stacked MyTasks filters.
    - Responsive padding and form stacking across SettingsView.
  - Centralized UI Component Standardization (`Select.tsx`, `Input.tsx`, `Chip.tsx`, `Button.tsx`):
    - Removed indiscriminate `min-h-[44px]` and `text-base` (16px) defaults across shared controls that were bloating filter toolbars and form controls on mobile.
    - Standardized `Select` to default `sizeVariant="md"` (`h-8 px-2.5 py-1 text-xs font-medium`), with scoped `[&_option]:text-xs [&_option]:bg-[var(--surface)] [&_option]:text-[var(--text)]` options, unifying filter dropdowns, card panel column selectors, and table role pickers with the compact proportions of cards.
    - Standardized `Input` to default `sizeVariant="md"` (`h-8 px-2.5 py-1 text-xs`), with `sm` (h-7) and `lg` (h-10) options.
    - Standardized `Chip` to `h-8 px-2.5 text-xs font-semibold` and `Button` `size="sm"` to `h-8 text-[11px]`, ensuring toolbars, search boxes, filter chips, and action buttons align at a uniform 32px height across the entire app.
  - Full required gate passed: `pnpm check:sqlite` (54 passed, 2 skipped, 0 errors).
