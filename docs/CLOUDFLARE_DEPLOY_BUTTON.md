# Native "Deploy to Cloudflare" Button Guide & Architecture

This document describes Burrow's support for Cloudflare's native one-click **Deploy to Cloudflare** button (`https://deploy.workers.cloudflare.com/?url=https://github.com/Open-Source-Solution-Cafe/Burrow`) alongside Burrow's CLI installer (`pnpm run setup -r`).

---

## Summary Status

**Status: Supported & Active.**

Burrow's Worker entrypoint (`src/worker/index.ts` → `ensureWorkerRuntimeEnv` in `src/worker/bootstrap.ts`) automatically initializes a freshly provisioned Cloudflare Worker + D1 deployment on first request with **zero manual environment variable inputs** required during the Cloudflare Deploy wizard.

---

## How One-Click Deployment Works

| Requirement | Implementation in Burrow |
| :--- | :--- |
| **Worker + Static Assets** | Defined in `wrangler.jsonc` (`main: src/worker/index.ts`, `assets.directory: ./dist/web`, `nodejs_compat`). Cloudflare Workers Builds installs dependencies, builds the SPA (`pnpm run build`), and deploys the Worker + assets. |
| **Zero-Prompt `.env.example`** | All environment variables in `.env.example` are commented out by default so Cloudflare's Deploy to Workers wizard does not prompt for localhost defaults, Docker settings, or static secrets. |
| **Cloudflare D1 Binding & First-Boot Migrations** | `wrangler.jsonc` declares the `DB` binding (`database_name: "burrow"`). On first request (`ensureWorkerRuntimeEnv`), Burrow checks `sqlite_master` and `d1_migrations`, atomically applies any pending migrations from `src/worker/d1-migrations.ts` (byte-for-byte synced with `migrations/*.sql`), and caches readiness per `DB` binding instance. |
| **R2 Bucket (`burrow-files`)** | Declared in `wrangler.jsonc` (`r2_buckets[0]`). Requires R2 Object Storage to be enabled once on the target Cloudflare account (free tier available). |
| **`BETTER_AUTH_SECRET`** | When `BETTER_AUTH_SECRET` is unset or shorter than 32 characters, `ensureWorkerRuntimeEnv` generates a 64-hex CSPRNG secret (`crypto.getRandomValues`) and persists it in D1 (`_worker_runtime_config`) using `INSERT OR IGNORE` so all isolates share one stable secret. Operators can still override it explicitly via Worker Secrets. |
| **`BETTER_AUTH_URL`** | When `BETTER_AUTH_URL` is omitted (or left on a `localhost`/`127.0.0.1` placeholder while serving HTTPS traffic), `deriveWorkerAuthUrl` automatically resolves the canonical origin from validated HTTPS requests (`https://<worker>.<subdomain>.workers.dev`). |
| **First-User Owner Claim (`BOOTSTRAP_TOKEN` Optional)** | When `BOOTSTRAP_TOKEN` is omitted (`GET /api/auth/config` returns `bootstrapTokenRequired: false`), the first user who registers at `/login` atomically claims Owner (`bootstrap_state`) and `/api/auth/sign-up/email` immediately locks to invite-only (`403 invite_required`) as soon as the first workspace exists. Operators who want an explicit pre-setup passphrase can still configure `BOOTSTRAP_TOKEN` (≥ 16 chars) in Worker Secrets or via Docker `pnpm run docker:init`. |

---

## CLI Alternative (`pnpm run setup -r`)

For operators who want automated Time Travel bookmarks, interactive domain binding, and CLI-generated secrets printed once at install time, `pnpm run setup -r` remains fully supported.
