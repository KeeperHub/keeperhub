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

## Rate Limits

Direct execution requests are limited to 60 requests per minute per API key. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` so you can pace requests; a `429` adds `Retry-After` with the seconds to wait. See [API errors](errors.md#rate-limit-headers) for the full header reference.

## Spending Caps

Organizations can configure daily spending caps in wei. If the cap is exceeded, execution requests return a `403` status with the error message `Daily spending cap exceeded`.

## Safe First-Write Sequence

Use the same request body from simulation through broadcast so the transaction
you inspected is the transaction you send:

1. Read `GET /api/chains` and choose a chain where `isEnabled` and `isTestnet`
   are both `true`.
2. Send the intended request with `"simulate": true`. Continue only when the
   response has `success: true` and `wouldRevert: false`.
3. Remove `simulate`, add a unique `Idempotency-Key` header, and send the
   request once.
4. Save the returned `executionId`, then poll
   `GET /api/execute/{executionId}/status`. Honor the
   `X-Poll-Interval-Hint` response header between polls.
5. Treat the status response's `transactionHash` and `transactionLink` as the
   authoritative onchain proof.

This sequence catches bad addresses, ABI mistakes, insufficient balances, and
reverts before broadcast, while idempotency makes an interrupted client safe to
retry. Start with a testnet and testnet funds; simulation does not sign or send
a transaction.

## Idempotency

Send an `Idempotency-Key` header to safely retry a request without risking a double-execution. The key is any client-chosen string (for example an agent-side transaction id, ideally a UUID).

- **Replay**: a retry with the same key and the same request body returns the original response (same `executionId`, same status) without executing again.
- **Conflict**: reusing a key with a different request body returns `409` with code `idempotency_conflict` and the `originalExecutionId` the key first produced. Use a new key for a different request.
- **In progress**: a duplicate that arrives while the first request is still running returns `409` with code `idempotency_in_progress`; retry shortly.
- **Scope**: keys are scoped per organization, so the same key is shared across an org's API keys.
- **Window**: stored responses are replayable for 24 hours. After that the key is free to reuse.

Requests without an `Idempotency-Key` behave normally. Read-only and dry-run (`simulate: true`) requests are not affected.

```bash
curl -X POST https://app.keeperhub.com/api/execute/transfer \
  -H "Authorization: Bearer kh_..." \
  -H "Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7" \
  -H "Content-Type: application/json" \
  -d '{ "chainId": "8453", "recipientAddress": "0x...", "amount": "0.1" }'
```

Workflow webhooks (`POST /api/workflows/{workflowId}/webhook`) accept the same header, scoped per workflow.

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
  "recipientAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "amount": "0.1",
  "tokenAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "gasLimitMultiplier": "1.2"
}
```

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

The execution runs synchronously. Status will be `completed` or `failed` when the request returns. `transactionHash` and `transactionLink` are present only when `status` is `completed`.

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
  "functionArgs": "[\"0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb\"]",
  "abi": "[{...}]",
  "value": "0.1",
  "gasLimitMultiplier": "1.2"
}
```

**Parameters:**

- `contractAddress` (required): Smart contract address
- `chainId` (required): Numeric chain ID as a number or numeric string. The
  legacy `network` field still accepts known chain names but is deprecated.
- `functionName` (required): Name of the function to call
- `functionArgs` (optional): JSON array string of function arguments (e.g., `"[\"0x...\", \"1000\"]"`)
- `abi` (optional): Contract ABI as JSON string. Auto-fetched from block explorer if omitted.
- `value` (optional): Native value to send with the call, as a decimal string in ether units (e.g. `0.1`) (for payable functions)
- `gasLimitMultiplier` (optional): Gas limit multiplier

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
  "status": "completed"
}
```

Write functions execute synchronously and return execution status.

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
  "functionArgs": "[\"0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb\"]",
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

### Response

**Condition Not Met:**

```json
{
  "executed": false,
  "condition": {
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
  "condition": {
    "met": true,
    "observedValue": "1500000000000000000",
    "targetValue": "1000000000000000000",
    "operator": "gt"
  }
}
```

## Dry-Run Simulation

All three execute endpoints (`/api/execute/transfer`, `/api/execute/contract-call`, `/api/execute/check-and-execute`) accept a `simulate` flag on the body. When set to boolean `true`, the endpoint validates inputs, resolves the org's from-address, encodes the call, and runs `provider.estimateGas` + `provider.call` against the chain — **without** signing or broadcasting a transaction.

No row is inserted into the execution audit table, no funds are reserved against the spending cap, and no transaction hash is produced. Use it to pre-flight a transaction (catch reverts, allowance mismatches, balance shortfalls, ABI mistakes) before spending gas.

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
  "wouldRevert": true,
  "revertReason": "Error(ERC20: transfer amount exceeds balance)",
  "error": "Error(ERC20: transfer amount exceeds balance)"
}
```

Revert decoding tries (in order): the contract's own ABI custom errors, common OpenZeppelin / standard errors, then the standard `Error(string)` revert (which is surfaced as `Error(<message>)`). If none match, the raw RPC error message is surfaced.

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

### Known limitation

The `from` address used during simulation is the org's wallet (`getOrganizationWalletAddress`). Organizations that route writes through a Safe will see a simulation that reflects the EOA sending the call, not the Safe. Most config-bug categories (bad ABI, bad args, insufficient balance, allowance mismatches) still surface; Safe-routed `msg.sender` semantics do not.

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
  "transactionHash": "0x...",
  "transactionLink": "https://etherscan.io/tx/0x...",
  "sponsored": false,
  "gasUsedWei": "21000000000000",
  "result": {...},
  "error": null,
  "createdAt": "2024-01-01T00:00:00Z",
  "completedAt": "2024-01-01T00:00:15Z"
}
```

**Status Values:**

- `pending`: Queued for execution
- `running`: Currently executing
- `completed`: Successfully completed
- `failed`: Execution failed

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
- `422`: Wallet not configured, code `WALLET_NOT_CONFIGURED` (see [Wallet Management](/wallet-management/turnkey))
- `429`: Rate limit exceeded
- `400`: Invalid request parameters
