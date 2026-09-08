---
title: "Marketplace"
description: "List workflows on the KeeperHub Marketplace so AI agents and users can discover, call, and pay for them."
---

# Marketplace

The KeeperHub Marketplace lets you publish workflows that AI agents and users can discover and call on demand. You set the slug, the price, and the input/output interface. KeeperHub handles routing, payment settlement, and execution. You collect 70% of every call.

## How it works

When you list a workflow, KeeperHub registers it as a resource under its own entry on the x402, MPP, and ERC-8004 registries. Agents browsing those registries find KeeperHub as a service provider, then see your listed workflow as a callable resource alongside everyone else's.

To callers, a listed workflow is a black box: they supply the inputs you define, pay the price you set, and get back the outputs you expose. Your node graph stays private.

Payments settle in USDC on Base (via x402) or USDC.e on Tempo (via MPP). Agents never need ETH for gas, since KeeperHub facilitators submit and pay for the on-chain transaction.

## Before you list

Run through three checks before you hit publish:

1. **It actually works.** Test it manually with the Run button. The execution should complete and the output should include the fields you plan to expose. If it errors out for you, it'll error out for callers.
2. **Inputs come from the trigger, not from hardcoded values.** Anything caller-supplied (a wallet address, a token, an amount) has to flow in through the Manual trigger and be pulled into downstream nodes via a field reference. Hardcoded values are baked in at build time and ignore whatever the caller sends.
3. **The workflow is active.** Inactive workflows reject calls. Toggle it on before listing.

To wire up a caller-supplied input: add a Manual trigger node, then in the downstream node click the field you want to make dynamic, choose "Add" from the type selector, and pick the matching trigger output. The field now reads from the caller's input on every call.

## Listing a workflow

Open the workflow in the KeeperHub editor. Click the **Marketplace** button in the top toolbar.

### Slug

The slug is the permanent identifier for this workflow on the registry. Once you publish, it cannot be changed.

Choose something clear and specific. Use lowercase letters, numbers, and hyphens only.

Good examples:

- `aave-v3-health-check`
- `eth-balance`
- `stablecoin-yield-rates`

Avoid generic slugs like `my-workflow` or `test`. The slug appears in URLs, registry listings, and agent discovery results.

### Price

The amount (in USDC) charged per call. You can change this after publishing.

Most utility workflows on the Marketplace price between `$0.001` and `$0.10` per call. Agents pay per request, so a price that sounds negligible in isolation adds up at scale. When picking a number, weigh:

- The workflow's runtime cost (gas, RPC, external API calls).
- How long the execution takes.
- Whether the output is a one-shot answer or part of a chained agent session.

You can update the price at any time on existing listed workflows. Prior calls settle at the price active when the call was made.

### Input schema

The input schema defines what the caller must supply. Each field you add becomes a required parameter in the API call.

For each field, provide:

- **Field name**: the key name the caller uses (e.g., `address`, `asset`, `chain`).
- **Type**: `string`, `number`, or `boolean`.
- **Description**: one sentence explaining what the field expects.

Every field in the input schema must be referenced somewhere in a workflow node, otherwise the value is received but never used. The most common pattern is: Manual trigger collects all input fields, downstream nodes reference those fields via the field picker.

Example input schema for a wallet health check workflow:

```json
{
  "address": {
    "type": "string",
    "description": "EVM wallet address to check"
  },
  "chain": {
    "type": "string",
    "description": "Chain name: ethereum or base"
  }
}
```

### Output schema

The output schema defines what the workflow returns to the caller after execution. You select which node outputs to expose.

In most cases, you expose all fields from the final data node in your workflow. Click "All fields from [node name]" to expose everything that node produces, or select individual fields if you want to filter the response.

Keep outputs clean. Return the data the caller asked for. Avoid exposing internal fields, intermediate values, or debug information that isn't useful to a consumer.

## After listing

Once listed, your workflow turns green in the editor. You can find all of your listed workflows on the [**Earnings**](/workflows/marketplace#earnings) page in the left nav, alongside their per-call revenue and invocation counts.

Your workflow is now registered on x402scan.com, mppscan.com, and 8004scan.io under KeeperHub's registration. Agents browsing those registries see it as a callable resource at `https://app.keeperhub.com/api/mcp/workflows/<slug>/call`, and as a single-tool MCP server at `https://app.keeperhub.com/mcp/w/<slug>` that an agent can install directly into Claude Code, Cursor, or Windsurf — see [Per-Workflow MCP Servers](/agent/mcp-server#per-workflow-mcp-servers) for the install snippet. KeeperHub's own registry pages are public:

- [KeeperHub on x402scan](https://www.x402scan.com/server/59aa13ab-2a99-4409-a4e1-8927f4006b29)
- [KeeperHub on mppscan](https://mppscan.com/server/3a9395b49a059838086613a280a30d94b812991214d6fcb215a1d3c2196d5785)
- [KeeperHub on 8004scan](https://8004scan.io/agents/ethereum/31875)

The slug, your listed price, and your input/output schema are what agents see. The internal node logic stays private.

## Earnings

Every call to your listed workflow generates revenue. KeeperHub takes a 30% platform fee. You receive 70%.

You can see your earnings breakdown on the **Earnings** page in KeeperHub:

- Total invocations.
- Gross revenue (total USDC paid by callers).
- Platform fee (30%).
- Your earnings (70%).

Earnings are broken down by payment network (Base via x402, Tempo via MPP).

### Execution quota

When a Marketplace caller pays for one of your listed workflows at **$0.05 USDC per call or higher**, that execution does not count toward your organization's monthly execution limit. Marketplace revenue covers the cost on KeeperHub's side, so charging your plan's quota on top would be double-counting.

The exemption is gated on actual payment receipt, not on listing state alone. So:

- **Only paid Marketplace calls qualify.** When you click Run in the editor, or the workflow fires from a schedule, block trigger, event, webhook, or direct API call, no payment is recorded and the run counts toward your quota normally, even if the workflow is listed at the threshold price. The exemption is for revenue you actually received, not for the act of listing.
- **The price floor is a hard cutoff.** A listing priced at $0.049 gives no quota relief; one at $0.05 is fully exempt. The floor prevents an owner from publishing at $0 (or near it) and self-calling through the marketplace to accumulate free executions.
- **The exemption is locked in per call.** Once a paid call is recorded as exempt, raising or lowering the listing price afterward does not change the verdict for past calls. Future calls are evaluated against the price in effect at their moment of payment.
- **Direct API and private workflows are unaffected.** Direct executions and runs of any workflow you haven't listed always count toward your quota.

### Receiving revenue on two chains

After a caller pays, the USDC (on Base) or USDC.e (on Tempo) lands directly in your organization's creator wallet. The split between them is just a function of which agents called your workflow. There's nothing to configure, and a zero balance on one chain isn't a problem.

You can see both totals in the wallet overlay. They're both stablecoins pegged to USD and both fully redeemable. If you'd rather consolidate to one chain, bridge between Base and Tempo manually; KeeperHub doesn't auto-bridge and your funds stay where they landed.

#### Why two chains?

Different agents run on different wallets. Coinbase's Agent Kit ecosystem holds USDC on Base. MPP-native wallets hold USDC.e on Tempo. Picking one chain would lock out the other ecosystem, so KeeperHub accepts both. Tempo is also cheaper and faster to settle, which matters once an agent is making thousands of paid calls.

## How agents call your workflow

Agents discover and call your workflow via two meta-tools exposed through KeeperHub's OpenAPI:

- `search_workflows`: find workflows by name, tag, or description. Returns slug, input schema, and price.
- `call_workflow`: execute a workflow by slug, supplying the required inputs.

Each call is paid via one of two protocols. Both are always offered on every paid workflow call:

| Protocol | Chain | Token | Used by |
|---|---|---|---|
| x402 | Base (chain ID 8453) | USDC (`0x8335...02913`) | Agentcash wallets with a Base balance, Coinbase CDP-backed agents |
| MPP | Tempo (chain ID 4217) | USDC.e (`0x20c0...8b50`) | Agentcash wallets with a Tempo balance, MPP-native clients |

The calling agent picks which protocol to use based on what its wallet holds. As a creator you don't pick one: both are live on every listed workflow.

### Wallet options for callers

Agents need an agentic wallet to pay for calls. Three options are available:

#### KeeperHub Agentic Wallet (recommended)

Install with two commands:

```bash
npx -p @keeperhub/wallet keeperhub-wallet skill install
npx -p @keeperhub/wallet keeperhub-wallet add
```

Custody is server-side via Turnkey's secure enclave. No private key lands on disk. Supports both x402 (Base USDC) and MPP (Tempo USDC.e). Includes a three-tier safety hook (auto-approve, ask, block) with a configurable spending threshold.

After install, restart the agent session once so it picks up the new skill.

#### agentcash (for development and testing)

```bash
npx agentcash add https://app.keeperhub.com
```

Walks KeeperHub's OpenAPI, generates a skill file, and installs it across detected agent runtimes. Supports x402. Private key is stored unencrypted on disk, so treat it as a low-balance testing wallet only.

#### Coinbase Agentic Wallet Skills

```bash
npx skills add coinbase/agentic-wallet-skills
```

Requires a Coinbase Developer Platform account. Supports x402. Includes general-purpose onchain utility skills in addition to payment support.

### How payment settles under the hood

On Base, the agent signs an EIP-3009 `TransferWithAuthorization`. A facilitator submits the transaction and pays the gas; the agent only debits the USDC amount. No ETH required.

On Tempo, the agent signs an MPP payment proof and the MPP facilitator pays network fees. The agent only debits USDC.e. When both networks are on offer, agents using the KeeperHub wallet auto-select MPP because it settles faster and cheaper.

## Changing your listing

After publishing, you can update:

- Listed price.
- Output schema.

You cannot change:

- Slug (permanent once set).
- Input schema fields already in use by callers (adding new optional fields is fine; removing or renaming existing ones breaks callers).

To make a significant change to the workflow logic, update the nodes and test before the change goes live. Callers hitting your slug during a failed execution see an error and are not charged.

## Things to know

Your node graph stays private. Callers only ever see the input schema, the output schema, and the price.

Your slug, on the other hand, is public. x402scan.com and mppscan.com index it under KeeperHub's registration, so pick something you're happy seeing on a registry page.

Reliability is on you. Callers are only charged on successful execution, but repeat failures cost you trust (and revenue, since agents stop calling you). Watch the Earnings page after any workflow change.

Calls run inside your KeeperHub organization. Connected wallets and integrations the workflow uses are billed to your org, not the caller's. Executions of listings priced at $0.05 USDC or higher are exempt from your monthly execution quota; see [Execution quota](#execution-quota) above.

## Reference implementation

The `mcp-test` workflow at `https://app.keeperhub.com/api/mcp/workflows/mcp-test/call` is the public reference. It's priced at `$0.01` per call, accepts both x402 and MPP payments, and its `/openapi.json` entry is what the registry scanners ingest.
