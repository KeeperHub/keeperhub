---
title: "Lucid Agents Plugin"
description: "Discover Lucid agents, call their free entrypoints, and read the x402 terms of priced ones."
---

# Lucid Agents Plugin

Discover a [Lucid](https://www.npmjs.com/package/@lucid-agents/core) agent and call its entrypoints from a workflow. Free entrypoints return their output. Priced entrypoints return their x402 payment terms instead of running, so a workflow can see what a call would cost.

This plugin never signs or pays, and it cannot make a paid call.

No credentials required. The agent URL is set on each action. It must be a public http(s) address: private, loopback and link-local addresses are refused, and redirects are not followed.

## Actions

| Action | Description |
|--------|-------------|
| Discover Agent | Read an agent's card and list its entrypoints and prices |
| Call Entrypoint | Invoke an entrypoint; returns its output, or its x402 terms if it is priced |

## Discover Agent

Reads the agent card at `{agentUrl}/.well-known/agent-card.json`. The step fails if the response is not a Lucid agent card.

**Inputs:** Agent URL

**Outputs:** `success`, `name`, `description`, `entrypoints`, `pricedEntrypoints`, `error`

Each item in `entrypoints` has `name`, `description`, `priced` and `inputSchema`. A priced entrypoint also has:

- `price`: the price exactly as the card states it.
- `priceUnit`: `usd` when the price is a USD decimal string, so `"0.01"` is one cent. `base_units` when the entrypoint is priced as a token amount, so `"10000"` of a 6-decimal token is 0.01 of that token. Absent when the card does not say.
- `asset`: the token contract, only when `priceUnit` is `base_units`. A USD price names no token on the card. Call Entrypoint's `payment.asset` always carries the token the agent will charge in.
- `network` and `payTo`, when the card states them.

An entrypoint that is marked as paid but states no price is still reported as `priced: true`.

## Call Entrypoint

Sends `POST {agentUrl}/entrypoints/{entrypoint}/invoke` with `{ "input": ... }`.

**Inputs:** Agent URL, Entrypoint, Input JSON (optional)

**Outputs:** `success`, `status`, `output`, `runId`, `payment`, `challenge`, `httpStatus`, `error`

What comes back depends on the entrypoint:

- **Free entrypoint:** `status` is `completed`, `output` holds the result and `runId` the agent's run id. The step fails if the agent answers without an entrypoint result.
- **Priced entrypoint:** the entrypoint does not run. `status` is `awaiting_payment`. `payment` holds the first accepted requirement (`scheme`, `network`, `amount`, `asset`, `payTo`, `resource`), where `amount` is always in the asset's base units. `challenge` holds the full x402 challenge as the agent served it. This is a quote, not an error, so `success` is `true`. The terms are read from the `PAYMENT-REQUIRED` header (base64 or JSON) or from the response body.

Redirects are never followed. Point the action at the agent's final URL. The step is not retried automatically, because a retry would run the entrypoint again.

**Example workflow:**
```
Manual trigger
  -> Lucid Agents: Discover Agent
  -> Lucid Agents: Call Entrypoint (Entrypoint: {{DiscoverAgent.entrypoints[0].name}})
  -> Condition: {{CallEntrypoint.status}} === "completed"
  -> (true) use {{CallEntrypoint.output}}
```
