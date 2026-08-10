---
title: "API"
description: "Trigger a KeeperHub workflow from a backend service and read the result, including the transaction hash, entirely over REST."
---

# Getting Started with the API

Trigger a workflow from your own service and read the result back. This page covers execution; to
author a workflow first, use the [browser](/getting-started/browser) or an
[agent](/getting-started/agent).

## Which endpoint you want

| | Direct execution | Workflow execution |
|---|---|---|
| **Use for** | A single transfer or contract call, no branching | Multi-step logic, conditions, anything reusable |
| **Needs a workflow first** | No | Yes |
| **Endpoint** | `POST /api/execute/transfer`, `POST /api/execute/contract-call` | `POST /api/workflows/{workflowId}/execute` |

The rest of this page covers workflow execution. For direct execution, including spending caps and
simulation, see [Direct Execution](/api/direct-execution).

## 1. Get an API key

In the app, click your avatar, then **API Keys**, then the **Organisation** tab. Create a key and
copy it immediately, it is shown once.

Organization keys start with `kh_` and authenticate REST and MCP. User keys (`wfb_`) authenticate
webhook triggers and are not interchangeable. See [API Keys](/api/api-keys).

Verify the key works before building on it:

```bash
curl -sf -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  https://app.keeperhub.com/api/keys
```

`200` means the credential is valid and scoped to an organization; `401` means it is not. Point
health checks at this endpoint. `GET /api/chains` is public and answers either way, so it tells
you the service is reachable, not that your key works.

No browser? Signup is captcha-gated and key creation needs a signed confirmation, so scripts start
from wallet sign-in instead. See [Headless Onboarding](/api/headless-onboarding).

## 2. Fund the wallet, if the workflow spends

Your organization's Turnkey wallet is provisioned on signup and gets a monthly allowance of
sponsored gas on mainnet.

Sponsorship pays the **network fee**, not the value moved. A workflow that sends 0.1 ETH still
needs 0.1 ETH in the wallet, and an ERC-20 transfer still needs the token balance. Sponsorship
also requires the sender to be the wallet rather than a Safe, the transaction to use the public
mempool, and gas credits remaining for the period. See [Gas Management](/wallet-management/gas).

## 3. Start the run

```bash
curl -X POST https://app.keeperhub.com/api/workflows/{workflowId}/execute \
  -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```js
const res = await fetch(
  `https://app.keeperhub.com/api/workflows/${workflowId}/execute`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KEEPERHUB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  }
);
const { executionId } = await res.json();
```

This returns `{ executionId, status: "running" }`. There is no transaction hash yet.

## 4. Wait for it to finish

`GET /api/workflows/executions/{executionId}/wait` blocks server-side until the run reaches a
terminal state, so you do not need a tight poll loop.

It does not block forever. `timeoutMs` is capped at **60000** and defaults to **25000** if
omitted. On timeout the request returns `200` with `completed: false`, and you call it again to
keep waiting. A run longer than a minute always needs more than one call.

```js
async function waitForExecution(executionId, { deadlineMs = 10 * 60 * 1000 } = {}) {
  const giveUpAt = Date.now() + deadlineMs;

  while (Date.now() < giveUpAt) {
    const res = await fetch(
      `https://app.keeperhub.com/api/workflows/executions/${executionId}/wait?timeoutMs=55000`,
      { headers: { Authorization: `Bearer ${process.env.KEEPERHUB_API_KEY}` } }
    );
    if (!res.ok) {
      throw new Error(`wait failed: ${res.status}`);
    }

    const data = await res.json();
    if (!data.completed) {
      continue; // server-side wait window elapsed, ask again
    }
    if (data.status !== "success") {
      throw new Error(data.error ?? `execution ${data.status}`);
    }
    return data;
  }

  throw new Error(`execution ${executionId} did not finish within the deadline`);
}
```

Check `status !== "success"` rather than `status === "error"`. A run can also end `system_error`
or `cancelled`, and both report `completed: true`, so a check for `error` alone lets a failed run
through as a success.

The response is:

```json
{
  "executionId": "...",
  "status": "success",
  "completed": true,
  "transactionHashes": [],
  "output": null,
  "error": null,
  "gasUsedWei": null,
  "completedAt": "..."
}
```

If you would rather drive your own loop, for example to show incremental progress,
`GET /api/workflows/executions/{executionId}/status` returns immediately. It is a **different
shape**: it adds per-node status and progress, and it has no `completed` field, so branch on
`status` directly rather than reusing the code above.

## 5. Read the result

`transactionHashes` holds an entry per onchain write the workflow performed. It is an empty array
for read-only workflows, so guard before indexing:

```js
const result = await waitForExecution(executionId);
const [firstTx] = result.transactionHashes;
if (firstTx) {
  console.log(firstTx.hash);
}
```

Each entry carries `hash`, `nodeId`, `nodeName`, and, when known, `chainId` and `network`.

## Common problems

- **`404` on execute.** The workflow id is wrong, or it belongs to a different organization than
  the key.
- **The run never leaves `pending`.** Check the wallet balance on the target network. See the
  sponsorship limits above.
- **A key that looks set but is not.** Validate config explicitly. An all-zero private key or a
  literal `your_key_here` passes a naive truthiness check and fails later as a confusing signing
  error rather than a clear "not configured".
- **`429`.** Direct execution is limited to 60 requests per minute per API key. Honour
  `Retry-After`, back off exponentially, and send a stable `Idempotency-Key` header on writes.

## Next

- [API Overview](/api) for every endpoint
- [Executions](/api/executions) for history and filtering
- [Errors](/api/errors) for error shapes and status codes
- [Headless Onboarding](/api/headless-onboarding) to go from nothing to a key without a browser
