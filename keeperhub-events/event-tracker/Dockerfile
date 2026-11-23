# Multi-stage Dockerfile for the event tracker service
# Build context: repo root (for pnpm workspace lockfile access)

# ==============================================================================
# Base stage - common setup
# ==============================================================================
FROM node:22-alpine AS base
RUN npm install -g pnpm@10
WORKDIR /app

# ==============================================================================
# Dependencies stage - install and deploy production dependencies
# ==============================================================================
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY event-tracker/package.json ./event-tracker/

RUN --mount=type=cache,id=pnpm-events,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && \
    pnpm deploy --legacy --filter @techops/events-tracker --prod /app/deploy

# ==============================================================================
# Build stage - install all dependencies, type check, and bundle
# ==============================================================================
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY event-tracker/package.json event-tracker/tsconfig.json event-tracker/tsup.config.ts ./event-tracker/
COPY event-tracker/src/ ./event-tracker/src/
COPY event-tracker/lib/ ./event-tracker/lib/

RUN --mount=type=cache,id=pnpm-events,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @techops/events-tracker

RUN pnpm --filter @techops/events-tracker typecheck && \
    pnpm --filter @techops/events-tracker build

# ==============================================================================
# Runtime stage - minimal production image
# ==============================================================================
FROM node:22-alpine AS runtime

RUN apk add --no-cache tini

RUN addgroup -g 1001 -S events && \
    adduser -S events -u 1001

WORKDIR /app

COPY --from=deps /app/deploy/node_modules ./node_modules
COPY --from=build /app/event-tracker/dist ./dist
COPY --from=build /app/event-tracker/package.json ./package.json

RUN chown -R events:events /app

USER events

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
