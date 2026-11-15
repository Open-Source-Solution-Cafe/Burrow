# Burrow

**Fast, self-hostable shared team workspace for rich notepads, Kanban boards, and file storage — engineered for Cloudflare Workers + D1 + R2 and Docker + PostgreSQL.**

[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/)
[![Hono](https://img.shields.io/badge/Hono-4.13-E36002.svg)](https://hono.dev/)
[![BlockNote](https://img.shields.io/badge/BlockNote-0.55-111827.svg)](https://www.blocknotejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8.3-646CFF.svg)](https://vite.dev/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers_D1_R2-F38020.svg)](https://workers.cloudflare.com/)
[![Docker and PostgreSQL](https://img.shields.io/badge/Docker-PostgreSQL_17-2496ED.svg)](./docker-compose.yml)

---

![Burrow Kanban board in Modern Dark theme showing sprint columns, card priorities, subtasks, and resizable sidebar](docs/assets/screenshots/kanban-board.png)

---

## Try the Live Demo

Explore a live instance hosted on Cloudflare Workers, D1, and R2 (reset automatically every 2 hours):

- **URL:** <https://burrow.osscafe.com>
- **Email:** `demo@osscafe.com`
- **Password:** `demopassword123`

> Prefer to jump straight to installation? See [Quick Start](#quick-start) or the full [Deployment & Upgrades Guide](docs/DEPLOYMENT_AND_UPGRADES.md).

---

## Core Features & Benefits

- **Workspaces & Scoped Projects**: Organize teams, notes, boards, and media cleanly inside isolated workspaces and projects (`owner`, `editor`, `viewer` roles).
- **Rich Block Notepads & Nested Pages**: Slash commands, checklists, code blocks, callouts, embedded media, document outlines, and hierarchical sub-pages. Uses lease-based document edit locking so team members take turns editing a notepad safely without conflicting overwrites (rather than simultaneous real-time co-editing).
- **Kanban, List & Calendar Views**: Drag-and-drop cards across columns with WIP limits, priorities, due dates, subtasks, tags, comments, and quick-add shortcuts.
- **Instant Full-Text Search (`Cmd+K` / `Ctrl+K`)**: Command palette backed by SQLite FTS5 or PostgreSQL `tsvector` indexes across notepads and board cards.
- **Integrated File & Media Library**: Upload images, videos, and project attachments to **Cloudflare R2**, **S3-compatible storage**, or **local disk** with automatic quota and type validation.
- **Multilingual & Themeable UI**: Instant client-side switching across **English**, **Spanish**, and **French**, plus three curated built-in themes (`Modern Dark`, `Basalt Dark`, `Basalt Light`).

<details open>
<summary><strong>Screenshots: Workspace Dashboard & Nested Document Editor</strong></summary>

![Burrow project dashboard overview in Modern Dark theme with Notepads, Kanban Boards, and customizable sidebar width](docs/assets/screenshots/dashboard-modern.png)

![Burrow rich block document editor showing Engineering Architecture document and nested sub-page tree in the sidebar](docs/assets/screenshots/editor-nested.png)

</details>

---

## Quick Start

### Prerequisites

- **Node.js `^20.19.0` or `>=22.12.0`** (required by Vite 8) and **pnpm 10+** (or **Docker** for container self-hosting)
- A **Cloudflare account** (for edge deployment with [R2 Object Storage activated](docs/DEPLOYMENT_AND_UPGRADES.md#prerequisites))

### Deploy to Cloudflare in 4 Commands

```bash
git clone https://github.com/Open-Source-Solution-Cafe/Burrow.git
cd Burrow
pnpm install
pnpm run setup -r
```

The interactive 10-stage setup verifies your environment, authenticates Wrangler, provisions D1 and R2 if missing, applies SQL migrations safely, deploys the Worker + SPA, configures Worker secrets, verifies live health/auth endpoints, and displays your **Production URL** alongside a one-time **`BOOTSTRAP_TOKEN`** printed only on initial setup so you can register the first Owner account (`BETTER_AUTH_SECRET` is never printed to logs or stdout).

### Try Locally in Development

```bash
pnpm run setup
pnpm dev
```

Runs the API + React app locally using SQLite (`./data/burrow.db`) and local file storage (`./data/uploads`) with zero cloud dependencies.

---

## Deployment Options

### Option A: Cloudflare Edge (Workers + D1 + R2)

Best for zero-maintenance hosting inside Cloudflare's free-tier limits.

- **First-time install or safe retry**: `pnpm run setup -r`
- **Custom domain** (on Cloudflare DNS): `pnpm run setup -r -- --domain notes.example.com`
- **Dry-run preview** (prints all 10 stages cleanly): `pnpm run setup -r -- --dry-run`
- **Safe upgrades**: `git pull && pnpm install && pnpm run deploy` (records a D1 Time Travel bookmark before running migrations, preserves all Worker secrets, and verifies `/api/health`, `/api/auth/config`, `/api/system/version`, and `/` post-deploy).

> Curious about Cloudflare's native one-click deploy button? Read our engineering assessment in [Native Deploy Button Feasibility](docs/CLOUDFLARE_DEPLOY_BUTTON.md).

### Option B: Docker & PostgreSQL

Best for self-hosted servers, VPS environments, and Docker Compose stacks.

**Local Docker evaluation (`http://localhost:3005`, bound strictly to `127.0.0.1`):**

```bash
pnpm run docker:init -- --local-eval
docker compose up -d --build
```

> `pnpm run docker:init -- --local-eval` generates unique stable `.env` secrets and displays your one-time `BOOTSTRAP_TOKEN` cleanly without printing secrets into production container logs.

**Production Docker deployment (internet-accessible):**

```bash
pnpm run docker:init -- --url https://notes.example.com
# Place Caddy / Nginx / Traefik in front of 127.0.0.1:3005 (or set BIND_HOST intentionally)
docker compose up -d --build
```

Includes **PostgreSQL 17**, automatic schema migrations on boot, full-text search via PostgreSQL `tsvector`, and optional S3-compatible object storage. See [Deployment & Upgrades](docs/DEPLOYMENT_AND_UPGRADES.md#option-2-docker--postgresql-self-hosting) for reverse-proxy, environment, and upgrade steps.

---

## Internationalization & Themes

- **Languages**: Built-in **English (`EN`)**, **Español (`ES`)**, and **Français (`FR`)** with one-click switching in the sidebar footer and login screen.
- **Themes**:
  - **Modern Dark** *(Default)* — Sleek dark workspace with a drag- and keyboard-resizable navigation sidebar (`200px`–`480px`).
  - **Basalt Dark** — Industrial two-tier dark rail and compact workspace density.
  - **Basalt Light** — High-contrast warm paper & ink light theme.
- **Responsive Mobile Layout**: Collapsible navigation drawer and mobile-adapted board/editor controls.

<details>
<summary><strong>Screenshots: Basalt Dark, Basalt Light & Mobile Responsive Layout</strong></summary>

![Burrow Kanban board in Basalt Dark theme featuring the two-tier navigation rail](docs/assets/screenshots/theme-basalt-dark.png)

![Burrow Kanban board in Basalt Light theme with warm paper canvas and dark ink text](docs/assets/screenshots/theme-basalt-light.png)

![Burrow mobile responsive board layout at 390x844 viewport with collapsible drawer trigger and search shortcut](docs/assets/screenshots/mobile-layout.png)

</details>

---

## Architecture Overview

Burrow is structured as a hexagonal core decoupled from runtime storage and transport:

```text
src/
├── core/        # Domain services, Hono routes, repositories & infrastructure contracts
├── worker/      # Cloudflare Workers entrypoint + D1 / R2 adapters
├── server/      # Node.js / Docker server + SQLite / PostgreSQL + S3 / local disk adapters
└── web/         # React 19 + TanStack Router + BlockNote + Tailwind CSS SPA
```

This separation lets you run the exact same application locally on SQLite, on Cloudflare's edge with D1 + R2, or in Docker with PostgreSQL — with schema parity tests enforcing behavioral consistency across runtimes.

---

## Security & Privacy

- **Zero-Trust First-Boot Claim**: Initial Owner registration requires `BOOTSTRAP_TOKEN` paired with an atomic email reservation in `bootstrap_state`, preventing drive-by account takeovers on newly deployed public instances. Subsequent users require explicit workspace invitations.
- **Strict Workspace & Project Isolation**: Every resource endpoint enforces workspace membership and role checks before returning data or generating media URLs.
- **Hardened HTTP & Auth Defaults**: Powered by [Better Auth](https://www.better-auth.com/) with CSRF origin checks, security headers, body size bounds, safe upload validation, and optional Magic Link (`RESEND_API_KEY`) or Google/GitHub OAuth (completely hidden when unconfigured).
- **Minimal Terminal Secret Exposure & Zero Telemetry**: Cryptographically random `BETTER_AUTH_SECRET` signing keys are uploaded directly to encrypted Cloudflare Worker secrets and never printed. The one-time `BOOTSTRAP_TOKEN` is shown once in the interactive initial-setup summary (preserved without reprinting on upgrades unless `--rotate-bootstrap-token` is passed) and redacted by the server in production logs. No analytics or telemetry leave your instance.

---

## Documentation, Contributing & License

| Guide | Description |
| :--- | :--- |
| [Deployment, Configuration & Upgrades](docs/DEPLOYMENT_AND_UPGRADES.md) | Complete Cloudflare Workers and Docker/PostgreSQL setup, env reference, Time Travel backups, and troubleshooting |
| [Bootstrap Recovery & Migration Checks](docs/BOOTSTRAP_RECOVERY.md) | Recovering interrupted owner setup, preflight data checks, and storage inventory |
| [Cloudflare Deploy Button Assessment](docs/CLOUDFLARE_DEPLOY_BUTTON.md) | Technical evaluation of one-click Cloudflare provisioning requirements |
| [Contributing Guide](CONTRIBUTING.md) | Architecture walkthrough, local dev commands, `pnpm run check:sqlite`, and screenshot automation |
| [Changelog](CHANGELOG.md) | Version history and unreleased improvements |

Licensed under the [AGPL-3.0-or-later](LICENSE) license. See [CLA.md](CLA.md) for contributor licensing details.
