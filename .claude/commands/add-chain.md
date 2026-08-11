---
description: Add a new blockchain and its stablecoins to the wallet modal end-to-end
argument-hint: <chain-name-or-chain-id>
---

<objective>
Standardise onboarding a new EVM chain into KeeperHub's wallet modal. `$ARGUMENTS` is the chain name (e.g. "Ethereum", "Avalanche", "Plasma") or chain ID (e.g. `1`, `43114`, `9745`). If empty, ask the user.

End state: the chain is seeded in `chains` + `explorer_configs`, has at least one `supported_tokens` entry per mainnet asset (verified on-chain), and the wallet modal renders it correctly.
</objective>

<context>
Chain seed script: @scripts/seed/seed-chains.ts
Stablecoin seed script: @scripts/seed/seed-tokens.ts
RPC config (chain ID to RPC URL mapping): @lib/rpc/rpc-config.ts
Wallet modal (consumes supported_tokens via /api/supported-tokens): @components/overlays/wallet-overlay.tsx
Supported tokens API (master-list logic, TEMPO carve-outs): @app/api/supported-tokens/route.ts
Schema: @lib/db/schema-extensions.ts (supportedTokens), @lib/db/schema.ts (chains, explorerConfigs)
Project conventions: @CLAUDE.md
</context>

<process>

### 1. Parse arguments and identify the chain

From `$ARGUMENTS`, resolve to a canonical `(chainId, jsonKey, symbol)` tuple. Look up the chain on chainlist.org or the protocol's official docs. Confirm with the user before proceeding if ambiguous.

Needed facts (ask the user for anything missing):
- Chain ID (integer).
- Human name (e.g. "Avalanche").
- Native symbol (e.g. "AVAX").
- `jsonKey` for env/Helm config (kebab-case, e.g. `avax-mainnet`, `plasma-testnet`).
- Is testnet? (boolean).
- Primary + fallback public RPC URLs.
- Block explorer URL + API type (`etherscan` for Etherscan V2 family, `blockscout` otherwise).
- List of stablecoin contract addresses to track in the wallet modal (mainnet chains only need this; testnets often have one faucet USDC).

### 2. Check what already exists

Idempotency matters. For the target chain ID, check:

- `lib/rpc/rpc-config.ts`: does `CHAIN_CONFIG[<id>]` exist? Does `PUBLIC_RPCS` have entries?
- `scripts/seed/seed-chains.ts`: is there an entry in `DEFAULT_CHAINS`? An entry in `EXPLORER_CONFIG_TEMPLATES`? An entry in `chainToDefaultIdMap`?
- `scripts/seed/seed-tokens.ts`: any `TOKEN_CONFIGS` rows?
- Database (dev): `SELECT chain_id, name FROM chains WHERE chain_id = <id>`; `SELECT COUNT(*) FROM supported_tokens WHERE chain_id = <id>`.

Report which pieces exist and which are missing. Only modify what needs modifying.

### 3. Wire up RPC config (if missing)

Edit [lib/rpc/rpc-config.ts](lib/rpc/rpc-config.ts):
- Add primary + fallback URLs to the `PUBLIC_RPCS` constant.
- Add a `CHAIN_CONFIG[<id>]` entry with `jsonKey`, `envKey`, `fallbackEnvKey`, `publicDefault`, `publicFallback`.

### 4. Wire up chain seed (if missing)

Edit [scripts/seed/seed-chains.ts](scripts/seed/seed-chains.ts):
- Append a `NewChain` entry to `DEFAULT_CHAINS` following the existing pattern (use `getChainConfigValue`, `getRpcUrlByChainId`, `getWssUrl`, `getUsePrivateMempoolRpc`, `getPrivateRpcUrl`).
- Add the chain to `chainToDefaultIdMap` (name to default chainId).
- Add an entry to `EXPLORER_CONFIG_TEMPLATES` keyed by chain ID. Etherscan V2 chains use `explorerApiUrl: "https://api.etherscan.io/v2/api"`; Blockscout chains use their own endpoint.

### 5. Verify stablecoins on-chain

**Before editing `seed-tokens.ts`**, validate every proposed token address. For each `(chainId, tokenAddress)`:

Run:
```bash
pnpm tsx scripts/verify-token.ts <chainId> <tokenAddress>
```

This calls `symbol()`, `name()`, `decimals()` via the chain's configured primary RPC (falls back to public RPC on failure). It prints the resolved metadata and exits non-zero on failure.

Record each `(chainId, tokenAddress, symbol, name, decimals)`. Reject any address that reverts, times out, or returns a symbol that doesn't match what the user expects (a common sign of a wrong address or a proxy to a different impl).

### 6. Update seed-tokens.ts

Edit [scripts/seed/seed-tokens.ts](scripts/seed/seed-tokens.ts). Append `TOKEN_CONFIGS` rows under a new comment block matching the existing format:

```ts
// ==========================================================================
// <Chain Name> (chainId: <id>)
// ==========================================================================
{
  chainId: <id>,
  tokenAddress: "0x...", // <SYMBOL>
  logoUrl: LOGOS.<SYMBOL> ?? null,
  isStablecoin: true,
  sortOrder: 1,
},
```

Rules:
- Addresses MUST be lowercase (the `supported_tokens_chain_address` unique index + wallet modal lookups assume this).
- `sortOrder` starts at 1 for the primary stablecoin on the chain and increments.
- If no `LOGOS.<SYMBOL>` entry exists and you have a canonical logo URL, add it to the `LOGOS` constant; otherwise use `null`.
- Do NOT hardcode `symbol`, `name`, or `decimals` in `TOKEN_CONFIGS`; the seed script fetches them on-chain.

### 7. Seed locally and verify

```bash
pnpm tsx scripts/seed/seed-chains.ts
pnpm tsx scripts/seed/seed-tokens.ts
```

Then confirm:
- `SELECT chain_id, symbol, name, decimals FROM supported_tokens WHERE chain_id = <id>` returns the expected rows.
- `curl 'http://localhost:3000/api/supported-tokens?chainId=<id>'` returns the tokens with resolved `explorerUrl`.
- Open the wallet modal in the app, switch to the new chain's card, and verify the stablecoins render (balances may be zero).

### 8. Lint, type-check, and commit

```bash
pnpm check
pnpm type-check
pnpm fix
```

Fix any failures before committing. Commit message format (no ticket numbers per repo convention):

```
feat: add <chain-name> to wallet with <symbols> stablecoins
```

### 9. Staging and prod rollout

The seed scripts are idempotent (update-on-conflict by `(chain_id, token_address)`). They run on deploy via `scripts/migrate-prod.ts`; no manual DB edits are needed in staging or prod.

If the chain requires env vars (private RPC, API keys), coordinate the Helm/Parameter Store `CHAIN_RPC_CONFIG` update with the infra owner before the PR merges.

</process>

<success_criteria>
- `lib/rpc/rpc-config.ts` has `CHAIN_CONFIG[<id>]` and public RPC entries.
- `scripts/seed/seed-chains.ts` has the chain in `DEFAULT_CHAINS`, `chainToDefaultIdMap`, and `EXPLORER_CONFIG_TEMPLATES`.
- `scripts/seed/seed-tokens.ts` has at least one `TOKEN_CONFIGS` row per tracked stablecoin, all addresses lowercase and verified on-chain by `scripts/verify-token.ts`.
- Local seed runs complete without errors; `/api/supported-tokens?chainId=<id>` returns the expected payload; wallet modal renders the new chain card.
- `pnpm check`, `pnpm type-check` and `pnpm fix` pass.
- Commit follows conventional-commit format, PR targets `staging`.
</success_criteria>
