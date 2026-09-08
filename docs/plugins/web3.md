---
title: "Web3 Plugin"
description: "Blockchain operations including balance checks, contract interactions, transfers, calldata decoding, and AI-powered risk assessment."
---

# Web3 Plugin

Interact with EVM-compatible blockchain networks and Solana. Read-only actions work without credentials. Write actions require a connected Turnkey wallet.

## Actions

| Action | Category | Credentials | Description |
|--------|----------|-------------|-------------|
| Get Native Token Balance | Web3 | No | Check ETH/MATIC/etc. balance of any address |
| Get ERC20 Token Balance | Web3 | No | Check ERC20 token balance of any address |
| Get SPL Token Balance | Web3 | No | Check SPL token balance of any Solana address |
| Read Contract | Web3 | No | Call view/pure functions on smart contracts |
| Batch Read Contract | Web3 | No | Batch multiple contract reads into one RPC call via Multicall3 |
| Get Transaction | Web3 | No | Fetch full transaction details by hash |
| Write Contract | Web3 | Wallet | Execute state-changing contract functions |
| Transfer Native Token | Web3 | Wallet | Send native tokens (ETH/MATIC on EVM, SOL on Solana) to a recipient |
| Transfer ERC20 Token | Web3 | Wallet | Send ERC20 tokens to a recipient |
| Transfer SPL Token | Web3 | Wallet | Send SPL tokens on Solana to a recipient |
| Approve ERC20 Token | Web3 | Wallet | Approve a spender contract to spend tokens on your behalf |
| Check ERC20 Allowance | Web3 | No | Check the current token spending allowance granted to a spender |
| Query Contract Events | Web3 | No | Query historical smart contract events across a block range |
| Query Transaction History | Web3 | No | Query historical transactions by function call with optional argument filtering |
| Sign Typed Data (EIP-712) | Web3 | Wallet | Produce an EIP-712 signature over a typed-data payload for off-chain signed intents |
| Decode Calldata | Security | No | Decode raw calldata into human-readable function calls |
| Assess Transaction Risk | Security | No | AI-powered risk scoring with built-in DeFi rules |

---

## Get Native Token Balance

Check the native token balance (ETH, MATIC, etc.) of any address on any supported EVM chain.

**Inputs:** Network, Address

**Outputs:** `success`, `balance` (human-readable), `balanceWei`, `address`, `error`

**When to use:** Monitor wallet balances, trigger refills when balance drops below a threshold, track treasury holdings.

**Example workflow:**
```
Schedule (every hour)
  -> Get Native Token Balance (bot wallet)
  -> Condition: balance < 0.1 ETH
  -> Transfer Native Token (refill from treasury)
  -> Discord: "Bot wallet refilled"
```

---

## Get ERC20 Token Balance

Check the balance of any ERC20 token for a given address on EVM chains. For SPL tokens on Solana, use Get SPL Token Balance.

**Inputs:** Network, Address, Token (select from supported tokens or enter custom contract)

**Outputs:** `success`, `balance.balance`, `balance.symbol`, `balance.decimals`, `balance.name`, `address`, `error`

**When to use:** Track token holdings, monitor protocol positions, alert on balance changes.

---

## Get SPL Token Balance

Check the balance of any SPL token for a given Solana address. Supports Token-2022 mints and program-owned (off-curve) wallet addresses. A wallet with no associated token account for the mint reports a zero balance. Token symbol and name resolve from the mint's on-chain metadata when the token is not in the supported list.

**Inputs:** Network (Solana), Address, Token (select from supported tokens or enter a mint address)

**Outputs:** `success`, `balance.balance`, `balance.symbol`, `balance.decimals`, `balance.name`, `address`, `error`

**When to use:** Track SPL token holdings, monitor treasury balances on Solana, alert on balance changes.

---

## Read Contract

Call view or pure functions on any verified smart contract. Automatically fetches the ABI from block explorers and supports proxy contracts.

**Inputs:** Network, Contract Address, ABI (auto-fetched), Function, Function Arguments

**Outputs:** `success`, `result` (structured based on ABI outputs), `error`

**When to use:** Read on-chain state (prices, positions, governance proposals), check protocol health factors, monitor contract parameters.

**Example workflow:**
```
Schedule (every 5 min)
  -> Read Contract: Aave getLiquidationThreshold()
  -> Condition: health factor < 1.5
  -> Discord: "Liquidation risk alert"
```

---

## Batch Read Contract

Call the same contract function with multiple argument sets -- or different functions across different contracts -- in a single RPC call using Multicall3. Reduces dozens of individual read-contract nodes into one.

No credentials required -- this is a read-only operation using Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11`.

### Input Modes

| Mode    | Description                                                                 | Best For                                                              |
| ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Uniform | One contract, one function, multiple arg sets on a single network           | Same function across many inputs: `balanceOf(addr)` for 50 pools      |
| Mixed   | Each call has its own network, contract address, ABI, function, and args    | Heterogeneous reads: `hat()` + `approvals(addr)` on different chains  |

### Inputs

**Uniform Mode:**

| Input           | Required | Description                                                                              |
| --------------- | -------- | ---------------------------------------------------------------------------------------- |
| inputMode       | Yes      | `uniform` (default) or `mixed`                                                           |
| network         | Yes      | EVM chain to execute on                                                                  |
| contractAddress | Yes      | Target contract address (`0x...` or template variable)                                   |
| abi             | Yes      | Contract ABI (auto-fetched from block explorer or pasted manually)                       |
| abiFunction     | Yes      | Function to call (selected from ABI)                                                     |
| argsList        | No       | Argument sets for each call (see Args List Builder below)                                |
| batchSize       | No       | Max calls per Multicall3 request (default: 100, range: 1-500)                            |

**Args List Builder (Uniform Mode):**

The Args List field uses a dynamic builder instead of raw JSON. After selecting a function, the UI shows labeled inputs for each parameter based on the ABI signature. For example, selecting `allowance(address owner, address spender)` shows two labeled inputs per row: "owner (address)" and "spender (address)". Click "Add Arg Set" to add more rows, each representing one call. Template variables like `{{NodeName.value}}` are supported in all inputs.

**Mixed Mode:**

| Input     | Required | Description                                                                                    |
| --------- | -------- | ---------------------------------------------------------------------------------------------- |
| inputMode | Yes      | Must be `mixed`                                                                                |
| calls     | Yes      | List of call objects, each with its own network, contract address, ABI, function, and arguments |
| batchSize | No       | Max calls per Multicall3 request per network (default: 100, range: 1-500)                      |

Each call in mixed mode is fully self-contained with:
- **Network** -- can mix calls across different chains (grouped and batched per network)
- **Contract Address** -- with address book integration for saved addresses
- **ABI** -- auto-fetched from block explorer per contract
- **Function** -- selected from the contract's ABI
- **Arguments** -- auto-populated input fields based on function signature

### Outputs

| Output     | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| success    | Whether the batch operation succeeded overall                                |
| results    | Array of `{ success, result, error? }` in original call order                |
| totalCalls | Total number of calls executed                                               |
| error      | Error message if the entire batch failed (validation, RPC, or encoding error)|

Each entry in `results` has:
- `success` -- whether this specific call succeeded
- `result` -- decoded return value (structured with named fields when ABI provides output names)
- `error` -- revert reason if the call failed (decoded from revert data when possible)

### Partial Failure Handling

Uses Multicall3's `aggregate3` with `allowFailure: true`. If one call reverts, the others still return successfully. Each result has its own `success` flag. Revert reasons are decoded when possible (custom errors, `Error(string)` pattern, or raw bytes).

### Cross-Chain Execution (Mixed Mode)

When mixed mode calls target different networks, calls are automatically grouped by network. Each network group is executed in parallel via `Promise.all`, and results are merged back in the original call order. This means you can batch reads across Ethereum, Polygon, and Arbitrum in a single node with minimal latency overhead.

### Batch Size

The `batchSize` parameter (default: 100, max: 500) controls how many calls are included in each Multicall3 RPC request. If you have 250 calls with a batch size of 100, the node sends 3 sequential RPC requests (100 + 100 + 50). Lower values reduce payload size and are useful when RPC providers have response size limits. Maximum total calls per execution is 5000.

### Result Structure

Return values are structured based on ABI output definitions:

- **Single unnamed output**: Returns the value directly (e.g., `"1000000000000000000"`)
- **Single named output**: Returns `{ outputName: value }` (e.g., `{ "balance": "1000000000000000000" }`)
- **Multiple outputs**: Returns an object with all named fields (e.g., `{ "reserve0": "...", "reserve1": "...", "blockTimestamp": "..." }`)
- **BigInt values**: Serialized as strings to preserve precision

---

## Example Workflows

### DEX Pool Liquidity Monitor (Uniform Mode)

Monitor a token's balance across multiple DEX pool contracts. One function (`balanceOf`), many addresses. Each arg set shows a labeled "account (address)" input.

```
Schedule (every 5 min)
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       contractAddress: 0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2 (MKR)
       function: balanceOf(address)
       argsList:
         Call 1: account = 0xPool1
         Call 2: account = 0xPool2
         Call 3: account = 0xPool3
         ...
         Call 14: account = 0xPool14
  -> Aggregate:
       operation: sum
       inputMode: array
       arrayInput: {{@batch:Batch Read Contract.results}}
       fieldPath: result.balance
  -> Condition: {{@total:Aggregate.result}} < 1000000000000000000000
  -> Discord: "Low MKR liquidity: {{@total:Aggregate.result}} across {{@batch:Batch Read Contract.totalCalls}} pools"
```

### Multi-Contract Governance Dashboard (Mixed Mode)

Read different parameters from multiple governance contracts on the same chain.

```
Schedule (every hour)
  -> Batch Read Contract:
       inputMode: mixed
       calls: [
         { network: "ethereum", contractAddress: "0xGovA", abiFunction: "hat", args: [] },
         { network: "ethereum", contractAddress: "0xGovA", abiFunction: "approvals", args: ["0xSpell1"] },
         { network: "ethereum", contractAddress: "0xGovB", abiFunction: "proposalCount", args: [] },
         { network: "ethereum", contractAddress: "0xGovB", abiFunction: "state", args: [42] }
       ]
  -> Discord: "hat={{@batch.results[0].result}}, approvals={{@batch.results[1].result}}, proposals={{@batch.results[2].result}}"
```

### Cross-Chain Balance Check (Mixed Mode)

Check the same token's balance on multiple chains in a single node.

```
Schedule (every 15 min)
  -> Batch Read Contract:
       inputMode: mixed
       calls: [
         { network: "ethereum", contractAddress: "0xUSDC_ETH", abiFunction: "balanceOf", args: ["0xTreasury"], abi: "..." },
         { network: "polygon", contractAddress: "0xUSDC_POLY", abiFunction: "balanceOf", args: ["0xTreasury"], abi: "..." },
         { network: "arbitrum", contractAddress: "0xUSDC_ARB", abiFunction: "balanceOf", args: ["0xTreasury"], abi: "..." }
       ]
  -> Aggregate:
       operation: sum
       inputMode: array
       arrayInput: {{@batch:Batch Read Contract.results}}
       fieldPath: result
  -> Discord: "Total USDC across 3 chains: {{@total:Aggregate.result}}"
```

### Keeper Network Job Scanner (Uniform Mode)

Check which jobs are workable across a keeper network using a single batched read. Each arg set shows a labeled "keeper (address)" input.

```
Schedule (every block)
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       contractAddress: 0xKeeperRegistry
       function: workable(address)
       argsList:
         Call 1: keeper = 0xJob1
         Call 2: keeper = 0xJob2
         Call 3: keeper = 0xJob3
         Call 4: keeper = 0xJob4
  -> Condition: any result.success && result.result == true
  -> Write Contract: execute the workable job
```

### Uniswap V2 Pair Reserves (Uniform Mode)

Read reserves from multiple Uniswap V2 pairs. `getReserves()` takes no parameters, so each arg set is empty -- just click "Add Arg Set" for each pair contract you want to query. Returns `(reserve0, reserve1, blockTimestampLast)` per call.

```
Schedule (every 5 min)
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       contractAddress: 0xPairAddress
       function: getReserves()
       argsList: (no parameters -- function has no inputs, single arg set added)
  -> Discord: "Pair reserves: {{@batch:Batch Read Contract.results}}"
```

### Multi-Param Function: Allowance Check (Uniform Mode)

Check token allowances for multiple owner/spender pairs. The `allowance(address,address)` function has two parameters, so each arg set shows labeled inputs for both "owner" and "spender".

```
Schedule (every hour)
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       contractAddress: 0xUSDC
       function: allowance(address,address)
       argsList:
         Call 1: owner = 0xTreasury, spender = 0xRouter
         Call 2: owner = 0xTreasury, spender = 0xBridge
         Call 3: owner = 0xVault,    spender = 0xRouter
  -> Condition: any result where result < threshold
  -> Discord: "Low allowance detected"
```

### Loop + Batch Read (Dynamic Address List)

Use a database query to get a dynamic list of addresses, then batch-read their balances. Each arg set's "account" field uses a template variable.

```
Schedule (daily)
  -> Database Query: SELECT address FROM monitored_wallets
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       contractAddress: 0xUSDC
       function: balanceOf(address)
       argsList:
         Call 1: account = {{@db:Database Query.rows[0].address}}
         Call 2: account = {{@db:Database Query.rows[1].address}}
         ...
  -> Aggregate:
       operation: sum
       inputMode: array
       arrayInput: {{@batch:Batch Read Contract.results}}
       fieldPath: result
  -> Discord: "Total USDC across {{@batch:Batch Read Contract.totalCalls}} wallets: {{@total:Aggregate.result}}"
```

### Partial Failure Detection

Handle calls where some succeed and some revert, such as checking allowances on contracts that may not implement the interface.

```
Schedule (every hour)
  -> Batch Read Contract:
       inputMode: mixed
       calls: [
         { network: "ethereum", contractAddress: "0xTokenA", abiFunction: "allowance", args: ["0xOwner", "0xSpender"], abi: "..." },
         { network: "ethereum", contractAddress: "0xTokenB", abiFunction: "allowance", args: ["0xOwner", "0xSpender"], abi: "..." },
         { network: "ethereum", contractAddress: "0xNonERC20", abiFunction: "allowance", args: ["0xOwner", "0xSpender"], abi: "..." }
       ]
  -> Condition: any result where success == false
  -> Discord: "Failed calls: {{failed results with error messages}}"
```

---

## Get Transaction

Fetch full transaction details by hash via `eth_getTransactionByHash`. Returns sender, recipient, value, calldata, nonce, gas, and block explorer links.

**Inputs:** Network, Transaction Hash

**Outputs:** `success`, `hash`, `from`, `to`, `value` (ETH), `input` (calldata), `nonce`, `gasLimit`, `blockNumber`, `transactionLink`, `fromLink`, `toLink`, `error`

**When to use:** Enrich event-triggered workflows with full transaction context, inspect pending transactions, feed transaction data into Decode Calldata or Assess Risk steps.

**Example workflow:**
```
Event (new transaction on monitored contract)
  -> Get Transaction: {{Trigger.transactionHash}}
  -> Decode Calldata: {{GetTransaction.input}}
  -> Assess Transaction Risk: calldata={{GetTransaction.input}}, value={{GetTransaction.value}}
  -> Condition: riskScore >= 51
  -> Discord: "HIGH RISK TX from {{GetTransaction.from}}: {{AssessRisk.reasoning}}"
```

---

## Query Contract Events

Query historical smart contract events (logs) across a block range with automatic batching. Supports any EVM-compatible chain. The step internally batches queries in 2,000-block chunks to stay within RPC provider limits.

**Inputs:**
- Network (required)
- Contract Address (required)
- Contract ABI (required, auto-fetched from block explorer)
- Event Name (required, selected from ABI)
- Block Lookback -- number of blocks to scan back from To Block (default: 6500, ~1 day on Ethereum). Ignored if From Block is set
- From Block -- explicit start block (overrides Block Lookback)
- To Block -- end block number (default: latest)

**Outputs:** `success`, `events` (array of decoded event objects with `blockNumber`, `transactionHash`, `logIndex`, `args`), `fromBlock`, `toBlock`, `eventCount`, `error`

**How it works:**

1. Resolves the block range from inputs (either explicit From/To or lookback from latest)
2. Splits the range into 2,000-block batches to avoid RPC provider limits
3. Queries each batch via `eth_getLogs` and decodes events using the ABI
4. Concatenates all results and returns the full event list

**When to use:** Index historical events, monitor contract activity over time, aggregate on-chain data for analytics, trigger downstream actions based on past events.

**Example workflow -- DEX Swap Monitor:**
```
Schedule (every hour)
  -> Query Contract Events: Uniswap Router, event "Swap", Block Lookback 300
  -> Condition: eventCount > 0
  -> Discord: "{{QueryEvents.eventCount}} swaps in the last hour"
```

**Example workflow -- Governance Vote Tracker:**
```
Schedule (daily)
  -> Query Contract Events: Governor contract, event "VoteCast", Block Lookback 7200
  -> SendGrid: "{{QueryEvents.eventCount}} votes cast today"
```

---

## Query Transaction History

Query historical transactions sent to a contract address, filtered by function call and optionally by argument values. Uses block explorer APIs (Etherscan/Blockscout) to find transactions, then decodes their calldata using the provided ABI. Useful when the target contract does not emit events for certain function calls.

**Inputs:**

| Input | Required | Description |
|-------|----------|-------------|
| Network | Yes | EVM chain to query |
| Contract Address | Yes | Target contract address |
| ABI | Yes | Contract ABI (auto-fetched from block explorer) |
| Function | Yes | Function name to filter by (selected from ABI) |
| Function Arguments | No | Argument values to match. Empty args act as wildcards -- leave all empty to return all calls to the selected function |
| Block Lookback | No | Number of blocks to scan back from To Block (default: 6500). Ignored if From Block is set |
| From Block | No | Explicit start block (overrides Block Lookback) |
| To Block | No | End block number (default: latest) |

**Outputs:** `success`, `transactions` (array of decoded transaction objects), `fromBlock`, `toBlock`, `totalFetched`, `matchCount`, `contractAddressLink`, `error`

Each transaction in the `transactions` array contains:
- `hash` -- transaction hash
- `from` -- sender address
- `to` -- contract address
- `value` -- ETH value sent
- `blockNumber` -- block number
- `timestamp` -- block timestamp
- `functionName` -- decoded function name
- `functionSignature` -- full function signature
- `args` -- decoded named arguments as key-value pairs
- `transactionLink` -- block explorer link

**How it works:**

1. Resolves the block range from inputs (either explicit From/To or lookback from latest)
2. Fetches all transactions to the contract via block explorer API (Etherscan `txlist` or Blockscout equivalent)
3. Decodes each transaction's calldata using the provided ABI
4. Filters to only transactions calling the selected function
5. If argument values are provided, matches decoded args against filter values (case-insensitive, empty = wildcard)

**When to use:** Query on-chain activity for contracts that don't emit events for certain operations, audit historical function calls, monitor specific contract interactions over a block range.

**Example workflow -- Monitor specific function calls:**
```
Schedule (every hour)
  -> Query Transaction History: contract 0xVault, function "deposit", Block Lookback 300
  -> Condition: matchCount > 0
  -> Discord: "{{QueryTx.matchCount}} deposits in the last hour"
```

**Example workflow -- Filter by argument value:**
```
Schedule (every 15 min)
  -> Query Transaction History: contract 0xEngine, function "lock", args: ["", "0xSpecificUrn"]
  -> Condition: matchCount > 0
  -> SendGrid: "{{QueryTx.matchCount}} lock() calls to urn 0xSpecificUrn"
```

---

## Write Contract

Execute state-changing functions on smart contracts using your Turnkey wallet. Requires a connected wallet.

**Inputs:** Network, Contract Address, ABI (auto-fetched), Function, Function Arguments, Gas Limit Multiplier (optional, in Advanced section)

**Outputs:** `success`, `transactionHash`, `transactionLink`, `gasUsed` (total gas cost in wei), `result`, `error`

**When to use:** Execute DeFi operations (harvest, compound, rebalance), respond to on-chain events, automate protocol maintenance.

**Gas Configuration:** Optionally set a custom Gas Limit Multiplier in the Advanced section to override the chain default. See [Gas Management](/wallet-management/gas) for details.

**Note:** The `gasUsed` output represents the total transaction cost in wei (gas units × effective gas price), not just the number of gas units consumed.

### Direct-API field names

If you're building this action via the [Workflows API](/api/workflows) rather than the editor, the UI labels above map to these `config` keys — the strict-mode validator will reject the natural-language versions (`function`, `method`, `contract`).

`functionName` and `args` are a trap. The save-time validator accepts them so that workflows persisted before a field rename stay re-savable, but the runtime never translates them to `abiFunction` / `functionArgs`. A workflow built with them saves cleanly and then fails at execution with ``Missing `abiFunction` in the step config``. Send the canonical keys.

| UI label | API `config` field | Shape |
|---|---|---|
| Function | `abiFunction` | plain function name string (e.g. `"release"`). Not `functionName` — see the note above. |
| Function Arguments | `functionArgs` | **JSON-encoded array string** — e.g. `"[\"0xabc…\"]"`. Templates inside the string are resolved before `JSON.parse`, so wrap template tokens in the array's string quotes. |
| Contract ABI | `abi` | JSON-encoded string (same convention as `functionArgs`) |
| Web3 Connection | `web3Connection` | Sender routing: `"default"` (org policy), `"eoa"` (force the Turnkey EOA), or `"safe:<safeWalletId>"`. The signing wallet is your org's Turnkey wallet, resolved automatically. |
| Network | `network` | numeric chain id as a string (e.g. `"11155111"`) |

See the [generic web3 write-contract example](/api/workflows#generic-web3-write-contract-example-manual-trigger) in the Workflows API docs for a full working request body.

---

## Transfer Native Token

Send native tokens from your Turnkey wallet to a recipient address. On EVM networks this sends ETH, MATIC, or the chain's native asset. On Solana networks this sends SOL.

**Inputs:** Network, Amount, Recipient Address, Gas Limit Multiplier (optional, in Advanced section; EVM only)

**Outputs:** `success`, `transactionHash`, `transactionLink`, `gasUsed` (total fee in wei on EVM, lamports on Solana), `gasUsedUnits` and `effectiveGasPrice` on Solana (compute-unit metadata), `error`

**When to use:** Refill bot wallets, distribute funds, automate payroll.

**Gas Configuration:** On EVM networks you can optionally set a custom Gas Limit Multiplier in the Advanced section. See [Gas Management](/wallet-management/gas) for details. Solana uses lamport fees and compute units instead of EVM gas limits.

**Note:** On EVM, `gasUsed` is the total transaction cost in wei (gas units x effective gas price). On Solana, `gasUsed` is the total lamport fee (base signature fee plus priority fee from consumed compute units).

---

## Transfer ERC20 Token

Send ERC20 tokens from your Turnkey wallet to a recipient address.

**Inputs:** Network, Token, Amount, Recipient Address, Gas Limit Multiplier (optional, in Advanced section)

**Outputs:** `success`, `transactionHash`, `transactionLink`, `gasUsed` (total gas cost in wei), `amount`, `symbol`, `recipient`, `error`

**When to use:** Distribute tokens, move funds between wallets, automate token transfers based on conditions.

**Gas Configuration:** Optionally set a custom Gas Limit Multiplier in the Advanced section to override the chain default. See [Gas Management](/wallet-management/gas) for details.

**Note:** The `gasUsed` output represents the total transaction cost in wei (gas units × effective gas price), not just the number of gas units consumed.

---

## Transfer SPL Token

Send SPL tokens on Solana from your Turnkey wallet to a recipient address. If the recipient does not yet have an associated token account for the mint, KeeperHub creates one and reserves the rent-exempt minimum from your SOL balance.

**Inputs:** Network (Solana mainnet or devnet), Mint address, Amount, Recipient address

**Outputs:** `success`, `transactionHash`, `transactionLink`, `gasUsed` (total lamport fee), `gasUsedUnits`, `effectiveGasPrice`, `amount`, `mint`, `decimals`, `recipient`, `recipientTokenAccount`, `createdRecipientAccount`, `error`

**When to use:** Distribute SPL tokens, automate treasury payouts on Solana, or move tokens between wallets on Solana networks.

---

## Approve ERC20 Token

Grant spending permission to a spender contract, allowing it to transfer ERC20 tokens on behalf of your Turnkey wallet. This is required before using DEX aggregators, DeFi protocols, or any contract that needs to move tokens from your wallet.

**Inputs:** Network, Token, Spender Address, Amount, Gas Limit Multiplier (optional, in Advanced section)

**Outputs:** `success`, `transactionHash`, `transactionLink`, `gasUsed` (total gas cost in wei), `approvedAmount` (human-readable or "unlimited"), `spender`, `symbol`, `error`

**When to use:** Enable DeFi interactions (swaps, deposits, lending), automate approval management, set up bot wallets for protocol operations.

**Amount Options:**
- Exact amount (e.g., "100.50") - approve only the specified amount
- "max" or "unlimited" - approve unlimited spending (max uint256)

**Gas Configuration:** Optionally set a custom Gas Limit Multiplier in the Advanced section to override the chain default. See [Gas Management](/wallet-management/gas) for details.

**Note:** The `gasUsed` output represents the total transaction cost in wei (gas units × effective gas price), not just the number of gas units consumed.

**Example workflow:**
```
Schedule (daily)
  -> Check ERC20 Allowance: owner={{walletAddress}}, spender={{routerAddress}}
  -> Condition: allowanceRaw < 1000000000
  -> Approve ERC20 Token: spender={{routerAddress}}, amount="max"
  -> Discord: "Router approval refreshed"
```

---

## Sign Typed Data (EIP-712)

Produce an EIP-712 signature over a typed-data payload using your organization's Turnkey wallet, for off-chain signed intents. Fund-moving authorizations (permits, transfer authorizations, delegations) are refused on this action.

**Inputs:** EIP-712 Typed Data (JSON with `domain`, `types`, `primaryType`, and `message`)

**Outputs:** `success`, `signature` (65-byte 0x-prefixed signature), `signer` (checksummed signer address), `error`, `code` (`VALIDATION`, `NO_WALLET`, `POLICY_BLOCKED`, `UPSTREAM`, or `UNKNOWN`)

**When to use:** Sign off-chain intents such as order commitments or attestations that a downstream service verifies. Not for fund-moving permits or transfer authorizations, which are refused.

---

## Check ERC20 Allowance

Check the current ERC20 token spending allowance that an owner has granted to a spender address. This is a read-only operation that does not require credentials.

**Inputs:** Network, Token, Owner Address, Spender Address

**Outputs:** `success`, `allowance` (human-readable), `allowanceRaw` (wei string), `symbol`, `error`

**When to use:** Monitor approval status before operations, audit token permissions, trigger approval renewals when allowance drops below threshold.

**Example workflow:**
```
Schedule (every hour)
  -> Check ERC20 Allowance: owner={{treasuryWallet}}, spender={{dexRouter}}
  -> Condition: allowanceRaw < 100000000000000000000
  -> Approve ERC20 Token: amount="1000"
  -> SendGrid: "DEX router approval renewed to 1000 tokens"
```

---

## Decode Calldata

Decode raw transaction calldata into human-readable function calls with parameter names and values. Uses a cascading strategy: manual ABI, block explorer lookup, 4byte.directory, then selector-only fallback.

**Inputs:** Calldata (hex string), Contract Address (optional), Network (optional), ABI Override (optional, advanced)

**Outputs:** `success`, `selector`, `functionName`, `functionSignature`, `parameters` (array with name/type/value), `decodingSource`, `error`

**When to use:** Analyze pending transactions before execution, audit governance proposals, inspect multisig queue items, feed decoded data into risk assessment.

This is a security-critical action (`maxRetries = 0`). On error, it fails rather than retrying.

**Example workflow:**
```
Webhook (receives pending tx)
  -> Decode Calldata: {{Trigger.calldata}}
  -> Condition: functionName == "transferOwnership"
  -> Discord: "ALERT: Ownership transfer detected"
```

---

## Assess Transaction Risk

AI-powered risk assessment that combines built-in DeFi security rules with OpenAI analysis. Produces a risk score (0-100) and detailed risk factors.

**Inputs:** Transaction Calldata, Contract Address (optional), Transaction Value in ETH (optional), Chain (optional), Sender Address (optional)

**Outputs:** `success`, `riskLevel` (low/medium/high/critical), `riskScore` (0-100), `factors` (array of risk descriptions), `decodedFunction`, `reasoning`, `error`

**How it works:**

1. Auto-decodes calldata internally (no need for a separate Decode Calldata step)
2. Runs built-in rules across 4 categories:
   - **Approval risks** -- Unlimited approvals (MAX_UINT256), setApprovalForAll
   - **Privileged operations** -- transferOwnership, upgradeTo, selfdestruct
   - **Value risks** -- Large ETH transfers (>10 ETH)
   - **Interaction risks** -- Zero address targets, unknown selectors, generic execution patterns
3. Critical rule match short-circuits without AI call
4. Otherwise, enhances assessment with GPT-4o Mini (3s timeout)
5. Combines rule-based and AI findings, taking the higher risk level

**Fail-closed policy:** If the AI call fails or times out, the risk level is elevated (not lowered). This is a security-critical action (`maxRetries = 0`).

**When to use:** Guard transactions before execution, score governance proposals, audit multisig queues, build security monitoring workflows.

**Example workflow -- Transaction Guardian:**
```
Webhook (receives pending tx from multisig)
  -> Assess Transaction Risk: {{Trigger.calldata}}
  -> Condition: riskLevel == "critical" OR riskLevel == "high"
    -> YES: Discord #security-alerts: "HIGH RISK TX: {{AssessRisk.reasoning}}"
    -> NO: Discord #operations: "TX approved ({{AssessRisk.riskLevel}})"
```

**Example workflow -- Approval Monitor:**
```
Schedule (every 15 min)
  -> Read Contract: getApprovalQueue()
  -> Assess Transaction Risk: {{ReadContract.result.calldata}}
  -> Condition: riskScore > 50
  -> SendGrid: "Review required: risk score {{AssessRisk.riskScore}}"
```
