---
phase: 37
plan: 03
status: complete
requirements: [INT-04]
completed_at: 2026-04-23
---

# Plan 37-03 Summary: Docker-compose + CI Wiring

## What was built

Docker-compose service and GitHub Actions job that together enforce INT-04: the PR #953 unit test suite passes unchanged against both `SANDBOX_BACKEND=local` (default) and `SANDBOX_BACKEND=remote` (against the sandbox container from Plan 37-01). Developers can spin the sandbox up locally with `pnpm dev:sandbox`.

## Key files modified

| Path | Change |
|------|--------|
| `docker-compose.yml` | Added `sandbox` service on `:8787` between `app-dev` and `dispatcher` blocks, with `/healthz` healthcheck and profiles `dev, minikube, prod`. |
| `package.json` | Added `"dev:sandbox": "docker compose up sandbox"` script. |
| `.github/workflows/pr-checks.yml` | Added `test-unit-sandbox-remote` job as sibling of `test-unit`. Builds sandbox image, starts container, runs the PR #953 test file with `SANDBOX_BACKEND=remote`. |
| `plugins/code/steps/run-code.ts` | Added `normalizeRemoteError()` post-processor so remote-backend error messages match the `Code execution failed: ...` / `Code execution timed out after N second(s)` copy that the local runner produces. Needed to pass the PR #953 test assertions unchanged. |

## Local smoke (the INT-04 gate, reproduced locally)

```
# Build
docker compose build sandbox
 ... Service sandbox  Built

# Start
docker compose up -d sandbox
 ... Container keeperhub-sandbox  Started

# Health
curl -sf http://localhost:8787/healthz
ok

# The gate
SANDBOX_BACKEND=remote SANDBOX_URL=http://localhost:8787 \
  pnpm exec vitest run --dir tests/unit tests/unit/code-run-code.test.ts

 Test Files  1 passed (1)
      Tests  72 passed | 1 skipped (73)

# Same suite vs local backend (control)
pnpm exec vitest run --dir tests/unit tests/unit/code-run-code.test.ts
 Test Files  1 passed (1)
      Tests  72 passed | 1 skipped (73)

# Cleanup
docker compose down sandbox
 ... Container keeperhub-sandbox  Removed
```

Both backends report an identical 72 passed / 1 skipped count. The 1 skipped is the Linux-only `/proc/self/environ` regression that auto-skips on macOS (`process.platform !== "linux"`) — it will run inside the Linux CI runner.

## Grep-anchored acceptance

| Check | Count | Status |
|-------|-------|--------|
| `docker-compose.yml`: `sandbox:` service key | 1 | pass |
| `docker-compose.yml`: `dockerfile: sandbox/Dockerfile` | 1 | pass |
| `docker-compose.yml`: `"8787:8787"` port map | 1 | pass |
| `docker-compose.yml`: `wget ... localhost:8787/healthz` healthcheck | 1 | pass |
| `docker-compose.yml`: accidental `SANDBOX_BACKEND.*remote` | 0 | pass (remote NOT default) |
| `package.json`: `"dev:sandbox"` script | 1 | pass |
| `package.json`: `docker compose up sandbox` (v2 syntax) | 1 | pass |
| `.github/workflows/pr-checks.yml`: `test-unit-sandbox-remote:` job | 1 | pass |
| `.github/workflows/pr-checks.yml`: `SANDBOX_BACKEND: remote` | 1 | pass |
| `.github/workflows/pr-checks.yml`: `SANDBOX_URL: http://localhost:8787` | 1 | pass |
| `.github/workflows/pr-checks.yml`: `docker build -f sandbox/Dockerfile` | 1 | pass |
| `.github/workflows/pr-checks.yml`: `pnpm test:unit tests/unit/code-run-code.test.ts` | 1 | pass |
| `.github/workflows/pr-checks.yml`: YAML validates (python yaml.safe_load) | pass | pass |
| `.github/workflows/pr-checks.yml`: existing `test-unit:` job unchanged | yes | pass |

## Requirements covered

- **INT-04** Existing unit test suite (`tests/unit/code-run-code.test.ts`, 73 tests) passes unchanged against `SANDBOX_BACKEND=local` AND `SANDBOX_BACKEND=remote`. Verified by local smoke; CI gate in place via new `test-unit-sandbox-remote` job.

## Secondary fix delivered inside this plan

`plugins/code/steps/run-code.ts` normalizeRemoteError():

The sandbox service emits error messages like `"Script execution timed out after 1000 ms"` directly from the PR #953 `CHILD_SOURCE` template. The local runner (`runLocal`) rewrites these to `"Code execution timed out after 1 second"` before returning. Without the same rewrite on the remote path, two PR #953 tests fail (`reports syntax errors` expects `Code execution failed: ...` prefix; `wall-clock timeout` expects `timed out after 1 second` format).

The normalizer post-processes `runRemote` output inside `stepHandler`, so downstream consumers (UI, alerting) see identical error copy across backends. Already-wrapped messages (`"Code execution failed:"`, `"sandbox client error:"`, `"No code provided"`, `"Unresolved template variables:"`) pass through unchanged.

## Commits

- `fix(37-02): normalize remote-backend error messages to match local format`
- `feat(37-03): add sandbox service to docker-compose + dev:sandbox script`
- `feat(37-03): add test-unit-sandbox-remote CI job`

## Forward reference

Phase 38 will:
- Wire `SANDBOX_BACKEND=remote` into staging main-app Deployment env via Helm values.
- Swap `SANDBOX_URL` to the intra-cluster Service DNS name (e.g., `http://keeperhub-sandbox-staging.keeperhub.svc:8787`).
- Add the Kubernetes manifests (ServiceAccount with no RoleBindings and no IRSA annotation, `automountServiceAccountToken: false` at both SA and Pod level, Deployment, Service, NetworkPolicy via VPC CNI).
- Run the escape-matrix E2E tests (TEST-01..05) against staging.

Phase 39 will retire the in-pod child_process path after 7-day prod stability and rotate the high-value secrets.
