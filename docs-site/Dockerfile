FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files. Both package.json AND pnpm-lock.yaml are required so
# the install resolves to the exact versions the lockfile pins. Without the
# lockfile, pnpm floats every range fresh on each build, which has caused
# transparent registry-side dep regressions to break the docs build with
# Server Components prerender errors.
# pnpm-workspace.yaml comes too, so this install reads the same workspace
# context that produced the lockfile.
COPY docs-site/package.json docs-site/pnpm-lock.yaml docs-site/pnpm-workspace.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules

# Copy docs-site source. The in-repo `docs-site/content` symlink to `../docs`
# is a local dev convenience. Inside the image it would resolve outside /app,
# which Turbopack (Next.js 16) rejects. Remove it and replace with the real
# docs tree copied in directly.
COPY docs-site/ ./
RUN rm -f ./content
COPY docs/ ./content/

# Build the application
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Tell pnpm it's running non-interactively so v11+ doesn't abort on its
# pre-script deps-status check (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
ENV CI=true

RUN corepack enable pnpm && pnpm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built application
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
