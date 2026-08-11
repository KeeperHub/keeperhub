# Retirement PR Scaffold (Phase 39 success criterion 3)

**Trigger:** After 7 consecutive days of clean prod operation on `SANDBOX_BACKEND=remote`.

**Scope:** Remove the in-pod `child_process.spawn` path from `plugins/code/steps/run-code.ts`. The main app always dispatches to the remote sandbox via `lib/sandbox-client.ts`. Local dev uses `pnpm dev:sandbox` + `SANDBOX_BACKEND=remote + SANDBOX_URL=http://localhost:8787`.

## Branch name

`simon/v1.9-retire-in-pod-sandbox`

## Files to modify

### `plugins/code/steps/run-code.ts` — reduce to ~80 lines

Delete:
- All imports except: `server-only`, `withPluginMetrics`, `withStepLogging` from the step-handler infra, `runRemote` from `@/lib/sandbox/client`, `ErrorCategory` + `logUserError` (optional — only if we keep server-side logging of errors here; runRemote already returns clean RunCodeResult).
- `spawn`, `deserialize` from node:child_process / node:v8 — no longer used here.
- `CHILD_ENV_ALLOWLIST`, `buildChildEnv()`, `CHILD_SOURCE`, `parseChildOutput()`, `runInChild()`, `runLocal()` — entirely removed.
- The `SANDBOX_BACKEND` env read — dispatcher always uses remote.
- `normalizeRemoteError()` — `runRemote` is now the only path, error format is already the main-app format since plans 37-02/03 aligned them.
- `extractLineNumber()`, `VM_LINE_REGEX` helpers — these moved to `lib/sandbox-client.ts` during Phase 37, not needed here.

Keep:
- `DEFAULT_TIMEOUT_SECONDS = 60`, `MAX_TIMEOUT_SECONDS = 120`, `UNRESOLVED_TEMPLATE_REGEX`.
- `stripStringLiterals` + `validateInput` — pre-flight validation still owned by the step.
- `runCodeStep` export, `maxRetries = 0`, `_integrationType`.

Final dispatcher becomes:

```typescript
async function stepHandler(input: RunCodeCoreInput): Promise<RunCodeResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return validationError;
  }
  const rawTimeout = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const clampedSeconds = Math.min(
    Math.max(1, rawTimeout),
    MAX_TIMEOUT_SECONDS,
  );
  return runRemote({
    code: input.code,
    timeoutMs: clampedSeconds * 1000,
  });
}
```

### `tests/unit/code-run-code.test.ts`

The existing 73-test file was restored verbatim from PR #953 in Phase 37 Plan 02. With the retirement:

Option A (preferred — smaller diff):
- Delete the Linux-only `/proc/self/environ` test (lines ~462-500) — it tested the child_process path which no longer exists in the main-app.
- Leave the rest intact. They exercise the behaviour users observe; the implementation swapped from local child_process to remote HTTP + sandbox child_process, but the observable API is unchanged.
- The CI `test-unit-sandbox-remote` job from Phase 37 Plan 03 becomes the sole gate for this file (the `test-unit` job keeps running it too; it runs against the remote backend only now, since that's the only path).

Option B (cleaner, larger diff):
- Move the file to `tests/e2e/code-run-code.remote.test.ts` and wire it to boot the sandbox container via `globalSetup`. Makes the boundary explicit.
- Tradeoff: `tests/unit/` convention weakens; longer test runtime.

Default: Option A.

### Delete or update

- `sandbox/src/run-code.ts` has the runner. Unchanged in retirement — it's the sandbox's implementation; the main app just stops having its own copy.
- `sandbox/src/run-code.test.ts` — unchanged; still tests the sandbox's own runner.

## Acceptance criteria

- [ ] `plugins/code/steps/run-code.ts` contains NO `spawn`, NO `node:child_process`, NO `CHILD_SOURCE`, NO `CHILD_ENV_ALLOWLIST`, NO `runLocal`, NO `SANDBOX_BACKEND` env read.
- [ ] `grep -r 'node:child_process' plugins/code/` returns nothing (anti-assertion).
- [ ] `pnpm check` and `pnpm type-check` exit 0.
- [ ] `pnpm test:unit tests/unit/code-run-code.test.ts` exits 0 (against remote backend — sandbox container running in CI via the existing `test-unit-sandbox-remote` job).
- [ ] The deleted `/proc/self/environ` test from `tests/unit/code-run-code.test.ts` is either removed or moved to `tests/e2e/sandbox-escape/` (where it belongs).
- [ ] PR description references KEEP-332 and links the Phase 38 + Phase 39 escape-matrix results.

## PR description template

```
# Retire in-pod sandbox (KEEP-332)

After 7 days of prod stability on `SANDBOX_BACKEND=remote`, remove the
in-pod child_process fallback. The main app now always dispatches to
the out-of-pod sandbox service (deploy/keeperhub-sandbox/prod/).

**Before:** plugins/code/steps/run-code.ts had a full Node child_process
runner (~440 LOC) as the `SANDBOX_BACKEND=local` path.

**After:** plugins/code/steps/run-code.ts is a thin wrapper around
lib/sandbox-client.ts::runRemote (~80 LOC).

## Why retire

User JS no longer runs in the main-app's Pod, so the scrubbed child_env
defence was only relevant when SANDBOX_BACKEND=local. That path is no
longer reachable in prod (Phase 39 flipped SANDBOX_BACKEND=remote in
Helm values) and deleting it removes a maintenance burden.

## Safety

- The three exfil paths closed by v1.9 (main pod env, K8s SA token,
  IRSA token) remain closed — the sandbox Pod's SA is scrubbed with
  automountServiceAccountToken:false at both SA and Pod level and no
  IRSA annotation. Phase 38's escape-matrix E2E in staging AND Phase
  39's re-run in prod both confirm five-for-five.
- `pnpm dev:sandbox` spins up the sandbox locally via docker-compose so
  developers still have a turn-key local setup.

## Refs

- KEEP-332 (closed by this PR)
- v1.9 milestone summary: .planning/milestones/v1.9-*.md
```
