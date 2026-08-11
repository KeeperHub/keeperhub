# Multi-stage Dockerfile for the Solana tracker service
# Build context: keeperhub-events/ (pnpm workspace root, for lockfile access)

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
COPY solana-tracker/package.json ./solana-tracker/

RUN --mount=type=cache,id=pnpm-solana,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && \
    pnpm deploy --legacy --filter @keeperhub/solana-tracker --prod /app/deploy

# ==============================================================================
# Build stage - install all dependencies, type check, and bundle
# ==============================================================================
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY solana-tracker/package.json solana-tracker/tsconfig.json solana-tracker/tsup.config.ts ./solana-tracker/
COPY solana-tracker/src/ ./solana-tracker/src/
COPY solana-tracker/lib/ ./solana-tracker/lib/

RUN --mount=type=cache,id=pnpm-solana,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @keeperhub/solana-tracker

RUN pnpm --filter @keeperhub/solana-tracker typecheck && \
    pnpm --filter @keeperhub/solana-tracker build

# ==============================================================================
# Runtime stage - minimal production image
# ==============================================================================
FROM node:22-alpine AS runtime

RUN apk add --no-cache tini

RUN addgroup -g 1001 -S solana && \
    adduser -S solana -u 1001

WORKDIR /app

COPY --from=deps /app/deploy/node_modules ./node_modules
COPY --from=build /app/solana-tracker/dist ./dist
COPY --from=build /app/solana-tracker/package.json ./package.json

RUN chown -R solana:solana /app

USER solana

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
