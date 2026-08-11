FROM node:24-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sandbox/package.json ./sandbox/
RUN --mount=type=cache,id=pnpm-sandbox,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @keeperhub/sandbox

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sandbox/package.json sandbox/tsconfig.json ./sandbox/
COPY sandbox/src ./sandbox/src
# Shared grandchild source, imported by sandbox/src/run-code.ts via
# `../../lib/sandbox/child-source.js`. sandbox/tsconfig.json has
# rootDir=".." so tsc can compile this file as part of the sandbox build.
COPY lib/sandbox/child-source.ts ./lib/sandbox/child-source.ts
# Shared SSRF blocklist data (CIDR ranges + hostname patterns),
# imported by lib/sandbox/child-source.ts as a JSON module so the
# specifier resolves identically in both the keeperhub Turbopack
# bundler and the standalone sandbox's strict ESM runtime. See the
# docstring in lib/ssrf-blocklist.ts for the full rationale.
COPY lib/ssrf-blocklist.json ./lib/ssrf-blocklist.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/sandbox/node_modules ./sandbox/node_modules
RUN pnpm --filter @keeperhub/sandbox build

# Runtime: distroless nodejs24. No shell, no busybox, no apk, no package
# manager, no compiler. A successful node:vm escape lands in a process
# whose only spawnable executable is /nodejs/bin/node. The chart's
# readOnlyRootFilesystem + tmpfs /tmp + dropped capabilities seal off
# the rest.
#
# Pinned by digest below for reproducibility; refresh when bumping the
# node 24 line. The tag-only reference is kept in a comment for grep.
# Reference tag: gcr.io/distroless/nodejs24-debian12:latest
# Digest verified against the multi-arch image index on 2026-05-25.
FROM gcr.io/distroless/nodejs24-debian12@sha256:61f4f4341db81820c24ce771b83d202eb6452076f58628cd536cc7d94a10978b AS runtime
WORKDIR /app
# Pod spec sets runAsUser=1001; ensure /app and its contents are owned
# by that uid even though the user is not in /etc/passwd.
COPY --from=build --chown=1001:1001 /app/sandbox/dist ./dist
COPY --from=build --chown=1001:1001 /app/sandbox/package.json ./package.json
USER 1001
ENV NODE_ENV=production
ENV SANDBOX_PORT=8787
EXPOSE 8787
# Distroless nodejs ENTRYPOINT is already ["/nodejs/bin/node"], so CMD
# is just the script path.
CMD ["dist/sandbox/src/index.js"]
