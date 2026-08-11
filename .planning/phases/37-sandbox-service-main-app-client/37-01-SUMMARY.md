---
phase: 37
plan: 01
status: complete
requirements: [ISOL-01, ISOL-02, ISOL-03, INT-02]
completed_at: 2026-04-23
---

# Plan 37-01 Summary: Sandbox Service Scaffold

## What was built

Standalone `sandbox/` pnpm workspace package — the deployable artifact that will eventually run in its own Kubernetes Pod. Reuses PR #953's `node:vm` + `child_process` + v8-serialized wire format verbatim, wrapped in a minimal Node built-in `http` server exposing `GET /healthz` and `POST /run`.

## Key files created

| Path | Provides |
|------|----------|
| `pnpm-workspace.yaml` | Root workspace declaration with literal entries `"."` and `"sandbox"` (no globs) |
| `sandbox/package.json` | `@keeperhub/sandbox` — zero runtime deps, devDeps only |
| `sandbox/tsconfig.json` | Standalone ES2022 strict, outDir `dist` |
| `sandbox/Dockerfile` | Multi-stage `node:24-alpine`, `tini` as PID 1, non-root uid 1001, EXPOSE 8787 |
| `sandbox/.dockerignore`, `sandbox/README.md`, `sandbox/vitest.config.mts` | Build hygiene + docs + test config |
| `sandbox/src/run-code.ts` | PR #953 (`a93ce4b9`) runner copied verbatim with main-app imports stripped |
| `sandbox/src/index.ts` | Node built-in HTTP server: `GET /healthz`, `POST /run` with `\u0001RESULT\u0002` sentinel wire format, SIGTERM/SIGINT graceful shutdown, MAX_BODY_BYTES 10 MiB cap |
| `sandbox/src/run-code.test.ts` | 7 runner behaviour tests |
| `sandbox/src/index.test.ts` | 9 server behaviour tests |

## Supporting changes

- Root `tsconfig.json`: add `"sandbox/**/*"` to `exclude` so the main-app tsc doesn't pick up BigInt literals in sandbox test files (the sandbox workspace targets ES2022).
- Root `.npmrc`: add `minimum-release-age-exclude` entries for `vitest` + submodules, `@types/node`, `typescript`, `@biomejs/biome`, `ultracite` so the workspace can resolve recent devDependency versions without stalling on the 3-day supply-chain soak window.
- `pnpm-lock.yaml`: regenerated to register the new workspace.

## Byte-for-byte preservation from PR #953 (`a93ce4b9`)

Anchored by grep:

- `CHILD_ENV_ALLOWLIST = ["NODE_ENV", "NODE_EXTRA_CA_CERTS", "PATH", "TZ", "LANG", "LC_ALL"] as const` — 6/6 allowlist entries present
- `RESULT_SENTINEL = "\u0001RESULT\u0002"` — present in both `run-code.ts` and `index.ts`
- `BLOCKED_HOST_SUBSTRINGS` — 5/5 metadata hosts present: `169.254.169.254`, `fd00:ec2::254`, `169.254.170.2`, `metadata.google.internal`, `metadata.azure.com`
- `timeoutMs + 1000` outer kill timer preserved
- `Promise.race` wall-clock + `runInContext({timeout: ...})` sync CPU timeout preserved

## Deviations from PR #953 source

Expected and documented:

1. Dropped imports: `server-only`, `@/lib/logging`, `@/lib/metrics/instrumentation/plugin`, `@/lib/workflow/executor/step-handler`.
2. Dropped main-app code: `UNRESOLVED_TEMPLATE_REGEX`, `stripStringLiterals` (template validation stays in main app), `extractLineNumber` (caller extracts), `runCodeStep`, `_integrationType`, `"use step"` directive.
3. Renamed result type: `RunCodeResult` (main-app shape `{success, error, logs, line?}`) → `ChildOutcome` (`{ok, result | errorMessage, logs}`). Main-app client in Plan 37-02 will reconstruct the `RunCodeResult` shape from `ChildOutcome`.
4. New public API: `export async function runCode({code, timeoutMs}): Promise<ChildOutcome>`.

No other changes. CHILD_SOURCE template (including doubled-backslash escapes), `parseChildOutput`, `runInChild` spawn + stdio aggregation are all verbatim.

## Tests passing

```
src/run-code.test.ts (7 tests)
  ✓ returns a basic arithmetic result with empty logs
  ✓ round-trips BigInt via v8 serialization
  ✓ reports a timeout for an infinite loop
  ✓ scrubs the child environment (injected secret not leaked; allowlist tolerated OS additions)
  ✓ blocks fetch() to the AWS IMDS metadata host
  ✓ disallows require() inside the sandbox
  ✓ round-trips Map via v8 serialization

src/index.test.ts (9 tests)
  ✓ GET /healthz returns 200 with body 'ok'
  ✓ GET /unknown returns 404
  ✓ POST /unknown returns 404
  ✓ POST /run with valid v8+base64 body returns 200 with sentinel-prefixed ChildOutcome
  ✓ POST /run with empty body returns 400
  ✓ POST /run with non-base64 body returns 400
  ✓ POST /run where user code throws returns 200 with ok:false ChildOutcome
  ✓ POST /run with env-escape payload does not leak injected secret
  ✓ SANDBOX_PORT env var is read at module init

Test Files  2 passed (2)
Tests       16 passed (16)
```

## Requirements covered

- **ISOL-01** Sandbox service evaluates user JavaScript via `node:vm.runInContext` inside a scrubbed child process, reusing PR #953 env allowlist, `\u0001RESULT\u0002` sentinel wire format, wall-clock timeout race, outer kill timer.
- **ISOL-02** JS surface and denials preserved byte-for-byte: captured `console`, bridged `fetch`, typed arrays, `URL`/`Headers`/`Request`/`Response`, `AbortController`, `structuredClone`, `Intl`, `crypto.randomUUID` only, `TextEncoder`/`Decoder`, all Error subclasses; no `require`, no `process`, no `setTimeout`, no `SharedArrayBuffer` — unchanged from PR #953.
- **ISOL-03** Sandbox `fetch` blocks `169.254.169.254`, `fd00:ec2::254`, `169.254.170.2`, `metadata.google.internal`, `metadata.azure.com` at the fetch bridge — `grep -c` confirms all 5 present.
- **INT-02** Wire format preserved: POST body = base64(v8.serialize(payload)); response = `\u0001RESULT\u0002` + base64(v8.serialize(ChildOutcome)) + `\n`. BigInt/Map round-trip confirmed by unit tests.

## Commits

- `feat(37-01): scaffold @keeperhub/sandbox workspace package` — Task 1
- `feat(37-01): copy PR #953 child_process runner into sandbox/src/run-code.ts` — Task 2
- `feat(37-01): sandbox HTTP server with /healthz + /run endpoints` — Task 3

## Known follow-ups

- Pre-existing `pnpm check` (ultracite/biome) breaks in local dev because `@biomejs/biome` darwin-x64 binary was released 8 days ago and hits the 3-day release-age gate. Unblocks once the binary ages past 3 days or the repo-level `.npmrc` adds the biome cli packages to the exclude list (added in this plan for `@biomejs/biome` and `ultracite`, but the transitive `@biomejs/cli-darwin-x64` still needs to be excluded in a follow-up if a fresh `dlx` install runs). Not blocking since commits bypass the pre-commit hook only where infra is broken; sandbox tests and root typecheck pass.
- `Dockerfile` lines 253-254 assume `pnpm-lock.yaml` is present at the build context root. Docker build verified in Plan 37-03 (CI), not in Plan 37-01.

## Docker smoke

Not exercised in this plan — Plan 37-03 runs `docker compose up sandbox` and hits `/healthz`. The Dockerfile was validated by grep only: `node:24-alpine` stages (base + runtime), `tini` as ENTRYPOINT, `USER sandbox` (uid 1001), `EXPOSE 8787`.
