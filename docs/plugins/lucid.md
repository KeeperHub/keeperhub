---
title: "Lucid Agents Plugin"
description: "Discover Lucid agents and call their entrypoints, free or x402-priced, with the payment decision left to your workflow."
---

# Lucid Agents Plugin

Discover a [Lucid](https://www.npmjs.com/package/@lucid-agents/core) agent and call its entrypoints from a workflow. Free entrypoints return their output. Priced entrypoints return their x402 payment terms instead, so a later step in your workflow can decide whether to pay.

This plugin never signs or pays. Paying is a separate, explicit step you add to the workflow, which is where your spending policy lives.

No credentials required. The agent URL is set on each action.

## Actions

| Action | Description |
|--------|-------------|
| Discover Agent | Read an agent's card and list its entrypoints and prices |
| Call Entrypoint | Invoke an entrypoint; returns its output, or its x402 terms if it is priced |

## Discover Agent

Reads the agent card at `{agentUrl}/.well-known/agent-card.json`.

**Inputs:** Agent URL

**Outputs:** `success`, `name`, `description`, `entrypoints`, `pricedEntrypoints`, `extensions`, `error`

Each item in `entrypoints` has `name`, `description`, `priced`, `price` (in the asset's base units, so 10000 is 0.01 USDC), `asset`, `network`, `payTo` and `inputSchema`. An entrypoint that is marked as paid but states no terms is still reported as `priced: true`.

## Call Entrypoint

Sends `POST {agentUrl}/entrypoints/{entrypoint}/invoke` with `{ "input": ... }`.

**Inputs:** Agent URL, Entrypoint, Input JSON (optional), Payment Header (optional)

**Outputs:** `success`, `status`, `output`, `payment`, `paymentRequired`, `paid`, `paymentResponse`, `httpStatus`, `error`

What comes back depends on the entrypoint:

- **Free entrypoint:** `status` is `completed` and `output` holds the result.
- **Priced entrypoint, no Payment Header:** `status` is `awaiting_payment`. `payment` holds the first accepted requirement (`scheme`, `network`, `amount`, `asset`, `payTo`, `resource`) and `paymentRequired` holds the full challenge as the agent served it. This is a quote, not an error, so `success` is `true`. The terms are read from the `PAYMENT-REQUIRED` header (base64 or JSON) or from the response body.
- **Priced entrypoint, with a Payment Header:** the signed payload is sent as both `PAYMENT-SIGNATURE` and `X-PAYMENT`, so it reaches x402 servers of either version. On success, `paid` is `true` and `paymentResponse` holds the decoded settlement receipt when the agent returns one. If the agent answers with another 402, the step fails.

Redirects are never followed, because following one would send the request, and any payment, to a host you did not name. Point the action at the agent's final URL. The step is not retried automatically.

## Adding a payment policy

The step between the quote and the paid call is yours. It reads `payment` (or the full `paymentRequired`), decides whether this payment is acceptable, and only then lets a signed x402 payment reach the second call. Two common shapes:

- **Policy in the workflow.** A Condition checks the quote against your rules, for example the payee and a price cap, and only its true branch continues to the paid call. The signed payment comes from wherever your signer lives, such as the trigger input of a workflow your treasury calls.
- **Policy in your own service.** A Webhook sends `paymentRequired` to a service that applies your policy (allowlist, budgets, human approval) and returns a signed payment, which the paid call reads from the Webhook's response.

**Example workflow:**
```
Manual trigger (input: paymentHeader from your signer)
  -> Lucid Agents: Discover Agent
  -> Lucid Agents: Call Entrypoint (no payment header)
  -> Condition: {{CallEntrypoint.status}} === "awaiting_payment"
       && {{CallEntrypoint.payment.payTo}} === "<approved payee>"
       && {{CallEntrypoint.payment.amount}} <= 10000
  -> (true) Lucid Agents: Call Entrypoint (Payment Header: {{ManualTrigger.paymentHeader}})
```

If the policy says no, the workflow stops before the second call and nothing is paid.
