---
title: "Direct Execution API"
description: "KeeperHub Direct Execution API - execute blockchain transactions without workflows."
---

# Direct Execution API

The Direct Execution API allows you to execute blockchain transactions directly without creating workflows. All endpoints require API key authentication and are subject to rate limiting and spending caps.

## Authentication

All direct execution endpoints require an organization API key (`kh_`) passed in the `Authorization` header as a bearer token:

```http
Authorization: Bearer kh_your_api_key
```

See [Authentication](/api/authentication) for the full auth model and [API Keys](/api/api-keys) for details on creating and managing API keys.

Scope is enforced on these endpoints. A key created with `mcp:read` only can read execution status and run dry-run simulations, but is refused with `403 insufficient_scope` when it tries to broadcast. Broadcasting needs `mcp:write` or `mcp:admin`. A key created without any scope has no scope restriction and passes every gate; the same rules apply to MCP OAuth tokens.

## Rate Limits

Direct execution requests are limited to 60 requests per minute per API key. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` so you can pace requests; a `429` adds `Retry-After` with the seconds to wait. See [API errors](errors.md#rate-limit-headers) for the full header reference.

## Spending Caps

Two independent daily caps bound the native token **value** an organization moves (gas is not counted against them):

| Cap | Unit | Applies to |
| --- | --- | --- |
| `dailyValueCapWei` | wei | every EVM chain |
| `dailySolanaValueCapLamports` | lamports | Solana |

**Every organization is capped, including one that has never configured anything.** An organization that has set no cap of its own, or that clears one, gets the platform default for that chain family rather than unlimited spending. There is no uncapped state: raising the ceiling means setting a higher number, not leaving the field empty. The defaults are `0.02 ETH` per day for EVM chains and `0.5 SOL` per day for Solana; self-hosted deployments can change them with the `EXECUTE_DEFAULT_DAILY_VALUE_CAP_WEI` and `EXECUTE_DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS` environment variables.

Both caps count value moved by workflow runs as well as by this API, so the two cannot be used to double-spend the same daily budget. Exceeding one returns `403` with `Daily spending cap exceeded` (or `Daily Solana spending cap exceeded`).

Call `GET /api/analytics/spend-cap` before planning a large transfer. Read `effectiveDailyCapWei` and `effectiveDailySolanaCapLamports` — those are the figures enforcement uses. A null `dailyCapWei` means the organization configured nothing, not that spending is unbounded.

### Stablecoin transfers

An ERC-20 transfer carries no native value, so the daily caps above cannot see it. A single transaction that moves a recognised stablecoin (any token listed for that chain and flagged as a stablecoin) is limited to **100 USD**, applying the 1:1 peg to the token's own decimals. The limit is per transaction rather than per day, and covers every write path: `/api/execute/transfer`, `/api/execute/contract-call`, protocol actions, `/api/execute/node`, and the equivalent workflow steps. Over the limit nothing is signed or broadcast; the request completes as a failed execution (`202` with `status: "failed"`) whose error reads `Stablecoin transfer of ... exceeds the 100.0 USD per-transaction limit`. Self-hosted deployments can change the figure with `EXECUTE_DEFAULT_STABLECOIN_CAP_MICRO_USD` (micro-USD, so `100000000` is 100 USD).

A dry run reports the same refusal: simulating an over-limit transfer returns a failed simulation carrying the limit, rather than a clean estimate for a transfer that would fail at broadcast.

`approve` is bounded by the same figure, with one exception. Approving more than the limit is allowed when the spender is a contract belonging to a protocol integration, which is what makes the usual approve-then-swap pattern work. Approving more than the limit to any other address is refused, because an unbounded allowance to an address outside that set is a standing right to move the balance that no later check can see. An approval at or under the limit is always allowed.

Two things this does **not** do: it does not price non-stablecoin ERC-20s, which are not bounded at all, and it does not cover Solana. SPL token transfers are outside the ceiling, and the daily Solana cap counts native SOL only.

## Safe First-Write Sequence

Use the same request body from simulation through broadcast so the transaction
you inspected is the transaction you send:

1. Read `GET /api/chains` and choose a chain where `isEnabled` and `isTestnet`
   are both `true`.
2. Send the intended request with `"simulate": true`. Continue only when the
   response has `success: true` and `wouldRevert: false`.
3. Remove `simulate`, add an `Idempotency-Key` header, and send the request
   once. The key must identify the work rather than the attempt, so that a
   retry sends the same one: see [Choosing a stable key](#choosing-a-stable-key).
4. Save the returned `executionId`, then poll
   `GET /api/execute/{executionId}/status`. Honor the
   `X-Poll-Interval-Hint` response header between polls.
5. Treat the status response's `receipts` as the authoritative onchain proof:
   each entry is a receipt re-fetched from the chain, so `verified` and
   `receiptStatus` say what actually happened. `transactionHash` and
   `transactionLink` identify the transaction but are self-reported by the
   write path.

This sequence catches bad addresses, ABI mistakes, insufficient balances, and
reverts before broadcast, while idempotency makes an interrupted client safe to
retry. Start with a testnet and testnet funds; simulation does not sign or send
a transaction.

## Idempotency

Send an `Idempotency-Key` header to safely retry a request without risking a double-execution. The key is any client-chosen string (for example an agent-side transaction id, ideally a UUID). Every guarantee below depends on the retry sending the **same** key, so a caller that reconstructs a request rather than replaying a buffered one must derive its key deterministically: see [Choosing a stable key](#choosing-a-stable-key).

- **Replay**: a retry with the same key and the same request body returns the original response (same `executionId`, same status) without executing again, plus an `idempotentReplay` marker described below. Replay lasts 24 hours from the original request. Past that the stored response is gone and the same key executes again, silently, so a job that repeats on a cadence of a day or longer needs a time bucket in its key: see [Choosing a stable key](#choosing-a-stable-key).
- **Conflict**: reusing a key with a different request body returns `409` with code `idempotency_conflict`, `retryable: false`, and the `originalExecutionId` the key first produced. Use a new key for genuinely different work, not for a retry of the same work whose body was reconstructed: see [Choosing a stable key](#choosing-a-stable-key).
- **In progress**: a duplicate that arrives while the first request is still running returns `409` with code `idempotency_in_progress` and `retryable: true`; retry shortly with the same key.
- **Scope**: keys are scoped per organization and per endpoint, so the same key is shared across an org's API keys but does not collide between `/transfer`, `/contract-call`, `/check-and-execute`, and a workflow webhook.
- **Window**: stored responses are replayable for 24 hours. After that the key is free to reuse.

### Recognising a replay

A replayed response is otherwise indistinguishable from a fresh one, which matters most when the stored outcome was a failure: the body carries the original error and nothing else, so a retry loop reads "still reverting" when in fact no transaction was sent. To make the difference visible, a replayed JSON-object body carries an extra top-level field:

```json
{
  "success": false,
  "error": "Contract call failed: Error(LK: not yet due)",
  "idempotentReplay": true
}
```

- `idempotentReplay` is present **only** on a replay, and is always `true`. A fresh response never carries it, so treat its absence as "this outcome just happened".
- It is added to **every** replayed object body, successes as well as failures. A replayed `202` carries it alongside the original `executionId`.
- It is added at read time only. The stored response is never modified, so replaying twice returns the same body both times.
- Bodies that are not JSON objects (arrays, strings, `null`) are returned untouched, so a client that already parses those shapes is unaffected.
- The marker rides in the body rather than a response header because the common consumer is an agent reading a tool result, where headers are not surfaced.

Conflict and in-progress responses are not replays and never carry the field.

### When to reuse a key, and when to rotate it

The two `409` codes mean opposite things, so the status does not separate them.
Both carry `retryable`, which answers one narrow question: is it safe to send this
request again under the same key? The field is on these two codes only, and every
other status keeps the semantics documented in [Errors](/api/errors) whether or
not it is present.

```json
{
  "error": "A request with this Idempotency-Key is already being processed. Retry the same key shortly; do not rotate it.",
  "code": "idempotency_in_progress",
  "retryable": true
}
```

**Reuse the same key** whenever you do not hold a definite outcome for the previous
attempt. A timeout, a dropped connection or a `5xx` tells you nothing about whether
the request was received, so a retry must be able to match the original. Reusing the
key is what makes that retry safe: it returns the in-progress guard while the first
request is still running, and the real outcome as a replay once it finishes.

**Rotate to a new key** once the previous attempt returned a definite result. A
stored failure is replayable for 24 hours, so a key that has already failed keeps
returning that failure rather than retrying.

**A conflict does not by itself mean rotate.** `retryable: false` says only that
this body is not the body the key was bound to, and there are two reasons for
that. If the work is genuinely different, rotate — that is what a new key is
for. If it is the same intent whose body was re-serialized, the body drifted and
the intent did not: `hashRequest` normalizes key order but not values, so `"0.1"`
against `"0.10"`, `network` in place of `chainId`, or a reworded memo all produce
a conflict for work that is already under way. Rotating there escapes the
in-progress guard on a request that may already have broadcast. Canonicalize the
body and keep the key.

Rotating a key while a request may still be in flight is the case to avoid. It escapes
the in-progress guard, and for a fund-moving call the second request can broadcast a
transaction for an action the first one is already completing.

Requests without an `Idempotency-Key` behave normally. Read-only and dry-run (`simulate: true`) requests are not affected.

```bash
curl -X POST https://app.keeperhub.com/api/execute/transfer \
  -H "Authorization: Bearer kh_..." \
  -H "Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7" \
  -H "Content-Type: application/json" \
  -d '{ "chainId": "8453", "recipientAddress": "0x...", "amount": "0.1" }'
```

Workflow webhooks (`POST /api/workflows/{workflowId}/webhook`) accept the same header, scoped per workflow.

### Choosing a stable key

A UUID generated per attempt does not survive a retry: the second attempt generates a
different UUID, so the request is treated as new and executes again. A UUID works only
when it is persisted before the first attempt and recovered afterwards.

A caller that cannot persist a key must derive one that is reproducible from the work
itself. Derive it from a canonical form of the caller's own stable identifier for the
piece of work, joined with the fields that determine the onchain effect:

```text
taskId|chainId|recipientAddress|amount|tokenAddress
```

The separator is a single ASCII vertical bar, `U+007C`, with no surrounding whitespace.

`taskId` is whatever the caller already uses to name the work: an invoice number, a
payroll period, a job id. It must be stable across a retry of the same work and
different for different work.

Work that repeats on a schedule needs the period in the `taskId`, not just the job name.
A daily job keyed on `nightly-sweep` alone derives the same key on every run, and because
the replay window is 24 hours it lands near the boundary each time: sometimes inside the
window, where the run is swallowed as a replay, sometimes outside it, where the run
executes. Including the period, as in `nightly-sweep-2026-08-06`, makes each run distinct
work with a full 24 hours of retry protection of its own.

Canonicalize each part before joining:

- **`taskId`**: trim surrounding whitespace, and percent-encode any `%` as `%25` and any
  `|` as `%7C`. Without this a `taskId` of `8453|0xabc` on chain `1` joins to the same
  string as a different intent on chain `8453`. Do not case-fold it; task identifiers
  are opaque to this endpoint.
- **Resolve the chain to one spelling.** These endpoints accept `chainId` and also the
  deprecated `network` alias, so `{"network": "base"}` and `{"chainId": 8453}` are the
  same transfer. Resolve the alias to a numeric chain id first, then use its decimal
  integer form with no leading zeros, so `8453`, `"8453"` and `"base"` all agree.
- **Lowercase addresses**, so a checksummed and an unchecksummed address agree.
- **Canonicalize `amount` as a decimal string**, not a binary float, under all of the
  following rules, so that two conforming implementations cannot disagree:
  - trim surrounding whitespace, and reject a leading `+` or `-`
  - use no exponent notation
  - require at least one digit before the decimal point, so `.5` becomes `0.5`
  - strip leading zeros, except the single `0` before a decimal point, so `01.5`
    becomes `1.5` and `007` becomes `7`
  - strip trailing zeros after the decimal point, then strip a trailing decimal point,
    so `0.0010` becomes `0.001` and `1.000` becomes `1`
  - if the rules above leave an empty string, use `0`, so `0`, `0.0` and `0.000` all
    agree regardless of the order the rules are applied in

  Specifying the string form rather than a numeric type is deliberate: a caller parsing
  `"0.1"` as a 64-bit float gets `0.100000000000000006`, and binary floats also collapse
  distinct 18-decimal amounts onto the same value.
- **Represent omitted optional fields as an empty string**, so the separator positions
  stay fixed.

Hash the joined string's UTF-8 bytes with SHA-256 and send the digest as lowercase hex
in the `Idempotency-Key` header.

#### A stable key does not by itself produce a replay

Deriving a stable key is necessary but not sufficient, and it is worth being precise
about what it buys, because the difference decides how a caller should handle the
response.

The stored record is keyed on `(organization, scope, key)`, but the **request body is
hashed too**, and only a value-equal body replays. The body is hashed after it is parsed,
so formatting is normalized — whitespace, key order, and the spelling of JSON *numbers*
all stop mattering, and `{"chainId": 8453}` and `{"chainId": 8.453e3}` are the same body.
What is not normalized is the value itself, so anything carried as a string keeps its
exact spelling. `{"network": "base"}` and `{"chainId": 8453}` are different bodies, as are
the strings `"0.001"` and `"0.0010"`, and so is a `reason`, `memo` or `note` field that
the caller reworded between attempts.

So a retry that reuses a stable key with a reconstructed, value-different body returns
`409 idempotency_conflict`, not a replay. **That is the outcome to design for**, and it
is the safe one: the fail-closed `409` is precisely what stops the reconstructed retry
from executing a second time. A caller that expects a replay will read it as a bug in
its key derivation and reach for a fresh key, which is the one response that does cause
a double-execution.

Handle it as an answer rather than an error. When the `409` body carries a non-null
`originalExecutionId`, poll `GET /api/execute/{executionId}/status` with it to learn the
outcome of the work you were retrying.

`originalExecutionId` is nullable, and it is null in the two cases you are most likely to
hit here: the first attempt reached the broadcast path and failed, and the first attempt
is still in flight. Neither is a reason to rotate the key. Instead, canonicalize the body
with the rules above so it matches the original and re-send under the same key. A record
that has settled — whether it succeeded or failed — replays its stored response, so that
re-send returns the original outcome rather than executing again; a record still in
flight returns `409 idempotency_in_progress`, which is the retryable code, so back off
and re-send.

To get an actual replay instead, the retry must reproduce every value in the body, though
not its formatting. Canonicalize the body with the same rules used for the key, and omit
free-text fields whose wording is not reproducible, rather than regenerating them.

A stable key makes a **repeated** submission of the same work safe. It does not help
with three other cases:

- the caller submits genuinely different work, which needs a different key rather than
  deduplication
- the state that justified the request has changed by the time the transaction lands,
  which needs a check before submission
- the same work is legitimately repeated but the key cannot tell it apart from a retry

The last case is why `taskId` belongs in the key by default. **Omit it only when
repeating the transfer would genuinely be a mistake.** Hashing the effect fields alone
makes every identical transfer the same request, so an agent that legitimately pays the
same recipient the same amount twice inside the 24 hour window gets the second call
answered from the first one's cached response: the original `executionId`,
`status: completed`, and no second transfer. That outcome is flagged only by
`idempotentReplay: true` in the body, which is easy to miss if the caller does not check
that field, so the second payment can go missing while the response reads as success.

## Sponsored Executions

Writes may be gas-sponsored and broadcast through a relayer or smart-account
(EIP-7702) path instead of your org's EOA wallet. A sponsored execution does
not change your EOA's nonce or native balance, and it will not appear in a
block explorer's `txlist` for that address — checks against the EOA will
conclude nothing happened even though the transaction succeeded. Check the
`sponsored` field on the status response and treat `transactionHash` /
`transactionLink` as the authoritative proof, not EOA-level state.

## Transfer Funds

```http
POST /api/execute/transfer
```

Transfer native tokens (ETH, MATIC, etc.) or ERC-20 tokens directly.

### Request Body

```json
{
  "chainId": 11155111,
  "recipientAddress": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "amount": "0.1",
  "tokenAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "gasLimitMultiplier": "1.2"
}
```

### Recipient validation

`recipientAddress` is validated with a strict **EIP-55 checksum** before the
request is accepted. Pass either:

- the exact checksummed form (mixed-case), or
- an **all-lowercase** address (e.g. `0x742d35cc6634c0532925a3b844bc454e4438f44e`).

A mixed-case address whose checksum does not match is rejected with
`Invalid recipient address: <address>` — even if the lowercase hex is correct.
Widely-copied example addresses often carry a mangled checksum or the wrong
number of hex digits, so prefer copying from the address book or from a tool
that computes EIP-55 rather than retyping. Add frequently-used recipients to the
[address book](/wallet-management/address-book) first; address book entries are
stored lowercase and displayed in checksummed form.

**Parameters:**

- `chainId` (required): Numeric chain ID as a number or numeric string (for
  example, `11155111` for Ethereum Sepolia or `8453` for Base). The legacy
  `network` field still accepts known chain names but is deprecated.
- `recipientAddress` (required): Destination wallet address
- `amount` (required): Amount in human-readable units (e.g., "0.1" for 0.1 ETH or tokens)
- `tokenAddress` (optional): ERC-20 token contract address. Omit for native token transfers.
- `tokenConfig` (optional): JSON string with token metadata for non-standard tokens: `{"decimals":18,"symbol":"USDC"}`
- `gasLimitMultiplier` (optional): Gas limit multiplier (e.g., "1.5" for 50% buffer)

### Response

Successful broadcast requests return HTTP `202 Accepted`:

```json
{
  "executionId": "direct_123",
  "status": "completed",
  "transactionHash": "0x...",
  "transactionLink": "https://etherscan.io/tx/0x..."
}
```

The execution runs synchronously. Status will be `completed`, `failed` or
`unconfirmed` when the request returns. `transactionHash` and `transactionLink`
are present only when the transfer step reported success, so a `failed` or
`unconfirmed` response carries neither - including when a transaction was
broadcast and its receipt could not be confirmed. Retrieve the hash for those
from `GET /api/execute/{executionId}/status`, which reads the stored execution
rather than the step result.

## Call Smart Contract

```http
POST /api/execute/contract-call
```

Call any smart contract function. Automatically detects read vs write operations.

### Request Body

```json
{
  "contractAddress": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  "chainId": 1,
  "functionName": "balanceOf",
  "functionArgs": "[\"0x742d35Cc6634C0532925a3b844Bc454e4438f44e\"]",
  "abi": "[{...}]",
  "value": "0.1",
  "gasLimitMultiplier": "1.2"
}
```

**Parameters:**

- `contractAddress` (required): Smart contract address
- `chainId` (required): Numeric chain ID as a number or numeric string. The
  legacy `network` field still accepts known chain names but is deprecated.
- `functionName` (required): Name of the function to call. The workflow web3
  action node config calls this same value `abiFunction`; this route accepts
  `abiFunction` as an alias so payloads copied between the two layers bind
  without a rename. If both keys are present their values must agree once
  surrounding whitespace is trimmed; a mismatch - including an empty or
  non-string `functionName` next to a different `abiFunction` - is rejected
  with a 400 naming both values.
- `functionArgs` (optional): JSON array string of function arguments (e.g., `"[\"0x...\", \"1000\"]"`)
- `abi` (optional): Contract ABI as JSON string. Auto-fetched from block explorer if omitted.
- `value` (optional): Native value to send with the call, as a decimal string in ether units (e.g. `0.1`) (for payable functions)
- `gasLimitMultiplier` (optional): Gas limit multiplier

**Direct execution vs. workflow node field names**

The same values carry different field names depending on which surface you're
building against. This route accepts either spelling; workflow node config
accepts only the single spelling in the right-hand column, which is not the
canonical one in either row.

| Meaning | `POST /api/execute/contract-call` | Workflow web3 action node config |
|---|---|---|
| Chain to execute on | `chainId` (canonical), `network` (deprecated alias) | `network` |
| Function to call | `functionName` (canonical), `abiFunction` (alias) | `abiFunction` |

The `abiFunction` alias is specific to this route. `check-and-execute` still
requires `functionName` (and `action.functionName`), so a body that carries
only `abiFunction` is rejected there with a 400.

### Response

**Read Function (view/pure):**

```json
{
  "result": "1500000000000000000"
}
```

Read functions return immediately with the result value.

**Write Function:**

```json
{
  "executionId": "direct_123",
  "status": "completed",
  "transactionHash": "0x...",
  "transactionLink": "https://etherscan.io/tx/0x..."
}
```

Write functions execute synchronously. `status` is `completed`, `failed` or
`unconfirmed` by the time the request returns.

`transactionHash` is present whenever a transaction reached the chain, which
includes `failed` and `unconfirmed`. A call that reverts still produced a
transaction, and the hash is how you find out what the chain said about it. It
is absent only when the call never broadcast - a guard, a validation error, or
a failure before submission.

`transactionLink` accompanies the hash whenever the write produced an explorer
URL, including a reverted or unreadable broadcast.

## Protocol Actions

```http
POST /api/execute/{protocol}/{action-slug} <!-- api-docs-ignore -->
```

Execute a registered protocol action (for example `POST /api/execute/aave-v3/supply`). <!-- api-docs-ignore -->
Use `search_protocol_actions` via MCP or the protocol registry to discover
available actions and their parameters.

### Request Body

Pass action parameters as a JSON object. `chainId` is required for every action
(the legacy `network` field is accepted as a deprecated alias). Required fields
for each action are defined in the protocol registry.

### Response

**Read actions** return the plugin result directly with HTTP `200`.

**Write actions** return HTTP `202 Accepted` with this endpoint's envelope
(`executionId`, `status`, and the optional fields below). `status` is one of
`completed`, `failed`, or `unconfirmed`. Unlike [Call Smart
Contract](#call-smart-contract) writes, protocol writes may include `rejection`
and `errorClass` on a failed write, and they include `transactionLink` whenever
the write step produced one (including on revert). Call Smart Contract writes
omit `rejection`/`errorClass` and omit the link on a reverted call.

```json
{
  "executionId": "direct_123",
  "status": "failed",
  "transactionHash": "0x...",
  "transactionLink": "https://etherscan.io/tx/0x...",
  "error": "execution reverted",
  "errorClass": "external",
  "rejection": {
    "kind": "string-revert",
    "reason": "execution reverted"
  }
}
```

`executionId` and `status` are always present. `transactionHash` and
`transactionLink` are included whenever the write broadcast a transaction,
including on `failed` and `unconfirmed`, so a reverted or still-pending call
stays look-up-able in the explorer.

`error` is present only when `status` is `failed`. `rejection` and `errorClass`
are optional and appear only on failed writes when the step could classify the
revert.

`unconfirmed` is non-terminal and poll-only: the transaction was broadcast but
the chain has not confirmed it yet. Do not treat the body as a failure. Do not
rotate `Idempotency-Key` or re-submit; the transaction may still land and a
second send moves funds twice. Poll `GET /api/execute/{executionId}/status`
until `completed` or `failed` for receipts and the persisted result.

## Check and Execute

```http
POST /api/execute/check-and-execute
```

Read a contract value, evaluate a condition, and conditionally execute a write operation.

### Request Body

```json
{
  "contractAddress": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  "chainId": 1,
  "functionName": "balanceOf",
  "functionArgs": "[\"0x742d35Cc6634C0532925a3b844Bc454e4438f44e\"]",
  "abi": "[{...}]",
  "condition": {
    "operator": "gt",
    "value": "1000000000000000000"
  },
  "action": {
    "contractAddress": "0x...",
    "functionName": "transfer",
    "functionArgs": "[\"0x...\", \"500000000000000000\"]",
    "abi": "[{...}]",
    "gasLimitMultiplier": "1.2"
  }
}
```

**Condition Operators:**

- `eq`: Equal to
- `neq`: Not equal to
- `gt`: Greater than
- `lt`: Less than
- `gte`: Greater than or equal to
- `lte`: Less than or equal to

The check function must resolve to exactly one supported scalar output.
Solidity integers support all six operators. `address` and `bytes1` through
`bytes32` support `eq` and `neq` only. `condition.value` must be a
`BigInt`-compatible decimal or hexadecimal string. KeeperHub rejects empty,
multi-output, compound, or otherwise unsupported ABI return shapes with HTTP
`400` before the check RPC call. It also rejects an operator that the output
type does not support, or a runtime result that cannot be compared, before the
action executes. The action leg never forwards native value; `action.value` is
not part of the supported request shape.

### Response

**Condition Not Met:**

```json
{
  "executed": false,
  "conditionResult": {
    "met": false,
    "observedValue": "500000000000000000",
    "targetValue": "1000000000000000000",
    "operator": "gt"
  }
}
```

**Condition Met and Action Executed:**

```json
{
  "executed": true,
  "executionId": "direct_123",
  "status": "completed",
  "conditionResult": {
    "met": true,
    "observedValue": "1500000000000000000",
    "targetValue": "1000000000000000000",
    "operator": "gt"
  }
}
```

The request field is `condition` and the response field is `conditionResult`, on
both the broadcast and the `simulate: true` paths. A parser written once against
this endpoint works for both.

## Dry-Run Simulation

All three execute endpoints (`/api/execute/transfer`, `/api/execute/contract-call`, `/api/execute/check-and-execute`) accept a `simulate` flag on the body. When set to boolean `true`, the endpoint validates inputs, resolves the org's from-address, encodes the call, and runs `provider.estimateGas` + `provider.call` against the chain — **without** signing or broadcasting a transaction.

No row is inserted into the execution audit table, no funds are reserved against the spending cap, and no transaction hash is produced. Use it to pre-flight a transaction (catch reverts, allowance mismatches, balance shortfalls, ABI mistakes) before spending gas.

A deterministic failed simulation answers with HTTP `400`. Do not classify every such body as an EVM
revert: read a string `code` first, then `failureKind`, then `wouldRevert`. A `code` is an
attributed preflight failure such as `insufficient_balance`; `failureKind: "revert"`
with `wouldRevert: true` is a confirmed call revert; an uncoded
`failureKind: "validation"` is not. Route-level parameter errors may carry none of these
fields. This ordering keeps a generic "non-2xx means the request is malformed" wrapper
from discarding actionable chain-state diagnostics without mislabelling input errors as
reverts. A simulator infrastructure failure uses `failureKind: "unavailable"`,
`wouldRevert: false`, and HTTP `503` instead.

### Request

Add `"simulate": true` to any of the standard request bodies:

```json
{
  "contractAddress": "0x...",
  "chainId": 1,
  "functionName": "transfer",
  "functionArgs": "[\"0x...\", \"1000000\"]",
  "abi": "[{...}]",
  "simulate": true
}
```

`simulate` must be a strict boolean — `true` or `false`. Strings (`"true"`), numbers (`1`), and other non-boolean values are rejected with HTTP 400 to prevent silent fall-through to a real broadcast. There is no query-string form; the body field is the only way to request a dry run.

Because a dry run never signs or broadcasts, a credential scoped `mcp:read` may run one. Removing `simulate` to broadcast requires `mcp:write`.

### Response — successful simulate

```json
{
  "success": true,
  "status": "simulated",
  "from": "0x...orgWallet",
  "to": "0x...target",
  "value": "1000000000000000000",
  "gasEstimate": "65000",
  "simulatedReturnValue": true,
  "wouldRevert": false
}
```

- `from`: the org's wallet address used as the sender (see "Known limitation" below)
- `to`: the low-level call target. For an ERC-20 transfer this is the token contract,
  not the transfer recipient
- `value`: native value in wei sent with the call
- `gasEstimate`: estimated gas units required by the call, as a decimal string
- `simulatedReturnValue`: the decoded return value of the call (e.g. `true` for ERC-20 `transfer`, the read value for view functions, `null` for native transfers to an EOA recipient)
- `wouldRevert`: always `false` on this path

### Response — would-revert

When the chain would have rejected the transaction, the endpoint returns HTTP 400 with the decoded reason:

```json
{
  "success": false,
  "status": "simulated",
  "from": "0x...orgWallet",
  "to": "0x...target",
  "value": "0",
  "failureKind": "revert",
  "wouldRevert": true,
  "revertReason": "Error(ERC20: transfer amount exceeds balance)",
  "error": "Error(ERC20: transfer amount exceeds balance)"
}
```

- `failureKind`: `"revert"` confirms that the call produced a revert rather than an
  input or preflight failure
- `wouldRevert`: `true` on this failure path; use it together with `failureKind`, not as
  a revert discriminator by itself

Revert decoding tries (in order): the contract's own ABI custom errors, common OpenZeppelin / standard errors, then the standard `Error(string)` revert (which is surfaced as `Error(<message>)`). If none match, the failure is either attributed to a funding shortfall (see below) or the raw RPC error message is surfaced.

### Response — underfunded sender

A node asked to estimate gas for a transfer the sender cannot pay for rejects it without revert data, and the resulting `CALL_EXCEPTION` names neither the balance nor the address. When the simulator can confirm that is what happened, the failure carries a machine-readable `code` and the numbers a caller needs to fix it:

```json
{
  "success": false,
  "status": "simulated",
  "from": "0x...orgWallet",
  "to": "0x...recipient",
  "value": "1000000000000000000",
  "failureKind": "validation",
  "wouldRevert": true,
  "revertReason": "Insufficient ETH balance. Have: 0.25, Need: 1.0. Fund 0x...orgWallet with at least 0.75 ETH on this chain and retry.",
  "error": "Insufficient ETH balance. Have: 0.25, Need: 1.0. Fund 0x...orgWallet with at least 0.75 ETH on this chain and retry.",
  "code": "insufficient_balance",
  "balanceWei": "250000000000000000",
  "requiredWei": "1000000000000000000",
  "shortfallWei": "750000000000000000",
  "nativeSymbol": "ETH",
  "originalError": "missing revert data (action=\"estimateGas\", ...)"
}
```

- `failureKind`: `"validation"` here means no EVM revert was decoded. It does not mean
  the request data is malformed; inspect `code` before interpreting this discriminator
- `code`: `"insufficient_balance"` — branch on this rather than string-matching `revertReason`. Absent when the simulator has no more specific machine-readable cause
- `balanceWei` / `requiredWei` / `shortfallWei`: the sender's native balance, the native value the call would move, and the difference, all in wei
- `nativeSymbol`: the chain's native currency symbol (`ETH`, `BNB`, `POL`); falls back to `native` if the chain is not seeded
- `originalError`: the node's own message, kept verbatim. Attribution only ever adds — nothing the chain said is discarded
- `undecodedRevertData`: present only when the node did return revert data that no ABI on the decode path matched. The first four bytes are the custom-error selector, which you can look up in a selector database. When this field is set, funding the wallet may not be enough on its own — the contract is also rejecting the call

The comparison is against the transfer value only; gas is not included (the gas estimate is what failed, so there is no number to add). A wallet funded with exactly the transfer amount therefore still fails, carrying the node's own `insufficient funds for gas * price + value` message and no `code`.

**Safe-routed organizations:** the balance is read from `from`, which is the org's EOA. If your organization routes writes through a Safe, the transfer is funded from the Safe instead, so these fields describe the wrong address — see [Known limitation](#known-limitation) below.

### Token-transfer specifics

For ERC-20 transfers, `decimals` is optional — when omitted, the simulator looks up the token's `decimals()` on-chain. `tokenConfig` is resolved through the same helper the broadcast path uses, so `customToken`, `supportedTokenId`, and legacy `tokenConfig` shapes all work identically.

### check-and-execute specifics

`simulate: true` still evaluates the condition (which is read-only) and only swaps the **action's** write for a simulated call. The response wraps the simulate body in the existing `{ executed, conditionResult }` envelope:

```json
{
  "success": true,
  "status": "simulated",
  "from": "0x...",
  "to": "0x...",
  "gasEstimate": "65000",
  "simulatedReturnValue": true,
  "wouldRevert": false,
  "executed": true,
  "conditionResult": { "met": true, "...": "..." }
}
```

`executed` reflects whether the action would have successfully run, so a reverted simulate returns `executed: false`.

#### When no action is simulated

A dry run reaches the action only when the condition is met and the action is a
write. Two outcomes stop earlier, and both answer `200` with `success: true` and
`status: "simulated"`, so the run is never mistaken for a failure:

```json
{
  "success": true,
  "status": "simulated",
  "executed": false,
  "conditionResult": { "met": false, "...": "..." }
}
```

A read-only action answers the same way with `executed: true` and the `result`
of the read.

Neither carries `wouldRevert`. That field is a statement about a specific call
that was encoded and estimated, and on these paths no such call was made, so
there is nothing to report. Read `wouldRevert` only when it is present, and use
`success` to decide whether the dry run itself completed.

Broadcast responses are unaffected: without `simulate: true` these two outcomes
return `{ executed, conditionResult }` exactly as before.

### Known limitation

The `from` address used during simulation is the org's wallet (`getOrganizationWalletAddress`). Organizations that route writes through a Safe will see a simulation that reflects the EOA sending the call, not the Safe. Most config-bug categories (bad ABI, bad args, allowance mismatches) still surface; Safe-routed `msg.sender` semantics do not.

This also applies to the underfunded-sender response above. The balance is read from `from`, but a Safe-routed org funds the transfer from the Safe, so `code`, `balanceWei`, `shortfallWei` and the "Fund `<address>`" sentence describe the EOA rather than the address the broadcast actually spends from. If your organization routes writes through a Safe, do not act on those fields without resolving the signer mode first.

## Get Execution Status

```http
GET /api/execute/{executionId}/status
```

Check the status of a direct execution.

### Response

```json
{
  "executionId": "direct_123",
  "status": "completed",
  "type": "transfer",
  "network": "11155111",
  "transactionHash": "0x...",
  "transactionLink": "https://etherscan.io/tx/0x...",
  "sponsored": false,
  "retryCount": 0,
  "receipts": [
    {
      "hash": "0x...",
      "chainId": 11155111,
      "verified": true,
      "receiptStatus": "success",
      "blockNumber": 11413447,
      "gasUsed": "68115",
      "verifiedAt": "2024-01-01T00:00:15Z"
    }
  ],
  "gasUsedWei": "21000000000000",
  "gasPriceWei": "1163827869",
  "estimatedCostUsd": null,
  "result": {...},
  "error": null,
  "createdAt": "2024-01-01T00:00:00Z",
  "completedAt": "2024-01-01T00:00:15Z"
}
```

**Other fields:**

- `network`: the chain identifier the request supplied, stored verbatim as a
  string. The form is decided by the value, not by the field: both `chainId`
  and the deprecated `network` alias accept a numeric chain ID or a known chain
  name, so `"11155111"` and `"sepolia"` are each reachable through either.
  Do not key a chain lookup on this without handling both forms. A body
  carrying neither field is rejected with a 400 before an execution row exists,
  so this is never `null` on the endpoints documented here.
  When a body sends both, the routes disagree about which wins: `contract-call`
  takes `network`, while `transfer` and `check-and-execute` take `chainId`.
  Send one.
- `retryCount`: internal re-executions of a node execution, which is
  `/api/execute/node` and is not covered by this page. It is always `0` for the
  transfer, contract-call and check-and-execute endpoints documented here,
  whatever happened internally - those paths never set it, so a `0` is not
  evidence that nothing was retried. Where the field is set, each count is a
  fresh execution of the step rather than a replacement of an earlier
  transaction: nothing is resubmitted at a pinned nonce and no gas price is
  bumped. A failure that carries a transaction hash is therefore never
  retried, whatever its message says: the hash means a transaction is already
  live, and a retry would sign a second one rather than replace it. Of the
  failures that carry no hash, only connection-level errors (resets and
  timeouts) are retried, and an error reporting that a transaction is already
  live - a used nonce, an already-known hash, an underpriced replacement - is
  not. The one case left open is an attempt that exceeds its own per-attempt
  timeout: it is abandoned rather than cancelled, so nothing comes back to
  carry a hash, and a per-attempt timeout shorter than the chain's confirmation
  latency can leave two transactions confirmed.
- `gasPriceWei`: the effective gas price, as a decimal string. On EVM chains
  this is in wei. On Solana it is the micro-lamports-per-compute-unit price of
  the priority component, as described in
  [Gas Management](../wallet-management/gas.md).
  Do not multiply it by `gasUsedWei`: that field is already a cost
  (`gasUsed * effectiveGasPrice`), so the product squares the price. The figure
  in gas units is the per-receipt `gasUsed` above, and multiplying that is a
  cost on EVM chains only.
- `estimatedCostUsd`: reserved, and always `null` today. Nothing populates it;
  it awaits a price-oracle integration. Do not branch on it being non-null.

**Receipts:**

`receipts` carries one entry per transaction hash this execution claimed, each
independently re-fetched from the chain before the execution was allowed to
settle. It is the evidence behind `status`, not a restatement of it:

- `verified`: whether this hash positively confirmed on-chain. An execution
  settles as `completed` only when every entry is `true`.
- `receiptStatus`: `success`, `reverted`, `safe_inner_failure` (the outer
  transaction succeeded but a wrapped inner call failed), `not_found`, or
  `timeout`. The last two mean verification could not reach a definitive
  answer within its budget; they fail the execution closed rather than
  optimistically settling it, so a `failed` execution carrying `timeout` may
  describe a transaction that later lands.
- `blockNumber` / `gasUsed`: read from the fetched receipt, not self-reported
  by the write path.

The array is empty for executions that claimed no transaction hash, such as
read calls and simulations.

**Status Values:**

- `pending`: Queued for execution
- `running`: Currently executing
- `unconfirmed`: Broadcast, but the receipt could not be read conclusively yet.
  **Non-terminal.** Keep polling. Do not re-send the request with a fresh
  `Idempotency-Key`, which would risk a second transaction: see
  [Idempotency](#idempotency) and
  [Zero to a Verified Onchain Transaction](/guides/first-verified-transaction).
- `completed`: Successfully completed
- `failed`: Execution failed

Treat this list as a lower bound rather than a closed set. A client that routes an
unrecognised status into a failing `default` branch will report a failure for an
execution that is still settling, and one that responds by retrying with a new
idempotency key can put a second transaction onchain. Decide terminality from the
`X-Poll-Interval-Hint` response header rather than from the status string: the
server computes it from its own terminal set, so it stays correct for statuses
added after your client shipped. `0` means terminal.

`sponsored` is `true` when the write was gas-sponsored and broadcast through
a relayer or smart-account path rather than your org's EOA wallet — see
[Sponsored Executions](#sponsored-executions).

When polling this endpoint, honour the `X-Poll-Interval-Hint` response header instead of polling on a fixed timer: it gives the recommended number of seconds to wait before the next poll. A value of `0` means the execution has reached a terminal state (`completed` or `failed`) and you can stop polling.

## Error Responses

Direct execution endpoints return detailed error information:

```json
{
  "error": "Missing required field",
  "field": "network",
  "details": "network is required and must be a non-empty string"
}
```

**Common Error Codes:**

- `401`: Invalid or missing API key
- `403`: The daily spending cap is exceeded, or the credential lacks the scope the request needs (`insufficient_scope`). Scope is enforced for both OAuth tokens and organization API keys. A key created without a scope has no scope restriction and passes every gate. See [Spending Caps](#spending-caps) — an organization that never configured a cap is still subject to the platform default.
- `422`: Wallet not configured, code `WALLET_NOT_CONFIGURED` (see [Wallet Management](/wallet-management/turnkey))
- `429`: Rate limit exceeded
- `400`: Invalid request parameters

An `insufficient_scope` response names the scope the endpoint needs and the one
this connection is allowed:

```json
{
  "error": "insufficient_scope",
  "message": "This endpoint requires the `mcp:write` scope. This credential is allowed `mcp:read`. Retrying will not widen it. An API key's scope is fixed when the key is created and cannot be raised. A new key has to be issued with the scope this endpoint requires.",
  "retryable": false,
  "required_scope": "mcp:write",
  "granted_scope": "mcp:read"
}
```

The closing sentence names the remedy for the credential that was used, because
the two families differ. An API key's scope is written into the key when it is
created and cannot be changed afterwards, so a new key is the only route. An
OAuth connection is instead told that an owner or admin controls its ceiling
under Settings > Developer > Agents.

`granted_scope` is what the credential may do right now. For an OAuth token that
is not always the scope it was issued with: an organization can cap what its
agents may do, and the cap is applied on every call, so a token issued with
`mcp:admin` reports `mcp:read` here while a read-only cap is in force.
Reauthorizing with a wider scope does not lift a cap; only an owner or admin
can, in the Agents settings. An API key reports the scope stored on the key.

Broadcasting requires `mcp:write`. A dry run (`simulate: true`) neither signs nor broadcasts, so `mcp:read` is sufficient.

## Workflow Run preflight simulation

Before an interactive Run, the workflow editor calls `POST /api/workflows/{workflowId}/simulate` to perform a read-only preflight of reachable EVM write nodes.

The simulation is advisory and never blocks execution. Reverts, funding shortfalls, invalid simulation inputs, unsupported signers, RPC failures, timeouts, and unavailable simulation services are shown in the issues overlay with **Run Anyway** available. A funding shortfall reports the account to fund and the amount it is short by, and names no configured field, because no configured field is wrong.

Only write nodes reachable from a trigger are simulated. Disconnected write nodes are ignored.

Each write is simulated independently against the current chain state. A later write may appear to revert when it depends on an earlier workflow step whose state change has not yet been applied. Later-write warnings therefore state that the result may depend on an earlier step in the workflow.

The endpoint is protected by rate limiting, a maximum of 50 workflow nodes, and a 15-second simulation deadline.

The preflight does not sign or broadcast transactions, create execution records, reserve spending limits, or perform billing operations.
