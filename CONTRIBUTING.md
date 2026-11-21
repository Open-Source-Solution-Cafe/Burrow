# Contributing to Burrow

Thank you for your interest in **Burrow**! This guide covers current contribution status, local development, project structure, quality checks, and maintainer workflow expectations.

---

## Contribution Status & Licensing

> **Important Notice:** External pull requests and code contributions are **not** currently accepted.
> If you encounter a bug, have a feature idea, or want to share feedback on self-hosting, please open a GitHub Issue instead of submitting a pull request. External pull requests are closed without review in accordance with our [pull request template](.github/PULL_REQUEST_TEMPLATE.md).

- **Open-Source License:** Burrow is licensed under [AGPL-3.0-or-later](LICENSE). See [README.md](README.md#permanent-self-hosted-commitment--license) for what stays permanently open source and uncapped in the self-hosted release.
- **Contributor License Agreement (`CLA.md`):** [CLA.md](CLA.md) is kept in the repository as a dormant governance safeguard for any future time when external code contributions open, ensuring maintainers retain dual-licensing flexibility alongside `AGPL-3.0-or-later`.

---

## Repository Architecture

Burrow uses a hexagonal architecture so the core workspace application runs identically on **Cloudflare Workers (D1 + R2)** and **Node.js / Docker (PostgreSQL or SQLite + S3/Local)**:

```text
src/
├── core/        # Domain services, Hono API routes, repositories & infrastructure interfaces
├── worker/      # Cloudflare Workers entrypoint & D1/R2 wiring
├── server/      # Node.js / Docker HTTP server, SQLite/PostgreSQL startup & S3/local storage
└── web/         # React 19 + Vite 8 + Tailwind CSS frontend SPA
migrations/      # SQLite / Cloudflare D1 Drizzle migrations
migrations/postgres/ # PostgreSQL Drizzle migrations
scripts/         # Setup, deploy, check gates, invariants & screenshot tooling
tests/           # Unit, adapter contract, API scope & integration suites
```

---

## Local Development

### Prerequisites

- **Node.js `^20.19.0` or `>=22.12.0`** (required by Vite 8)
- **pnpm 10+** (`pnpm install`)

### Running Locally

1. **Quick local SQLite + Vite dev server:**
   ```bash
   pnpm run setup
   pnpm dev
   ```
   Opens the web app on `http://localhost:3005` (or Vite port configured in `dev.mjs`) backed by local SQLite in `data/burrow.db`.

2. **Local Cloudflare Worker (Miniflare D1 + R2):**
   ```bash
   pnpm run setup -- --worker
   pnpm dev:worker
   ```

3. **Docker + PostgreSQL:**
   ```bash
   docker compose up -d --build
   ```

---

## Quality Gates & Tests

Run the full check suite before pushing or opening an internal pull request:

```bash
pnpm run check:sqlite
```

This runs, in order:
1. `tsc -b` — Strict TypeScript project references across `core`, `node`, `worker`, and `web`.
2. `node scripts/check-basalt.mjs` — Design-system token guard over `src/web`.
3. `node scripts/check-licenses.mjs` — Dependency license hygiene check (`MIT`, `Apache-2.0`, `BSD-*`, `ISC` allowed; copyleft third-party packages disallowed).
4. `node scripts/check-decoupling.mjs` — Boundary verification for the public repository.
5. `eslint .` — Linting across server, worker, web, scripts, and tests.
6. `vitest run` — Unit, API, security, and SQLite adapter test suites.

### Additional Verification Commands

- **Data Invariants (SQLite / Worker / PostgreSQL)**:
  ```bash
  pnpm run check:data
  pnpm run check:data -- --worker
  ```
- **Regenerate Documentation Screenshots**:
  ```bash
  node scripts/capture-screenshots.mjs --build
  ```
  Captures fresh Playwright screenshots into `docs/assets/screenshots/` from an isolated temporary server without touching your local `./data` directory.

---

## Database Migrations

- **SQLite / D1**: Edit the Drizzle schema, then generate migrations with `pnpm run db:generate`.
- **PostgreSQL**: Keep schema changes synchronized and generate migrations with `pnpm run db:generate:postgres`.
- Both SQLite/D1 and PostgreSQL schemas must remain functionally equivalent (`tests/unit/schema-parity.test.ts` enforces parity automatically when `pnpm check` runs with PostgreSQL available).

---

## Submitting Changes (Maintainers)

1. Branch from `master`.
2. Keep changes focused, include unit or API tests for behavior changes, and avoid committing `.env`, `.dev.vars`, or `wrangler.local.jsonc`.
3. Record user-facing changes under `## [Unreleased]` in `CHANGELOG.md`.
4. Ensure `pnpm run check:sqlite` (and `pnpm check` when PostgreSQL is available) passes cleanly with zero errors.
