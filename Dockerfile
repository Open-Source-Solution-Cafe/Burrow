# ==============================================================================
# Burrow Container Build
# Stage 1: Build @burrow/sdk, web SPA, and bundle server
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Enable Corepack and activate pnpm
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

# Native build dependencies for native modules (e.g. better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy workspace manifests first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY scripts/install-hooks.mjs ./scripts/install-hooks.mjs
COPY packages/core/package.json ./packages/core/package.json
COPY packages/eslint-plugin/package.json ./packages/eslint-plugin/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/worker/package.json ./packages/worker/package.json
COPY packages/plugins/package.json ./packages/plugins/package.json
COPY packages/plugins/_template/package.json ./packages/plugins/_template/package.json
COPY packages/plugins/estimation/package.json ./packages/plugins/estimation/package.json
COPY packages/plugins/hello/package.json ./packages/plugins/hello/package.json
COPY packages/plugins/public-sharing/package.json ./packages/plugins/public-sharing/package.json
COPY packages/plugins/workspace-export/package.json ./packages/plugins/workspace-export/package.json

# Install dependencies (including devDependencies required for build)
RUN pnpm install --frozen-lockfile --config.enable-pre-post-scripts=true

# Copy application source
COPY . .

# Build @burrow/sdk, web frontend, and esbuild Node server
RUN pnpm run build

# Prune devDependencies to keep only production node_modules
RUN pnpm prune --prod

# ==============================================================================
# Stage 2: Production runtime image
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Install curl for container health check
RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV PORT=3005
ENV BURROW_CONTAINER=true

# Copy package manifest, workspace SDK output, production node_modules, compiled assets, and migrations
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

# Expose default application port
EXPOSE 3005

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3005/api/health || exit 1

# Start the Burrow Node server
CMD ["node", "dist/server.mjs"]
