# Happy Path E2E Tests

End-to-end tests covering core user workflows in KeeperHub.

## Test Suites

### Scheduled Workflow (`scheduled-workflow.test.ts`)

Tests for creating and managing scheduled workflows.

| Test | Description |
|------|-------------|
| **create and save a scheduled workflow with webhook action** | Signs up a new user, creates a workflow, configures a schedule trigger with cron expression `0 * * * *` (hourly), adds a Send Webhook action, saves, and verifies the workflow persists after page reload. |
| **schedule trigger configuration persists after save** | Creates a workflow with a specific cron schedule (`30 8 * * 1-5` - 8:30 AM weekdays), saves it, reloads the page, and verifies the cron expression was persisted correctly. |
| **saved workflow can be reloaded** | Creates and saves a workflow, verifies the URL contains the workflow ID, reloads the page, and confirms the trigger node is still visible. |

### Web3 Balance Check (`web3-balance.test.ts`)

Tests for Web3 blockchain integration workflows using a known Ethereum address (vitalik.eth).

| Test | Description |
|------|-------------|
| **create workflow with Web3 check-balance action** | Signs up, creates a workflow, adds the "Get Native Token Balance" action, configures it with mainnet and a test address, saves, and verifies the action node persists after reload. |
| **configure Web3 action with network selection** | Creates a workflow with the balance check action and tests the network dropdown selector (Radix UI combobox) by selecting the mainnet option. |
| **Web3 action configuration persists after save** | Creates a workflow, configures the balance action with network and address, saves, reloads, and verifies the address value was persisted in the action configuration. |
| **trigger Web3 workflow and verify execution output** | Creates and configures a complete Web3 balance workflow, triggers it manually via the Run button, switches to the Runs tab, and verifies an execution entry ("Run #1") appears. |

## Test Configuration

- All tests run **serially** within each suite (`test.describe.configure({ mode: "serial" })`)
- Each test clears cookies in `beforeEach` for isolation
- Tests use the shared utility functions from `../utils/`

## Running Tests

```bash
# Run all happy path tests
pnpm exec playwright test tests/e2e/playwright/happy-paths/

# Run a specific suite
pnpm exec playwright test tests/e2e/playwright/happy-paths/web3-balance.test.ts

# Run in headed mode (visible browser)
pnpm exec playwright test tests/e2e/playwright/happy-paths/ --headed

# Run a single test by name
pnpm exec playwright test -g "create workflow with Web3"
```

## Test Data

- **Test Address**: `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (vitalik.eth)
- **Test Network**: `mainnet`
- **Test Cron**: `0 * * * *` (hourly), `30 8 * * 1-5` (weekday mornings)
