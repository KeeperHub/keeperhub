# Workflow Schema Reference

Details of the workflow JSON schema that the rest of the docs do not
spell out: which `config` fields are JSON-encoded strings rather than
raw arrays, how `functionArgs` maps onto ABI inputs, and the exact
shapes the strict validator accepts.

---

## The critical fields

### `abi` — must be a JSON string, not an array

**Wrong (causes 422 error):**
```json
{
  "abi": [{ "name": "transfer", "type": "function", ... }]
}
```

**Correct:**
```json
{
  "abi": "[{\"name\":\"transfer\",\"type\":\"function\",...}]"
}
```

Always `JSON.stringify()` your ABI before putting it in the config.

---

### `functionArgs` — a JSON-stringified positional array

`functionArgs` is a JSON-stringified positional array whose elements
map to the ABI inputs by index.

**Wrong:**
```json
{
  "functionArgs": "[{\"to\":\"0xRecipient\",\"amount\":\"1000000\"}]"
}
```

**Correct:**
```json
{
  "functionArgs": "[\"0xRecipient\",\"1000000\"]"
}
```

Note: named-field objects only apply to a single `tuple`/struct
parameter, not as a wrapper for all args.

---

### `tokenConfig` for `web3/approve-token`

`tokenConfig` accepts either a bare `0x`-prefixed token address
(treated as the token address directly) or a JSON string with
the full custom token shape. Both work:

```json
{ "tokenConfig": "0xTokenAddress" }
```

```json
{
  "tokenConfig": "{\"mode\":\"custom\",\"customToken\":{\"address\":\"0xTokenAddress\"}}"
}
```

Note: `symbol` is fetched on-chain; you don't need to provide it.

---

### Deadlines — keep template substitution result valid JSON

Template expressions inside `functionArgs` are supported and
resolve before `JSON.parse`. The rule is: ensure the substituted
result is valid JSON. Computing values like deadlines beforehand
is the safest approach:

```typescript
const deadline = Math.floor(Date.now() / 1000) + 600;
functionArgs: JSON.stringify([deadline])
```

Avoid arithmetic expressions after substitution
(e.g. `{{timestamp}} + 3600`) as they produce invalid JSON.

---

### `network` — recommended as a string chain ID

A string chain ID is the recommended form:

```json
{ "network": "11155111" }
{ "network": "1" }
```

The API also accepts raw numbers and legacy names like
`"sepolia"` or `"base"` at runtime, but string chain IDs
are the safest and most explicit.

---

### `gasLimitMultiplier` — pass as a string

```json
{ "gasLimitMultiplier": "1.5" }
```

Helps avoid out-of-gas errors on complex transactions.

---

## Endpoint reference

### Create workflow
```
POST /api/workflows/create
```

### Execute workflow
```
POST /api/workflow/{workflowId}/execute
```
or
```
POST /api/workflows/{workflowId}/execute
```
Both routes work identically.

### Get execution status
```
GET /api/workflows/executions/{executionId}/status
```

Returns a `transactionHashes` array in the success payload —
you can read tx hashes directly from the status response
without fetching logs separately. Each entry is a receipt object
(`hash`, `nodeId`, `verified`, ...), not a bare hash string — see
[Transaction Hashes](/api/executions#transaction-hashes).

### Get execution logs
```
GET /api/workflows/executions/{executionId}/logs
```

---

## Node structure

Every node follows this shape (`status` and `description` are optional):

```typescript
{
  id: "unique-id",
  type: "trigger" | "action",
  data: {
    label: "Human readable name",
    type: "trigger" | "action",
    config: { ... },
    // status and description are optional
  }
}
```

---

## Trigger node

```typescript
{
  id: "trigger",
  type: "trigger",
  data: {
    label: "Manual Trigger",
    type: "trigger",
    config: { triggerType: "Manual" },
  }
}
```

Use the capitalized canonical value: `"Manual"`, `"Schedule"`,
`"Webhook"`, `"Event"`, `"Block"`, `"Transfer"`.

---

## Edge structure

```typescript
{
  id: "e1",
  source: "trigger",
  target: "step-1"
}
```

---

## Finding your wallet integration ID

```typescript
const res = await axios.get("https://app.keeperhub.com/api/integrations", {
  headers: { Authorization: `Bearer ${API_KEY}` }
});
const walletId = res.data[0].id; // bare array, no wrapper
```

---

## Transaction hash location

The workflow execution status endpoint returns `transactionHashes`
directly in the success payload. You can read tx hashes from
the status response without fetching logs. Each entry is a receipt
object, so pull `.hash` out of it rather than using the entry itself
as the hash:

```typescript
const status = await getExecutionStatus(executionId);
const txHashes = status.transactionHashes.map((entry) => entry.hash);
```

---

## What we found genuinely undocumented

1. `abi` must be `JSON.stringify()`'d — causes a silent 422 if not
2. `gasLimitMultiplier` must be a string, not a number
3. The edge shape (`id`, `source`, `target`) is not in the quickstart
4. The create/status/logs endpoint paths are not in one place in the docs

