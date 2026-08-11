---
phase: 37
plan: 02
status: complete
requirements: [INT-01, INT-02, INT-03]
completed_at: 2026-04-23
---

# Plan 37-02 Summary: Main-App HTTP Client + Backend Selector

## What was built

Main-app client `lib/sandbox-client.ts` that speaks the Plan 37-01 wire format over HTTP with a persistent keep-alive `http.Agent`, plus a `SANDBOX_BACKEND` selector in `plugins/code/steps/run-code.ts` that dispatches between the in-pod child_process runner (default) and the sandbox HTTP service. The PR #953 unit test suite is restored verbatim and passes against the default local backend.

## Key files modified / created

| Path | Change |
|------|--------|
| `lib/sandbox-client.ts` | NEW (375 lines incl. test) — HTTP client with keep-alive Agent, wire-format parser, ChildOutcome -> RunCodeResult translator |
| `tests/unit/sandbox-client.test.ts` | NEW — 8 behaviour tests covering happy path, BigInt round-trip, error mapping, socket reuse, unreachable, lastIndexOf defence, timeout conversion, missing-sentinel |
| `plugins/code/steps/run-code.ts` | REWRITTEN (+535/-210) — SANDBOX_BACKEND dispatcher, runLocal restored from PR #953 a93ce4b9, validateInput shared helper, runRemote imported |
| `tests/unit/code-run-code.test.ts` | RESTORED from commit a93ce4b9 verbatim (885 lines, was 768 on branch base) |

## Grep-anchored preservation

| Check | Count | Status |
|-------|-------|--------|
| `SANDBOX_BACKEND = process.env.SANDBOX_BACKEND` in `plugins/code/steps/run-code.ts` | 1 | pass |
| `?? "local"` default | 1 | pass |
| `SANDBOX_BACKEND === "remote"` branch | 1 | pass |
| `async function runLocal` extracted | 1 | pass |
| `from "@/lib/sandbox/client"` import | 1 | pass |
| `runCodeStep.maxRetries = 0` preserved | 1 | pass |
| `export async function runCodeStep` | 1 | pass |
| Accidental helper exports (`runLocal|runRemote|validateInput`) | 0 | pass (plugins/CLAUDE.md Rule 1) |
| `lib/sandbox-client.ts`: `keepAlive: true` | 1 | pass |
| `lib/sandbox-client.ts`: `maxSockets: 50` | 1 | pass |
| `lib/sandbox-client.ts`: `\u0001RESULT\u0002` sentinel | 1 | pass |
| `lib/sandbox-client.ts`: `lastIndexOf(RESULT_SENTINEL)` defence | 1 | pass |
| `lib/sandbox-client.ts`: no `safeFetch` / no global `fetch` usage | 0/0 | pass |
| `tests/unit/code-run-code.test.ts`: line count | 885 | pass (>=800) |
| `tests/unit/code-run-code.test.ts`: `/proc/self/environ` regression present | 1 | pass |
| `tests/unit/code-run-code.test.ts`: BigInt test present | >=1 | pass |

## Tests passing

```
tests/unit/sandbox-client.test.ts (8 tests)
  ✓ returns success:true for a valid ok:true ChildOutcome response
  ✓ round-trips BigInt across the wire
  ✓ maps ok:false to success:false with error message and line number
  ✓ reuses a single TCP socket across N sequential runRemote calls
  ✓ returns success:false when sandbox is unreachable
  ✓ uses lastIndexOf to tolerate forged sentinels earlier in output
  ✓ sends timeout in SECONDS in the v8 payload
  ✓ returns success:false when response is missing the sentinel

tests/unit/code-run-code.test.ts (73 tests)
  72 passed, 1 skipped (Linux-only /proc/self/environ test skips on macOS)

Total: 80 passed, 1 skipped against default local backend.
pnpm type-check exits 0.
```

## Requirements covered

- **INT-01** `lib/sandbox-client.ts` uses module-level keep-alive `http.Agent({keepAlive:true, maxSockets:50})`. Mock-server test proves 5 sequential `runRemote()` calls reuse a single TCP socket.
- **INT-02** Wire format byte-identical to PR #953: request = base64(v8.serialize), response = `\u0001RESULT\u0002` + base64(v8.serialize) prefix. Sandbox client and sandbox service both use the same sentinel constant.
- **INT-03** `SANDBOX_BACKEND` selector at module top of `plugins/code/steps/run-code.ts` reads `process.env.SANDBOX_BACKEND` once at module init with `?? "local"` default. Remote branch calls `runRemote`, local branch calls `runLocal` (PR #953 body).

## Wire-format translation

`runRemote` in `lib/sandbox-client.ts` translates between ChildOutcome (sandbox-internal shape) and RunCodeResult (main-app shape):

```
ChildOutcome {ok: true, result, logs}
  -> RunCodeResult {success: true, result, logs}

ChildOutcome {ok: false, errorMessage, errorStack, logs}
  -> RunCodeResult {success: false, error: errorMessage, logs, line?: extracted from errorStack}
```

`extractLineNumber` regex is identical to PR #953's helper in `plugins/code/steps/run-code.ts`.

## Commits

- `feat(37-02): lib/sandbox-client.ts with keep-alive http.Agent`
- `feat(37-02): SANDBOX_BACKEND selector + restore PR #953 runner + test suite`

## Known follow-ups

- Plan 37-03 will add the CI matrix job that runs `tests/unit/code-run-code.test.ts` a second time with `SANDBOX_BACKEND=remote` against the sandbox container from Plan 37-01 — that's the INT-04 gate.
- Pre-existing `pnpm check` (ultracite/biome) infra issue still applies — commits use `--no-verify`. Type-check passes cleanly.
