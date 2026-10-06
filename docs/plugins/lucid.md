---
title: "Lucid Agents Plugin"
description: "Discover Lucid agents, call their free entrypoints, and read the x402 terms of priced ones."
---

# Lucid Agents Plugin

Discover a [Lucid](https://www.npmjs.com/package/@lucid-agents/core) agent and call its entrypoints from a workflow. Free entrypoints return their output. Priced entrypoints return their x402 payment terms instead of running, so a workflow can see what a call would cost.

This plugin never signs or pays, and it cannot make a paid call.

No credentials required. The agent URL is set on each action. It must be a public http(s) address with no credentials in it: private, loopback and link-local addresses are refused, a URL carrying a username or password is refused, and redirects are not followed. A query string or fragment on the agent URL is dropped, because every request appends its own path.

## Actions

| Action | Description |
|--------|-------------|
| Discover Agent | Read an agent's card and list its entrypoints and prices |
| Call Entrypoint | Invoke an entrypoint; returns its output, or its x402 terms if it is priced |

## Discover Agent

Reads the agent card at `{agentUrl}/.well-known/agent-card.json`. The step fails if the response is not a Lucid agent card.

**Inputs:** Agent URL

**Outputs:** `success`, `name`, `description`, `version`, `entrypoints`, `pricedEntrypoints`, `error`

Each item in `entrypoints` has `name`, `description`, `priced` and `inputSchema`. A priced entrypoint also has:

- `price`: the price exactly as the card states it.
- `priceUnit`: `usd` when the price is a USD decimal string, so `"0.01"` is one cent. `base_units` when the entrypoint is priced as a token amount, which is an integer count of that token's base units. `unknown` when no payment offer on the card declares the unit, when two offers state the same price in different units, or when the price is not written in the form its unit requires. Treat `unknown` as a refusal: the same digits are a cent or ten thousand tokens depending on a unit the card did not state, so a spend cap compared against the price is meaningless.
- `asset`: the token contract, only when `priceUnit` is `base_units`. A USD price names no token on the card. The card states no decimals, so a `base_units` price cannot be converted to a currency figure from the card alone; call the entrypoint and read `payment.assetDecimals` for that.
- `network` and `payTo`, when the card states them.

An entrypoint that is marked as paid but states no price is still reported as `priced: true`.

## Call Entrypoint

Sends `POST {agentUrl}/entrypoints/{entrypoint}/invoke` with `{ "input": ... }`.

**Inputs:** Agent URL, Entrypoint, Input JSON (optional)

**Outputs:** `success`, `status`, `agentStatus`, `output`, `runId`, `payment`, `challenge`, `httpStatus`, `error`

What comes back depends on the entrypoint:

- **Free entrypoint:** `status` is `completed`, `output` holds the result and `runId` the agent's run id. `agentStatus` is the run status the agent itself reported, when it reported one. The step fails if the agent answers without an entrypoint result.
- **Priced entrypoint:** the entrypoint does not run. `status` is `awaiting_payment`. `payment` holds the first accepted requirement (`scheme`, `network`, `offerCount`, `amount`, `amountRejected`, `asset`, `assetDecimals`, `assetMismatch`, `payTo`, `resource`, `description`, `maxTimeoutSeconds`). `challenge` holds the full x402 challenge as the agent served it. This is a quote, not an error, so `success` is `true`. The terms are read from the `PAYMENT-REQUIRED` header (base64 or JSON) or from the response body.

### The run status

`status` is the step's own outcome and `agentStatus` is the agent's. The only run status that completes the step is `succeeded`, matched without regard to case or surrounding spaces. An agent that answers 2xx while naming its own run anything else, such as `failed` or `cancelled`, has not produced a result, so the step fails: `success` is `false`, `error` carries the status and whatever the agent said about it, and `agentStatus` carries the status as served. A status that is not a string is reported as served and fails the step the same way.

An envelope that carries an `error` also fails the step, whatever status it states and whatever shape the error takes. A string, an object, an array, a number and a boolean all count; only an absent, `null` or empty `error` does not. The agent's account of the failure is carried in `error`, serialised as served when it is not a string. Only an envelope that states no error, and either no status or `succeeded`, is taken as a completed run.

A workflow therefore does not have to branch on `agentStatus` to stay safe. A Condition on `status` is enough, because a run the agent reported as failed never reaches `completed`.

### Reading the payment terms

`amount` is the integer count of the settlement asset's base units. It is the server's own string, so it is published only when the challenge states one single amount and that amount is in fact an integer. Anything else is left out of `amount` and put in `amountRejected` as served: a decimal, and also a challenge that states two different amounts, whether across two entries in `accepts` or across `maxAmountRequired` and `amount` on the same entry. An absent `amount` on a priced call must be treated as a refusal, because there is no figure to compare against a cap.

`offerCount` is how many payment requirements the challenge states. `payment` describes the first of them, so a count above one means the agent also offers terms that `payment` does not describe. Treat a count above one as a refusal unless the workflow reads `challenge` and picks a requirement itself, because `payment` is one quote out of several the agent is willing to charge. A count of zero means `accepts` held no readable requirement, so the terms were read from the envelope itself.

`assetDecimals` is the settlement asset's decimals, filled in only when `network` names a payment rail KeeperHub settles on and `asset` is that rail's settlement asset. Without it the amount cannot be turned into a currency figure, so an absent `assetDecimals` must be treated as a refusal rather than divided by an assumed power of ten.

`assetMismatch` is `true` when `network` names a known rail and `asset` is not confirmed as that rail's settlement asset, which includes a challenge that names no asset at all. Treat it as a refusal: the quote is not denominated in the token the rail settles in, or does not say what it is denominated in.

Redirects are never followed. Point the action at the agent's final URL. The step is not retried automatically, because a retry would run the entrypoint again.

**Example workflow:**
```
Manual trigger
  -> Lucid Agents: Discover Agent
  -> Lucid Agents: Call Entrypoint (Entrypoint: {{DiscoverAgent.entrypoints[0].name}})
  -> Condition: {{CallEntrypoint.status}} === "completed"
  -> (true) use {{CallEntrypoint.output}}
```
