---
title: "Direct Execution API"
description: "KeeperHub Direct Execution API - execute blockchain transactions without workflows."
---

# Direct Execution API

The Direct Execution API allows you to execute blockchain transactions directly without creating workflows. All endpoints require API key authentication and are subject to rate limiting and spending caps.

## Authentication

All direct execution endpoints require an API key passed in the `X-API-Key` header:

```http
X-API-Key: keeper_...
```

See [API Keys](/api/api-keys) for details on creating and managing API keys.

## Rate Limits

Direct execution requests are limited to 60 requests per minute per API key. When rate limited, the API returns a `429` status with a `Retry-After` header indicating seconds to wait.

## Spending Caps

Organizations can configure daily spending caps in wei. If the cap is exceeded, execution requests return a `422` status with error code `SPENDING_CAP_EXCEEDED`.

## Transfer Funds

```http
POST /api/execute/transfer
```

Transfer native tokens (ETH, MATIC, etc.) or ERC-20 tokens directly.

### Request Body

```json
{
  "network": "ethereum",
  "recipientAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "amount": "0.1",
  "tokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "gasLimitMultiplier": "1.2"
}
```

**Parameters:**

- `network` (required): Blockchain network name (e.g., `ethereum`, `base`, `polygon`)
- `recipientAddress` (required): Destination wallet address
- `amount` (required): Amount in human-readable units (e.g., "0.1" for 0.1 ETH or tokens)
- `tokenAddress` (optional): ERC-20 token contract address. Omit for native token transfers.
- `tokenConfig` (optional): JSON string with token metadata for non-standard tokens: `{"decimals":18,"symbol":"USDC"}`
- `gasLimitMultiplier` (optional): Gas limit multiplier (e.g., "1.5" for 50% buffer)

### Response

```json
{
  "executionId": "direct_123",
  "status": "completed"
}
```

The execution runs synchronously. Status will be `completed` or `failed` when the request returns.

## Call Smart Contract

```http
POST /api/execute/contract-call
```

Call any smart contract function. Automatically detects read vs write operations.

### Request Body

```json
{
  "contractAddress": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  "network": "ethereum",
  "functionName": "balanceOf",
  "functionArgs": "[\"0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb\"]",
  "abi": "[{...}]",
  "value": "0",
  "gasLimitMultiplier": "1.2"
}
```

**Parameters:**

- `contractAddress` (required): Smart contract address
- `network` (required): Blockchain network name
- `functionName` (required): Name of the function to call
- `functionArgs` (optional): JSON array string of function arguments (e.g., `"[\"0x...\", \"1000\"]"`)
- `abi` (optional): Contract ABI as JSON string. Auto-fetched from block explorer if omitted.
- `value` (optional): ETH value to send with the call in wei (for payable functions)
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
  "network": "ethereum",
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
- `422`: Wallet not configured (see [Wallet Management](/wallet-management/para))
- `429`: Rate limit exceeded
- `400`: Invalid request parameters
