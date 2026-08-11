# Task: Sky Protocol Plugin (F-049)

Status: NOT STARTED
Priority: 6 (month 1-3)
Effort: S (1 week)
Depends on: F-048 (SHIPPED)

## Objective

Create a Sky Protocol (formerly MakerDAO) plugin using the `defineProtocol()` system shipped in F-048. This is the first real-world protocol definition -- WETH was a simple example, Sky validates the system against a complex, multi-contract, multi-chain protocol.

Sky is KeeperHub's flagship reference customer ($9.5B+ TVL, 7+ years). Having Sky as a first-class protocol plugin is both a dogfood exercise and a sales asset.

## Context

F-048 shipped:
- `defineProtocol()` typed API in `keeperhub/lib/protocol-registry.ts`
- `protocolToPlugin()` auto-generation of workflow nodes
- `resolveAbi()` with 24h caching and proxy detection in `keeperhub/lib/abi-cache.ts`
- Generic `protocol-read` and `protocol-write` steps
- `discover-plugins` extended to scan `keeperhub/protocols/`
- WETH example protocol (4 chains, 3 actions)

This task validates the system against a protocol with:
- Multiple contracts (sUSDS, USDS, DAI, SKY, MKR, converters)
- Multi-chain deployments (Ethereum, Base, Arbitrum)
- Mix of read and write actions
- Proxy contracts (UUPS/ERC-1967 for USDS and sUSDS)
- ERC-4626 vault interface (sUSDS)

## Research: Sky Protocol Current State (Feb 2026)

Sky rebranded from MakerDAO. The ecosystem has migrated from DAI to USDS as the primary stablecoin, and from MKR to SKY as the governance token. Key changes:

- **USDS** replaced DAI as the primary stablecoin (1:1 converter available, no fees, permanent)
- **sUSDS** replaced sDAI as the primary savings product (ERC-4626 vault, earns Sky Savings Rate)
- **SKY** replaced MKR as the governance token (1 MKR = 24,000 SKY, one-way conversion)
- **Multi-chain**: USDS and sUSDS deployed on Ethereum, Base, and Arbitrum via SkyLink bridge
- **DAI and sDAI** still exist and function but are legacy -- new users should use USDS/sUSDS

### Verified Contract Addresses

#### Ethereum Mainnet (chain ID: 1)

| Contract | Address | Proxy | Notes |
|---|---|---|---|
| USDS | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` | Yes (UUPS/ERC-1967) | Primary stablecoin, 18 decimals |
| sUSDS | `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD` | Yes (UUPS/ERC-1967) | ERC-4626 savings vault, 18 decimals |
| DAI | `0x6B175474E89094C44Da98b954EedeAC495271d0F` | No | Legacy stablecoin, 18 decimals |
| sDAI | `0x83F20F44975D03b1b09e64809B757c47f942BEeA` | No | Legacy ERC-4626 savings vault |
| SKY | `0x56072C95FAA701256059aa122697B133aDEd9279` | No | Governance token, 18 decimals |
| MKR | `0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2` | No | Legacy governance token |
| DAI-USDS Converter | `0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A` | No | 1:1 bidirectional, no fees |
| MKR-SKY Converter | `0xA1Ea1bA18E88C381C724a75F23a130420C403f9a` | No | 1 MKR = 24,000 SKY, one-way only |

#### Base (chain ID: 8453)

| Contract | Address | Proxy |
|---|---|---|
| USDS | `0x820C137fa70C8691f0e44Dc420a5e53c168921Dc` | Yes |
| sUSDS | `0x5875eEE11Cf8398102FdAd704C9E96607675467a` | Yes (EIP-1967 Transparent) |

#### Arbitrum One (chain ID: 42161)

| Contract | Address | Proxy |
|---|---|---|
| USDS | `0x6491c05A82219b8D1479057361ff1654749b876b` | Yes |
| sUSDS | `0xdDb46999F8891663a8F2828d25298f70416d7610` | Yes (EIP-1967 Transparent) |

### Key Technical Details

**sUSDS (ERC-4626 vault)** -- The primary user-facing contract for savings:
- `deposit(uint256 assets, address receiver)` -- deposit USDS, receive sUSDS shares
- `withdraw(uint256 assets, address receiver, address owner)` -- withdraw exact USDS amount
- `redeem(uint256 shares, address receiver, address owner)` -- redeem exact sUSDS shares
- `convertToAssets(uint256 shares)` -- preview USDS value of sUSDS shares
- `convertToShares(uint256 assets)` -- preview sUSDS shares for USDS amount
- `balanceOf(address)` -- sUSDS share balance
- `totalAssets()` -- total USDS in vault
- No fees, fees cannot be enabled in the future

**DAI-USDS Converter:**
- `daiToUsds(address usr, uint256 amount)` -- convert DAI to USDS
- `usdsToDai(address usr, uint256 amount)` -- convert USDS to DAI
- 1:1 ratio, no fees, permissionless

**MKR-SKY Converter:**
- `mkrToSky(address usr, uint256 mkrAmt)` -- convert MKR to SKY (one-way, burns MKR)
- Rate: 1 MKR = 24,000 SKY

### Sources
- Sky Developer Docs: https://developers.sky.money/
- Chainlog: https://chainlog.sky.money/api/mainnet/active.json
- GitHub: https://github.com/sky-ecosystem

## Acceptance Criteria

- [ ] `keeperhub/protocols/sky.ts` exists with a valid `defineProtocol()` call
- [ ] 10+ actions covering core Sky operations (savings, tokens, converters)
- [ ] Multi-chain support: Ethereum (all contracts), Base + Arbitrum (USDS, sUSDS)
- [ ] `pnpm discover-plugins` registers Sky as a protocol plugin without errors
- [ ] Sky actions appear in the workflow builder node palette
- [ ] Sky actions appear in `/api/mcp/schemas` response
- [ ] Sky protocol card appears in the Hub Protocols tab
- [ ] Clicking Sky card shows action list with correct type badges and chain badges
- [ ] Proxy contract ABIs resolve correctly via `resolveAbi()` (USDS and sUSDS are proxies)
- [ ] `pnpm check` and `pnpm type-check` pass with zero errors

## Actions (14 total)

### Savings -- sUSDS (ERC-4626 vault, multi-chain)

| # | Slug | Label | Type | Contract | Function | Chains |
|---|---|---|---|---|---|---|
| 1 | `deposit-ssr` | Deposit USDS to Savings | write | sUsds | `deposit` | 1, 8453, 42161 |
| 2 | `withdraw-ssr` | Withdraw USDS from Savings | write | sUsds | `withdraw` | 1, 8453, 42161 |
| 3 | `redeem-ssr` | Redeem sUSDS Shares | write | sUsds | `redeem` | 1, 8453, 42161 |
| 4 | `get-susds-balance` | Get sUSDS Balance | read | sUsds | `balanceOf` | 1, 8453, 42161 |
| 5 | `preview-deposit` | Preview Savings Deposit | read | sUsds | `previewDeposit` | 1, 8453, 42161 |
| 6 | `get-susds-value` | Get USDS Value of sUSDS | read | sUsds | `convertToAssets` | 1, 8453, 42161 |

### Token Balances (multi-chain where available)

| # | Slug | Label | Type | Contract | Function | Chains |
|---|---|---|---|---|---|---|
| 7 | `get-usds-balance` | Get USDS Balance | read | usds | `balanceOf` | 1, 8453, 42161 |
| 8 | `get-dai-balance` | Get DAI Balance | read | dai | `balanceOf` | 1 |
| 9 | `get-sky-balance` | Get SKY Balance | read | sky | `balanceOf` | 1 |

### Approvals

| # | Slug | Label | Type | Contract | Function | Chains |
|---|---|---|---|---|---|---|
| 10 | `approve-usds` | Approve USDS Spending | write | usds | `approve` | 1, 8453, 42161 |
| 11 | `approve-dai` | Approve DAI Spending | write | dai | `approve` | 1 |

### Converters (Ethereum only)

| # | Slug | Label | Type | Contract | Function | Chains |
|---|---|---|---|---|---|---|
| 12 | `convert-dai-to-usds` | Convert DAI to USDS | write | daiUsdsConverter | `daiToUsds` | 1 |
| 13 | `convert-usds-to-dai` | Convert USDS to DAI | write | daiUsdsConverter | `usdsToDai` | 1 |
| 14 | `convert-mkr-to-sky` | Convert MKR to SKY | write | mkrSkyConverter | `mkrToSky` | 1 |

## Technical Approach

### Follow the WETH pattern exactly

The WETH definition at `keeperhub/protocols/weth.ts` is the reference. Sky follows the same structure with more contracts and actions.

```typescript
// keeperhub/protocols/sky.ts
import { defineProtocol } from "@/keeperhub/lib/protocol-registry";

export default defineProtocol({
  name: "Sky",
  slug: "sky",
  description: "Sky Protocol (formerly MakerDAO) -- USDS savings, token management, and DAI/MKR migration",
  website: "https://sky.money",

  contracts: {
    sUsds: {
      label: "sUSDS (Savings USDS)",
      addresses: {
        "1": "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
        "8453": "0x5875eEE11Cf8398102FdAd704C9E96607675467a",
        "42161": "0xdDb46999F8891663a8F2828d25298f70416d7610",
      },
      // Proxy -- ABI auto-resolved via abi-cache
    },
    usds: {
      label: "USDS Stablecoin",
      addresses: {
        "1": "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
        "8453": "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
        "42161": "0x6491c05A82219b8D1479057361ff1654749b876b",
      },
    },
    dai: {
      label: "DAI Stablecoin (Legacy)",
      addresses: {
        "1": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      },
    },
    sky: {
      label: "SKY Governance Token",
      addresses: {
        "1": "0x56072C95FAA701256059aa122697B133aDEd9279",
      },
    },
    daiUsdsConverter: {
      label: "DAI-USDS Converter",
      addresses: {
        "1": "0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A",
      },
    },
    mkrSkyConverter: {
      label: "MKR-SKY Converter",
      addresses: {
        "1": "0xA1Ea1bA18E88C381C724a75F23a130420C403f9a",
      },
    },
  },

  actions: [
    // ... 14 actions as defined above
  ],
});
```

### ABI resolution

Omit `abi` from all contract definitions. `resolveAbi()` in `keeperhub/lib/abi-cache.ts` auto-fetches from Etherscan/BaseScan/Arbiscan. All Sky contracts are verified. USDS and sUSDS are proxies -- `resolveAbi()` handles EIP-1967/1822 proxy detection automatically.

### After creating the definition

Run `pnpm discover-plugins` to:
1. Scan `keeperhub/protocols/sky.ts`
2. Auto-generate plugin registration in `keeperhub/protocols/index.ts`
3. Add Sky to step-registry and codegen-registry
4. Add `sky` to the IntegrationType union in `lib/types/integration.ts`

## Scope

**Build:**
- `keeperhub/protocols/sky.ts` with 7 verified contracts and 14 actions
- Verify end-to-end: discover-plugins, workflow builder, MCP schemas, Hub UI

**Skip:**
- Custom icon (uses generic protocol icon from F-048)
- Governance actions (vote, delegate via Chief) -- defer
- Vault/CDP management (open vault, draw DAI) -- complex, defer
- stUSDS (Staked USDS) -- expert-level risk token, defer
- PSM (Peg Stability Module) -- infrastructure, not user-facing
- SkyLink bridge actions -- cross-chain bridge, defer
- Sky on non-EVM chains (Solana via Wormhole NTT)

## Files to Reference

**Protocol system (shipped in F-048):**
- `keeperhub/lib/protocol-registry.ts` -- `defineProtocol()`, types, registry
- `keeperhub/lib/abi-cache.ts` -- `resolveAbi()` with caching
- `keeperhub/protocols/weth.ts` -- Reference protocol definition (follow this pattern exactly)
- `keeperhub/protocols/index.ts` -- Auto-generated barrel (regenerated by discover-plugins)
- `keeperhub/plugins/protocol/steps/protocol-read.ts` -- Generic read step
- `keeperhub/plugins/protocol/steps/protocol-write.ts` -- Generic write step
- `scripts/discover-plugins.ts` -- Protocol scanning logic
- `keeperhub/lib/chain-utils.ts` -- Chain ID to name mapping

**Hub UI (verify Sky appears):**
- `keeperhub/components/hub/protocol-grid.tsx`
- `keeperhub/components/hub/protocol-card.tsx`
- `keeperhub/components/hub/protocol-detail.tsx`

## Constraints

- Protocol address keys use numeric chain ID strings (`"1"`, `"8453"`, `"42161"`)
- All custom code in `keeperhub/` per fork policy
- Run `pnpm discover-plugins` after creating the protocol file
- Biome lint: block statements, cognitive complexity max 15, top-level regex

## When Done

- Run `pnpm discover-plugins` -- Sky appears in generated registries
- Run `pnpm check` and `pnpm type-check` -- zero errors
- Verify Sky appears in: workflow builder palette, `/api/mcp/schemas`, Hub Protocols tab
- Update `~/.claude/work-command/state.json`: set F-049 status to "completed", add completedDate
- Add log entry with summary
