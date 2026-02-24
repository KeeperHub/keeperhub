---
description: Add a new protocol plugin to KeeperHub from a spec file or protocol name
argument-hint: <spec-file-or-protocol-name>
---

<objective>
Add a new KeeperHub protocol plugin using a multi-agent pipeline. $ARGUMENTS is either:
- A file path ending in `.md` (spec file, e.g., `specs/F-049-sky-protocol-plugin.md`) -- read and extract all protocol details from it
- A protocol name (e.g., "Aave", "Uniswap") -- interview the user for contracts, chains, and actions
- Empty -- ask the user what protocol to add

This command orchestrates specialized agents across 5 phases: analyze, plan, develop, test, and fix. Each phase has a clear responsibility and handoff, producing higher quality output than a single sequential pass.
</objective>

<context>
Reference implementation (WETH): @keeperhub/protocols/weth.ts
Type definitions and defineProtocol API: @keeperhub/lib/protocol-registry.ts
Project conventions: @CLAUDE.md
Existing protocols: !`ls keeperhub/protocols/`
Docs plugin format reference: @docs/plugins/web3.md
Docs plugin nav: @docs/plugins/_meta.ts
Docs plugin overview: @docs/plugins/overview.md
</context>

<architecture>
CRITICAL: Follow these conventions EXACTLY. All protocol definitions go in `keeperhub/protocols/` (NOT `protocols/`).

FILE LOCATION: `keeperhub/protocols/{slug}.ts`

IMPORT (exact):
```typescript
import { defineProtocol } from "@/keeperhub/lib/protocol-registry";
```

EXPORT (exact):
```typescript
export default defineProtocol({...})
```

HOW IT WORKS (registration chain):
Protocol plugins are "meta-plugins" -- each .ts file in `keeperhub/protocols/` defines one protocol, and `pnpm discover-plugins` generates a barrel (`keeperhub/protocols/index.ts`) that imports + registers all of them. The barrel calls `registerProtocol(def)` and `registerIntegration(protocolToPlugin(def))` for each protocol. At server startup, `keeperhub/plugins/protocol/index.ts` imports this barrel as a side effect, which triggers registration. Each protocol slug becomes its own `IntegrationType` entry (e.g., `"weth"`, `"sky"`). The generic `protocol-read` and `protocol-write` step handlers route to the correct contract/function at runtime via a hidden `_protocolMeta` JSON field that's auto-injected into each action's config.

If ANY protocol definition fails validation, the entire import chain fails and the server won't start. This makes correct definitions critical.

COMPLETE defineProtocol() SHAPE:
```typescript
defineProtocol({
  name: string,           // Display name (e.g., "Sky Protocol")
  slug: string,           // kebab-case (e.g., "sky") -- matches filename without .ts
  description: string,    // One-line description of the protocol
  website?: string,       // Protocol website URL (optional)
  icon?: string,          // Path like "/protocols/sky.png" -- optional, default square icon shown if omitted

  contracts: Record<string, {
    label: string,
    addresses: Record<string, string>,  // chainId string -> 0x-prefixed hex address (exactly 42 chars)
    abi?: string,                       // OMIT for auto-fetch (recommended -- see ABI handling below)
    userSpecifiedAddress?: boolean,     // When true, the runtime address comes from user input (see below)
  }>,

  actions: Array<{
    slug: string,           // kebab-case (e.g., "deposit-ssr", "get-balance")
    label: string,          // User-facing label (e.g., "Deposit USDS to Savings")
    description: string,    // What the action does (one sentence)
    type: "read" | "write", // read = view/pure functions, write = state-changing transactions
    contract: string,       // MUST exactly match a key in the contracts object above
    function: string,       // Exact Solidity function name (e.g., "deposit", "balanceOf")
    inputs: Array<{
      name: string,         // Exact Solidity parameter name
      type: string,         // MUST be a valid Solidity type: address, uint256, int256, bytes32, bool, string, bytes, uint8, etc.
      label: string,        // User-facing label shown in workflow builder
      default?: string,     // Default value as string (optional)
      decimals?: boolean | number,  // true = 18 decimals, number = specific decimals
    }>,
    outputs?: Array<{       // REQUIRED for read actions that return values. Omit for write actions.
      name: string,         // Output field name (used as {{NodeId.fieldName}} in templates)
      type: string,         // Solidity return type
      label: string,        // User-facing label
      decimals?: number,    // Decimal places for display
    }>,
  }>,
})
```

VALIDATION RULES (enforced by defineProtocol at import time -- violations throw at startup):
- Protocol slug must match `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/` (kebab-case, start with letter)
- Action slugs must match the same pattern
- Contract addresses must match `/^0x[0-9a-fA-F]{40}$/` (exactly 42 chars, 0x prefix)
- Every `action.contract` value must reference an existing key in the `contracts` object
- At least one contract required
- At least one action required
- No duplicate action slugs

CHAIN IDs (numeric strings as object keys):
- `"1"` -- Ethereum Mainnet
- `"8453"` -- Base
- `"42161"` -- Arbitrum One
- `"10"` -- Optimism

ABI HANDLING:
- OMIT the `abi` field from all contract definitions (recommended)
- `resolveAbi()` auto-fetches from block explorers (Etherscan, BaseScan, Arbiscan) with 24h cache
- Proxy detection is automatic: EIP-1967, EIP-1822, EIP-2535 (Diamond) -- ABI follows the implementation
- Only provide inline `abi` if: contract is unverified on all explorers AND you have the ABI string
- Add a comment noting proxy status: `// Proxy -- ABI auto-resolved via abi-cache`

USER-SPECIFIED ADDRESS CONTRACTS:
- Some protocols (e.g., Safe multisig wallets) are deployed at user-specific addresses rather than fixed protocol-level addresses
- Set `userSpecifiedAddress: true` on such contracts
- The `addresses` field still serves as chain-availability metadata -- populate it with reference addresses (e.g., singleton/implementation addresses) so `collectAllChains()` in the UI correctly shows supported chains
- Address format validation is skipped for these contracts (the reference addresses are informational)
- At build time, `buildConfigFieldsFromAction()` automatically inserts a `contractAddress` template-input field at the top of the action config
- At runtime, `protocol-read.ts` and `protocol-write.ts` read `input.contractAddress` instead of looking up from the fixed addresses map
- Reference: `keeperhub/protocols/safe.ts` (canonical example)

ICON HANDLING:
- Icon is fully optional -- if omitted, a default square protocol icon (`ProtocolIcon`) is displayed everywhere (Hub, workflow builder, etc.)
- If user provides an icon URL: download to `public/protocols/{slug}.png`, set `icon: "/protocols/{slug}.png"`
- If user provides a local image path: copy to `public/protocols/{slug}.png`, set `icon: "/protocols/{slug}.png"`
- If no icon provided: OMIT the `icon` field entirely from the definition -- do not set it to an empty string or null
- ICON QUALITY: The icon component in `keeperhub/plugins/protocol/icon.tsx` (`createProtocolIconComponent`) renders at 48x48 via Next.js `<Image>`. Source images MUST be at least 256x256 for crisp display on retina screens. Preferred sources in order:
  1. Trust Wallet assets: `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/{checksumAddress}/logo.png` (256x256, transparent, high quality)
  2. CoinGecko large: `https://assets.coingecko.com/coins/images/{id}/large/{slug}.png`
  3. Protocol's own website/GitHub brand assets
  4. User-provided URL (verify dimensions after download with `sips -g pixelWidth -g pixelHeight`)
  - Avoid CryptoCompare and other aggregator thumbnails -- they are often low-res upscales that appear blurry

ACTION GROUPING:
- Group related actions with comment headers in the actions array (improves readability)
- Examples: `// Savings`, `// Token Balances`, `// Approvals`, `// Converters`

OUTPUT FIELDS:
- All actions automatically get: `success` (boolean), `error` (string) -- do NOT define these
- Write actions automatically get: `transactionHash`, `transactionLink` -- do NOT define these
- Read actions: MUST define `outputs` array if the function returns values (e.g., balances, previews). Without outputs, return values are lost
- Write actions: NEVER define outputs for tx hash/link -- they are auto-added
- CRITICAL: Output field count and order MUST exactly match the contract function's return values. Declaring outputs that don't exist in the return data causes silent data corruption (values shift or are undefined). Always verify output count against the contract ABI or block explorer before defining outputs.

INPUT FIELD AUTO-BEHAVIOR:
- Inputs with `type: "address"` automatically get address book UI support (popover with saved addresses)
- This is handled by `buildConfigFieldsFromAction()` setting `isAddressField: true` -- no manual config needed

CHAIN-ACTION AVAILABILITY:
- An action is only available on chains where its contract has an address
- For multi-contract protocols: verify each action's contract is deployed on all intended chains
- Example: Sky's DAI-USDS Converter exists only on Ethereum ("1"), so `convert-dai-to-usds` is Ethereum-only even if other Sky contracts exist on Base and Arbitrum

POST-CREATION STEPS (run in this exact order):
1. `pnpm discover-plugins` -- scans keeperhub/protocols/, generates keeperhub/protocols/index.ts, adds to lib/types/integration.ts
2. `pnpm check` -- lint check (Biome/Ultracite)
3. `pnpm type-check` -- TypeScript validation
4. NEVER manually edit `keeperhub/protocols/index.ts` or `lib/types/integration.ts` -- these are auto-generated by `pnpm discover-plugins`. Hand-editing them defeats the purpose and creates drift.

WETH REFERENCE (canonical example -- 4 chains, 3 actions):
```typescript
import { defineProtocol } from "@/keeperhub/lib/protocol-registry";

export default defineProtocol({
  name: "WETH",
  slug: "weth",
  description: "Wrapped Ether -- wrap ETH to WETH (ERC-20) and unwrap back to ETH",
  website: "https://weth.io",
  icon: "/protocols/weth.png",

  contracts: {
    weth: {
      label: "WETH Contract",
      addresses: {
        // Ethereum Mainnet
        "1": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        // Base
        "8453": "0x4200000000000000000000000000000000000006",
        // Arbitrum One
        "42161": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        // Optimism
        "10": "0x4200000000000000000000000000000000000006",
      },
      // ABI omitted -- resolved automatically via abi-cache
    },
  },

  actions: [
    {
      slug: "wrap",
      label: "Wrap ETH",
      description: "Wrap native ETH into WETH (ERC-20). Send ETH value with the transaction.",
      type: "write",
      contract: "weth",
      function: "deposit",
      inputs: [],
    },
    {
      slug: "unwrap",
      label: "Unwrap WETH",
      description: "Unwrap WETH back to native ETH",
      type: "write",
      contract: "weth",
      function: "withdraw",
      inputs: [{ name: "wad", type: "uint256", label: "Amount (wei)" }],
    },
    {
      slug: "balance-of",
      label: "Get Balance",
      description: "Check WETH balance of an address",
      type: "read",
      contract: "weth",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Wallet Address" }],
      outputs: [
        {
          name: "balance",
          type: "uint256",
          label: "WETH Balance (wei)",
          decimals: 18,
        },
      ],
    },
  ],
});
```

F-049 SKY SPEC AS EXAMPLE (what a spec file looks like):
The spec at `specs/F-049-sky-protocol-plugin.md` defines 7 contracts (sUSDS, USDS, DAI, SKY, DAI-USDS Converter, MKR-SKY Converter) and 14 actions across Ethereum, Base, and Arbitrum. It shows how to handle multi-contract, multi-chain protocols with proxy contracts. Use this as the gold standard for complex, multi-contract, multi-chain protocol specs.

WHAT HAPPENS AUTOMATICALLY AFTER REGISTRATION (no manual work needed):
- Protocol card appears in the Hub Protocols tab (`/hub`)
- Shareable detail page at `/hub/protocol/{slug}` with OG image generation
- Protocol actions appear in the workflow builder node palette
- API endpoint at `/api/protocols/{slug}` returns protocol JSON
- Protocol actions appear in `/api/mcp/schemas` for AI workflow generation
- Address-type input fields get address book popover in the UI

KNOWN ISSUES & RUNTIME CONSIDERATIONS:

1. **_protocolMeta persistence**: The hidden `_protocolMeta` config field (auto-injected by `buildConfigFieldsFromAction`) is only persisted via `defaultValue` when nodes are created through the ActionGrid in the workflow builder. The protocol detail page (`/hub/protocol/{slug}`) creates workflow nodes directly via the API and must explicitly include `_protocolMeta` in the node config. This is already handled in `protocol-detail.tsx` -- do NOT remove that code.

2. **_actionType fallback**: The protocol step handlers (`protocol-read.ts`, `protocol-write.ts`) have a fallback: if `_protocolMeta` is missing from the step input, they derive metadata from `_actionType` (e.g., `"sky/get-usds-balance"` -> protocolSlug: `"sky"`, look up action by slug). This fallback lives in `resolve-protocol-meta.ts`. The workflow executor injects `_actionType` into all step inputs.

3. **Cognitive complexity**: The protocol step functions (`protocol-read.ts`, `protocol-write.ts`) are near the Biome cognitive complexity limit (15). The metadata resolution was extracted to `resolve-protocol-meta.ts` to stay under the limit. Do NOT inline that logic back into the step files.

4. **"use step" bundler constraints**: Protocol step files have `"use step"` -- NEVER export helper functions from them. Shared logic goes in separate files without `"use step"` (e.g., `resolve-protocol-meta.ts`). See MEMORY.md for details.

5. **Testing runtime execution**: Always test a protocol action by actually running a workflow (not just registration/UI). The protocol detail page "Use in Workflow" button is the fastest way. Verify the step executes successfully, not just that the node appears in the builder.

6. **Proxy contract ABI resolution**: The ABI auto-fetch in `abi-cache.ts` checks whether the fetched ABI contains any `"function"` entries before accepting it. Proxy contracts (EIP-1967, etc.) return a valid ABI from Etherscan but with only constructor/error/event/fallback entries and no functions. Without the function check, the code short-circuits before proxy detection runs, causing `"Function X not found in ABI"` errors at runtime. This is fixed -- do NOT remove the `hasFunctions` check in `fetchAbiFromExplorer()`.

7. **Icon rendering quality**: The protocol icon component (`createProtocolIconComponent` in `keeperhub/plugins/protocol/icon.tsx`) renders at 48x48 via Next.js `<Image>`. Source images must be at least 256x256 for crisp retina display. Prefer Trust Wallet assets as the primary icon source.
</architecture>

<process>
This command runs as a multi-agent pipeline. You (the main agent) orchestrate 5 phases, spawning specialized agents for analysis, development, testing, and fixing.

## PHASE 0: GATHER (main agent, interactive)

1. PARSE $ARGUMENTS
   - If $ARGUMENTS ends with `.md` and the file exists: read it, extract protocol name, contracts, addresses, chains, and actions
   - If $ARGUMENTS is a protocol name string: research the protocol, then interview user for details
   - If $ARGUMENTS is empty: ask the user what protocol they want to add

2. GATHER PROTOCOL INFORMATION (skip fields that came from spec file)
   - Protocol name and slug (derive slug as kebab-case from name)
   - Description (one line)
   - Website URL (optional)
   - Icon source: URL to download, local file path, or skip (generic icon used)
   - Which chains to support (Ethereum "1", Base "8453", Arbitrum "42161", Optimism "10")
   - For each contract:
     - Key name (camelCase, e.g., `sUsds`, `daiUsdsConverter`)
     - Display label
     - Address per chain (verify format: 0x + 40 hex chars)
     - Is it a proxy? (note in comment, but omit abi field either way)
   - For each action:
     - Slug (kebab-case)
     - Label (user-facing)
     - Description (one sentence)
     - Type: "read" or "write"
     - Contract key (must match a key in contracts)
     - Function name (exact Solidity name)
     - Inputs array (name, type, label; add decimals for token amounts)
     - Outputs array (for read actions that return values)

3. BUILD PROTOCOL BRIEF
   Construct a structured text block containing ALL gathered data. This brief is the single source of truth passed to downstream agents. Format it clearly with sections for metadata, contracts, and actions. Include exact counts:
   - Total contracts: N
   - Total actions: N (M read, K write)
   - Chains: list

## PHASE 1: ANALYZE (Explore agent)

Spawn a `protocol-analyst` agent using the Task tool:
- `subagent_type`: `Explore`
- `name`: `protocol-analyst`

Pass the protocol brief in the prompt and instruct the agent to validate:

```
You are the protocol analyst for the KeeperHub /add-protocol pipeline.

You receive a protocol brief and must validate it before any code is written.
Your job is read-only analysis -- you do NOT create or modify any files.

PROTOCOL BRIEF:
{paste the complete brief here}

VALIDATION CHECKS (run all of these):

1. SLUG FORMAT: All slugs (protocol + every action) match /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/ (kebab-case, starts with letter)
2. ADDRESS FORMAT: All contract addresses are valid hex (exactly 42 chars, 0x prefix, followed by 40 hex chars)
3. CONTRACT REFERENCES: Every action.contract value matches an existing key in the contracts object
4. NO DUPLICATE ACTIONS: All action slugs are unique
5. MINIMUM CONTENT: At least 1 contract and 1 action defined
6. INPUT TYPES: All input types are valid Solidity types (address, uint256, int256, bytes32, bool, string, bytes, uint8, uint16, uint32, uint64, uint128, int8, int16, int32, int64, int128, bytes1-bytes32, tuple, arrays like uint256[], address[])
7. READ ACTION OUTPUTS: Every read action that returns values has an outputs array defined
8. SLUG COLLISION: Check lib/types/integration.ts -- the protocol slug must NOT already exist as an IntegrationType entry
9. FILENAME COLLISION: Check keeperhub/protocols/ -- no existing file named {slug}.ts
10. CHAIN CONSISTENCY: For each action, verify its contract has addresses on at least 1 chain. Flag actions whose contract is only on a subset of chains (informational, not a failure)
11. OUTPUT COUNT ACCURACY: For each read action with outputs, verify the output count matches the contract function's actual return value count. Flag any mismatch -- extra outputs cause silent data corruption at runtime.

RESPONSE FORMAT:
Return EXACTLY one of these two formats:

If all checks pass:
VALIDATION: PASS
- Contracts: {count}
- Actions: {count} ({read_count} read, {write_count} write)
- Chains: {list}
- Chain-limited actions: {list any actions available on fewer chains than others, or "none"}

If any check fails:
VALIDATION: FAIL
Issues:
1. {description of first issue}
2. {description of second issue}
...
```

**If the analyst returns FAIL:** Present the issues to the user. Correct the brief based on user feedback. Re-run the analyst with the corrected brief. Repeat until PASS.

**If the analyst returns PASS:** Proceed to Phase 2.

## PHASE 2: PLAN (main agent, no subagent)

With the validated brief, construct the exact instructions for the developer agent. This is a synthesis step -- you hold full conversation context and produce precise file-level instructions:

1. Determine the icon handling approach (curl URL, cp local path, or omit)
2. Map out the defineProtocol structure: contracts object with exact keys/addresses, actions array with exact fields
3. Determine the documentation structure: frontmatter, overview paragraph, actions table, per-action sections, supported chains
4. Determine the test file structure: what to test and expected values
5. Compile all of this into the developer agent's prompt (Phase 3)

## PHASE 3: DEVELOP (general-purpose agent)

Spawn a `protocol-developer` agent using the Task tool:
- `subagent_type`: `general-purpose`
- `name`: `protocol-developer`

Pass the full protocol brief AND the file plan from Phase 2. The prompt must include the complete `<architecture>` section from this command (copy it verbatim into the prompt) so the developer has all conventions available.

```
You are the protocol developer for the KeeperHub /add-protocol pipeline.

Your job is to create all files for a new protocol plugin. Follow every convention EXACTLY.

ARCHITECTURE CONVENTIONS:
{paste the complete <architecture> section here}

PROTOCOL BRIEF:
{paste the complete brief here}

FILE PLAN:
{paste the file plan from Phase 2 here}

TASKS (execute in this order):

1. ICON (if applicable)
   - If URL provided: run `curl -sL -o public/protocols/{slug}.png "{url}"`
   - If local path provided: run `cp {path} public/protocols/{slug}.png`
   - If no icon: skip this step

2. PROTOCOL DEFINITION
   Create `keeperhub/protocols/{slug}.ts` following the exact WETH pattern:
   - Single import: `import { defineProtocol } from "@/keeperhub/lib/protocol-registry";`
   - Single export: `export default defineProtocol({...})`
   - Inline comments for chain names (// Ethereum Mainnet, // Base, etc.)
   - Comments for proxy contracts: `// Proxy -- ABI auto-resolved via abi-cache`
   - Group actions by category with comment headers
   - Omit `abi` field from all contracts (auto-fetched)
   - No emojis anywhere

3. REGISTER
   Run `pnpm discover-plugins` and verify:
   - No errors in output
   - Protocol slug appears in the output
   - `keeperhub/protocols/index.ts` imports the new protocol
   - `lib/types/integration.ts` includes the slug in IntegrationType
   - IMPORTANT: Never manually edit keeperhub/protocols/index.ts or lib/types/integration.ts. These are auto-generated. If they need changes, fix the source (protocol definition file) and re-run discover-plugins.

4. DOCUMENTATION
   Create `docs/plugins/{slug}.md` with this structure:
   - Frontmatter: `title: "{name} Protocol"`, `description: "..."` summarizing purpose and chains
   - H1: `# {name} Protocol`
   - Overview paragraph: what the protocol does, supported chains, credential note (write actions require wallet)
   - Actions table with columns: Action, Type (Read/Write), Credentials, Description
   - For EACH action: H2 section with:
     - **Inputs:** list of input fields with types
     - **Outputs:** list of output fields (read actions); write actions auto-include success/transactionHash/transactionLink/error
     - **When to use:** one-sentence guidance
   - "Example Workflows" section with 2-4 practical multi-step workflow examples showing how the protocol's actions combine with other nodes. Each example should have:
     - A descriptive title (e.g., "Monitor USDS Savings Position")
     - A node chain showing the workflow visually: `Trigger -> Protocol Action -> Processing -> Output`
     - One sentence explaining what it does
     - Use real KeeperHub nodes: Schedule/Manual/Webhook triggers, Math (Aggregate with divide post-op for wei-to-decimal), Condition (threshold checks), Discord/SendGrid (alerts), HTTP Request (webhooks), other protocol actions
     - Examples should cover common patterns: balance monitoring with alerts, threshold-based automation, multi-step DeFi operations, portfolio tracking
     - For read actions returning wei values, show the Math node conversion pattern: `Read Balance -> Math (Sum, divide by 10^18) -> Condition (check threshold)`
   - "Supported Chains" section listing each chain with contracts deployed on it
   - No emojis anywhere

5. DOCS NAVIGATION
   Edit `docs/plugins/_meta.ts`:
   - Insert `{slug}: "{name}"` in alphabetical order among existing entries

   Edit `docs/plugins/overview.md`:
   - Add a row to the "Available Plugins" table: `| [{name}](/plugins/{slug}) | Protocol | {action summary} | Wallet (for writes) |`
   - Insert the row in a logical position (protocols together)

6. UNIT TESTS
   Create `tests/unit/protocol-{slug}.test.ts` using Vitest:
   ```typescript
   import { describe, expect, it } from "vitest";
   ```

   Import the protocol definition from `@/keeperhub/protocols/{slug}` and test:
   - **Definition validity**: importing does not throw (defineProtocol validation passes)
   - **Slug format**: protocol slug and all action slugs match /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
   - **Address format**: every contract address is 42-char hex with 0x prefix
   - **Contract references**: every action.contract references an existing contract key
   - **No duplicate actions**: all action slugs are unique
   - **Read action outputs**: every read action has outputs defined
   - **Chain coverage**: for each action, its contract has addresses on at least 1 chain
   - **Action count**: total actions matches {expected_action_count}
   - **Registration**: after import, verify the protocol is registered (import from `@/keeperhub/lib/protocol-registry` and use `getProtocol("{slug}")`)

RESPONSE FORMAT:
When done, return a structured summary:
FILES_CREATED:
- {path}: {description}
- ...

DISCOVER_PLUGINS_RESULT: {success/failure + any relevant output}
REGISTRATION_VERIFIED: {yes/no}
```

## PHASE 4: TEST (general-purpose agent)

Spawn a `protocol-tester` agent using the Task tool:
- `subagent_type`: `general-purpose`
- `name`: `protocol-tester`

```
You are the protocol tester for the KeeperHub /add-protocol pipeline.

Your job is to verify that the protocol "{slug}" was created correctly. Run all checks and report results.
You do NOT fix issues -- you only report them.

PROTOCOL: {slug}
EXPECTED ACTION COUNT: {count}
EXPECTED CHAINS: {chain list}

CHECKS (run all):

1. UNIT TESTS
   Run: `pnpm vitest run tests/unit/protocol-{slug}.test.ts`
   Report: PASS or FAIL with test output

2. LINT
   Run: `pnpm check`
   If it fails, read `.claude/lint-output.txt` for details.
   Report: PASS or FAIL with error details

3. TYPE CHECK
   Run: `pnpm type-check`
   If it fails, read `.claude/typecheck-output.txt` for details.
   Report: PASS or FAIL with error details

4. REGISTRATION - BARREL
   Read `keeperhub/protocols/index.ts` and verify "{slug}" appears as an import.
   Report: PASS or FAIL

5. REGISTRATION - INTEGRATION TYPE
   Read `lib/types/integration.ts` and verify "{slug}" appears in the IntegrationType union.
   Report: PASS or FAIL

6. DOCUMENTATION - PAGE
   Read `docs/plugins/{slug}.md` and verify:
   - Has frontmatter with title and description
   - Has H1 heading
   - Has actions table
   - Has per-action H2 sections
   - Has "Supported Chains" section
   - No emojis
   Report: PASS or FAIL with details

7. DOCUMENTATION - NAV
   Read `docs/plugins/_meta.ts` and verify "{slug}" entry exists.
   Report: PASS or FAIL

8. DOCUMENTATION - OVERVIEW
   Read `docs/plugins/overview.md` and verify the protocol row exists in the table.
   Report: PASS or FAIL

9. CONSISTENCY
   Read `keeperhub/protocols/{slug}.ts` and cross-check:
   - Action count matches {expected_action_count}
   - Chain list matches {expected_chains}
   - Actions documented in docs match actions in definition
   Report: PASS or FAIL with discrepancies

10. PROTOCOL DETAIL PAGE - _protocolMeta
   Read `keeperhub/components/hub/protocol-detail.tsx` and verify:
   - The `handleUseInWorkflow` function includes `_protocolMeta` in the node config
   - The _protocolMeta JSON includes protocolSlug, contractKey, functionName, actionType
   Report: PASS or FAIL
   NOTE: This is critical -- without _protocolMeta in the config, workflows created from the protocol detail page will fail at runtime with "Invalid _protocolMeta" even though the node appears correctly in the builder.

11. OUTPUT FIELD ACCURACY
   For each read action, verify the output count matches the contract function's actual return values by checking the ABI on a block explorer.
   Report: PASS or FAIL with specific actions that have mismatched output counts

12. AUTO-GENERATED FILES
   Run `pnpm discover-plugins` and verify no diff is produced on keeperhub/protocols/index.ts or lib/types/integration.ts (meaning they were generated, not hand-edited).
   Report: PASS or FAIL

RESPONSE FORMAT (use exactly this structure):

TEST REPORT:
1. UNIT TESTS: {PASS|FAIL} {details if fail}
2. LINT: {PASS|FAIL} {details if fail}
3. TYPE CHECK: {PASS|FAIL} {details if fail}
4. REGISTRATION - BARREL: {PASS|FAIL}
5. REGISTRATION - INTEGRATION TYPE: {PASS|FAIL}
6. DOCUMENTATION - PAGE: {PASS|FAIL} {details if fail}
7. DOCUMENTATION - NAV: {PASS|FAIL}
8. DOCUMENTATION - OVERVIEW: {PASS|FAIL}
9. CONSISTENCY: {PASS|FAIL} {details if fail}
10. PROTOCOL DETAIL PAGE: {PASS|FAIL} {details if fail}
11. OUTPUT FIELD ACCURACY: {PASS|FAIL} {details if fail}
12. AUTO-GENERATED FILES: {PASS|FAIL}

OVERALL: {ALL_PASS|HAS_FAILURES}
FAILURES: {comma-separated list of failed check numbers, or "none"}
```

**If ALL_PASS:** Proceed to final summary. Skip Phase 5.

**If HAS_FAILURES:** Proceed to Phase 5.

## PHASE 5: FIX (general-purpose agent, conditional)

Only run this phase if Phase 4 reported failures. Spawn a `protocol-fixer` agent:
- `subagent_type`: `general-purpose`
- `name`: `protocol-fixer`

```
You are the protocol fixer for the KeeperHub /add-protocol pipeline.

The tester found issues with the "{slug}" protocol. Fix all failures and verify the fixes.

ARCHITECTURE CONVENTIONS:
{paste the complete <architecture> section here}

TEST REPORT FROM PHASE 4:
{paste the complete test report here}

PROTOCOL SLUG: {slug}

FIX PROCEDURE:

For each failure in the test report, fix the root cause:

- UNIT TEST failures: Read the test output, identify what's wrong in the protocol definition or test file, fix it, re-run `pnpm vitest run tests/unit/protocol-{slug}.test.ts`
- LINT failures: Read `.claude/lint-output.txt`, fix issues in protocol + test + docs files, re-run `pnpm check`
- TYPE CHECK failures: Read `.claude/typecheck-output.txt`, fix type issues, re-run `pnpm type-check`
- REGISTRATION failures: Re-run `pnpm discover-plugins`, then verify files
- DOCUMENTATION failures: Fix missing sections, entries, or formatting in docs files

IMPORTANT RULES:
- Fix the source of the problem, not the test
- Follow all conventions from the architecture section (block statements, no emojis, explicit types, etc.)
- After fixing, re-run the relevant check command to verify
- You may iterate up to 3 times per failure category
- Do NOT fix things that are already passing

RESPONSE FORMAT:
FIX REPORT:
- {check name}: {FIXED|PARTIALLY_FIXED|ALREADY_PASSING} {details}
- ...

REMAINING ISSUES: {list of any unfixed issues, or "none"}
OVERALL: {ALL_FIXED|PARTIALLY_FIXED}
```

**If ALL_FIXED:** Proceed to final summary.

**If PARTIALLY_FIXED:** Present remaining issues to the user and explain what could not be auto-fixed.

## FINAL SUMMARY

After all phases complete, present a summary to the user:

```
Protocol: {name} ({slug})
Contracts: {count}
Actions: {count} ({read_count} read, {write_count} write)
Chains: {chain list}

Files created:
- keeperhub/protocols/{slug}.ts
- docs/plugins/{slug}.md
- tests/unit/protocol-{slug}.test.ts
{- public/protocols/{slug}.png (if icon was provided)}

Files modified:
- docs/plugins/_meta.ts
- docs/plugins/overview.md
- keeperhub/protocols/index.ts (auto-generated)
- lib/types/integration.ts (auto-generated)

Status: All checks passing (lint, type-check, unit tests, registration, docs)
```
</process>

<verification>
Before completing, verify all phases executed:
- Phase 0 (Gather): Protocol brief constructed with all required fields
- Phase 1 (Analyze): Analyst returned VALIDATION: PASS
- Phase 2 (Plan): File plan constructed for developer agent
- Phase 3 (Develop): All files created, discover-plugins ran successfully
- Phase 4 (Test): All 12 checks reported
- Phase 5 (Fix): Only if needed -- all issues resolved or user informed of remaining issues
- Final: `keeperhub/protocols/{slug}.ts` exists with valid defineProtocol() call
- Final: `pnpm check` and `pnpm type-check` pass
- Final: Protocol registered in `keeperhub/protocols/index.ts` and `lib/types/integration.ts`
- Final: Documentation at `docs/plugins/{slug}.md` with nav and overview entries
- Final: Unit tests at `tests/unit/protocol-{slug}.test.ts` passing
- Final: No emojis in any created files
</verification>

<success_criteria>
- Protocol definition file at `keeperhub/protocols/{slug}.ts` follows exact WETH pattern
- All validation rules pass at import time (slugs, addresses, contract refs)
- `pnpm discover-plugins` registers the protocol in generated registries
- `pnpm check` and `pnpm type-check` pass with zero errors
- Unit tests at `tests/unit/protocol-{slug}.test.ts` pass
- Protocol appears in both `keeperhub/protocols/index.ts` and `lib/types/integration.ts`
- Protocol card appears in the Hub Protocols tab (visible in UI)
- Protocol actions appear in workflow builder node palette
- Documentation page at `docs/plugins/{slug}.md` with actions table and per-action details
- Protocol listed in `docs/plugins/overview.md` table and `docs/plugins/_meta.ts` nav
</success_criteria>
