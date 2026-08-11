# Task: Protocol Registry & ABI Resolution (F-048)

**Status: SHIPPED (v1.2 -- 2026-02-20)**

## Objective

Build a declarative protocol definition system where adding a new DeFi protocol requires only a TypeScript definition file -- no step code, no plugin boilerplate. Protocol definitions auto-generate workflow nodes that plug into the existing plugin system.

The end result: adding Compound support takes 30 minutes and zero custom step code.

## Context

KeeperHub's existing plugin system requires writing step files (with `"use step"` directive), plugin definitions, icons, and wiring up registration for every action. This works for generic tools (Web3, Discord) but doesn't scale for protocol-specific actions where 70-80% are just `read-contract` or `write-contract` with pre-filled parameters.

The protocol registry sits between protocol definitions and the existing plugin system:

```
defineProtocol("compound.ts")
  -> Protocol Registry (resolves contracts, ABIs, chains)
    -> Auto-generates IntegrationPlugin + PluginAction[]
      -> Existing plugin system (discover-plugins, step-registry, MCP schemas)
```

Foundation for: F-049 (Sky Plugin), F-008 (Direct Execution API), F-014 (Safe Plugin Pack).

## Acceptance Criteria

- [x] `defineProtocol()` function accepts a typed protocol definition object and returns protocol metadata
- [x] Protocol definitions live in `keeperhub/protocols/{protocol-slug}.ts` (one file per protocol)
- [x] `pnpm discover-plugins` extended to scan `keeperhub/protocols/` and auto-generate plugin registrations
- [x] Each protocol becomes an `IntegrationPlugin` with auto-generated `PluginAction[]` entries
- [x] Protocol actions appear in the workflow builder as nodes (e.g., "WETH: Wrap", "WETH: Unwrap")
- [x] Protocol actions appear in MCP schemas endpoint (`/api/mcp/schemas`)
- [x] ABI resolution: auto-fetch from block explorer when `abi` omitted from definition, cache result
- [x] Proxy detection: reuse existing `fetch-abi` logic (EIP-1967, EIP-1822, EIP-2535 Diamond)
- [x] Multi-chain: contract addresses vary per chain, protocol definition declares all deployments
- [x] At runtime, auto-generated steps call existing `read-contract` or `write-contract` core logic -- no new execution code
- [x] At least one example protocol definition included (WETH wrap/unwrap/balanceOf)
- [x] `pnpm check` and `pnpm type-check` pass with zero errors
- [x] Hub UI: Protocols tab with grid view, detail view, action list, "Use in Workflow" navigation

## Shipped Implementation

### Milestone: v1.2 Protocol Registry (4 phases, 10 plans)

| Phase | What | Plans | Key Files |
|-------|------|-------|-----------|
| Phase 6: Foundations | Protocol types, defineProtocol(), core extraction | 2 | protocol-registry.ts, read-contract-core.ts, write-contract-core.ts |
| Phase 7: Plugin Auto-Generation | protocolToPlugin(), protocol steps, discover-plugins, bootstrap | 4 | protocol-read.ts, protocol-write.ts, discover-plugins.ts, protocols/index.ts |
| Phase 8: ABI Resolution + Example | ABI auto-fetch, 24h cache, proxy detection, WETH | 2 | abi-cache.ts, weth.ts |
| Phase 9: Hub UI | Tabs, protocol grid, detail view, action list | 2 | protocol-grid.tsx, protocol-detail.tsx, protocol-card.tsx |

### Key Architecture Decisions (shipped)

| Decision | Rationale |
|----------|-----------|
| File-based protocol definitions | No DB needed, discover-plugins scans at build time |
| -core.ts extraction pattern | Enables reuse without bundler violations (decode-calldata-core.ts reference) |
| Server-side bootstrap via barrel file | Generated keeperhub/protocols/index.ts ensures registration at startup |
| Side-effect imports for registration | Triggers through existing plugin import chain, zero manual steps |
| Generic protocol icon (Box from lucide-react) | Custom icons per-protocol deferred |
| In-memory ABI cache with 24h TTL | Simple, no external cache dependency |
| Numeric chain ID strings as address keys | Matches chain-select field stored values ("1", "8453", etc.) |
| _protocolMeta hidden field with JSON | UI hides underscore-prefixed fields automatically |
| Intentional logic duplication in protocol-read/write | Cannot share helpers between "use step" files |

### File Structure (as shipped)

```
keeperhub/
  lib/
    protocol-registry.ts        -- defineProtocol(), protocolToPlugin(), types, runtime registry
    abi-cache.ts                 -- resolveAbi() with 3-stage resolution (definition/cache/explorer)
    chain-utils.ts               -- getChainName() for human-readable chain ID mapping
  protocols/
    weth.ts                      -- WETH protocol (4 chains, 3 actions, ABI omitted for auto-fetch)
    index.ts                     -- Auto-generated barrel (imports + registers all protocols)
  plugins/
    protocol/
      index.ts                   -- Plugin shell with side-effect import of protocols barrel
      icon.tsx                   -- ProtocolIcon (Box from lucide-react)
      steps/
        protocol-read.ts         -- Generic read step for all protocol read actions
        protocol-write.ts        -- Generic write step for all protocol write actions
  api/
    protocols/route.ts           -- GET /api/protocols (returns registered protocol definitions)
  components/hub/
    protocol-grid.tsx            -- Filterable protocol card grid
    protocol-card.tsx            -- Individual protocol card
    protocol-detail.tsx          -- Inline detail view with action list
```

Core logic extraction:
```
keeperhub/plugins/web3/steps/
  read-contract-core.ts          -- Extracted from read-contract.ts (352 lines)
  write-contract-core.ts         -- Extracted from write-contract.ts (399 lines)
  read-contract.ts               -- Thin wrapper: enrichment + metrics + delegates to core
  write-contract.ts              -- Thin wrapper: enrichment + metrics + delegates to core
```

### Import Chain (server startup)

```
plugins/index.ts
  -> @/keeperhub/plugins (keeperhub/plugins/index.ts)
    -> ./protocol (keeperhub/plugins/protocol/index.ts)
      -> @/keeperhub/protocols (keeperhub/protocols/index.ts -- auto-generated)
        -> registerProtocol(wethDef) + registerIntegration(protocolToPlugin(wethDef))
```

### WETH Example Protocol

4 chains (Ethereum, Base, Arbitrum, Optimism), 3 actions (wrap/write, unwrap/write, balanceOf/read). ABI intentionally omitted to exercise auto-fetch path.

---

## Original Spec (reference)

<details>
<summary>Original architecture and design spec (pre-implementation)</summary>

### Protocol Definition Format

```typescript
// keeperhub/protocols/compound.ts
import { defineProtocol } from "@/keeperhub/lib/protocol-registry";

export default defineProtocol({
  name: "Compound",
  slug: "compound",
  description: "Compound Finance lending protocol",
  website: "https://compound.finance",

  contracts: {
    cometUsdc: {
      label: "USDC Market (Comet)",
      addresses: {
        ethereum: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
        base: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
        arbitrum: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA",
      },
      // abi: omitted -> auto-fetched from block explorer and cached
    },
    rewards: {
      label: "Rewards",
      addresses: {
        ethereum: "0x1B0e765F6224C21223AeA2af16c1C46E38885a40",
      },
    },
  },

  actions: [
    {
      slug: "supply",
      label: "Supply",
      description: "Supply tokens to a Compound market",
      type: "write",
      contract: "cometUsdc",
      function: "supply",
      inputs: [
        { name: "asset", type: "address", label: "Token to supply" },
        { name: "amount", type: "uint256", label: "Amount", decimals: true },
      ],
    },
    {
      slug: "claim-rewards",
      label: "Claim Rewards",
      description: "Claim accumulated COMP rewards",
      type: "write",
      contract: "rewards",
      function: "claim",
      inputs: [
        { name: "comet", type: "address", label: "Market address" },
        { name: "src", type: "address", label: "Account", default: "{{wallet}}" },
        { name: "shouldAccrue", type: "bool", label: "Accrue first", default: "true" },
      ],
    },
    {
      slug: "get-balance",
      label: "Get Balance",
      description: "Check supply balance in a Compound market",
      type: "read",
      contract: "cometUsdc",
      function: "balanceOf",
      inputs: [
        { name: "account", type: "address", label: "Account", default: "{{wallet}}" },
      ],
      outputs: [
        { name: "balance", type: "uint256", label: "Balance", decimals: 6 },
      ],
    },
  ],
});
```

### Type Definitions

```typescript
export type ProtocolContract = {
  label: string;
  addresses: Record<string, string>;      // chainName -> address
  abi?: string;                            // JSON ABI string. If omitted, auto-fetched.
};

export type ProtocolActionInput = {
  name: string;                            // Solidity parameter name
  type: string;                            // "address" | "uint256" | "bool" | "bytes" | etc.
  label: string;                           // Human-readable label for UI
  default?: string;                        // Default value (supports {{wallet}} template)
  decimals?: boolean | number;             // true = auto-detect, number = fixed decimals
};

export type ProtocolActionOutput = {
  name: string;
  type: string;
  label: string;
  decimals?: number;
};

export type ProtocolAction = {
  slug: string;
  label: string;
  description: string;
  type: "read" | "write";
  contract: string;
  function: string;
  inputs: ProtocolActionInput[];
  outputs?: ProtocolActionOutput[];
};

export type ProtocolDefinition = {
  name: string;
  slug: string;
  description: string;
  website?: string;
  contracts: Record<string, ProtocolContract>;
  actions: ProtocolAction[];
};
```

### UI Design

Tab switcher on Hub page (Workflows | Protocols), protocol grid matching workflow template styling, inline detail view with action list, "Use in Workflow" navigation.

</details>

## Scope Changes from Original Spec

| Original Plan | What Shipped | Why |
|---------------|-------------|-----|
| Address keys as chain names ("ethereum") | Numeric chain ID strings ("1", "8453") | Matches chain-select field stored values at runtime |
| Protocol icons per-protocol | Single generic Box icon | Custom icons deferred to future |
| Hub sidebar chain filter | Search input only | MVP simplification |
| Action pre-insertion into workflow canvas | Navigate to builder only | Pre-adding node deferred |
| protocol-section.tsx + protocol-action-row.tsx | Combined into protocol-grid.tsx + protocol-detail.tsx | Simpler component structure |
| Separate ABI core extraction | resolveAbi() uses shared lib/explorer modules directly | No need for separate core file -- explorer logic already modular |

## Files to Reference

**Protocol system (shipped):**
- `keeperhub/lib/protocol-registry.ts` -- Types, defineProtocol(), protocolToPlugin(), runtime registry
- `keeperhub/lib/abi-cache.ts` -- resolveAbi() with cache and proxy detection
- `keeperhub/protocols/weth.ts` -- Example protocol definition
- `keeperhub/plugins/protocol/steps/protocol-read.ts` -- Generic read step
- `keeperhub/plugins/protocol/steps/protocol-write.ts` -- Generic write step
- `scripts/discover-plugins.ts` -- Protocol discovery and barrel generation

**Core extraction (shipped):**
- `keeperhub/plugins/web3/steps/read-contract-core.ts` -- Extracted read logic
- `keeperhub/plugins/web3/steps/write-contract-core.ts` -- Extracted write logic

**Hub UI (shipped):**
- `app/hub/page.tsx` -- Tab switcher, protocol state management
- `keeperhub/components/hub/protocol-grid.tsx` -- Protocol card grid
- `keeperhub/components/hub/protocol-card.tsx` -- Individual protocol card
- `keeperhub/components/hub/protocol-detail.tsx` -- Detail view with action list
- `keeperhub/api/protocols/route.ts` -- GET /api/protocols endpoint

## Constraints

- All custom code in `keeperhub/` directory per fork policy
- Step files with `"use step"` cannot export functions -- use `-core.ts` pattern
- No Node.js-only SDKs in step files -- use `fetch()` directly
- Biome lint: block statements required, cognitive complexity max 15, top-level regex
- Run `pnpm discover-plugins` after adding protocol files
- Run `pnpm check` and `pnpm type-check` before committing
