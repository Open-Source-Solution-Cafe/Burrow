# Native "Deploy to Cloudflare" Button Feasibility Assessment

This document evaluates supporting Cloudflare's native one-click **Deploy to Cloudflare** button (`https://deploy.workers.cloudflare.com/?url=https://github.com/Open-Source-Solution-Cafe/Burrow`) alongside Burrow's verified CLI installer (`pnpm run setup -r`).

---

## Summary Verdict

**Status: Not recommended for advertisement yet (blocked by bootstrap secret & dynamic D1 binding UX).**

Burrow must **not** advertise a one-click Deploy to Cloudflare button until the application supports safe in-browser first-boot setup without pre-configured secrets and static/template D1 provisioning. Today, `pnpm run setup -r` remains the reliable, idempotent, and fully verified Cloudflare deployment method.

---

## Technical Evaluation

| Requirement | Current State in Burrow | Deploy Button Behavior / Gap |
| :--- | :--- | :--- |
| **Worker + Static Assets** | Defined cleanly in `wrangler.jsonc` (`main: src/worker/index.ts`, `assets.directory: ./dist/web`, `nodejs_compat`). | **Compatible.** Standard Vite build + Wrangler asset upload works cleanly in Cloudflare Workers Builds. |
| **Cloudflare D1 Binding** | `wrangler.jsonc` intentionally leaves `database_id` unset so contributors never commit personal UUIDs; `scripts/lib.mjs` discovers/creates `burrow` and writes git-ignored `wrangler.local.jsonc`. | **Gap.** Deploy to Cloudflare provisioning flows expect either explicit template provisioning or an automated binding flow without manual `wrangler.local.jsonc` generation. |
| **D1 Migrations** | Migrations live in `migrations/*.sql` and are applied by `wrangler d1 migrations apply burrow --remote` inside `setup.mjs` and `deploy.mjs`. | **Requires build/deploy hook.** Workers Builds build commands must explicitly chain D1 creation/migration or execute migrations on deploy; failures during unattended builds lack Burrow's recovery prompts and Time Travel bookmarks. |
| **R2 Bucket (`burrow-files`)** | Declared in `wrangler.jsonc` (`r2_buckets[0]`). Requires R2 activation on the target Cloudflare account. | **Partial gap.** Fails cleanly with an actionable error in `setup.mjs` if R2 is not activated; button flows give less clear guidance when R2 dashboard activation is missing on free accounts. |
| **`BETTER_AUTH_SECRET`** | Required 32+ byte secret for session signing (`setup.mjs` generates cryptographically random bytes via `crypto.randomBytes(32)`). | **UX / Security risk.** Asking users to invent or paste a 32-byte random secret manually inside a generic Cloudflare form risks weak user-chosen secrets. |
| **`BETTER_AUTH_URL`** | Required to match the deployed Worker URL (`https://<worker>.<subdomain>.workers.dev` or custom domain) for auth origin validation. | **Chicken-and-egg problem.** During initial button setup, users often do not yet know their exact assigned `workers.dev` subdomain before the first deploy finishes. |
| **`BOOTSTRAP_TOKEN`** | Required during first signup so unauthenticated visitors on a newly deployed public URL cannot hijack the Owner account before the deployer arrives. | **Gap.** Without `setup.mjs` generating and printing a one-time `BOOTSTRAP_TOKEN`, the deployer either has to supply one upfront via Cloudflare secrets or risk leaving registration unconfigured. |
| **Cloudflare Free Tier** | Worker + D1 + R2 free tiers cover typical team usage with zero external services required. | **Compatible.** Once R2 is activated in the Cloudflare Dashboard, all runtime components fit free-tier limits. |

---

## Recommended Next Steps Before Enabling the Button

Before adding a **Deploy to Cloudflare** badge to `README.md`, implement these targeted prerequisites:

1. **Dynamic Origin Fallback for `BETTER_AUTH_URL`**: When `BETTER_AUTH_URL` is omitted in production Workers behind Cloudflare HTTPS, safely derive the canonical origin from validated `request.url` or explicit trusted configuration so a first deploy boots on its `workers.dev` URL without pre-entering the URL.
2. **Managed Worker Secret Fallback / Ephemeral Setup Guard**: Document and support deterministic Worker secret generation or a dedicated Cloudflare Workers Builds deploy hook (`pnpm run build && npx wrangler d1 migrations apply ...`) paired with clear instructions for `BETTER_AUTH_SECRET` and `BOOTSTRAP_TOKEN`.
3. **End-to-End Fresh-Account Validation**: Test the full Cloudflare Dashboard Deploy Button clone -> build -> migrate -> secret entry -> Owner bootstrap flow end-to-end on a clean Cloudflare account before advertising the badge publicly.

Until those three items are completed, continue recommending **`pnpm run setup -r`** as the primary one-command Cloudflare deployment flow.
