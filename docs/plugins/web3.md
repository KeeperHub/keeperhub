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
| Batch Read Contract | Web3 | No | Batch multiple contract reads into one RPC call via Multicall3, including one function on a list of contracts |
| Get Transaction | Web3 | No | Fetch full transaction details by hash |
| Get Address Nonce | Web3 | No | Read an address's mined and pending transaction counts |
| Write Contract | Web3 | Wallet | Execute state-changing contract functions |
| Transfer Native Token | Web3 | Wallet | Send native tokens (ETH/MATIC on EVM, SOL on Solana) to a recipient |
| Transfer ERC20 Token | Web3 | Wallet | Send ERC20 tokens to a recipient |
| Transfer SPL Token | Web3 | Wallet | Send SPL tokens on Solana to a recipient |
| Approve ERC20 Token | Web3 | Wallet | Approve a spender contract to spend tokens on your behalf |
| Check ERC20 Allowance | Web3 | No | Check the current token spending allowance granted to a spender |
| Query Contract Events | Web3 | No | Query historical smart contract events across a block range, for one event, for several events across several contracts, or for one event across a list of contracts known at run time, optionally filtered by indexed argument values |
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

**Inputs:** Network, Contract Address, ABI (auto-fetched), Function, Function Arguments, Simulate at and Next block timestamp offset (optional, in Advanced section; see [Simulate at the next block](#simulate-at-the-next-block))

**Outputs:** `success`, `result` (structured based on ABI outputs), `error`, `simulation` (only when Simulate at is Next block)

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

Call one contract function with many argument sets, the same function on a list of contracts (for example `done()` on every spell), or different functions across different contracts, in a single RPC call using Multicall3. Reduces dozens of individual read-contract nodes into one.

No credentials required -- this is a read-only operation using Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11`.

### Input Modes

| Mode    | Description                                                                 | Best For                                                              |
| ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Uniform (Same function, multiple args) | One function on a single network: one contract with many arg sets, or the same call on a list of contracts | `balanceOf(addr)` for 50 pools; `done()` on every spell in a list |
| Mixed (Different contracts/functions) | Each call has its own network, contract address, ABI, function, and args    | Heterogeneous reads: `hat()` + `approvals(addr)` on different chains  |

### Inputs

**Uniform Mode:**

| Input           | Required | Description                                                                              |
| --------------- | -------- | ---------------------------------------------------------------------------------------- |
| inputMode       | Yes      | `uniform` (default) or `mixed`                                                           |
| network         | Yes      | EVM chain to execute on                                                                  |
| callsFrom       | No       | Where the calls come from: `rows` (default), `args-list` or `address-list` (see Calls From a List below) |
| contractAddress | Yes, except with `address-list` | Target contract address (`0x...` or template variable)            |
| abi             | Yes      | Contract ABI (auto-fetched from block explorer or pasted manually)                       |
| abiFunction     | Yes      | Function to call (selected from ABI)                                                     |
| argsList        | No       | Argument sets for each call, used with `rows` (see Args List Builder below)              |
| argsFromList    | With `args-list` | Argument Sets: a JSON array, usually a template, one entry per call           |
| contractAddresses | With `address-list` | Contract Addresses: a JSON array, usually a template, one call per address |
| functionArgs    | If the function takes arguments | With `address-list`: the arguments sent to every contract in the list; fill in every one, only a `string` may be left blank |
| abiFetchAddress | No       | With `address-list`: one contract with the same ABI, used only to fetch the ABI          |
| batchSize       | No       | Max calls per Multicall3 request (default: 100, range: 1-500)                            |

**Args List Builder (Uniform Mode):**

The Args List field uses a dynamic builder instead of raw JSON. After selecting a function, the UI shows labeled inputs for each parameter based on the ABI signature. For example, selecting `allowance(address owner, address spender)` shows two labeled inputs per row: "owner (address)" and "spender (address)". Click "Add Arg Set" to add more rows, each representing one call. Template variables like `{{NodeName.value}}` are supported in all inputs.

**Calls From a List (Uniform Mode):**

The rows editor suits a fixed set of calls. When the calls come from an earlier node (a registry read, a database query, an HTTP response), set **Calls From** to a list instead:

- **A list of argument sets** (`args-list`): one contract and function, one call per entry in **Argument Sets**. Each entry is the call's arguments in order, e.g. `["0xabc...", 5]`. For a function with one plain argument (an address, number, string, bool, bytes or bytes32), an entry can also be the bare value, e.g. `"0xabc..."`. Arguments are read as in Read Contract: a tuple is an object keyed by its member names, e.g. `{"token": "0xabc...", "amount": 5}`, or its members given flat, in order (except a tuple whose first member is itself a tuple, which must be an object).
- **A list of contract addresses** (`address-list`): one function, called on every address in **Contract Addresses** with the same **Function Arguments** (fill in every argument the function takes; only a `string` may be left blank, and is sent as an empty string). Arguments as the editor stores them (one value per argument, an empty string for a field you never typed in) are read one value per argument, so an untouched tuple is sent blank. When there are more values than arguments, a tuple is read as its members given in order; if an empty string in a tuple's place could also mean that tuple left blank and the two readings make different calls, the step asks for the tuple as an object. Contract Address is not used; to fetch the ABI, enter any one contract with the same ABI in **Fetch ABI From** (it is not called), or tick Use manual ABI and paste it.

Both lists take a JSON array typed in the field or, more often, a reference to an array from an earlier node, e.g. `{{@registry:Read Contract.result}}` for a function that returns an array. Prefer one reference to the whole array over references mixed into a typed list. Results keep the list's order, duplicates included, so another list of names lines up with them by position.

The list is checked before any call is made, and the step fails when:

- the list is blank (a reference that resolved to nothing) or an empty array, is a single value or not a JSON array, has more than 5,000 entries, or is larger than 1 MB
- Function Arguments is larger than 1 MB, or leaves an argument blank that is not a `string`
- an entry is not a valid address (an address in Contract Addresses is 0x and 40 hex characters), has the wrong number of arguments, or is not a plain value where one is expected (the message names the entry, counted from 1)
- an address argument has spaces around it (an address in Contract Address or Contract Addresses is trimmed; one passed as an argument is not)
- a tuple is given as an array of its members, as text or as a plain value instead of an object keyed by member name, or the function takes a tuple whose members have no names (such a function cannot be called from a list)
- an argument cannot be encoded for the function: a `bool` that is not `true` or `false`, a `bytes32` that is not 0x hex of that length (turn text into `bytes32` with the Encode / Decode node first), a number that is not a whole number written in digits (no commas or `1e18` notation) or does not fit its type (a `uint` cannot be negative), or a fixed-size array such as `uint256[3]` with the wrong number of items
- a number above 9,007,199,254,740,991 (or below its negative) is given without quotes: it may have lost digits on the way, so write it in quotes or have the earlier node send it as text
- the function declares more than 1,000 parameters and tuple members in all
- one call's arguments would encode to more than about 64 KB, the calls hold more than 50,000 values in all (Function Arguments, sent to every address, counts once), or the encoded calls add up to more than 10 MB

With Fail workflow on error off, these failures, like a failed batch, are passed to the next node as `success: true` with `results` null and `error` set. Only problems that leave the step with nowhere to call still fail the run, as in Read Contract: a missing or unknown network, an RPC configuration that cannot be resolved, a network the step cannot read on (Solana), a missing or invalid Contract Address, or a Contract Addresses that is blank, not a list, has more than 5,000 entries, is larger than 1 MB or has an entry that is not a valid address. In Different contracts/functions mode, so does a call that is not an object or has no valid network or address. An empty Contract Addresses list (`[]`) is passed on like the failures above. A list typed into Contract Addresses is checked when the workflow is saved, except for checksums, which are checked when the step runs.

Encode / Decode returns a one-entry array as a plain string, not a list. If the list may hold a single entry, take it from a source that always returns an array.

To use another Batch Read Contract's `results` as a list, map them to their `result` values first (for example with a Code node): each entry of `results` is an object, not an address or a value.

A list from a source you do not control (a webhook body, an HTTP response) decides which contracts are called. Calls are read-only and cannot spend, but any contract in the list can make its own call fail, or the whole batch (for example by using up all the gas), or return the values it chooses. Filter such a list, or check it against an allow-list, before it reaches Batch Read Contract.

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

### Registry Lookup (Argument Sets from a List)

Look up the address of every key a registry lists, without adding a row per key. A key added to the registry is picked up on the next run.

```
Schedule (every hour)
  -> Read Contract (node id: registry):
       network: ethereum
       contractAddress: 0xRegistry
       function: list()            (returns bytes32[])
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       callsFrom: args-list
       contractAddress: 0xRegistry
       function: getAddress(bytes32)
       argsFromList: {{@registry:Read Contract.result}}
```

If `list()` names its output (for example `keys`), the list is `{{@registry:Read Contract.result.keys}}`. `getAddress` takes one argument, so each key in the list is used as it is. `results[i]` is the address of the key at position `i` of the list.

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

### Uniswap V2 Pair Reserves (Address List)

Read reserves from multiple Uniswap V2 pairs. Every pair has the same `getReserves()` function, so set Calls From to a list of contract addresses: one call per pair, in the list's order. `getReserves()` takes no parameters, so Function Arguments stays empty. Returns `(reserve0, reserve1, blockTimestampLast)` per call.

```
Schedule (every 5 min)
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       callsFrom: address-list
       contractAddresses: ["0xPair1", "0xPair2", "0xPair3"]
       abiFetchAddress: 0xPair1   (only used to fetch the ABI)
       function: getReserves()
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

### Balances for a Dynamic Wallet List (Argument Sets)

Use a database query to get the current list of wallets, then batch-read their balances. The query returns the wallets as one JSON array, which becomes the Argument Sets list. `balanceOf` takes one argument, so each wallet address is used as it is.

```
Schedule (daily)
  -> Database Query: SELECT COALESCE(json_agg(address), '[]'::json) AS wallets FROM monitored_wallets
  -> Batch Read Contract:
       inputMode: uniform
       network: ethereum
       callsFrom: args-list
       contractAddress: 0xUSDC
       function: balanceOf(address)
       argsFromList: {{@db:Database Query.rows[0].wallets}}
  -> Aggregate:
       operation: sum
       inputMode: array
       arrayInput: {{@batch:Batch Read Contract.results}}
       fieldPath: result
  -> Discord: "Total USDC across {{@batch:Batch Read Contract.totalCalls}} wallets: {{@total:Aggregate.result}}"
```

A wallet added to the table is read on the next run, with no change to the workflow. An empty table gives an empty list, which fails the step; turn Fail workflow on error off to pass it on as a soft error instead.

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

## Get Address Nonce

Read the transaction count (nonce) of any address on EVM chains via `eth_getTransactionCount`. Every run reads both the mined count and the pending count in one step, so a single node can tell when transactions from a wallet are waiting in the mempool and not being mined.

**Inputs:** Network, Address, Block Tag (`latest` or `pending`, defaults to `latest`)

**Outputs:** `success`, `nonce` (count at the selected block tag), `blockTag`, `address`, `latestNonce` (mined transactions), `pendingNonce` (mined plus mempool transactions), `pendingCount` (`pendingNonce` minus `latestNonce`, never negative), `error`

**When to use:** Watch a keeper or bot wallet for stuck transactions, confirm a submitted transaction was mined before sending the next one, or compare the nonce against your own records to spot transactions that were mined but did not have the expected effect.

**Example workflow:**
```
Schedule (every 5 min)
  -> Get Address Nonce (keeper wallet)
  -> Condition: pendingCount > 0
  -> Discord: "{{GetAddressNonce.pendingCount}} transaction(s) waiting from {{GetAddressNonce.address}}"
```

---

## Query Contract Events

Query historical smart contract events (logs) across a block range with automatic batching. Supports any EVM-compatible chain. The step internally batches queries in 2,000-block chunks to stay within RPC provider limits.

One node can watch a single event on one contract, several events across several contracts on the same network, or one event across a list of contracts that is only known at run time.

**Query modes:**

| Mode | Description | Best For |
| ---- | ----------- | -------- |
| Single event (default) | One contract, one event, optional indexed argument filter | Watching one event, such as `Transfer` on a token |
| Multiple events or contracts | A list of contract and event pairs on one network, each with its own ABI and optional filter, returned as one merged list | Watching a set of permission or emergency events across related contracts from one node |
| One event, many contracts | One event and one ABI on a list of contract addresses, usually from an earlier node | Watching the same event on every contract in a list that changes between runs |

**Inputs:**
- Query Mode (default: Single event)
- Network (required) -- an EVM network. A Solana network fails the step, and stops the run even with Fail workflow on error off
- Contract Address (required)
- Contract ABI (required, auto-fetched from block explorer)
- Event Name (required, selected from ABI)
- Filter by Indexed Arguments (optional) -- a value for any indexed parameter of the event. Omit a parameter to match any value for it; a parameter given an empty value fails the step. One value per parameter: `eth_getLogs` also accepts a list of alternatives per topic, but that OR form is not supported here
- Events (required in Multiple mode): up to 20 entries, each with its own Contract Address, Contract ABI (auto-fetched from block explorer), Event and optional Filter by Indexed Arguments. In Multiple mode these replace the single Contract Address, Contract ABI, Event Name and filter fields above.
- Contract Addresses (required in One event, many contracts mode): a JSON array of addresses, or a reference to an array from an earlier node such as `{{@filter:Filter Array.values}}`. Up to 5,000 addresses. Contract ABI, Event Name and Filter by Indexed Arguments apply to every address in the list, and Contract Address is not used
- Fetch ABI From (optional, One event, many contracts mode): one contract with the same ABI, used only to fetch the ABI; it is not queried unless it is in the list. Alternatively tick Use manual ABI and paste the ABI
- Block Lookback -- number of blocks to scan back from To Block (default: 6500, ~1 day on Ethereum). Ignored if From Block is set
- From Block -- explicit start block (overrides Block Lookback)
- To Block -- end block number (default: latest)

**Outputs:** `success`, `events` (array of decoded event objects with `blockNumber`, `transactionHash`, `logIndex`, `args`), `fromBlock`, `toBlock`, `eventCount`, `error`

In Multiple and One event, many contracts modes each event also carries `contractAddress` and `eventName`, and `events` is one list ordered by block number, then log index, across every entry.

**How it works:**

1. Resolves the block range from inputs (either explicit From/To or lookback from latest)
2. Compiles any indexed argument filter into log topics, failing the step on a filter that could never match
3. Splits the range into 2,000-block batches to avoid RPC provider limits
4. Queries each batch via `eth_getLogs` and decodes events using the ABI
5. Concatenates all results and returns the full event list

**Filtering by indexed arguments**

The filter is applied by the RPC node, not after the fact, so a narrow filter changes what the query costs rather than only what it returns. On a busy contract that can be the difference between a query that completes and one that times out or hits the provider's response limit.

Only indexed parameters can be filtered. Whether a parameter is indexed is fixed by the contract, so the configuration panel lists the ones available and disables the rest.

Two limits are worth knowing before you rely on it:

- An indexed `string` or `bytes` is stored as a hash of its contents rather than the contents. Filtering one matches the whole value exactly; there is no partial or prefix matching, and the original value cannot be read back out of the log.
- An indexed array or tuple cannot be filtered at all, for the same reason: its topic is a hash of the encoded contents. Those parameters are shown but disabled, and filtering them in a later node is the way to do it.

A filter naming a parameter that is not indexed, or a value that does not fit its type, fails the step before any query runs rather than scanning the range and returning nothing.

**Querying one event on a list of contracts**

Set Query Mode to One event, many contracts and set Contract Addresses to the list. The list is checked before any query runs, and the step fails when it is blank, is a single value or text rather than a JSON array, has more than 5,000 entries, is larger than 1 MB, or has an entry that is not a valid address (the message names the entry, counted from 1; an address is 0x and 40 hex characters, and one in mixed case must have a valid checksum). Contract Addresses is checked the same way as in Batch Read Contract. These failures stop the run even with Fail workflow on error off. An empty list, `[]`, fails the step like any other query error: with Fail workflow on error off the run continues, and the node's `events` is null with `error` set, so an empty list is never mistaken for a range with no events. A list typed into the field is checked when the workflow is saved, except for checksums, which are checked when the step runs. An address listed more than once is queried once, so no event is returned twice. The addresses are queried in groups over one shared block range, and a latest To Block ends 5 blocks behind the latest block as in Multiple mode.

**Querying multiple events or contracts**

Set Query Mode to Multiple events or contracts and add one entry per contract and event pair. Each entry has its own contract address, ABI and event, and can carry its own indexed argument filter. Every entry runs on the node's network over one shared block range, so `fromBlock`, `toBlock` and `eventCount` describe the whole node.

The node makes as few `eth_getLogs` calls as the entries allow:

- Entries without a filter on the same contract share one call, and contracts watching the same set of events share one call through a list of addresses.
- An entry with a filter gets a call of its own, because its filter narrows topics that the other entries leave open.

Watching ten event types across three related contracts without filters takes at most three calls per 2,000-block batch, not one per contract and event pair. A log that two entries both match, such as a `Transfer` filtered on `from` in one entry and on `to` in another, is returned once.

Every entry is checked before any query runs. An invalid address, an ABI that does not parse, an event missing from its ABI, or a filter that could never match fails the step with a message naming the entry, for example `Event 3 (RoleGranted): ...`. One node holds at most 20 entries.

When To Block is empty or `latest`, a Multiple query ends 5 blocks behind the latest block. The calls for different entries can reach different nodes behind the same RPC provider, and a fixed end block lets every call cover exactly the same range. Block Lookback counts back from that end block, so a schedule whose lookback matches its interval still covers every block, and the most recent blocks are picked up on the next run.

**When to use:** Index historical events, monitor contract activity over time, aggregate on-chain data for analytics, trigger downstream actions based on past events, and watch one address, pool or token ID on a contract busy enough that an unfiltered scan is impractical. Use Multiple mode to watch a set of related events across several contracts from one node instead of one node per contract and event.

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

**Example workflow -- Treasury Deposit Watch:**
```
Schedule (every 15 minutes)
  -> Query Contract Events: USDC, event "Transfer", to = treasury address, Block Lookback 75
  -> Condition: eventCount > 0
  -> Discord: "{{QueryEvents.eventCount}} incoming transfers"
```
Without the `to` filter this query fetches every USDC transfer in the window and the node is doing the filtering; with it, the RPC returns only the treasury's.

**Example workflow (Protocol Emergency Watch):**
```
Schedule (every 15 minutes)
  -> Query Contract Events: Multiple events or contracts, Block Lookback 75
       Vault: "Paused", "Unpaused", "RoleGranted", "RoleRevoked"
       Price oracle: "Paused", "Unpaused"
       Governance token: "OwnershipTransferred"
  -> Condition: eventCount > 0
  -> Discord: "{{QueryEvents.eventCount}} admin events across the protocol"
```
One node replaces seven, and downstream nodes read one list in which each event names its contract and event.

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

**Inputs:** Network, Contract Address, ABI (auto-fetched), Function, Function Arguments, Fail workflow on error (optional, on by default), Gas Limit, Priority Fee, Max Fee, Sponsor gas, Simulate at and Next block timestamp offset (optional, in Advanced section; Sponsor gas only on networks gas sponsorship covers)

**Outputs:** `success`, `transactionHash`, `transactionLink`, `gasUsed` (total gas cost in wei), `result`, `error`, `simulation` (only when Simulate at is Next block)

**When to use:** Execute DeFi operations (harvest, compound, rebalance), respond to on-chain events, automate protocol maintenance.

**Note:** The `gasUsed` output represents the total transaction cost in wei (gas units × effective gas price), not just the number of gas units consumed.

### Gas settings

The Advanced section has three optional gas settings. Leave them empty to use the network defaults.

| Setting | What it does | With Sponsor gas on |
|---------|--------------|---------------------|
| [Gas Limit](/wallet-management/gas#gas-limit-override) | Fixed gas limit, used instead of the estimate | Not applied to a sponsored transaction; the sponsor sets its own limit |
| [Priority Fee (gwei)](/wallet-management/gas#priority-fee) | Tip paid to the block builder; a higher tip puts the transaction ahead of others in the same block | Hidden while the node is sponsored (see below) |
| [Max Fee (gwei)](/wallet-management/gas#max-fee) | Ceiling on the total fee per gas; a cap below the next block's base fee fails the step before sending | Hidden while the node is sponsored (see below) |

Sponsored transactions cannot carry a custom priority fee or max fee, so those two fields show only while the node pays its own gas: Sponsor gas off, Simulate at set to Next block, a network that gas sponsorship does not cover, a private mempool, or a Safe. Any change that hides them, such as turning Sponsor gas on or setting Simulate at back to Latest block, clears them, and the editor says so. With either one set, make sure the sending wallet holds enough of the network's native token to pay for gas. See [Custom gas settings and sponsorship](/wallet-management/gas#custom-gas-settings-and-sponsorship) for the full rules.

### Simulate at the next block

Before it sends, Write Contract simulates the call and estimates its gas against the latest block, and skips the send if the simulation reverts. A time-locked call (for example `require(block.timestamp >= lastRun + interval)`) therefore only passes once the first valid block already exists, so the transaction lands one block after it, or later.

Set **Simulate at** to **Next block** to run the simulation as if the next block had already arrived: block number + 1, and the next block's predicted timestamp. The call then passes while the first valid block is still being built. The same setting is on Read Contract, where it answers the read as of the next block, and on Batch Write Contract.

**What it changes.** Only the decision to send and the gas estimate use the predicted block. The signed transaction, its fees and its nonce are set as for any write (see [Gas Management](/wallet-management/gas)). The latest block is read when the step runs, not when the run was triggered, and every call is made against that block. Only the block number and timestamp are predicted: the state, other pending transactions and the base fee are the latest block's. It works the same for writes sent from your wallet, a Safe or a Safe role.

**Predicted time.** On most networks the predicted timestamp is the latest block's timestamp + one block time. On Ethereum and the other beacon-chain networks (Sepolia, Holesky, Hoodi, Gnosis, Chiado), blocks keep to fixed slots and a missed slot (no block in it) leaves its timestamp unused, so the step follows the slot clock instead: the predicted timestamp is the first slot a transaction sent now can still land in. A slot counts as passed a third of the way in (4 seconds on Ethereum), because blocks are still being built until then. After a missed slot the check therefore moves to the next slot instead of checking one slot early. If the RPC's latest block is more than 5 slots old, the RPC is lagging or the server clock is off, and the step fails as a temporary RPC error rather than checking old state.

**Block time.** Leave **Next block timestamp offset (seconds)** empty to use the network's block time, taken as the smallest gap between its last few blocks (at most 60 seconds) and refreshed every 10 minutes:

- Networks with fixed 12-second blocks (Ethereum) use 12, and networks with 2-second blocks (Base, OP, Polygon PoS) use 2.
- On networks where several blocks share one timestamp (Arbitrum and other sub-second networks), the next block's time cannot be predicted and the step fails with a message saying so. Setting the offset to 1 lets it run anyway, but the call can then pass a few blocks early.
- An offset larger than the real block time makes the check pass blocks early, and the transaction then reverts on-chain and spends gas. Leave it empty unless you have a reason to set it.
- If the RPC cannot return enough consecutive recent blocks to measure the block time, the step fails as a temporary RPC error and the next run measures again. Setting the offset skips the measurement.

The prediction only helps with a "not before" condition. A late next block has a later timestamp, so an unlock time still holds, but a deadline (`block.timestamp < deadline`) can pass the check and then fail on-chain.

**Costs and risks.**

- If another transaction changes the state first, or a block lands while yours is being sent, your transaction can revert on-chain. On networks with a private-mempool option in the Network list (for example Ethereum (Flashbots), which sends through Flashbots Protect), choose it so a failed prediction costs nothing. The check then runs on the private relay, the same RPC that sends, so the call is not shown to any other RPC. A private relay does not promise inclusion in the very next block. Elsewhere a lost race or an early send spends gas.
- KeeperHub does not stop a second send. With a trigger that fires every block, the run after the one that sent can still see the job as unworked (your transaction is not mined yet) and send again. Make the Condition before the write read something your transaction changes, or use a private-mempool network so a duplicate that reverts costs nothing.
- Gas sponsorship is off for a write with this setting, because the sponsor would simulate against the latest block again. Keep native gas in the wallet that pays.
- The extra calls take time. On networks with very short blocks the transaction can still land a block late.

**How the check runs.**

- **Writes** (Write Contract, and Batch Write Contract's send) use `eth_estimateGas` with block overrides: one call gives the revert check, the revert reason and the gas for the success path. This works on Flashbots Protect, which does not allow `eth_call`. If the RPC does not accept block overrides on `eth_estimateGas`, `eth_simulateV1` runs the check instead, and its gas used is taken plus about 27% (for refunds and nested calls) before your Gas Limit Multiplier applies; very deeply nested calls may need a higher multiplier.
- **Reads** (Read Contract, and Batch Write Contract's per-call check before sending) need return data, so they use `eth_simulateV1`, or `eth_call` with block overrides. Read Contract always uses the network's regular RPC, never a private relay. Batch Write Contract's check runs on its own network's RPC, so on a private relay that allows neither method, such as Flashbots Protect, it cannot run at the next block. Its send reuses the check's prediction while the block it was predicted from is still the latest and the predicted slot has not passed; otherwise (a new block, or a slot passed while the batch waited to send) the send checks again, and the reported `simulation` is the send's.
- Each check is paired with a proof call showing that the RPC applies the predicted timestamp (on a load-balanced RPC the two are separate requests). If the proof shows the timestamp was not applied, or the RPC rejects the overrides (for a write, after the `eth_simulateV1` fallback), the step fails with "Next-block simulation is not supported by this network's RPC", naming the method, rather than falling back to the latest block. That failure stops the run even with Fail workflow on error off, and the fallback RPC is not tried for it. Temporary RPC errors are retried and fail over as usual; if they persist, the step fails like any RPC error (softened when Fail workflow on error is off), and the next run or a re-run tries again.
- To check an RPC without sending, run the write once while the job is still locked: an error ending with "(simulated as of next block N, timestamp T)" means the check works and nothing was sent. To use a different RPC for a network, set one through [RPC preferences](/api/user#rpc-preferences).

**Example.** Race a job that unlocks at `lastRun + interval`:

```
Block trigger (every block)
  -> Read Contract "Read lastRun" (id lastRun)      lastRun()
  -> Read Contract "Read interval" (id interval)    interval()
  -> Condition     {{@__system:System.unixTimestamp}} - {{@lastRun:Read lastRun.result}} >= {{@interval:Read interval.result}} - 24
  -> Write Contract    run(), Simulate at: Next block, Network: Ethereum (Flashbots), Fail workflow on error: off
```

The Condition keeps runs far from the unlock from reaching the write: 24 is two 12-second blocks, so use about twice the block time on other networks. It only subtracts, because read results are text and `+` would join them instead of adding. Close to the unlock, the write's check reverts until the run where the next block is the first valid one; its error ends with "(simulated as of next block N, timestamp T)". That run sends. If the job exposes a check such as `workable()`, a single Read Contract with Simulate at set to Next block can replace the two reads and the arithmetic.

**Output.** With Next block set, the step output includes `simulation` once the check has run, also when a failure is softened by Fail workflow on error:

```json
{
  "simulation": {
    "mode": "next-block",
    "baseBlock": 1000000,
    "assumedBlockNumber": 1000001,
    "assumedTimestamp": 1795447751,
    "timestampOffsetSec": 12,
    "rpcMethod": "eth_estimateGas+blockOverrides"
  }
}
```

`baseBlock` is the latest block the check started from. `assumedTimestamp` is the predicted time of the next block and `timestampOffsetSec` the block time used; on beacon-chain networks, after a missed slot or on a slow RPC, `assumedTimestamp` can be more than one block time after `baseBlock`'s timestamp. `rpcMethod` is `eth_estimateGas+blockOverrides`, `eth_simulateV1` or `eth_call+blockOverrides`. Compare `assumedBlockNumber` with the block in the transaction link to see whether the transaction made the predicted block. `simulation` is absent when the step failed before the check ran, for example on an invalid setting or an RPC that does not support it.

### When a write fails

`Fail workflow on error` is on by default, so a write that fails stops the run and the failure is reported on the node.

Turn it off and the failure is softened instead: the workflow continues, and the node reports `success: true` with `error` and `rejection` set. The softened result carries only those three fields (plus `simulation` when Simulate at is Next block), so `transactionHash`, `transactionLink` and the receipt fields are absent from it. Read `error` to tell a softened failure from a real success, because at the node the two are otherwise identical.

The two halves of a softened failure are reported in different places, which is the part that surprises people:

- **On the node:** `success: true`, `error` set, no `transactionHash`.
- **On the execution:** `status: success`, `transactionHashes: []`, and `errorContext: null`, because that field is only populated for a failed status. The run reads as a success in `/api/analytics/runs` with no hash against it.

Not every failure softens. A failure with no class, or one classified as a third-party dependency, is softened. One classified as this workflow's own configuration or as a platform problem still fails the run whatever the toggle says, and so does a write whose outcome the platform cannot yet determine: a send that is still in flight is never reported as a success.

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
| Fail workflow on error | `failOnError` | `true` or `false` (or `"true"` / `"false"`), on by default. Off softens a failed write into `success: true` with `error` set. Anything else, a template included, is refused at save, unless the step already holds it (see [On/off toggles](/workflows/templating#onoff-toggles)); a value kept that way runs as off only when it resolves to `false`. |
| Priority Fee (gwei) | `priorityFeeGwei` | plain decimal string in gwei (e.g. `"3"`), optional. Greater than 0, at most 10000, at most 9 decimal places. Templates are allowed. Empty uses the network default. A value that is set but not valid (for example `"abc"`, `"0x5"`, `"1e3"`, `"0"`) fails the step before anything is sent. The editor shows the field only while the node pays its own gas. When set, the node is never gas-sponsored and pays gas from the sending wallet. See [Priority Fee](/wallet-management/gas#priority-fee). |
| Max Fee (gwei) | `maxFeeGwei` | plain decimal string in gwei (e.g. `"50"`), optional. Same format rules as `priorityFeeGwei`, and at least the priority fee when both are set. Empty means no cap. Higher fees are lowered to the cap; a cap below the next block's base fee fails the step before anything is sent (softened when `failOnError` is off). The editor shows the field only while the node pays its own gas. When set, the node is never gas-sponsored and pays gas from the sending wallet. See [Max Fee](/wallet-management/gas#max-fee). |
| Sponsor gas | `sponsorGas` | `true` or `false` (or `"true"` / `"false"`), on by default. Off always pays gas from your own wallet. Anything else, a template included, is refused at save, unless the step already holds it (see [On/off toggles](/workflows/templating#onoff-toggles)); a value kept that way runs as off only when it resolves to `false`. |
| Simulate at | `simulateAt` | `"latest"` (default) or `"next-block"`. See [Simulate at the next block](#simulate-at-the-next-block). |
| Next block timestamp offset (seconds) | `simulateTimestampOffsetSec` | The block time (slot length) used to predict the next block's time: a whole number from 1 to 60. Empty uses the network's block time. Read only when `simulateAt` is `"next-block"`. Read Contract and Batch Write Contract take the same two keys. |

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
