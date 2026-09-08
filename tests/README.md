# Tests

## Commands

```bash
pnpm test                    # All vitest tests (unit + integration + e2e vitest)
pnpm test:unit               # Unit tests only
pnpm test:integration        # Integration tests only
pnpm test:e2e                # Playwright E2E (browser)
pnpm test:e2e:ui             # Playwright E2E with interactive UI
pnpm test:e2e:vitest         # All vitest E2E tests
pnpm test:e2e:schedule       # Schedule pipeline infrastructure checks
pnpm test:e2e:schedule:full  # Schedule pipeline with FULL_E2E=true
pnpm test:e2e:runner         # Workflow runner lifecycle tests
```

Makefile targets:

```bash
make test                    # pnpm test
make test-unit               # tests/unit/
make test-integration        # tests/integration/
make test-e2e                # Vitest E2E against local K8s (port-forwards DB + SQS)
make test-e2e-hybrid         # Vitest E2E against docker-compose hybrid deployment
```

---

## Running the Playwright suite locally

The proxy sends any signed-in user without a second factor to `/enroll-mfa`, so
without a bypass token every auth setup fails before a single test runs. Set the
same token on the app and on the run:

```bash
LOAD_TEST_BYPASS_TOKEN=local pnpm dev            # in one shell

DATABASE_URL=postgresql://postgres:postgres@localhost:5433/keeperhub \
LOAD_TEST_BYPASS_TOKEN=local \
pnpm test:e2e                                     # in another
```

Playwright sends the token as a header on every request (`playwright.config.ts`),
and the app compares it in `lib/load-test-bypass.ts`. Two suites expect the MFA
gate to fire and therefore cannot pass with the token set; CI runs them in an
environment it never reuses.

Building a database from scratch follows the order CI uses in
`.github/actions/setup-e2e-db`, which matters: the workflow schema goes first.

```bash
pnpm db:setup-workflow && pnpm db:migrate && pnpm db:seed && pnpm db:seed-test-wallet
```

## Persistent Test Account

The seed script `scripts/seed/seed-test-wallet.ts` provisions a persistent test account used by both Playwright and vitest E2E tests. It is idempotent -- safe to run multiple times.

```bash
pnpm db:seed-test-wallet
```

| Field | Value |
|-------|-------|
| Email | `pr-test-do-not-delete@techops.services` |
| Password | `TestPassword123!` |
| Org Slug | `e2e-test-org` |
| Org Name | `E2E Test Organization` |
| Role | `owner` |

The script also seeds a **Para wallet** (EVM) linked to the test organization, required for `write-contract-workflow.test.ts` and any test that needs on-chain signing. The wallet data is hardcoded from the pre-provisioned Para wallet (same wallet used by keeper-app). No Para API calls are made at seed time.

**Environment variables required for wallet seeding:**

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection |
| `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` / `TURNKEY_ORGANIZATION_ID` | Parent-org credentials used by `createTurnkeyWallet` to provision the test wallet |

If these env vars are missing, the user + org are still created but the wallet step is skipped.

---

## When to Write a Playwright Test vs a Vitest E2E Test

### Playwright (browser E2E)

Use Playwright when the test **requires a browser** or validates **user-visible behavior**:

- UI rendering, layout, and interaction (clicks, form fills, drag-and-drop)
- Navigation flows (sign up, onboarding, page transitions)
- Visual state after actions (toasts, error messages, saved configs reloading)
- Full user journeys that start in the browser ("create workflow, configure trigger, save, reload, verify")

Playwright tests live in `tests/e2e/playwright/`. They run against a live (or deployed) app with a real database. The test user authenticates through the actual sign-up/login UI or via the persistent test account.

**Config:** `playwright.config.ts` -- serial execution (`fullyParallel: false`), single worker, 2 retries, chromium only. Reporter: `github` + `html` in CI, `list` locally. Auto-starts `pnpm dev` locally (disabled in CI and deployed environments).

### Vitest E2E (API/infrastructure)

Use Vitest when the test validates **backend behavior** that does not need a browser:

- API endpoint correctness (auth, status codes, response shapes)
- Database operations and record lifecycle (create, update, query execution records)
- Infrastructure integration (SQS send/receive, DB connectivity, RPC failover)
- Script behavior (workflow-runner exit codes, graceful shutdown, signal handling)
- On-chain interactions (balance checks, gas estimation, nonce management, real transactions)
- Pipeline flows (dispatcher -> SQS -> executor -> API -> runner)

Vitest E2E tests live in `tests/e2e/vitest/`. They connect directly to the database and infrastructure services. Some spawn child processes (workflow-runner). Some hit live RPC endpoints.

**Config:** `vitest.config.mts` -- excludes `tests/e2e/playwright/`, uses `tests/setup.ts` for mocks and env defaults.

### Decision rule

If the assertion is about **what the user sees in the browser**, use Playwright.
If the assertion is about **what happens in the database, queue, API, or chain**, use Vitest.

---

## Testability Signals

Components should announce their state explicitly via data attributes so that Playwright tests can wait deterministically instead of guessing from DOM side effects.

### Principles

1. **Components announce, tests listen.** A test should never have to infer readiness from child element counts, text content, or CSS classes when a data attribute can state it directly.
2. **Prefer expectation waits over selector waits.** Use `await expect(locator).toHaveAttribute()` over `page.waitForSelector()` where possible -- it reads better and aligns with Playwright conventions.
3. **Signals are for state transitions, not static content.** A static heading doesn't need a signal. A panel that fetches data before it's interactive does.

### Signal Types

#### `data-ready` -- async readiness

For components that load data or initialize before they're interactive. Boolean string.

```tsx
<div data-testid="workflow-canvas" data-ready={String(isCanvasReady)}>
```

```typescript
await expect(page.getByTestId("workflow-canvas")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
```

**When to add:** Any component that fetches on mount, initializes a library (React Flow, Monaco), or waits for a WebSocket connection before the user can interact.

**Current usage:** `workflow-canvas.tsx`

#### `data-page-state` -- page-level lifecycle

For pages with distinct render branches (loading, error, empty, ready). String enum.

```tsx
<main data-page-state={pageState}>
```

```typescript
await expect(page.locator("[data-page-state]")).toHaveAttribute("data-page-state", "logged-in-match", { timeout: 15_000 });
```

**When to add:** Any page that computes state from async sources (auth status, API calls, URL params) and renders different branches based on the result.

**Current usage:** `accept-invite/[inviteId]/page.tsx` with states: `loading`, `error`, `not-found`, `logged-in-match`, `logged-in-mismatch`, `logged-out`

#### `data-state` -- component lifecycle

For components with multiple operational phases. String enum. Follows the same idea as `data-page-state` but for sub-page components (panels, overlays, switchers).

```tsx
<button data-testid="org-switcher" data-state={switcherState}>
```

```typescript
await expect(page.getByTestId("org-switcher")).toHaveAttribute("data-state", "ready");
```

**When to add:** Stateful components where the test needs to distinguish between loading, ready, switching, or error states -- especially when the visual difference between states is subtle (spinner vs content swap).

**Current usage:** `org-switcher.tsx` with states: `switching`, `loading`, `ready`

#### `data-testid` -- stable selectors

For identifying elements that tests need to locate. Not a state signal, but the foundation that other signals attach to.

```tsx
<div data-testid="action-grid">
```

**When to add:** Any element that a test interacts with or asserts on. Prefer `data-testid` over CSS classes or text matchers for elements that are structurally important to tests.

**Naming:** Use kebab-case. For dynamic IDs, use `{component}-{identifier}` (e.g., `action-option-http-request`, `action-node-abc123`).

#### `data-value` / `data-*` aliases -- reading data back

The signals above announce *state*; aliases expose *data*. When a test needs to assert on a concrete value (a balance, a count, a resolved address, a saved config), surface it as a `data-*` attribute on a `data-testid`'d element instead of parsing rendered text. Rendered text is formatted for humans (locale separators, truncated `0x12...ef`, units), brittle to copy changes, and often split across child nodes; a data attribute is the raw, stable value the test actually cares about. This is what lets an agent assert on truth rather than on presentation.

```tsx
<span
  data-testid="wallet-balance"
  data-value={balanceWei}            // raw, unformatted -- the test asserts on this
  data-chain-id={chainId}
>
  {formatEther(balanceWei)} ETH      {/* humans read this */}
</span>
```

```typescript
await expect(page.getByTestId("wallet-balance"))
  .toHaveAttribute("data-value", expectedWei);
// or read it for a computed assertion:
const wei = await page.getByTestId("wallet-balance").getAttribute("data-value");
```

Conventions:

- **Raw over formatted.** Expose the unformatted value (`data-value={wei}`, not `"1.23 ETH"`). The test must never re-implement the component's formatter.
- **One value per attribute** for scalars: `data-count`, `data-status`, `data-address`, `data-<entity>-id` (e.g. `data-workflow-id`, `data-execution-id`).
- **Structured payloads via `data-snapshot`.** For a small object a test needs to assert on as a whole (a node's saved args, a resolved trigger config), serialize JSON into a single `data-snapshot` attribute and `JSON.parse` it in the test. Keep it small and intentional -- it is a test contract, not a state dump.

```tsx
<div data-testid="node-abc123" data-snapshot={JSON.stringify({ type, chainId, fnName })} />
```

```typescript
const snap = JSON.parse(
  (await page.getByTestId("node-abc123").getAttribute("data-snapshot")) ?? "{}"
);
expect(snap.fnName).toBe("transfer");
```

- **Lists:** put the alias on each row (`data-testid="row" data-id={r.id}`) so the test locates and reads by value, not by index.
- **Gate cost when it matters.** `data-snapshot` serialization on a hot, frequently re-rendered node is wasted work in production; gate those behind a build flag (e.g. emit only when `process.env.NEXT_PUBLIC_TEST_SIGNALS === "true"`). Plain scalar `data-*` attributes are cheap -- leave them always-on.

### What NOT to signal

- **Static content** that doesn't change after render -- test it with text matchers or role selectors
- **Internal component state** that has no user-visible effect -- tests shouldn't know about implementation details
- **Transient animations** -- wait for the end state, not the transition

### Adding signals to existing components

When retrofitting a component, the priority order is:

1. Does a test currently use `waitForTimeout()` or `waitForLoadState("networkidle")` to wait for this component? Replace with a signal.
2. Does a test wait for a child element as a proxy for parent readiness? Add `data-ready` to the parent.
3. Does a test check multiple DOM properties to infer which state the component is in? Add `data-state` or `data-page-state`.

### Current coverage

| Signal | Component | Values |
|--------|-----------|--------|
| `data-ready` | `workflow-canvas.tsx` | `"true"` / `"false"` |
| `data-ready` | `kpi-cards.tsx` | `"true"` / `"false"` |
| `data-ready` | `runs-table.tsx` | `"true"` / `"false"` |
| `data-ready` | `time-series-chart.tsx` | `"true"` / `"false"` |
| `data-ready` | `workflow-runs.tsx` | `"true"` / `"false"` |
| `data-page-state` | `accept-invite/[inviteId]/page.tsx` | `"loading"`, `"error"`, `"not-found"`, `"logged-in-match"`, `"logged-in-mismatch"`, `"logged-out"` |
| `data-state` | `org-switcher.tsx` | `"switching"`, `"loading"`, `"ready"` |
| `data-testid` | 20+ components | See Key Selectors Reference in CLAUDE.md |

---

## Agent-Driven Test Development

These tests are increasingly authored by a Claude agent in a tight loop. The agent is only as good as the signals it can read back from the browser and the application: write blind, run, fail, repeat is slow and produces flaky tests. The goal of this section is to maximize signal density per iteration and make every failure self-explanatory. It builds on Testability Signals (above) and the Playwright Discovery Framework (below); read both first.

### The loop

1. **Explore live, do not guess.** Drive the page through the Playwright MCP server (`.mcp.json`) -- navigate, click, snapshot, `page.evaluate` -- to confirm selectors, waits, and state transitions *before* writing the test. Or bootstrap with `pnpm discover` / `playwright codegen`.
2. **Author against deterministic signals.** Wait on `data-ready` / `data-state` / `data-page-state`; assert on `data-*` aliases (see "reading data back"). If a needed signal is missing, add it to the component -- never paper over it with `waitForTimeout()` or `networkidle`.
3. **Run one test with full capture** (see "Capture everything").
4. **Read the failure bundle, not the stack alone** -- screenshot, ARIA, console, network, React state, and the correlated server-log slice land in one directory.
5. **Verify against the production build** for prod-sensitive tests before calling it done (see "Dev vs production runtime").

### Capture everything (dev config)

Author with a dev-tuned Playwright config (e.g. `playwright.dev.config.ts`) that maximizes observability, distinct from the lean CI config:

| Setting | CI | Dev / agent |
|---------|----|-----|
| `trace` | `on-first-retry` | `on` -- per-action DOM, network, console, and timeline in every `trace.zip` |
| `video` | off | `retain-on-failure` |
| console + network capture | off | on -- piped into the failure bundle |
| React state capture | off | on (dev build only -- see below) |
| reporter | `github` + `html` | `list` + `json` (compact, machine-readable) |

Provide a wrapper command (e.g. `pnpm test:e2e:agent <file>`) that runs a single test, attaches all captures, and prints a compact result: pass/fail plus the absolute paths to the failure bundle. The agent reads paths, not scrollback.

### Signals the agent reads back

| Source | What it answers | How |
|--------|-----------------|-----|
| ARIA snapshot (`.probes/aria-snapshot.yaml`) | what the user sees / `getByRole` targets | `probe()`, discovery framework |
| `data-ready` / `data-state` / `data-page-state` | is it ready / which branch rendered | `toHaveAttribute()` waits |
| `data-*` aliases / `data-snapshot` | the actual values the UI holds | `getAttribute()` / `JSON.parse` |
| Console log | client errors, warnings, app logs | `page.on("console")` into the bundle |
| Network | which API call failed, status and body | `page.on("response")` for 4xx/5xx into the bundle |
| React fiber state | *why* it looks that way (props / hooks / atoms) | `probeReactState()` (dev only) |
| Server logs (correlated) | what the backend did for this exact action | `x-test-run-id` header into the log grep |
| Database (read + write) | did it persist / arrange a precondition | `tests/utils/db.ts` helpers, psql on `localhost:5433` |
| `kh` CLI | API-level inspect or repro, as a user would | `kh ...` (auth + CF Access handled via `~/.config/kh/hosts.yml`) |
| KeeperHub MCP | structured API surface for a deployed env | `mcp__keeperhub-dev__*` / `mcp__keeperhub-staging__*` |

### Inspect and mutate application state

The agent is not limited to reading the browser. To investigate *why* a flow behaves a certain way, or to arrange a precondition a UI path can't easily reach, it has three out-of-band channels into the same application and database the test drives:

- **Database (direct).** The fastest way to assert ground truth ("did the workflow row save with the right config?") and to seed exact preconditions the UI would take many steps to build. Use `tests/utils/db.ts` helpers (`createTestWorkflow`, `createApiKey`, `waitForWorkflowExecution`, `getDbConnection`) or psql against the local DB (`localhost:5433`).
- **`kh` CLI.** Drive the KeeperHub API the way a user would, with auth and Cloudflare Access handled automatically (`~/.config/kh/hosts.yml`) -- create, list, and inspect resources, or reproduce an API-level repro outside the browser. Never hand-roll `curl` / `fetch` against KeeperHub endpoints (root CLAUDE.md policy).
- **KeeperHub MCP tools** (`mcp__keeperhub-dev__*` / `mcp__keeperhub-staging__*`). The same API surface as structured tools -- workflow schemas, resource CRUD -- for inspecting a deployed environment in remote-mode tests or cross-checking the app's contract.

The split: **arrange and verify ground truth out-of-band** (DB, `kh`, MCP); **assert what the user sees in the browser** with Playwright. Mutating state to investigate is encouraged -- e.g. flip a workflow to disabled in the DB, then assert the UI reflects it -- but keep each test's setup explicit and reset so runs stay deterministic.

### React component state capture

Implement `probeReactState(page, selector)` (design sketched under "Future: React Component State Capture" below): walk the fiber from the matched DOM node to the nearest component boundary and serialize props plus hook/atom state into the failure bundle. This is the difference between "button disabled" and "`paraStatus: pending` -- the create call is still in flight". Scope it to a subtree around the failure point. It is **dev-build only** -- production strips `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which is a primary reason to author in dev mode.

### Browser-to-server correlation

The dev config injects an `x-test-run-id` (and a per-action id) via `extraHTTPHeaders`. The app echoes it into its structured logs, so the agent can pull *exactly* the server-side log slice for the action it just performed -- closing the gap between a stuck UI and the 500 that caused it. Pair it with the existing `X-Test-API-Key` rate-limit bypass.

### Determinism

- **Expand signal coverage.** The agent's reliability ceiling is the fraction of stateful components that announce readiness. Treat a missing signal as the bug, not the test.
- **Stub non-deterministic dependencies** (Turnkey / Para, OpenAI, chain RPC) with route interception for UI-flow tests, so the agent is not chasing external flake while authoring. Keep real on-chain / integration runs in a separate, explicitly tagged tier.
- **Known DB state per test** via the seed helpers; never depend on leftover data. Note the persistent test account is shared across suites -- Playwright teardown deletes it, which breaks vitest e2e if they run against the same DB.

### Dev vs production runtime

Author in dev; gate in prod. They are not interchangeable in this repo:

| | `pnpm dev` (author) | `pnpm build && pnpm start` (verify / CI) |
|-|---------------------|------------------------------------------|
| React fiber state capture | Yes (DevTools hook present) | No (stripped) |
| Source maps / readable stacks | Yes | Minified |
| Iteration speed | Fast (HMR) | Slow (rebuild) |
| Production-only behavior | Hidden | Exercised |

Tests that assert a production contract must be validated against the built app: e.g. `back-forward-hydration.test.ts` (`NEXT_BUILD_MODE=production`) and any webhook-triggered workflow (the Workflow DevKit graphile worker only advances runs under a production runtime; under `next dev` such runs hang at `pending`). Develop with rich dev signals, then run the prod-sensitive subset the way CI does before considering the test done.

---

## CI Execution Model

All E2E tests are managed by workflow files under `.github/workflows/`.

### Trigger summary

| Event | Ephemeral vitest | Ephemeral playwright | Remote playwright |
|-------|-----------------|---------------------|-------------------|
| Push to `staging`/`prod` | Yes | Yes (gates deploy) | Gated by `ENABLE_E2E_REMOTE_TESTS` var (post-deploy) |
| PR with `run-e2e-tests-ephemeral` label | Yes | Yes | No |
| `[skip e2e]` in commit message | Skipped | Skipped | Skipped |

Ephemeral tests are gated by the `ENABLE_E2E_EPHEMERAL_TESTS` repo variable. When disabled, e2e jobs become no-ops and deploy proceeds unconditionally.

### Execution order on push to staging/prod

```
ci-pipeline.yml:
    |
    +-- build-images.yml (Docker images to ECR)
    |
    +-- e2e-tests-ephemeral.yml (needs build-images)
    |        |
    |        +-- e2e-vitest-ephemeral (DB + SQS + built app)
    |                 |
    |                 +-- e2e-playwright-ephemeral (DB + built app, serial)
    |
    +-- deploy-keeperhub.yaml (needs build-images + e2e-tests, blocked on failure)
    |        |
    |        +-- deploy (Helm to EKS)
    |        |
    |        +-- e2e-playwright-remote (against deployed URL, gated by ENABLE_E2E_REMOTE_TESTS)
    |
    +-- release.yml (prod only, needs deploy, blocked on failure)
    |
    +-- docs-sync.yml (prod only, needs release)
```

### Playwright stability decisions

- **Serial execution** (`fullyParallel: false`, `workers: 1`): shared persistent test user session makes parallel unsafe
- **Retries: 2**: handles environmental flakiness; 3 consecutive failures = real failure
- **No sharding**: single runner completes full suite in ~6 min; sharding added cost without speed gain
- **Deterministic waits**: `data-ready`, `data-state`, `data-page-state` attributes replace `waitForTimeout()` and `networkidle`
- **Reporter**: `github` in CI (annotates PRs), `list` locally

---

## Test Index

### Unit Tests (`tests/unit/`)

No external infrastructure. All dependencies mocked. Covers Web3 utilities, RPC providers, scheduling, conditions, billing, protocol plugins, metrics, and more. Run `ls tests/unit/` for the full list.

### Integration Tests (`tests/integration/`)

Mock the database and HTTP layer but test real module wiring. Covers API routes (ABI, chains, execution, billing, admin), workflow duplication, schedule sync, and the workflow-runner process. Run `ls tests/integration/` for the full list.

### Vitest E2E Tests (`tests/e2e/vitest/`)

Run against real infrastructure (DB, SQS, RPC endpoints). Some spawn child processes.

| File | What it tests | Infra |
|------|---------------|-------|
| `api-key-auth.test.ts` | API key auth across all workflow endpoints (valid, invalid, expired, revoked, cross-org) | DB, App |
| `check-balance.test.ts` | Balance checking on EVM (Mainnet, Sepolia, Base) and Solana with failover | RPC |
| `full-pipeline.test.ts` | Complete execution pipeline: SQS -> executor -> workflow-runner for manual and schedule triggers, disabled workflow handling | DB, SQS, spawns runner |
| `gas-strategy.test.ts` | Adaptive gas estimation from live RPCs -- multipliers, fee history, chain-specific configs, clamping | RPC |
| `graceful-shutdown.test.ts` | SIGTERM handling in workflow-runner, exit code semantics (0 = business failure, 1 = system kill) | DB |
| `nonce-manager.test.ts` | PostgreSQL advisory locks for wallet/chain nonces -- lock lifecycle, session management, crash simulation | DB |
| `rpc-failover.test.ts` | Chain config resolution, user RPC preference CRUD, failover from bad primary to real fallback | DB, RPC |
| `schedule-pipeline.test.ts` | Infrastructure health checks -- DB connectivity, SQS send/receive, schema verification, internal auth header | DB, SQS, optional App |
| `transaction-flow.test.ts` | Integrated nonce + gas strategy for tx lifecycle (pending -> confirmed, replacement, recovery). Optional real Sepolia tx | DB, RPC, optional funded wallet |
| `user-rpc-workflow.test.ts` | Full user RPC preferences -> workflow execution with custom/default RPCs, preference CRUD, edge cases | DB, spawns runner, RPC |
| `workflow-runner.test.ts` | Execution record CRUD lifecycle, API key validation, workflow ownership, progress tracking, concurrent executions | DB, optional App |
| `write-contract-workflow.test.ts` | Write-contract step against SimpleStorage on Sepolia with Para wallet, on-chain verification, auto-funding | DB, Sepolia RPC, funded wallet, Para API |

### Playwright E2E Tests (`tests/e2e/playwright/`)

Run against a live app in a real browser. Require the app and database to be running.

| File | What it tests |
|------|---------------|
| `analytics-gas.test.ts` | Analytics gas tracking UI |
| `auth.test.ts` | Email OTP verification flow on signup |
| `billing.test.ts` | Billing plan selection, upgrade, and cancellation flows |
| `invitations.test.ts` | Organization invitation acceptance with navigation retry |
| `organization-wallet.test.ts` | Organization wallet creation and address display |
| `schedule-trigger.test.ts` | Schedule trigger node configuration UI |
| `workflow.test.ts` | Workflow canvas rendering and drag-to-create node |
| **happy-paths/** | |
| `scheduled-workflow.test.ts` | Create and save a scheduled workflow with webhook action, verify persistence |
| `web3-balance.test.ts` | Create workflow with Web3 check-balance action, configure network, trigger execution |

---

## Running CI Locally with `act`

[nektos/act](https://github.com/nektos/act) can emulate GitHub Actions workflows locally. The default `catthehacker/ubuntu:act-latest` image is missing tools that GitHub runners include (`pg_isready`, `aws`), so we build a custom image.

### One-time setup

```bash
# Build custom runner image with postgresql-client and awscli
cat > /tmp/Dockerfile.act << 'EOF'
FROM catthehacker/ubuntu:act-latest
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client python3-pip \
    && pip3 install awscli --break-system-packages \
    && rm -rf /var/lib/apt/lists/*
EOF
docker build -t act-runner:local -f /tmp/Dockerfile.act /tmp
```

### Create a secrets file

```bash
# /tmp/act-secrets.env
TURNKEY_API_PUBLIC_KEY=<parent-org public key>
TURNKEY_API_PRIVATE_KEY=<parent-org private key>
TURNKEY_ORGANIZATION_ID=<parent-org id>
```

### Run the e2e-vitest job

```bash
act push --job e2e-vitest \
  --secret-file /tmp/act-secrets.env \
  --platform ubuntu-latest=act-runner:local \
  --pull=false
```

`--pull=false` prevents act from trying to pull the local image from Docker Hub.

---

## Shared Utilities

| File | Purpose |
|------|---------|
| `tests/setup.ts` | Vitest global setup -- mocks `server-only`, sets env defaults |
| `tests/utils/db.ts` | Shared DB helpers: `createTestWorkflow`, `waitForWorkflowExecution`, `createApiKey`, `getUserIdByEmail` |
| `tests/fixtures/workflows.ts` | Workflow builders: `createScheduledWorkflow`, `createWebhookWorkflow`, trigger/action node factories, cron presets |
| `tests/fixtures/workflow-runner-harness.ts` | Harness for spawning workflow-runner as child process |
| `tests/e2e/playwright/utils/admin-fetch.ts` | Auth headers for admin test API and Cloudflare Access |
| `tests/e2e/playwright/utils/auth.ts` | `signUpAndVerify()`, `signIn()` for Playwright browser auth |
| `tests/e2e/playwright/utils/cleanup.ts` | Post-test cleanup: deletes test users, orgs, and Para wallets |
| `tests/e2e/playwright/utils/connection.ts` | Shared `getDbConnection()` postgres client factory |
| `tests/e2e/playwright/utils/db.ts` | Playwright-specific DB utilities: `createTestWorkflow`, persistent test user constants |
| `tests/e2e/playwright/utils/discover.ts` | Page discovery: `probe()`, `diffReports()`, `autoProbe()`, `highlightElements()` |
| `tests/e2e/playwright/utils/env.ts` | `isRemoteMode()` -- detects deployed vs local test environment |
| `tests/e2e/playwright/utils/invitations.ts` | Invitation acceptance helpers: navigate, wait for `data-page-state`, fetch invitation ID |
| `tests/e2e/playwright/utils/seed.ts` | Test data seeding: password hashing, user/org creation via direct DB inserts |
| `tests/e2e/playwright/utils/workflow.ts` | `waitForCanvas()`, `waitForWorkflowSave()`, and other Playwright workflow helpers |

---

## Playwright Discovery Framework

Tools for understanding page structure before writing E2E tests. Solves the problem of guessing selectors blind, running the test, failing, and repeating.

### Commands

```bash
pnpm discover /                        # Discover unauthenticated page
pnpm discover / --auth --highlight     # Authenticated with numbered element overlays
pnpm discover / --steps "click:button:has-text('Sign In')" "wait:500" "probe:dialog"
pnpm discover / --json                 # JSON to stdout
```

### Output

Each probe writes to `tests/e2e/playwright/.probes/<label>-<timestamp>/`:

| File | Purpose |
|------|---------|
| `screenshot.png` | Full page screenshot |
| `screenshot-highlighted.png` | Interactive elements with numbered red overlays |
| `elements.md` | Interactive elements table grouped by page region |
| `accessibility.md` | Parsed accessibility tree (roles, names, states) |
| `aria-snapshot.yaml` | Raw Playwright ARIA snapshot for writing `getByRole` locators |
| `diff.md` | What changed between two probes (new/removed elements, dialogs, toasts) |
| `report.json` | Full structured data |

### In-Test Usage

```typescript
import { probe, diffReports, autoProbe } from "./utils/discover";

// Manual probe at specific points
const before = await probe(page, "before-click");
await page.click('button:has-text("Sign In")');
const after = await probe(page, "after-click");
const diff = diffReports(before, after);

// Auto-probe on every URL change (only when PW_DISCOVER=1)
const handle = await autoProbe(page);
// ... test interactions ...
handle.stop();
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `PW_DISCOVER=1` | Enable auto-probing on navigation in tests |
| `CI` | When set, disables auto-probing regardless of `PW_DISCOVER` |

### Explore Harness

`tests/e2e/playwright/explore.test.ts` is a scratchpad for iterative exploration:

```bash
pnpm test:e2e --grep "explore"              # Run exploration
PW_DISCOVER=1 pnpm test:e2e --grep "explore"  # With auto-probing
```

Edit the steps in the file, run, read `.probes/` output, edit again, repeat until you understand the page structure. Then write the real test in a new file.

### Future: React Component State Capture

The discovery framework currently captures the DOM layer (ARIA snapshots, interactive elements, screenshots). A potential enhancement is capturing **React component state** from the virtual DOM at failure points, giving both the "what the user sees" and "why it looks that way".

**What it would add beyond ARIA snapshots:**

| Signal | ARIA Snapshot | React VDOM |
|--------|--------------|------------|
| Rendered output | Yes | No |
| Component hierarchy | No | Yes (`<WalletOverlay>` > `<Button>`) |
| Component props | No | Yes (`isLoading={true}`, `address="0x..."`) |
| Hook/atom state | No | Yes (jotai atoms, useState values) |
| Root cause of disabled state | Partial (sees `[disabled]`) | Yes (which prop/state caused it) |

**Concrete example from test debugging:**

When the Para wallet creation timed out, ARIA showed `button "Loading Creating..." [disabled]` -- enough to know it was stuck, but not why. React state would have shown `paraStatus: "pending"`, `apiError: null`, immediately confirming an API timeout vs an error state.

**Implementation approach:**

React exposes fiber nodes via `__REACT_DEVTOOLS_GLOBAL_HOOK__` (dev builds) and `_reactFiber$` properties on DOM elements. A `probeReactState(page, selector)` function could:

1. Find the DOM element matching the selector
2. Walk up the fiber tree to find the nearest meaningful component boundary
3. Extract props, state, and hook values
4. Serialize and write to `.probes/` alongside the existing outputs

**Risks and constraints:**

- React fiber internals are **not a public API** and change between React versions (currently React 19)
- Full tree serialization is expensive and noisy -- should be **scoped to a subtree** around the failure point
- Only available in dev builds (production strips `__REACT_DEVTOOLS_GLOBAL_HOOK__`)
- Circular references in state/props require careful serialization
- Jotai atoms may need special handling to extract readable values

**Recommended scope:** Targeted state capture at failure points (not full-tree analysis). Integrate into `probe()` as an optional `{ includeReactState: true }` flag that captures component state for the nearest React boundary around each interactive element.
