---
description: Test all actions for a protocol by creating workflows, executing them, and verifying results
argument: protocol-slug (e.g. sky, spark, aave, compound, lido, ethena, yearn)
---

# Test Protocol: $ARGUMENTS

Test all actions for the **$ARGUMENTS** protocol across read and write operations.

## Step 0: Determine Target Environment

Ask the user which environment to test against if not obvious from context:
- **dev**: `mcp__keeperhub-dev__*` tools (localhost:3000)
- **staging**: `mcp__keeperhub-staging__*` tools (app-staging.keeperhub.com)
- **prod**: `mcp__keeperhub__*` tools (app.keeperhub.com)

Use the corresponding MCP tool prefix for ALL workflow and execution operations throughout this test.

## Step 1: Get Wallet Address

The wallet address is needed for read actions (balance checks) and write actions (recipient/onBehalfOf). Do NOT hardcode any wallet address.

Create a workflow to read the wallet info:
```
Trigger -> web3/check-balance (network: "1", address: any known contract)
```

Or use the `/api/user/wallet` endpoint via MCP if available. The wallet address will be in the execution output or can be extracted from the organization's wallet integration.

If you already know the wallet address from prior conversation context, confirm it with the user before proceeding.

## Step 2: Read Protocol Definition

Read the protocol definition file:
```
protocols/$ARGUMENTS.ts
```

If it does not exist, check alternate names (e.g., `compound-v3.ts` for `compound`, `uniswap-v3.ts` for `uniswap`, `yearn-v3.ts` for `yearn`). Aave versions use explicit slugs: `aave-v3.ts` has slug `aave-v3`, `aave-v4.ts` has slug `aave-v4`.

Extract:
- Protocol name, slug, and description
- All contracts with their addresses and supported chains
- All actions grouped by type (read vs write)
- Whether contracts use `userSpecifiedAddress` (need a real vault/pool address)
- Which chains have the most contract coverage

## Step 3: Check for Existing Seed Workflows

Look for pre-built workflow JSON files:
```
scripts/seed/workflows/$ARGUMENTS/
```

If `mcp-test-*.json` files exist, they can be used as reference but may need wallet address updates.

## Step 4: Test Read Actions via Direct MCP

For protocols with read actions, test them directly via MCP tools first (faster than workflows):

```
mcp__keeperhub-{env}__$ARGUMENTS_{action-slug}
```

For each read action:
- Use the wallet address for `account`/`user` fields
- Use `"1000000000000000000"` (1e18) for `amount`/`assets`/`shares` fields
- Use well-known token addresses for `asset` fields (DAI, USDC, WETH for mainnet)
- For `userSpecifiedAddress` contracts, use a well-known vault/pool address from docs or block explorers
- Use the chain with the most contract coverage (usually "1" for mainnet)

Record results as you go. If a direct MCP call returns 501 (not supported for direct execution), fall back to workflow execution in Step 5.

## Step 5: Test via Workflows (for write actions + any 501 reads)

### Write Action Workflows

For each write action that needs testing, create a workflow using `mcp__keeperhub-{env}__workflow_create`:

**Sequential chaining pattern** (approve -> action):
```
Trigger -> Approve Token -> Protocol Action
```

Important rules:
- Chain write actions **sequentially** (not parallel from trigger) to avoid nonce contention
- Include `web3/approve-token` nodes before any DeFi action that spends tokens
- Use realistic but small amounts (0.001 ETH, 1 USDC, etc.)
- Use the org wallet address for `recipient`/`onBehalfOf`/`receiver`/`owner`/`to` fields
- Run write workflows **one at a time** -- parallel execution causes nonce lock failures on the same wallet

### Read Action Workflows (for 501 fallbacks)

Create a single workflow with all read actions chained **sequentially**:
```
Trigger -> Read1 -> Read2 -> Read3 -> ...
```

Sequential edges prevent the workflow engine from aborting remaining nodes if one fails.

### Execution

Execute with `mcp__keeperhub-{env}__workflow_execute`, then poll with `mcp__keeperhub-{env}__execution_status`. Wait 25-35 seconds between status checks for write workflows.

Get detailed results with `mcp__keeperhub-{env}__execution_logs` after completion.

## Step 6: Save Seed Workflows

Save tested workflow configurations to `scripts/seed/workflows/$ARGUMENTS/` for reuse:

**File naming convention**:
- `mcp-test-{action-description}.json` for write action workflows
- `mcp-test-reads.json` for the consolidated read actions workflow

**Important**: Seed files should use placeholder comments for wallet-specific values. Use the actual wallet address in the file but add a top-level `"wallet"` field documenting which address was used:

```json
{
  "protocol": "$ARGUMENTS",
  "network": "1",
  "networkName": "mainnet",
  "type": "write",
  "wallet": "0x... (Testing org on staging)",
  "name": "MCP Test: ...",
  "description": "...",
  "nodes": [...],
  "edges": [...]
}
```

## Step 7: Withdraw Test Funds

After write tests, create and execute withdrawal workflows to recover deposited funds:
- `vault-withdraw` / `vault-redeem` for ERC-4626 vaults
- Protocol-specific withdraw actions (e.g., `aave-v3/withdraw`, `compound/withdraw`)
- Run withdrawals **sequentially** (same nonce contention concern)

Verify final balances match expectations.

## Step 8: Report Results

Print a results table:

| Action | Slug | Type | Status | Notes |
|--------|------|------|--------|-------|
| Get Balance | protocol/get-balance | read | Pass | returned 0 |
| Supply WETH | protocol/supply | write | Pass | tx confirmed |
| Swap Tokens | protocol/swap | write | Fail | tuple[] encoding bug |

Summary:
- Total actions tested: X
- Reads: Y/Y passed
- Writes: Z/W passed
- Skipped: N (reason)
- Seed workflows saved: list files

## Error Handling

- **501 on direct MCP call**: Action is not a protocol action (e.g., `web3/check-balance`). Test via workflow instead.
- **Nonce lock failure**: Too many parallel write workflows. Re-run sequentially.
- **"Function not found in ABI"**: Contract ABI auto-resolution failed. May need inline ABI in protocol definition -- file a fix.
- **"exceed deposit limit"**: Vault is full. Try a different vault address or smaller amount.
- **"OperationNotAllowed"**: Protocol-specific restriction (cooldowns, timelocks). Note as expected behavior.
- **Contract revert with no data**: Usually means insufficient balance, missing approval, or wrong function args.

## Key Differences from Legacy Command

- Uses MCP tools (`mcp__keeperhub-{env}__*`) not raw curl/CLI
- Supports dev/staging/prod environments
- Tests writes via approve->action workflow chains
- Recovers test funds via withdrawal workflows
- Saves seed files with wallet metadata
- Runs write workflows sequentially to avoid nonce contention
- Does NOT hardcode wallet addresses -- discovers them at runtime
