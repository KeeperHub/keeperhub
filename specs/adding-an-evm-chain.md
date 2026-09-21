# Adding an EVM chain

Contributor runbook. Every step below is a place in this repository that has
to know about a chain before the chain works end to end. The list exists
because the procedure was split across a maintainer-only slash command, a seed
script and six unrelated modules, and each chain request that arrived
re-derived it and missed a different piece.

Solana chains follow a different path (`chainType: "solana"`, no explorer API
family, no Multicall) and are out of scope here.

## Where your pull request ends

A chain lands in two repositories, in this order:

1. **This repository first.** Everything in this document. The chain has to
   exist in `lib/rpc/rpc-config.ts` and `scripts/seed/seed-chains.ts` before
   anything else can refer to it.
2. **`KeeperHub/chain-config` second, maintainers only.** That repository
   overrides fields (private RPC URLs, WSS URLs, per-environment `isEnabled`)
   on chains that already exist here. An entry added there for a chain this
   repository does not know is inert: nothing reads it. If you have merged a
   chain-config entry and the chain is still absent from `GET /api/chains`,
   this is why.

Your pull request stops at the end of step 9. Private RPC endpoints, API keys
and the Parameter Store `CHAIN_RPC_CONFIG` value are wired by the infra owner
after merge; say in the description whether the chain needs any.

## Before you start

Open an issue first ([ISSUES.md](../ISSUES.md)): a chain addition changes what
users can select in production. Collect these facts and put them in the issue:

| Fact | Example | Where it is used |
|---|---|---|
| Chain id | `9745` | Everywhere; the primary key |
| Display name | `Plasma` | `DEFAULT_CHAINS.name`, and the key into `CHAIN_TO_DEFAULT_ID` |
| Native symbol | `XPL` | `DEFAULT_CHAINS.symbol` |
| `jsonKey` (kebab-case) | `plasma-mainnet` | `CHAIN_CONFIG`, chain-config overrides, Helm |
| Is testnet | `false` | `DEFAULT_CHAINS.isTestnet` |
| Two public HTTPS RPC URLs | primary and fallback | `PUBLIC_RPCS` |
| A public WSS URL, if one exists | `wss://...` | `publicWssDefault`; see step 3 |
| Explorer URL and API family | `https://plasmascan.to`, `etherscan` or `blockscout` | `EXPLORER_CONFIG_TEMPLATES` |
| Stablecoins to show in the wallet | addresses, lowercase | `seed-tokens.ts` |
| Whether the stablecoin lineup mirrors Ethereum mainnet | see step 6 | `INDEPENDENT_TOKEN_LIST_CHAIN_IDS` |
| Name aliases the API should accept | `plasma`, `plasma-mainnet` | `DEFAULT_CHAINS.aliases`, `docs/api/chains.md` |

Cite the source for the chain id, RPC URLs and every token address (chainlist,
the chain's own documentation, the token issuer). Addresses added in a pull
request trip the `contracts-checked` gate and a maintainer has to verify each
one against the source you give.

## Steps

### 1. RPC configuration: `lib/rpc/rpc-config.ts`

Add the public URLs to `PUBLIC_RPCS`, then a `CHAIN_CONFIG[<chainId>]` entry
with `jsonKey`, `envKey`, `fallbackEnvKey`, `publicDefault` and
`publicFallback`.

This entry is load-bearing, not cosmetic. `getRpcUrlByChainId` throws for a
chain id with no `CHAIN_CONFIG` entry, and the seed script calls it for every
chain in `DEFAULT_CHAINS` at module load. A chain added to the seed without
this entry crashes the seed, and the seed runs on every deploy.

### 2. Chain seed: `scripts/seed/seed-chains.ts`, three places

1. Append a `NewChain` entry to `DEFAULT_CHAINS`, copying the shape of the
   neighbouring entries (`getChainConfigValue`, `getRpcUrlByChainId`,
   `getWssUrl`, `getUsePrivateMempoolRpc`, `getPrivateRpcUrl`). Add `aliases`
   for every name the `network` field should accept.
2. Add `<displayName>: <chainId>` to `CHAIN_TO_DEFAULT_ID`. The key is the
   display name, character for character. This is the map that joins a chain
   to its explorer config, and a name that is missing from it used to drop the
   explorer config with a `console.warn` while the seed exited zero. It now
   fails: `tests/unit/seed-chains-explorer-coverage.test.ts` runs the same join
   and the seed throws on a miss, so a chain cannot ship without an explorer.
3. Add an `EXPLORER_CONFIG_TEMPLATES[<chainId>]` entry. Etherscan V2 family
   chains use `explorerApiUrl: "https://api.etherscan.io/v2/api"` and
   `explorerApiType: "etherscan"`; Blockscout instances use their own
   `<explorer>/api` and `explorerApiType: "blockscout"`. The path fields
   (`explorerTxPath`, `explorerAddressPath`, `explorerContractPath`) differ by
   explorer software; open a transaction and a verified contract on the
   explorer and copy what you see. If the explorer has no usable API yet,
   leave `explorerApiUrl` and `explorerApiType` out rather than pointing them
   at something that does not answer: transaction and address links still
   work, ABI auto-fetch stays off for the chain, and the seed and its test
   accept the entry (Arc mainnet is in that state today).

### 3. WebSocket endpoint, or Event triggers do not work

`defaultPrimaryWss` is nullable and nothing in this repository complains when
it is null. The consumer is the event tracker service
(`keeperhub-events`), whose workflow mapper refuses to register an Event
trigger on a chain without a primary WSS URL, and does so silently: the
workflow saves, shows as enabled, and never fires.

So decide it now, and record the decision in the pull request:

- The chain publishes a reliable public WSS endpoint: set `publicWssDefault`
  (and `publicWssFallback` if there is one) on the `CHAIN_CONFIG` entry.
  `getWssUrl` falls back to it when chain-config has no WSS URL.
- It does not: the WSS URL has to come from chain-config after merge. State
  in the pull request that Event triggers on this chain depend on that
  follow-up, so the maintainer wiring chain-config knows to include it.

### 4. Blockscout-backed explorers: `plugins/blockscout/chains.ts`

If the explorer is a Blockscout instance, add the chain to
`BLOCKSCOUT_INSTANCES`. This is what the Blockscout plugin's actions (address
balance, counters and info, token info, transaction lookup) use, and it is
separate from the explorer config seeded in step 2: that one serves ABI
fetches and explorer links, this one serves the plugin. Etherscan-family
chains skip this step.

### 5. Gas strategy: `lib/web3/gas-strategy.ts`

`AdaptiveGasStrategy.getHardcodedOverrides` carries per-chain gas multipliers
and priority-fee floors. A chain with no entry gets `DEFAULT_CONFIG`, which is
correct for most L2s. Add an override only if the chain's fee market needs
one (a known minimum priority fee, unusually inaccurate gas estimation), and
say in the pull request why.

### 6. Wallet token list: `lib/chain-utils.ts`

The wallet modal renders each chain's stablecoins by overlaying its
`supported_tokens` rows on the Ethereum mainnet master list, and shows
"Not available" for any mainnet stablecoin the chain lacks. That is right for
chains that mirror mainnet's lineup (Circle USDC, Tether USDT, Sky USDS) and
wrong for chains that do not: Plasma ships USDT0 and no Circle USDC, so the
overlay would print a "Not available" row for every mainnet asset next to its
one real token.

If the chain's lineup does not mirror mainnet, add its id to
`INDEPENDENT_TOKEN_LIST_CHAIN_IDS` in `lib/chain-utils.ts`. Both consumers
(the wallet modal and `/api/supported-tokens`) read that one set; it used to
be two hand-synced copies, and a chain added to one but not the other rendered
correctly in the API and wrongly in the modal.

### 7. Stablecoins: `scripts/seed/seed-tokens.ts`

Verify every address on chain before adding it:

```bash
pnpm tsx scripts/verify-token.ts <chainId> <tokenAddress>
```

Then add `TOKEN_CONFIGS` rows under a comment block for the chain. Addresses
are lowercase (the unique index and the modal lookups assume it); `sortOrder`
starts at 1; `symbol`, `name` and `decimals` are read on chain by the seed, so
do not hardcode them. Testnets usually need one faucet USDC; mainnets need
every stablecoin users will hold there.

### 8. Names the API accepts: `lib/rpc/network-utils.ts` and `docs/api/chains.md`

There are two alias vocabularies and they do not read each other.
`DEFAULT_CHAINS.aliases` lands in the `chains` table and is what the
agentic-wallet workflow binding and the events route use to classify a chain
tag. `getChainIdFromNetwork` in `network-utils.ts` has its own hardcoded
`networkMap` for the deprecated `network` field on the action and execute
endpoints, and `docs/api/chains.md` publishes that map as the table of
accepted names. If users will send the chain by name through `network`, add
the names to `networkMap` and to the table. Numeric chain ids work on every
seeded chain without this step.

`docs/api/chains.md` is registered in `specs/api-coverage.json`. Editing it
means running `pnpm check:api-docs` before you push; CI runs the same check
and fails on drift.

### 9. Display names and scanner (usually no change)

- `lib/chain-utils.ts` `CHAIN_NAMES` and `EXPLORER_URLS`: static display names
  and address links used by the scan and hub surfaces and the OG image
  generator, which do not read the chains table. Add the chain if those
  surfaces should name it; otherwise it renders as `Chain <id>`.
- `components/overlays/wallet/chain-utils.ts` `CHAIN_DISPLAY_ORDER`: wallet
  card order. Unlisted chains sort last.
- `lib/scan/networks.ts` `SCAN_NETWORK_IDS`: only if a protocol registry in
  `lib/scan/adapters/protocol-registry.ts` gains the chain. The two are kept in
  lockstep by hand; do not add a chain to one without the other.

## Verify locally

```bash
pnpm tsx scripts/seed/seed-chains.ts
pnpm tsx scripts/seed/seed-tokens.ts
pnpm vitest run tests/unit/seed-chains-explorer-coverage.test.ts
curl 'http://localhost:3000/api/chains' | jq '.[] | select(.chainId == <chainId>)'
curl 'http://localhost:3000/api/supported-tokens?chainId=<chainId>'
```

The chain should appear in `/api/chains` with a non-null `explorerUrl`, the
tokens should come back with resolved `explorerUrl` values, and the wallet
modal should show the chain card with its tokens (balances may be zero). If
you set a WSS URL, create a workflow with an Event trigger on the chain and
confirm the event tracker registers it.

Then the usual gates:

```bash
pnpm check
pnpm type-check
pnpm check:api-docs   # if docs/api/chains.md changed
```

## Checklist for the pull request description

- Chain id, name, `jsonKey`, testnet flag, with the source cited.
- RPC URLs and explorer, with the source cited.
- WSS: public default set, or "depends on chain-config" stated.
- Token addresses, each verified with `scripts/verify-token.ts`, source cited.
- Independent token list: yes or no, and why.
- Aliases added to `networkMap` and `docs/api/chains.md`, or "numeric id only".
- Anything the infra owner has to do after merge (private RPC, API keys,
  chain-config entry).

## Maintainers: after merge

1. Add the chain-config entry (private RPC, WSS, per-environment flags) in
   `KeeperHub/chain-config`, then roll `CHAIN_RPC_CONFIG` through Parameter
   Store and Helm.
2. The seed runs on deploy and is idempotent: it upserts by `chainId` and
   disables any enabled chain row the seed no longer produces.
3. Check `GET /api/chains` on staging for the chain with its explorer fields
   populated, then the same on production after the release.
