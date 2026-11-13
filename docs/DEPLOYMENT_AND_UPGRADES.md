# Deployment, Configuration, Upgrades & Recovery

This guide covers installing, configuring, upgrading, backing up, and troubleshooting self-hosted **Burrow** on **Cloudflare (Workers + D1 + R2)** and **Docker / Node.js (PostgreSQL or SQLite)**.

---

## Table of Contents

- [Option 1: Cloudflare Edge (Workers + D1 + R2)](#option-1-cloudflare-edge-workers--d1--r2)
  - [Prerequisites](#prerequisites)
  - [One-Command Setup (10 Stages)](#one-command-setup-10-stages)
  - [Custom Domains & Worker Names](#custom-domains--worker-names)
  - [Updating an Existing Cloudflare Deployment](#updating-an-existing-cloudflare-deployment)
- [Option 2: Docker & PostgreSQL Self-Hosting](#option-2-docker--postgresql-self-hosting)
  - [Docker Compose Quick Start](#docker-compose-quick-start)
  - [Updating Docker Deployments](#updating-docker-deployments)
- [Environment Variables & Secret Management](#environment-variables--secret-management)
- [Backup & Restore](#backup--restore)
  - [Cloudflare D1 Time Travel & Export](#cloudflare-d1-time-travel--export)
  - [PostgreSQL & SQLite Backups](#postgresql--sqlite-backups)
- [Troubleshooting](#troubleshooting)

---

## Option 1: Cloudflare Edge (Workers + D1 + R2)

Burrow runs inside Cloudflare's free-tier limits for small teams using a single Worker with static assets, a D1 SQLite database, and an R2 object bucket.

### Prerequisites

1. **Node.js `^20.19.0` or `>=22.12.0`** (required by Vite 8) and **pnpm 10+** (`pnpm --version`).
2. A **Cloudflare account** with **R2 Object Storage activated** in the Cloudflare Dashboard (*Storage & Databases -> R2 Object Storage*). Cloudflare requires activating R2 once on your account before buckets can be created via Wrangler.
3. Authenticated Wrangler CLI (`pnpm exec wrangler login`), or an API token (`CLOUDFLARE_API_TOKEN`) with edit permissions for **Workers Scripts**, **D1**, and **R2**.

### One-Command Setup (10 Stages)

```bash
git clone https://github.com/Open-Source-Solution-Cafe/Burrow.git
cd Burrow
pnpm install
pnpm run setup -r
```

`pnpm run setup -r` executes 10 explicit stages and is safe to re-run after an interrupted attempt:

1. **Stage 1/10 — Checking environment**: Verifies Node `^20.19.0` / `>=22.12.0`, `pnpm`, and local build dependencies (`wrangler`, `tsc`, `vite`).
2. **Stage 2/10 — Authenticating with Cloudflare**: Runs `wrangler whoami --json` and launches `wrangler login` if your session is missing or expired.
3. **Stage 3/10 — Selecting Cloudflare account**: Respects `CLOUDFLARE_ACCOUNT_ID` if configured, auto-selects when one account exists, and prompts cleanly when multiple accounts exist.
4. **Stage 4/10 — Validating resource configuration**: Validates `wrangler.jsonc`, checks remote D1 resources, blocks any mismatched `D1_DATABASE_ID` collision in `.env`, and identifies whether this is a **Fresh installation** or an **Existing installation**.
5. **Stage 5/10 — Provisioning missing resources**: Reuses or creates the D1 database (`burrow`) and R2 bucket (`burrow-files`), writing only to the git-ignored `wrangler.local.jsonc`.
6. **Stage 6/10 — Running database migrations**: Applies pending SQL migrations to remote D1 without deleting existing tables or data.
7. **Stage 7/10 — Configuring secrets**: Lists existing Worker secrets via `wrangler secret list` and preserves already-configured `BETTER_AUTH_SECRET`, `BOOTSTRAP_TOKEN`, and `BETTER_AUTH_URL` values.
8. **Stage 8/10 — Deploying application**: Typechecks, builds the Vite SPA, deploys the Worker + static assets, and uploads only missing secrets via `wrangler secret bulk`.
9. **Stage 9/10 — Verifying deployment**: Polls `/api/health`, `/api/auth/config`, `/api/system/version`, and `/` (SPA HTML shell) so deployment success is verified end-to-end.
10. **Stage 10/10 — Displaying application URL and next steps**: Prints your production URL, database UUID, secret status, and initial `BOOTSTRAP_TOKEN` (only when newly generated).

> **Dry-run preview**: Inspect every stage and command without mutating resources using `pnpm run setup -r -- --dry-run`.

### Custom Domains, Staging & Worker Names

Attach a custom domain on Cloudflare DNS in the selected account (or save `CLOUDFLARE_DOMAIN=notes.example.com` in your local `.env` for future `pnpm run deploy` runs):

```bash
pnpm run setup -r -- --domain notes.example.com
```

Deploy under a custom Worker script name:

```bash
pnpm run setup -r -- --name my-burrow-worker
```

#### Isolated Staging Environment (`burrow-staging`)

Keep all destructive testing, pre-release checks, and migration dry-runs completely separate from production using the built-in `--staging` profile (`burrow-staging` Worker, `burrow-staging` D1, `burrow-staging-files` R2, and git-ignored `wrangler.staging.local.jsonc` / `STAGING_D1_DATABASE_ID`):

```bash
pnpm run setup:staging     # Provision & deploy isolated staging resources
pnpm run deploy:staging    # Migrate & upgrade burrow-staging
pnpm run reset:staging     # Wipe staging D1 data only (production unaffected)
pnpm run teardown:staging  # Tear down staging Worker, D1, and R2
```

To prevent accidental production outages, staging refuses `CLOUDFLARE_DOMAIN` or `--domain burrow.osscafe.com`, and non-interactive production teardown/reset (`-r --force`) is blocked unless `--confirm-production-teardown=DELETE-PRODUCTION-BURROW` or `--confirm-production-reset=RESET-PRODUCTION-BURROW` is explicitly passed. Interactive production teardown additionally requires typing both `TEARDOWN-PRODUCTION` and the exact Worker name.

### Updating an Existing Cloudflare Deployment

To pull the latest changes and safely roll forward an existing Cloudflare Worker:

```bash
git pull origin main
pnpm install
pnpm run deploy
```

`pnpm run deploy` performs the following rollback-safe sequence:
1. Validates environment prerequisites, active Wrangler auth/account, and D1 resource configuration.
2. Runs `check.mjs --sqlite` (typecheck, design guard, license check, decoupling check, ESLint, and tests).
3. Builds the frontend bundle (`vite build`).
4. Records a **D1 Time Travel bookmark** to `.deploy-log/rollbacks.log` (git-ignored) before touching the schema.
5. Applies pending remote D1 migrations (`CI=1`).
6. Uploads the updated Worker and verifies `/api/health`, `/api/auth/config`, `/api/system/version`, and `/`.

Existing Worker secrets (`BETTER_AUTH_SECRET`, `BOOTSTRAP_TOKEN`, `BETTER_AUTH_URL`) and workspace data are preserved across upgrades.

---

## Option 2: Docker & PostgreSQL Self-Hosting

### Docker Compose Quick Start

1. Copy and review `.env` from `.env.example` (generate a unique `BETTER_AUTH_SECRET` and `BOOTSTRAP_TOKEN`).
2. Start PostgreSQL + Burrow:

```bash
docker compose up -d --build
```

3. Verify the running container:

```bash
curl -fsS http://localhost:3005/api/health
```

4. Register your initial workspace Owner account on `/login` using your `BOOTSTRAP_TOKEN`.

When placing Burrow behind a reverse proxy (Caddy, Nginx, Traefik), set `BETTER_AUTH_URL` to your external HTTPS origin (`https://burrow.example.com`) and preserve `X-Forwarded-Host` / `X-Forwarded-Proto` headers.

### Updating Docker Deployments

```bash
git pull origin main
docker compose up -d --build
```

On startup, the Node server automatically applies any pending PostgreSQL (`migrations/postgres/`) or SQLite migrations before serving traffic.

---

## Environment Variables & Secret Management

Keep **secrets** out of version-controlled files (`wrangler.jsonc`, `.env.example`, or git commits). In Cloudflare Workers, secrets live encrypted in Cloudflare Workers Secrets (via `wrangler secret bulk`), while public binding names live in `wrangler.jsonc`.

| Variable | Required | Public / Secret | Purpose |
| :--- | :--- | :--- | :--- |
| `BETTER_AUTH_SECRET` | Yes | Secret | Signing key (32+ bytes) for encrypted user sessions. Generated automatically on Cloudflare setup and preserved on upgrades. |
| `BETTER_AUTH_URL` | Yes | Config / Secret | Canonical external origin (`https://notes.example.com` or `http://localhost:3005`) for auth redirects and CSRF checks. |
| `BOOTSTRAP_TOKEN` | Yes (1st signup) | Secret | One-time setup token required to register the first workspace owner account. Preserved once set; rotate only with `--rotate-bootstrap-token`. |
| `CLOUDFLARE_ACCOUNT_ID` | Multi-account only | Local Env | Optional 32-char Cloudflare account ID for non-interactive multi-account selection. |
| `CLOUDFLARE_DOMAIN` | Optional | Local Env | Saved custom domain attached automatically by production `pnpm run setup -r` / `pnpm run deploy` (ignored in `--staging`). |
| `D1_DATABASE_ID` | Optional | Local Env | Auto-discovered into git-ignored `wrangler.local.jsonc` when unset. Do not commit personal UUIDs into `wrangler.jsonc`. |
| `STAGING_D1_DATABASE_ID` | Optional (Staging) | Local Env | Auto-discovered into git-ignored `wrangler.staging.local.jsonc` for `--staging` commands, isolated from `D1_DATABASE_ID`. |
| `RESEND_API_KEY` | Optional | Secret | Enables Magic Link sign-in and email invitations. When omitted, email/password + copy-link invites work out of the box. |
| `EMAIL_FROM` | Optional | Config | Sender address when `RESEND_API_KEY` is configured. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional | Public ID / Secret | Enables Google OAuth button in `/login` when both are set. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional | Public ID / Secret | Enables GitHub OAuth button in `/login` when both are set. |
| `DATABASE_URL` | Docker / Postgres | Secret | PostgreSQL connection string (`postgres://user:pass@host:5432/db`). When unset in Node mode, uses local SQLite (`SQLITE_PATH`). |

---

## Backup & Restore

### Cloudflare D1 Time Travel & Export

Before every `pnpm run deploy`, Burrow records the current D1 Time Travel bookmark in `.deploy-log/rollbacks.log`.

Inspect current Time Travel bookmarks or export a full SQL snapshot:

```bash
pnpm exec wrangler d1 time-travel info burrow --remote
pnpm exec wrangler d1 export burrow --remote --output backup-$(date +%F).sql
```

Restore D1 to a recorded bookmark or timestamp:

```bash
pnpm exec wrangler d1 time-travel restore burrow --bookmark="<BOOKMARK_ID>" --remote
```

> Note: Restoring a schema backward requires also redeploying the matching previous Worker commit so queries match the restored schema.

### PostgreSQL & SQLite Backups

**PostgreSQL (Docker):**

```bash
# Backup
docker compose exec -T postgres pg_dump -U burrow burrow > burrow-backup.sql

# Restore (stop app container first to drain writers)
docker compose stop burrow
cat burrow-backup.sql | docker compose exec -T postgres psql -U burrow burrow
docker compose start burrow
```

**SQLite (Node.js standalone):**

Stop the server cleanly or use SQLite's online `.backup` command to copy `data/burrow.db` along with the `data/uploads/` directory at the same point in time.

---

## Troubleshooting

- **Expired Wrangler Session (`Authentication error [code: 10000]`)**: Run `pnpm exec wrangler login` and confirm with `pnpm exec wrangler whoami`, then re-run `pnpm run setup -r` or `pnpm run deploy`.
- **Multiple Cloudflare Accounts**: Set `CLOUDFLARE_ACCOUNT_ID=<32-char-id>` in `.env` or run `pnpm run setup -r` in an interactive terminal to choose from the account list.
- **`D1_DATABASE_ID collision` error**: Your `.env` contains a `D1_DATABASE_ID` that differs from the `burrow` database on the active Cloudflare account. Remove the stale `D1_DATABASE_ID` line from `.env` (or switch `CLOUDFLARE_ACCOUNT_ID` to the intended account) and re-run.
- **R2 Error (`[code: 10042]` / `Please enable R2`)**: Activate R2 Object Storage in the Cloudflare Dashboard for your selected account, then re-run `pnpm run setup -r`.
- **Interrupted first owner signup**: See [Bootstrap Recovery & Migration Checks](./BOOTSTRAP_RECOVERY.md) for `POST /api/auth/bootstrap/recover` instructions.
- **Database Integrity Verification**: Run `pnpm run check:data -- --remote` (Cloudflare D1) or `pnpm run check:data:postgres` (PostgreSQL) to execute the read-only invariant suite (`I1`–`I13`).
