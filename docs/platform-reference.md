---
title: "Platform Reference"
description: "The facts you need to integrate KeeperHub in one place - MCP endpoint, supported chains, USDC addresses, faucets, API key types, and rate limits."
---

# Platform Reference

A single copy-paste reference for the facts an integration needs:
where the MCP endpoint is, which chains are supported, which USDC address and
faucet to use, what the two API key types are for, the rate limits, the
machine-readable documents to start from, and how versioning and deprecation
are signalled. Each section links to its full reference page.

## 1. Connect the MCP endpoint

The hosted MCP server is the fastest way to drive KeeperHub from an AI agent.

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Run `/mcp` in Claude Code to complete OAuth in the browser. For headless or CI
environments, pass an organization API key instead:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

Every listed marketplace workflow is also reachable as its own typed MCP server
at `https://app.keeperhub.com/mcp/w/<slug>`. See the [MCP Server](/agent/mcp-server)
reference for the full tool list and per-workflow details.

The endpoint URL is also shown, with a copy button, in the dashboard: click your
avatar, then **API Keys**.

### OAuth vs API keys

Browser OAuth (for example `/mcp` in Claude Code) mints a **Bearer OAuth access
token**, not a `kh_` organization API key. The MCP server accepts either an
OAuth access token or `Authorization: Bearer kh_...` on each request. The OAuth
token endpoint expects an OAuth `client_id` / `client_secret`, not a `kh_` org
key — a `kh_` value fails client authentication as an invalid secret.

| Auth method | Credential | Best for |
|-------------|------------|----------|
| OAuth (browser) | Short-lived Bearer access token | Interactive agents, Claude Code `/mcp` |
| Organization API key (`kh_`) | Long-lived org key from Settings > Developer > API keys > Organisation keys | Headless CI, scripts, Docker |

For programmatic REST and MCP access without a browser redirect, create an
organization key from your avatar, then **API Keys**, then the **Organisation**
tab. See [MCP Server auth](/agent/mcp-server)
and [API Keys](/api/api-keys).

### Local and Docker MCP

Self-hosted KeeperHub exposes MCP at `http://localhost:3000/mcp`. OAuth
redirect flows require a reachable callback URL; when that is impractical (for
example inside Docker without a browser), prefer a `kh_` key:

```bash
claude mcp add --transport http --scope user keeperhub http://localhost:3000/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

For local development with a browser, `pnpm dev:login` opens a signed-in
Chromium session. Set `DEV_LOGIN_URL` if the app is not on `http://localhost:3000`.

### Simulation is EVM-only

`simulate: true` on MCP direct-execution tools (`execute_transfer`, etc.) works
on **EVM chain IDs only**. On Solana mainnet (`101`) and devnet (`103`), the
tool call **resolves** with `isError: true` — it does not throw to the MCP
client. Check that flag, then parse the JSON in `content[0].text` and stop when
`error` is `simulation_unsupported_chain`:

```js
const result = await client.callTool({
  name: "execute_transfer",
  arguments: args,
});
if (result.isError) {
  const payload = JSON.parse(result.content[0].text);
  if (payload.error === "simulation_unsupported_chain") {
    // hard stop — do not broadcast
  }
}
```

```json
{
  "error": "simulation_unsupported_chain",
  "message": "Direct-execution simulation is not supported on this chain.",
  "chain_id": 101,
  "hint": "Direct-execution simulation is EVM-only. Preflight with a Solana-aware client before broadcasting."
}
```

See [section 6](#6-send-your-first-transaction-safely) for the full preflight
flow.

## 2. Pick a key type

KeeperHub has two key systems. They are not interchangeable.

| Prefix | Scope | Managed at | Use for |
|--------|-------|------------|---------|
| `kh_` | Organization | `/api/keys` | REST API, MCP server, Claude Code plugin |
| `wfb_` | User | `/api/api-keys` | Webhook trigger authentication |

For programmatic API and MCP access, use an organization (`kh_`) key when you
need a long-lived credential. OAuth access tokens are a first-class REST
principal (`Authorization: Bearer …`) with their own scope model, but they are
browser-minted and short-lived — see [OAuth vs API keys](#oauth-vs-api-keys).
Full details: [API Keys](/api/api-keys).

Confirm the key works before building on it:

```bash
curl -sf -H "Authorization: Bearer kh_your_api_key" \
  https://app.keeperhub.com/api/keys
```

`GET /api/keys` is the auth probe: a `200` means the credential is valid and
scoped to an organization, a `401` means it is not. Point health checks and
first-run scripts at this endpoint. `GET /api/chains` is public and answers
either way, so it reports reachability rather than a working credential.

No browser available? Sign-up is captcha-gated and key creation needs a signed
confirmation, so a script or agent starts from wallet sign-in instead:
[Headless Onboarding](/api/headless-onboarding) is the same path
without a UI.

## 3. Supported chains

Status reflects support maturity: **stable** chains are production-ready;
**experimental** chains are accepted but may behave unreliably (for example,
broadcasts can hang) and should not be used for production writes without
opting in explicitly.

Start on a testnet. Fund the wallet with native gas first, then test USDC. The
wallet to fund is the organization wallet reported by `GET /api/user`, not the
address a wallet user signed in with - see
[Headless Onboarding](/api/headless-onboarding#3-the-wallet-to-fund-is-not-the-wallet-you-signed-in-with).

### Testnets (recommended to start on)

| Network | chainId | USDC | Faucets | Status |
|---|---|---|---|---|
| Ethereum Sepolia | `11155111` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | [ETH](https://cloud.google.com/application/web3/faucet/ethereum/sepolia), [USDC](https://faucet.circle.com) | stable |
| Base Sepolia | `84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | [ETH](https://portal.cdp.coinbase.com/products/faucet), [USDC](https://faucet.circle.com) | stable |

### Mainnets

| Network | chainId | USDC | Status |
|---|---|---|---|
| Ethereum | `1` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | stable |
| Base | `8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | stable |
| Arbitrum One | `42161` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | stable |
| Optimism | `10` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | stable |
| Polygon | `137` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | stable |

### Experimental

| Network | chainId | Status |
|---|---|---|
| 0G | `16661` | experimental |
| 0G Galileo (testnet) | `16602` | experimental |

The live source of truth for chains is `GET /api/chains`; agents can read the
same list (including per-chain `status`) from the `list_action_schemas` MCP
tool. Faucet links are third-party and may change. See the full
[Chains](/api/chains) reference for chain-name aliases and ABI fetching.

## 4. Rate limits

| Context | Limit |
|---|---|
| MCP (per organization) | 120 / minute |
| Public MCP tools/call (per IP) | 10 / minute |
| Direct execution (per API key) | 60 / minute |

Rate-limited requests return `429` with a `Retry-After` header (delta seconds).
When you hit a limit:

1. Read `Retry-After` and wait at least that many seconds before retrying.
2. Use exponential backoff with a cap (for example 1s, 2s, 4s, up to 30s; max 5 attempts).
3. On write operations, pass a stable idempotency key: `Idempotency-Key` header on REST, `idempotency_key` on MCP direct-execution tools.

For direct-execution spending caps, see [Direct Execution](/api/direct-execution).

## 5. Sandbox

The Code action runs untrusted JavaScript in an isolated `node:vm` sandbox with
outbound SSRF protection. See [Code Plugin](/plugins/code) for what is allowed
and blocked.

## 6. Send your first transaction safely

The MCP direct execution tools let an agent preflight and broadcast without
switching to a separate API client. Start with a testnet wallet funded from the
faucets above, then use this sequence:

1. Call `execute_transfer` with `simulate: true`.
2. Continue only when the result has `success: true` and
   `wouldRevert: false`.
3. Repeat the same call with `simulate` omitted and a new
   `idempotency_key`.
4. Pass the returned `executionId` to `get_direct_execution_status` and poll
   until the status is `completed` or `failed`. Wait the number of seconds in
   the `X-Poll-Interval-Hint` response header between polls rather than
   picking your own interval; a value of `0` means the execution is terminal
   and you can stop.
5. Save `transactionLink` from the terminal response as the onchain proof.

Example simulation on Base Sepolia:

```json
{
  "chain_id": "84532",
  "to_address": "0xRecipient",
  "amount": "0.01",
  "simulate": true
}
```

For an ERC-20 transfer, also pass the token's contract address as
`token_address`. The Base Sepolia USDC address is listed in the table above.
Any MCP tool result with `isError: true` is a failed preflight and must stop
the flow; revert details include the REST error JSON when available. As noted
in [section 1](#simulation-is-evm-only), simulation is EVM-only — on Solana
chain IDs `101` and `103` (and their aliases), `execute_transfer` with
`simulate: true` resolves with `isError: true` before any API call; parse
`content[0].text` as JSON and treat `error: "simulation_unsupported_chain"` as
a hard stop. See [MCP Server](/agent/mcp-server#safely-preflight-direct-writes)
for the tool flow and [Direct Execution](/api/direct-execution) for complete
response and error handling details.

## 7. Machine-readable entry points

Start from one of these rather than by scraping a page. Each is served without
authentication, is CORS-readable, and describes the surface it belongs to.

| Document | URL | What it describes |
|---|---|---|
| OpenAPI 3.1 | `https://app.keeperhub.com/openapi.json` | Callable endpoints, request and response schemas, the typed error model, per-workflow pricing, rate-limit headers |
| MCP server card | `https://app.keeperhub.com/.well-known/mcp.json` | Transport, tool catalog, and authentication for both the anonymous and organization-scoped MCP surfaces |
| MCP endpoint | `https://app.keeperhub.com/.well-known/mcp` | Streamable HTTP transport. Accepts an anonymous `initialize`, so a probe can confirm the server is alive without a credential |
| Agent card | `https://app.keeperhub.com/.well-known/agent-card.json` | ERC-8004 identity and onchain registration |
| x402 metadata | `https://app.keeperhub.com/.well-known/x402` | Per-call pricing for paid workflow endpoints |
| llms.txt | `https://docs.keeperhub.com/llms.txt` | Canonical index of all three KeeperHub hosts, for language models |
| Sitemap | `https://docs.keeperhub.com/sitemap.xml` | Every page on this site |

Every page on this site is also available as Markdown. Send
`Accept: text/markdown`, or append `.md` to the path:

```bash
curl -H "Accept: text/markdown" https://docs.keeperhub.com/platform-reference
curl https://docs.keeperhub.com/platform-reference.md
```

Both return the same document. Responses carry `Vary: Accept` so a shared cache
keys on it.

## 8. Versioning and deprecation

The REST surface is version 1. Send the optional `KeeperHub-Version` request
header to pin a call to a version; omitting it selects the current version.

```bash
curl -H "KeeperHub-Version: 1" \
     -H "Authorization: Bearer kh_your_api_key" \
     https://app.keeperhub.com/api/keys
```

Additive changes ship inside a version and need no action from you: new
endpoints, new optional fields, new enum members, new response headers. Treat
unknown fields as forward compatibility rather than as errors.

A breaking change ships as a new version, never in place. When an endpoint or a
version is scheduled for removal its responses carry:

| Header | Meaning |
|---|---|
| `Deprecation: <http-date>` | RFC 9745. The date the deprecation took effect. The endpoint still works. |
| `Sunset: <http-date>` | RFC 8594. The earliest date it may stop answering. |
| `Link: <url>; rel="deprecation"` | Where to read what replaces it. |

**A sunset date is never less than 180 days after the `Deprecation` header first
appears.** Log these headers rather than discarding them — they are the only
warning you get, and they arrive on successful responses, not errors.

The same policy is published as machine-readable metadata under
`x-api-versioning` in the [OpenAPI document](https://app.keeperhub.com/openapi.json),
alongside `x-error-model` and `x-rate-limits`.
