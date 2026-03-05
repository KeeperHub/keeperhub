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
| `TEST_PARA_USER_SHARE` | Raw Para user share (base64) |
| `WALLET_ENCRYPTION_KEY` | Encrypts user share at rest |

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

**Config:** `playwright.config.ts` -- single worker, serial execution (`fullyParallel: false`), chromium only, 2 retries, auto-starts `pnpm dev` locally. Reporter: `list` locally, `github` + `html` in CI.

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

## CI Execution Model

All E2E tests are managed by `.github/workflows/e2e-tests.yml`. The workflow has a `should-run` gate that determines which jobs execute based on the trigger event.

### Trigger conditions

| Event | Vitest E2E | Playwright (ephemeral) | Playwright (deployed) |
|-------|-----------|----------------------|----------------------|
| Push to `staging` or `prod` | Yes | Yes | No |
| PR with `run-e2e-tests` label | Yes | Yes | No |
| PR environment deploy completes | No | No | Yes |
| `[skip e2e]` in commit message | Skipped | Skipped | Skipped |

### Execution contexts

**Ephemeral (CI runner)** -- Vitest and Playwright run against a fresh app built on the CI runner with its own PostgreSQL service container and LocalStack (SQS). No external environment needed. This runs on every push to `staging`/`prod` and on labeled PRs.

| Property | Vitest E2E | Playwright |
|----------|-----------|------------|
| Infrastructure | PostgreSQL + LocalStack (SQS) | PostgreSQL |
| App startup | `pnpm build && pnpm start` | `pnpm dev` (via webServer config) |
| Execution order | Vitest runs first | Playwright runs after Vitest passes |
| Workers | Default | 1 (serial) |
| Retries | 0 | 2 |
| Test scope | All vitest E2E tests | All playwright tests |

**Deployed (PR environment)** -- Playwright runs against a live PR deployment at `app-pr-<number>.keeperhub.com`. Triggered automatically after the "Deploy PR Environment" workflow succeeds. Uses Cloudflare Access headers for authentication.

| Property | Value |
|----------|-------|
| Trigger | After PR environment deploy succeeds |
| Target | `https://app-pr-<number>.keeperhub.com` |
| Test scope | All tests except `happy-paths/` (excluded via `--grep-invert`) |
| Workers | 1 (serial) |
| Retries | 2 |
| Reporting | Comments results directly on the PR |

### Execution order on push to staging

```
pr-checks (lint, build, unit, integration)
    |
e2e-tests.yml triggers:
    |
    +-- should-run (gate)
         |
         +-- e2e-vitest (DB + SQS + built app)
         |        |
         |        +-- e2e-playwright (DB + dev server, runs after vitest)
         |
         +-- e2e-playwright-deployed (only for PR deploys, independent)
```

### Playwright test stability decisions

- **Serial execution** (`fullyParallel: false`, `workers: 1`): all tests share a single persistent test user session. Parallel execution caused shared-state conflicts (org mutations, workflow saves). Serial eliminates this class of flakiness.
- **Retries: 2**: handles environmental flakiness (network jitter, slow container startup). A test that fails 3 times in a row is a real failure.
- **No sharding**: removed 2-shard matrix in favour of single runner. Sharding added CI resource cost without meaningful speed gain given serial execution.
- **Deterministic waits**: app components expose `data-ready`, `data-state`, and `data-page-state` attributes. Tests wait on these signals instead of `waitForTimeout()` or `networkidle`.
- **Reporter**: `github` in CI (annotates failures on PRs), `list` locally (real-time terminal output).

---

## Test Index

### Unit Tests (`tests/unit/`)

No external infrastructure. All dependencies mocked.

| File | What it tests |
|------|---------------|
| `abi-utils.test.ts` | 4-byte function selector computation from signatures |
| `address-utils.test.ts` | EIP-55 checksum formatting, normalization, truncation |
| `api-metrics.test.ts` | Webhook and status poll metrics instrumentation |
| `balance-formatting.test.ts` | BigInt precision formatting for different decimals (18, 8, 6) |
| `builtin-variables.test.ts` | Builtin variables (timestamps, dates) in workflow conditions |
| `chain-service.test.ts` | Chain CRUD operations (create, read, update, enable/disable) |
| `config-service.test.ts` | User RPC preference CRUD and config resolution |
| `database-secrets.test.ts` | Password and URL stripping from database integration configs |
| `db-template-params.test.ts` | Database config merging and secret stripping for integrations |
| `explorer.test.ts` | Blockchain explorer URL generation and ABI fetching (Etherscan, Blockscout) |
| `gas-strategy.test.ts` | Gas price strategy calculation with hardcoded fallback configs |
| `metrics.test.ts` | Metrics collectors (console, noop, prefixed) and latency tracking |
| `network-utils.test.ts` | Chain ID resolution from network names |
| `nonce-manager.test.ts` | Nonce lock acquisition and database-backed nonce management |
| `plugin-metrics.test.ts` | Plugin execution metrics recording and wrappers |
| `rpc-config.test.ts` | RPC URL resolution priority (JSON config, env vars, public defaults) |
| `rpc-preferences-routes.test.ts` | RPC preferences API routes with mocked auth |
| `rpc-provider.test.ts` | EVM RPC provider manager with failover states and metrics |
| `saturation-metrics.test.ts` | Concurrent execution, queue depth, and DB pool saturation metrics |
| `schedule-dispatcher.test.ts` | `shouldTriggerNow` cron matching logic |
| `schedule-executor.test.ts` | SQS-based schedule execution and DB updates |
| `schedule-service.test.ts` | Cron expression validation, timezone validation, next run time |
| `serialize-sql-params.test.ts` | SQL parameter serialization (null, primitives, dates, BigInt) |
| `solana-provider.test.ts` | Solana RPC provider manager with failover and metrics |
| `template.test.ts` | Template processing with `@` references and nested path resolution |
| `template-remap.test.ts` | Template reference remapping during workflow duplication |
| `workflow-codegen-condition.test.ts` | Condition node validation for empty/unconfigured expressions |
| `workflow-metrics.test.ts` | Workflow execution metrics (trigger detection, step metrics) |
| `workflow-runner.test.ts` | Graceful shutdown implementation with exit codes and signals |

### Integration Tests (`tests/integration/`)

Mock the database and HTTP layer but test real module wiring.

| File | What it tests |
|------|---------------|
| `abi-route.test.ts` | ABI fetching endpoint for Etherscan, Basescan, Blockscout |
| `chains-route.test.ts` | Chains listing endpoint with enabled/disabled filtering |
| `execute-api.test.ts` | Workflow execution endpoint with DB and session mocking |
| `schedule-sync.test.ts` | Schedule synchronization between workflow config and DB |
| `web3-steps.test.ts` | Web3 plugin steps (check-balance, transfer-funds) with mocked providers |
| `workflow-duplicate.test.ts` | Workflow duplication with template reference remapping |
| `workflow-runner.test.ts` | Graceful shutdown by spawning actual workflow-runner process |

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
| `auth.test.ts` | Email OTP verification flow on signup |
| `invitations.test.ts` | Organization invitation acceptance with navigation retry |
| `organization-wallet.test.ts` | Organization wallet creation and address display |
| `schedule-trigger.test.ts` | Schedule trigger node configuration UI |
| `workflow.test.ts` | Workflow canvas rendering and drag-to-create node |
| **happy-paths/** | |
| `scheduled-workflow.test.ts` | Create and save a scheduled workflow with webhook action, verify persistence |
| `web3-balance.test.ts` | Create workflow with Web3 check-balance action, configure network, trigger execution |
| `webhook-workflow.test.ts` | Webhook-triggered workflow execution with API key auth, verify DB completion |

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
TEST_WALLET_ENCRYPTION_KEY=<32-byte hex key>
TEST_PARA_USER_SHARE=<base64 user share>
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
| `tests/e2e/playwright/utils/auth.ts` | `signUpAndVerify()` for Playwright browser auth |
| `tests/e2e/playwright/utils/db.ts` | Playwright-specific DB utilities |
| `tests/e2e/playwright/utils/workflow.ts` | `waitForWorkflowSave()` and other Playwright workflow helpers |
| `tests/e2e/playwright/utils/discover.ts` | Page discovery: `probe()`, `diffReports()`, `autoProbe()`, `highlightElements()` |

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
