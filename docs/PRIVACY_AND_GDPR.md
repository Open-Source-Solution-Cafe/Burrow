# Privacy & GDPR Compliance Guide (Self-Hosted Burrow)

This document describes how self-hosted **Burrow** handles personal data, authentication cookies, retention, and self-service GDPR data subject rights, as well as the configuration options available to instance operators.

---

## 1. Personal Data Stored

Depending on how a team uses an instance, Burrow stores the following user-related records in its primary database (`SQLite`, `PostgreSQL`, or `D1`) and object/file storage (`uploads`, `avatars`, or `R2`):

- **Account Identity & Authentication**: Display name, email address, verification status, optional avatar image, password hash (when using Email & Password), and linked external provider account identifiers (when optional OAuth is configured).
- **Sessions & Security Logs**: Active authentication sessions (session token hash, expiration timestamp, IP address, and user-agent string where provided by the runtime) and short-lived rate-limit / IP counters (`rate_limits`).
- **Workspace Membership & Preferences**: Workspace memberships, roles (`owner`, `editor`, `viewer`), workspace invites, and notification records.
- **Authored & Assigned Work Items**: Cards/tasks you are assigned to, comments you authored on cards, and workspace content (notepads, boards, cards, tags, and uploaded attachments) created inside your workspaces.

---

## 2. Cookies & Strictly Necessary Storage

Burrow uses **strictly necessary authentication cookies** (managed by Better Auth, including `better-auth.session_token` and short-lived signed `cookieCache` session metadata) solely to keep signed-in users authenticated and enforce CSRF protection on mutating requests.

- **No advertising, tracking, or third-party analytics cookies** are set by Burrow out of the box.
- Because only strictly necessary session cookies are used for authentication, no invasive tracking banner is injected by default.

---

## 3. Data Subject Rights & Self-Service Controls

Users can exercise their core GDPR rights directly from **Profile & Account** (via the bottom-left account menu, `/w/:workspaceId/profile`):

### Right of Access & Data Portability (GDPR Articles 15 & 20)
- **Endpoint**: `GET /api/account/export` (append `?download=1` to trigger a file download, and optional `&workspaceId=<id>` to scope to a single workspace).
- **UI**: **Download My Data (.json)** button (with workspace selector when you belong to multiple workspaces) under **Profile & Account → Personal Data & Privacy**.
- **Scope**: Always enabled for every authenticated user regardless of workspace role (including `viewer`) or workspace feature flag state. Returns a machine-readable JSON bundle (`schemaVersion: "burrow-personal-export-v1"`) containing your user profile, workspace memberships, assigned tasks, authored comments, and notifications (tagged with `workspaceName`), served with `Cache-Control: private, no-store`. If you have left or been removed from a workspace, your authored comment text and timestamps remain accessible while internal workspace/project/card IDs are redacted (`formerWorkspace: true`).
- Workspace `owner`s can also enable full workspace or project ZIP exports (`workspaceExport`) in **Workspace Settings → Features & System** (`/w/:workspaceId/settings#features`) to export complete boards, notepads, and uploaded media; workspace and project ZIP exports are restricted strictly to workspace `owner`s.

### Right to Rectification (GDPR Article 16)
- **Endpoint**: `POST /api/auth/update-user`
- **UI**: Inline **Display Name** editor (**Save Name**) under **Profile & Account**.
- Users can update their display name immediately at any time.

### Right to Erasure / Account & Workspace Deletion (GDPR Article 17)
- **Account Deletion**: `POST /api/auth/delete-user` (UI: **Delete Account** danger action in **Profile & Account → Personal Data & Privacy**). Deleting your account revokes active sessions and removes your user profile, memberships, and notifications. When you are the sole `owner` of a workspace, Burrow requires you to transfer ownership to another member or delete the workspace first before deleting your account.
- **Workspace Deletion**: `DELETE /api/workspaces/:wid` (UI: **Delete Workspace** danger action for workspace `owner`s). Removes the workspace, its boards/notepads/cards/comments/public shares, and schedules/deletes associated uploaded storage files.

### Note on Shared Content & Residual Display Labels
- Historical `@mention` rich-text chips inside existing collaborative notepads or card descriptions may retain the plain-text display label that was inserted at the time of writing.
- Public read-only share endpoints (`/api/public/shares/:token`) scrub and avoid exposing non-public user email addresses or internal account metadata.

---

## 4. Data Retention & Background Cleanup

- **Authentication Sessions**: Sessions expire automatically (7-day TTL) and are revoked upon sign-out or account deletion.
- **Rate-Limit Records**: Request counters in `rate_limits` track short sliding security windows.
- **Workspace Trash**: Soft-deleted notepads and cards sit in Trash until permanently purged or until the workspace is deleted.
- **Deferred Storage Deletions**: Storage object cleanups queued during deletions are tracked in `pending_storage_deletions` so failed or interrupted file removals can be retried cleanly without leaving orphan media behind.

---

## 5. Operator Transparency & Optional External Processors (GDPR Article 13)

Self-hosted operators can expose their own legal documents directly inside the Burrow login screen and **Profile & Account → Personal Data & Privacy**:

- `PRIVACY_POLICY_URL`: Optional `http://` or `https://` URL linking to your deployment's Privacy Policy.
- `TERMS_OF_SERVICE_URL`: Optional `http://` or `https://` URL linking to your deployment's Terms of Service.

When neither variable is configured (or if an invalid URL scheme is supplied), these links remain hidden so standalone self-hosted deployments require zero external configuration.

### Optional External Sub-Processors
By default, Burrow operates completely standalone (`docker compose up`) without sending personal data to external services. External data transfers occur **only** if an operator explicitly configures optional integrations:
- **Transactional Email (`RESEND_API_KEY`)**: Enables Magic Link sign-in emails and workspace invite emails via Resend. When unset, email links are logged to the server console and Magic Link login is hidden.
- **OAuth Sign-In (e.g., `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)**: Enables external identity provider sign-in. Hidden in the UI when unconfigured.
