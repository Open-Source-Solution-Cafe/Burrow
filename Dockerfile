# ==============================================================================
# Burrow Container Build
# Stage 1: Build web SPA and bundle server
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Enable Corepack and activate pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Native build dependencies for native modules (e.g. better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy dependency manifests first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install dependencies (including devDependencies required for build)
RUN pnpm install --frozen-lockfile

# Copy application source
COPY . .

# Build web frontend and esbuild Node server
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

# Copy package manifest, production node_modules, compiled assets, and migrations
COPY --from=builder /app/package.json ./package.json
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
