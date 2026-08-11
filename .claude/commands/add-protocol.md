---
description: Add a new protocol plugin to KeeperHub via an iterative agent pipeline
argument-hint: <protocol-name-or-spec-file>
---

<objective>
Add a new KeeperHub protocol plugin and iterate until the on-chain integration tests pass.

`$ARGUMENTS` is one of:
- A protocol name **including the version when multiple versions are live** (e.g. `"Aave V4"`, `"Uniswap V3"`, `"Compound V3"`, `"Pendle"`). The pipeline researches contracts, ABIs, and chains via web search and explorer lookups.
- A path to a spec file ending in `.md`. Pipeline reads it as the source of truth and only researches gaps.
- Empty, or a version-ambiguous name (e.g. just `"Aave"`). Pipeline MUST ask the user which version before researching. Do not default to "the latest" - V3 and V4 of Aave are both in active production use today, and each has its own contracts, ABIs, and slug.

DONE when ALL of the following pass:
- `public/protocols/{slug}.png` exists at the path the plugin's `icon` field points to. Every protocol ships with a real logo; placeholders and default-icon fallbacks are not allowed.
- `pnpm test tests/unit/protocol-{slug}.test.ts` (shape lock)
- `pnpm test tests/unit/build-workflow.test.ts` (registry walker: verifies the new protocol's `TEST_DATA` resolves cleanly for every chain it claims)
- `pnpm test tests/integration/protocol-{slug}-onchain.test.ts` against the test pattern selected in Phase 1 (a real testnet RPC, an anvil mainnet fork for mainnet-only protocols, or the public-RPC-fallback pattern; see `<process>` Phase 4). Calldata validation.
- `pnpm test:protocol` (alias for `vitest run tests/e2e/vitest/protocol-coverage`) — runs the coverage suite for every protocol with `TEST_DATA`. Gated by the project's standard e2e convention: `DATABASE_URL` must be set AND `SKIP_INFRA_TESTS` must NOT be `true`. The test posts workflows to a running keeperhub server's webhook endpoint at `PROTOCOL_E2E_BASE_URL` (default `http://localhost:3000`) and polls `workflow_executions` rows; RPC traffic is the server's responsibility via `CHAIN_RPC_CONFIG`, not the test's. Skipped is NOT pass. **Applies to Pattern A and C only.** Pattern B (mainnet-only) protocols omit `TEST_DATA` and have no coverage runner; the calldata `-onchain.test.ts` against real mainnet via the resolver pipeline is their sole vitest integration check (see Phase 1.7). If the protocol additionally needs write-broadcast verification, an optional fork-test script targets an anvil fork — that script is separate from the calldata test.
- `pnpm tsx scripts/seed/seed-protocol-workflows.ts --protocol={slug}` is idempotent: first run reports `N inserted, 0 failed`; immediate re-run reports `0 inserted, N refreshed, 0 skipped, 0 failed`. **Pattern A and C only**; Pattern B protocols have no seeded workflows.
- `pnpm check` (Ultracite lint)
- `pnpm type-check` (TypeScript)
- `pnpm discover-plugins` (protocol is registered and `protocols/index.ts` + `lib/types/integration.ts` regenerate cleanly)

The pipeline does NOT exit on partial work. If integration tests do not pass, it loops back to BUILD with the specific failure as the next problem to solve.
</objective>

<context>
Domain knowledge: @.claude/agents/protocol-domain.md
Blueprint pipeline: @.claude/agents/blueprint-pipeline.md
Project conventions: @CLAUDE.md

ABI-driven, Sepolia, 1:1 contract->surface (canonical reference): @protocols/wrapped.ts + @protocols/abis/weth.json
Mainnet-only, struct returns, docUrl tooltips: @protocols/aave-v4.ts
Multi-contract, struct-arg writes: @protocols/uniswap-v3.ts
Hybrid pattern (one ABI backing many UX surfaces; uses `deriveActionsFromAbi` + `defineProtocol`): @protocols/chainlink.ts

Unit test template: @tests/unit/protocol-wrapped.test.ts
Integration test template (Sepolia, gated): @tests/integration/protocol-wrapped-onchain.test.ts
Integration test template (mainnet, gated): @tests/integration/protocol-aave-v4-onchain.test.ts
Integration test template (ungated, public-RPC fallback): @tests/integration/protocol-uniswap-onchain.test.ts

Co-located TEST_DATA (KEEP-458 SSOT for protocol coverage): @lib/test-data/types.ts + @lib/test-data/build-workflow.ts + @lib/test-data/chain-test-data.ts
Canonical TEST_DATA examples: @protocols/aave-v3.ts (Sepolia, single contract, supply-cap workaround documented inline) + @protocols/superfluid.ts (multi-contract, userSpecifiedAddress, skip list)
Coverage test template (one file per chain, beforeAll setup + read/write phases): @tests/e2e/vitest/protocol-coverage/aave-v3/sepolia/coverage.test.ts
Shared coverage engine: @tests/e2e/vitest/protocol-coverage/_shared/setup.ts + @tests/e2e/vitest/protocol-coverage/_shared/run-fixture.ts + @tests/e2e/vitest/protocol-coverage/_shared/funding.ts
Seeder (idempotent; --protocol/--chain/--phase/--trigger/--user filters): @scripts/seed/seed-protocol-workflows.ts
Build-workflow registry walker (walks every protocol with testData): @tests/unit/build-workflow.test.ts

Protocol registry: @lib/protocol-registry.ts
ABI derivation internals: @lib/abi/protocol-derive.ts
Solidity type to field mapping: @lib/solidity-type-fields.ts
Tooltip/docUrl rendering: @lib/extensions.tsx (see `ProtocolFieldLabel`)

Existing protocols: !`ls protocols/`
Existing reduced ABIs: !`ls protocols/abis/ 2>/dev/null`
Existing integration tests: !`ls tests/integration/protocol-*-onchain.test.ts 2>/dev/null`
</context>

<process>
Spawn the Orchestrator agent with the iteration loop below. The Orchestrator MUST NOT exit until DONE (see `<objective>`) or a hard bail-out condition is hit.

```
Protocol Task: Add protocol "$ARGUMENTS" to KeeperHub via the iterative pipeline.

Domain Reference: .claude/agents/protocol-domain.md

ITERATION LOOP

Phases run in order. After VERIFY, if any check failed, loop back to BUILD with the specific failure as the next problem. Do not silently exit on partial work.

PHASE 1 - RESEARCH (web search + explorer lookups, BEFORE any code is written)

**Orient locally first**: run `/understand-chat protocols/` to see how the existing protocols are structured (definition strategy, ABI layout, TEST_DATA shape) and to confirm no entry for $ARGUMENTS already exists. The closest existing protocol is your structural template; the graph names it faster than `ls protocols/` + grep does.

Use WebSearch and WebFetch to gather concrete facts. Cite URLs and addresses for every claim. Do not guess; if a fact cannot be confirmed, mark it open and surface to the user.

1.1 Identity and version (do this FIRST; everything downstream depends on getting the version right)
- Canonical name and 1-line description of what the protocol does.
- **Version**: which specific version of the protocol is being added? Aave V2/V3/V4, Uniswap V2/V3/V4, Compound V2/V3, the Maker -> Sky rebrand, etc. Confirm the exact version explicitly. Do not assume "the latest" or "the most common" - the live deployments answer this, not your priors.
- Slug convention: **the slug tracks the protocol's own version branding**. If the protocol team brands itself as V2 / V3 / V4 in their docs and product UI (Aave V4, Uniswap V3, Compound III, Frax Ether V2), the slug includes that version suffix: `aave-v4`, `uniswap-v3`, `frax-ether-v2`. If the protocol does not version itself externally (WETH, ENS, Disperse, Multicall3), the slug omits a version. This rule applies whether or not an earlier version is already present in keeperhub - we are following the protocol's branding, not disambiguating internal entries.
- Pre-existing inconsistencies: a few protocols already in `protocols/` (`compound`, `uniswap`, `yearn`) use bare slugs even though the protocols they wrap brand themselves as V3, and their files are named `compound-v3.ts` / `uniswap-v3.ts` / `yearn-v3.ts`. These predate the rule above. Do not perpetuate them: new protocols MUST follow the protocol-version-branding rule, even when the result feels redundant.
- Official website.
- **Logo source (required, every protocol ships with one)**: identify a public URL for the protocol's official logo. Sources in order of preference: brand-assets page on the official site, `assets/` or `logos/` folder in the protocol's GitHub repo, `logo` field of the official npm package, the website favicon scraped at decent resolution. Note the URL and licensing in the Phase 2 report. The logo at `public/protocols/{slug}.png` is REQUIRED; placeholders and default-icon fallbacks are not acceptable. If no usable logo can be obtained from any of these sources, surface to the user (with the candidates) so they can drop the PNG in by hand before BUILD proceeds.
- Confirm the chosen slug does not collide with any entry in `protocols/` or `lib/types/integration.ts`.

1.2 Chains
- Which chains is the protocol deployed on?
- Intersect with KeeperHub's supported chains. Source of truth: existing protocols in `protocols/` and the chain entries in `chain-config/`. Any chain not in `chain-config/` will not have an explorer config and cannot be used.
- Report the intersection. That is the candidate `addresses` map.
- **HARD RULE: never fabricate a chain entry.** Do NOT add Sepolia (or any other chain) to the `addresses` map unless the protocol is genuinely deployed there at a real, verified contract address. Adding a chain to make local testing easier breaks workflows at runtime: the chain selector auto-exposes it to users and every call reverts because there is no contract code at the address.
- **Testnet-contract status (this drives the Phase 3 test pattern)**: explicitly record whether the protocol has a real deployment on a chain we can hit cheaply (Sepolia, Base Sepolia, Arbitrum Sepolia, Holesky). Verify this against the protocol's own addresses page AND a block explorer query on the candidate testnet; do not infer from "X has a Sepolia testnet" generally. If yes, integration tests use that testnet directly (Phase 3, pattern A). If no, integration tests use an anvil mainnet fork (Phase 3, pattern B) - NOT a fabricated testnet chain entry.

1.3 Contracts
- For each contract the user will interact with: label, address per chain, and the curated function set to expose.
- **Version isolation**: every contract MUST belong to the version identified in Phase 1.1. Do not mix V3 and V4 contracts in one protocol entry. When a version has sub-surfaces (Aave V4 Hub vs Spoke, Uniswap V3 SwapRouter02 vs older SwapRouter, Maker DSR vs Sky Savings Rate), name the exact surface in the contract label.
- Curate aggressively. Exposing every public function bloats the UI; pick the actions a user actually wants to run.
- Flag any contract whose address is per-user input (e.g. user supplies a pool address); these set `userSpecifiedAddress: true`.

1.4 ABI
- Obtain a reduced ABI for each contract. Source order of preference:
  a. npm package shipped by the protocol team **for the target version** (use the latest tagged release of that version's package, not main, not a different version's package).
  b. Verified contract on the relevant block explorer (Etherscan-style "Contract" tab). The explorer page MUST be for the version's deployment address from Phase 1.3 - confirm before copying the ABI. A V3 ABI scraped from a V4 contract page (or vice versa) will compile, pass unit tests, and fail integration tests with `INVALID_ARGUMENT` or `BAD_DATA`.
  c. Protocol's GitHub repo (look under `abi/`, `artifacts/`, or `out/` for forge projects). Pin to the version's tag or release branch, not `main` or `master`.
  d. Official protocol docs.
- **ABI-to-version match is a hard gate.** Function signatures drift between versions (Aave V3 `supply(asset, amount, onBehalfOf, referralCode)` becomes V4 `supply(reserveId, amount, onBehalfOf)`). The integration tests in Phase 4 will catch a version mismatch, but the cost is one or more failed iterations. Cite the exact source URL for each ABI in the Phase 2 report so reviewers can verify the version match before any code is written.
- Reduce: keep only the functions and events being exposed. Drop everything else.

1.5 Documentation URLs
- For each function being exposed, identify the canonical per-page docs URL. This populates `docUrl` on overrides.
- Prefer per-function pages over the docs root. Skip docUrl rather than link to a non-canonical page (blog, third-party tutorial).

1.6 Definition strategy (pick ONE; record why)
- DEFAULT: `defineAbiProtocol()` with one reduced ABI per contract.
- HYBRID: `defineProtocol()` with `...deriveActionsFromAbi(...)` spread into the actions array. Use when one ABI backs many distinct UX surfaces (price feeds, per-asset markets, curated bundles). Reference: `protocols/chainlink.ts`.
- FALLBACK: pure `defineProtocol()`. ONLY when no ABI source exists anywhere. Document the unavailability in the PR.
- ERC-4626 vaults: `defineProtocol()` + `erc4626VaultActions()` (no ABI-driven helper yet).

1.7 Test data scope (do this AFTER 1.6; depends on the action set being final)

**Pattern B protocols (mainnet-only — no testnet deployment) skip this phase entirely.** They omit the `testData` field on `defineProtocol`, do not get seeded workflow rows, and do not produce a `protocol-coverage/<slug>/<chain-name>/coverage.test.ts` runner. The shared coverage engine requires a funded persistent test wallet on the target chain (today, Sepolia only); mainnet has no funded test wallet (and shouldn't — writes cost real money). The calldata `-onchain.test.ts` against real mainnet via the resolver pipeline (Phase 3 Pattern B) is the sole vitest integration check, and Phases 4.8 / 4.9 are N/A. Continue to Phase 2 with TEST_DATA omitted.

**TEST_DATA covers a subset of `contract.addresses`, not the full set.** Populate TEST_DATA only for chains that have a funded persistent test wallet (today, Sepolia only). Other chains in `contract.addresses` are exercised by the calldata `-onchain.test.ts` (which iterates the addresses map) and seen by users via the workflow builder's chain selector, but get no seeded workflows and no coverage runner. Aave V3 is the canonical example: 5 chains in `contract.addresses`, 1 chain in TEST_DATA. Do not force TEST_DATA coverage onto a chain with no funded test wallet — the builder will throw, and even if it didn't, the runner would have no wallet to execute against.

For each chain confirmed in 1.2 that has a funded test wallet:
- Native gas floor. Minimum native balance needed for setup + every write action to land. The shared coverage engine's preflight throws on shortfall; conservative numbers are fine.
- ERC20 holdings. Cumulative across setup + every write action call. Concrete example: Aave V3 Sepolia uses 100 LINK setup supply + 10 LINK per supply test + buffer = 200 LINK floor (see `protocols/aave-v3.ts:23-25`).
- **TOKEN_REGISTRY coverage (gating)**: confirm every symbol the bindings reference already exists in `lib/test-data/chain-test-data.ts` for the chain. **If any entry is missing, ESCALATE: do not extend `chain-test-data.ts` during BUILD.** Surface the missing `(chainId, symbol, address, decimals)` tuples to the user in Phase 2 with verified addresses (from the explorer used for ABI sourcing) and ask for explicit confirmation before any code is written. TOKEN_REGISTRY is shared infra: a wrong decimals or address breaks every protocol that uses that token, not just the one being added.
- Approvals. List `(token, spender, amount)` triples. `spender` is usually `contract("<key>")`; literal addresses are valid but signal a non-protocol approval.
- One-shot protocol prep. If any write action needs state the wallet doesn't start with (Aave: open supply position; Superfluid: wrapped SuperToken balance; Uniswap V3: deployed pool), encode it as `setup.protocolSteps` entries: each is itself a protocol action call with bindings, runs once in `beforeAll`.
- Known on-chain gotchas. Document inline in `TEST_DATA` as comments. Real precedent: Aave V3 Sepolia hits `SUPPLY_CAP_EXCEEDED` (error 51) on DAI / USDC / USDT; LINK is the only borrowable testnet reserve with headroom (see `protocols/aave-v3.ts:13-18`).

For each action exposed:
- Bind every address-typed input. **Unbound address-typed inputs throw at build time** with a remediation message (see `lib/test-data/build-workflow.ts:166`). There is no silent default. Pick one of:
  - Token symbol string (e.g. `"DAI"`): resolves via `TOKEN_REGISTRY[chainId][symbol].address`.
  - `wallet()`: the persistent test user's per-environment Turnkey wallet (the user-self path).
  - `contract("<key>")`: protocol contract address by registry key.
  - Literal `"0x..."`: passed through verbatim.
- Bind every uint-with-decimals via `amount(symbol, human)`. Use `native(human)` for native ETH inputs.
- Literal strings (bool flags, enum codes, `referralCode`, `interestRateMode`) pass through unchanged.
- For actions whose on-chain prerequisite cannot be provisioned in setup (e.g. Superfluid GDA actions that need a pool address that doesn't exist until a write action creates one), list them in `skipped: { "<action-slug>": "<one-line reason>" }`. The seeder still emits these rows for dashboard discoverability; the test runner marks them `test.skip` with the reason visible to the reporter. **Skips are a Phase 2 commit, not a Phase 4 escape hatch.**

If a contract has `userSpecifiedAddress: true` (e.g. Superfluid SuperTokens), bind `contractAddress` as a virtual input on each action that uses it. Real inputs named `contractAddress` are forbidden by the builder (see `lib/test-data/build-workflow.ts:302-310`): rename in the protocol definition if any clash.

PHASE 2 - CONFIRM (gate: do NOT proceed without explicit user approval)

Post a research report to the user containing:
- Protocol: name, **version**, slug, 1-line description. State the version prominently; do not bury it.
- Chains: intersection list with rationale for each inclusion/exclusion.
- Contracts: table of label / function set / source ABI URL / docs URL. All contracts belong to the named version only.
- Definition strategy + why this one fits.
- ABI source(s) per contract, with the version each ABI corresponds to and the exact URL it came from.
- TEST_DATA scope per chain:
  - Setup: `minNativeHuman`, `requiredTokens`, `approvals`, `protocolSteps`.
  - Per-action bindings table (one row per chain if scope diverges between chains).
  - Skip list: action slugs that will be `test.skip` with their reasons.
- TOKEN_REGISTRY changes (REQUIRED whenever any binding references a `(chain, symbol)` not already in `lib/test-data/chain-test-data.ts`): table of new entries where `address` is taken from a block explorer (cite URL) AND `decimals` is confirmed by calling the token contract's `decimals()` view on the target chain (cite the eth_call result). Do not infer decimals from the token symbol or the explorer's metadata field: both are wrong often enough to break every workflow that uses the token (USDC is 6, not 18; some long-tail tokens use 8 or 9). The user is not the authority on decimals — the on-chain call is. If no changes are needed, state "no TOKEN_REGISTRY changes".

WAIT for explicit user confirmation on chains AND contracts AND TEST_DATA scope (setup + per-action bindings + skip list) AND any TOKEN_REGISTRY additions. The skip list and TOKEN_REGISTRY changes must be approved here, not introduced silently in BUILD. If the user redirects on chains, contracts, action scope, or any TOKEN_REGISTRY tuple, loop back to Phase 1 (or 1.7 for TOKEN_REGISTRY) with the adjustment and re-verify on-chain before re-reporting. Do not begin writing code.

Rationale: the chain selector auto-restricts to `Object.keys(contract.addresses)`. Any chain in the map becomes user-selectable in the workflow builder, and any user-selectable chain without a real deployment breaks workflows at runtime. This gate exists to prevent that class of bug.

PHASE 3 - BUILD

Once Phase 2 is confirmed, produce these files. For each, match the structure of the example called out:

- `protocols/{slug}.ts` - protocol definition AND co-located `TEST_DATA: ProtocolTestData` export, passed into `defineProtocol` as `testData: TEST_DATA`. Sentinel helpers imported from `@/lib/test-data/types` (`wallet()`, `amount()`, `contract()`, `native()`). Match the file picked in Phase 1.6 for the definition shape; match `protocols/aave-v3.ts` for the TEST_DATA layout (or `protocols/superfluid.ts` for protocols using userSpecifiedAddress contracts or a skip list).
- `protocols/abis/{slug}.json` (or `{slug}-{contract}.json` if multiple contracts) - reduced ABI(s). Functions plus only the events being exposed. Nothing else.
- `tests/unit/protocol-{slug}.test.ts` - shape and override integrity. Model on `tests/unit/protocol-wrapped.test.ts`. Cover at minimum:
  - Default export imports without throwing; name and slug correct.
  - Protocol slug matches kebab-case regex.
  - All action slugs match kebab-case regex.
  - Every action's `contract` references a defined contract key.
  - No duplicate action slugs (the registry does NOT check this; the unit test is the safety net).
  - Every read action has non-empty `outputs`.
  - Every contract address matches `^0x[0-9a-fA-F]{40}$`.
  - Action count + slugs (shape lock so future edits surface intent changes).
  - Per-action: function name, payable flag, input names/types/labels/helpTip/docUrl, output names/labels/decimals.
  - Chain coverage list - both inclusions AND explicit exclusions (e.g. `expect(chains).not.toContain("10")` for a gap).
  - Registry round-trip: `registerProtocol(def)` then `getProtocol(slug)`.
- `tests/integration/protocol-{slug}-onchain.test.ts` - calldata validation. Pick the pattern by the testnet-contract status from Phase 1.2:
  - **All three patterns share the same RPC pipeline.** Use `parseRpcConfig(process.env.CHAIN_RPC_CONFIG)` + `createRpcUrlResolver(...)` from `@/lib/rpc/rpc-config`, then `getRpcProviderFromUrls` + `executeWithFailover` from `@/lib/rpc/provider-factory`. Resolution order per chain: `CHAIN_RPC_CONFIG` JSON (CI + deployed envs) -> `CHAIN_<NETWORK>_PRIMARY_RPC` / `CHAIN_<NETWORK>_FALLBACK_RPC` env vars (dev override) -> `PUBLIC_RPCS.<NETWORK>` last-resort fallback. **All three are ungated** — the public RPC backs every tier so the test always runs; CI overrides with paid staging endpoints via `CHAIN_RPC_CONFIG`. **The patterns differ only in chain footprint**, not in RPC routing or vitest setup: A pins to a single testnet, B pins to a single mainnet (no testnet deployment exists), C iterates the protocol's full chain set. Pick by Phase 1.2's testnet-contract status, not by which RPC you have.
  - **Pattern A - single testnet** (Sepolia, Base Sepolia, etc.): model on `tests/integration/protocol-wrapped-onchain.test.ts`. Prefer Sepolia when both Sepolia and another testnet are available.
  - **Pattern B - single mainnet** (no testnet contract exists): model on `tests/integration/protocol-aave-v4-onchain.test.ts`. Read-only against real Ethereum mainnet via the resolver pipeline (`provider.call` / `estimateGas` only, never a real broadcast — so no real ETH is ever spent). The public mainnet RPC is fine for read-only calldata validation. If the protocol additionally needs a write-broadcast smoke test (e.g. Frax Ether V2's `mintFrxEth(1 ETH)` that asserts the 1:1 mint), produce the optional fork-test artefacts described below in this Phase 3 section (the `scripts/{slug}-fork-test.ts` script targeting an anvil mainnet fork at `http://localhost:8545`, plus the docs "Testing Without Risking Real ETH" section). The fork-test script is an ADD-ON for write verification, not a replacement for the calldata `-onchain.test.ts`.
  - **Pattern C - multi-chain**: model on `tests/integration/protocol-uniswap-onchain.test.ts`. Iterates the protocol's full chain set instead of pinning to one. Use when the protocol is deployed across many chains and you want calldata coverage on each (the resolver picks per-chain primaries/fallbacks from `CHAIN_RPC_CONFIG`).
  - All patterns require: `vi.mock("server-only", () => ({}));` at the top. One test per exposed action: reads decode the return type; writes call `estimateGas` or `provider.call` and accept `CALL_EXCEPTION` (business revert) while rejecting ABI errors (see Phase 4).
- `tests/e2e/vitest/protocol-coverage/{slug}/<chain-name>/coverage.test.ts` PER CHAIN in `TEST_DATA` (**Pattern A and C only**; Pattern B protocols skip this artefact, see Phase 1.7) - end-to-end execution via the shared coverage engine (KEEP-458). Model on `tests/e2e/vitest/protocol-coverage/aave-v3/sepolia/coverage.test.ts`. Gated by the project's standard e2e convention: `describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true")`. The test posts workflows to a running keeperhub server's webhook endpoint at `PROTOCOL_E2E_BASE_URL` (default `http://localhost:3000`) and polls `workflow_executions` rows; RPC traffic is the server's responsibility via `CHAIN_RPC_CONFIG`, not the test's. Discoverable by `vitest:e2e` via the `tests/e2e/vitest/**` glob. The shared `_shared/setup.ts` handles preflight (native gas, ERC20 balances), runs the setup workflow once in `beforeAll`, then `runPhaseFixtures` executes read+write actions with Manual triggers only (the webhook-fired execution path ignores trigger config, so the 5 trigger variants give no test signal at execution time). For Pattern A and C, this test is MANDATORY alongside the calldata `-onchain.test.ts`: they catch different classes of regression (calldata shape vs end-to-end execution).
- `lib/test-data/chain-test-data.ts` - extend ONLY with the `(chain, token)` entries explicitly confirmed in Phase 2. Each new entry needs `address`, `decimals`, `symbol`. Do NOT add entries silently in BUILD: TOKEN_REGISTRY is shared infra and a wrong entry (e.g. USDC at 18 decimals instead of 6) breaks every protocol that uses that token, not just the one being added.
- `docs/plugins/{slug}.md` - public docs page with actions table and per-action sections. For **Pattern B** protocols, MUST include a `## Why no testnet entry in the plugin` subsection that names the testnets checked (with evidence the protocol is not on them) so future maintainers don't try to "add Sepolia" again. **Additionally**, for Pattern B protocols that produce a fork-test script (write-broadcast verification), include a `## Testing Without Risking Real ETH` section documenting: (a) how to start anvil via the Foundry Docker image with `--fork-url <YOUR_MAINNET_RPC_URL>` on port 8545, (b) how to run the fork-test script with `pnpm tsx scripts/{slug}-fork-test.ts`, (c) how to point the local dev server at the fork via `CHAIN_ETH_MAINNET_PRIMARY_RPC=http://localhost:8545 pnpm dev`. Model on the section in `docs/plugins/frax-ether-v2.md`. Pattern B protocols without write-broadcast needs (e.g. aave-v4) omit the "Testing Without Risking Real ETH" section.
- `docs/plugins/_meta.ts` - add nav entry.
- `docs/plugins/overview.md` - add to protocols table.
- `public/protocols/{slug}.png` - icon (REQUIRED). Pull the PNG from the source identified in Phase 1.1. Match the rough dimensions of existing icons in `public/protocols/` (typical: 256x256 or 512x512, transparent background, square). Placeholder, AI-generated, or default-icon fallbacks are not acceptable - if no real logo can be obtained from the protocol's official sources, treat as a bail-out and surface to the user.
- **Pattern B with write-broadcast verification only** (optional): `scripts/{slug}-fork-test.ts` - TypeScript smoke test, run via `pnpm tsx`. Uses one of anvil's pre-funded test accounts to broadcast a real call against the forked bytecode (e.g. for Frax Ether V2 the smoke test calls `mintFrxEth()` with 1 ETH and asserts the 1:1 frxETH mint). Prints `PASS`/`FAIL` so the smoke test is runnable independently of vitest. Model on `scripts/frax-ether-v2-fork-test.ts`. Omit this artefact when the protocol's writes can be verified via `provider.call` / `estimateGas` against real mainnet (the aave-v4 case).

Auto-generated (do NOT hand-edit):
- `protocols/index.ts` - regenerated by `pnpm discover-plugins`.
- `lib/types/integration.ts` - slug appended by discover-plugins.

User-visible string formatting (HARD RULE):
- `description`, `label`, and `helpTip` strings on the protocol, actions, inputs, and outputs MUST NOT contain em dashes or double-hyphens (`--`). Use periods, colons, semicolons, or restructure the sentence. Hyphens inside compound words (e.g. `pro-rata`, `wei/sec`, `CFA+GDA`) are fine; the rule is specifically about the dash-as-clause-separator pattern.
- Applies equally to the docs/plugins/{slug}.md page.

PHASE 4 - VERIFY

Run in order. Do NOT advance past a failing step. Re-run the FULL sequence after every fix (do not assume earlier passes still pass).

4.1 `public/protocols/{slug}.png` exists at the path the plugin's `icon` field references. Visual sanity check: the file is a real protocol logo, not a placeholder or default-icon stand-in.
4.2 `pnpm discover-plugins` exits 0 and registers the protocol (check stdout includes the new slug; check `protocols/index.ts` was regenerated).
4.3 `pnpm check` passes.
4.4 `pnpm type-check` passes.
4.5 `pnpm test tests/unit/protocol-{slug}.test.ts` passes (shape lock).
4.6 `pnpm test tests/unit/build-workflow.test.ts` passes - the registry walker resolves every binding in the new `TEST_DATA` without throwing.
4.7 `pnpm test tests/integration/protocol-{slug}-onchain.test.ts` passes (calldata validation). Patterns A, B, and C are all ungated and resolve RPC via `CHAIN_RPC_CONFIG` -> per-chain env var -> public RPC fallback. No env vars are required to run locally. For CI runs the deployment sets `CHAIN_RPC_CONFIG` to paid staging endpoints; nothing additional is needed here. **If the test reports skips for reasons other than the resolver pipeline failing, treat as a failure and investigate** — under this design there should be no skipped sub-tests.
4.7a (Pattern B only, AND only if a fork-test script was produced) `pnpm tsx scripts/{slug}-fork-test.ts` against a local anvil fork: start anvil per the docs page Docker command, then run the script and assert PASS. The script is for verifying real write broadcasts (e.g. `mintFrxEth`); it is independent of the vitest calldata test in 4.7. If the protocol does not need write-broadcast verification, this step does not apply.
4.8 (**Pattern A and C only — N/A for Pattern B**) `pnpm tsx scripts/seed/seed-protocol-workflows.ts --protocol={slug}` against a local DB (run `pnpm db:seed-test-wallet` first if needed):
  - First run: `N inserted, 0 refreshed, 0 skipped, 0 failed` where N = (setup rows + actions * 5 triggers) summed across chains in `TEST_DATA`.
  - Immediate re-run with no edits: `0 inserted, N refreshed, 0 skipped, 0 failed` (idempotency check).
4.9 (**Pattern A and C only — N/A for Pattern B**) `pnpm test:protocol` (or `vitest run tests/e2e/vitest/protocol-coverage/{slug}` to scope to one protocol). Preconditions: a running keeperhub server, `DATABASE_URL` set, `SKIP_INFRA_TESTS` unset or `false`, a Turnkey-provisioned persistent test wallet in `organization_wallets`, and `PROTOCOL_E2E_BASE_URL` pointing at the server (default `http://localhost:3000`). The server's `CHAIN_RPC_CONFIG` resolves the actual RPC; the test code never reads RPC URLs directly. If `DATABASE_URL` is unset or `SKIP_INFRA_TESTS` is true, the suite skips — that is NOT pass; the Orchestrator must stand the server up before declaring DONE. For Pattern B protocols, no `TEST_DATA` means no seeded workflows and no coverage runner; the calldata test at 4.7 is the sole integration check.

When a check fails, classify and resolve:
- Lint / type / shape failure -> patch the source file or the unit test, depending on which is wrong. Tests encode intent; if the intent was wrong, update both.
- Integration test ABI errors (`INVALID_ARGUMENT`, `BAD_DATA`, `BUFFER_OVERRUN`, `"could not decode"`, `"invalid function"`) -> the reduced ABI does NOT match the deployed bytecode. Fix the ABI. Do NOT loosen the test.
- Calldata-test (`-onchain.test.ts`) `CALL_EXCEPTION` on a write action -> ACCEPT. A business revert (zero allowance, nonexistent reserve, missing approval) still proves the bytecode parsed the calldata. Document the revert in a comment if it is non-obvious.
- Calldata-test (`-onchain.test.ts`) `CALL_EXCEPTION` on a read action -> investigate. Reads should not revert unless the calldata is wrong (e.g. calling `balanceOf` on a non-token). Coverage-test read failures surface as failed workflow-step executions in the seeded workflow, not as test-level `CALL_EXCEPTION`; classify those via the step's runtime error rather than this bullet.
- Builder throws "address-typed input ... has no binding and no protocol-level default" -> bind the input in `TEST_DATA`. The message names the protocol/action/input; fix at the binding, not by adding a literal default in the protocol file.
- Builder throws "TOKEN_REGISTRY missing <symbol> on chain <id>" -> the binding references an entry not in Phase 2 scope. Loop back to Phase 2 with the missing tuple `(chain, symbol, address, decimals)` for explicit user confirmation. Do NOT silently add the entry in BUILD.
- Coverage-test setup-phase revert (in `runSetup`, on `approve-token` or a `protocolSteps` action) -> on-chain prereq not met. Common causes: faucet exhausted, supply cap reached on this asset, reserve paused, missing role. Audit `setup.requiredTokens` and the Phase 1.7 gotchas list. Do NOT relax the test.
- Coverage-test "skipped" rows in the vitest reporter for actions NOT listed in `skipped: {}` -> the runner only skips what the SSOT marks. Treat unexpected skips as failure and investigate (usually a `beforeAll` throw the harness converted to skip).
- Seeder reports `failed > 0` -> read the per-row error in stdout. Common cause: an input the registry doesn't know about (re-run `pnpm discover-plugins`).

Loop back to PHASE 3 with the specific failure as the problem to solve. Do not declare DONE until all checks pass cleanly.

PHASE 5 - EXIT

Once Phase 4 passes:
- Summarise: protocol slug, contracts, chains, action count, definition strategy used, TEST_DATA scope (per-chain setup, action-bindings count, skip count), seeded row count, coverage-test pass count per chain, any TOKEN_REGISTRY additions.
- Draft PR title and body, conventional commit format (e.g. `feat: KEEP-XXX add <Protocol> protocol plugin`). Branch `feat/KEEP-XXXX-add-{slug}` if a Linear ticket is set; else `feat/add-{slug}-protocol`.
- DO NOT create the PR. User confirmation is required per CLAUDE.md ("Do not git push or create GitHub PRs without user's confirmation").

BAIL-OUT CONDITIONS (stop the loop and surface to user):
- The same integration test failure recurs across 3 consecutive iterations.
- Research surfaces a chain / contract requirement that conflicts with the Phase 2 confirmation - re-confirm before proceeding.
- No ABI source can be obtained from any explorer, npm package, GitHub repo, or official docs - escalate; do not invent ABI fragments.
- **Version ambiguity**: $ARGUMENTS does not uniquely identify a version (e.g. just `"Aave"` when V3 and V4 are both live), OR research surfaces a candidate ABI / contract whose version cannot be confirmed. Surface the available versions to the user and wait for disambiguation. Do not pick a default.
- **No real logo can be obtained** from the protocol's official sources (brand page, GitHub assets, npm package, scraped favicon). Do NOT generate a placeholder. Surface the candidate URLs to the user so they can drop a PNG at `public/protocols/{slug}.png` directly.
- **Pattern B fork-test script produced but anvil cannot be run** locally (Docker is unavailable, the Foundry image cannot be pulled, port 8545 is occupied). The write-broadcast verification cannot run. The calldata `-onchain.test.ts` (4.7) is unaffected and still runs against real mainnet via the resolver pipeline; only the optional fork-test step (4.7a) is blocked. Surface to the user.

On bail-out, surface to the user:
- Current state of all generated files.
- The specific failure that blocked progress (full error text, not a summary).
- A concrete question to unblock (not "what should I do?", but e.g. "Pendle's `redeemPY` returns a struct with a `bytes32` field that decodes as a malformed tuple - should I expose this as a single struct field or flatten with named field overrides?").
```

The Orchestrator handles: web search, decomposing subtasks, delegating to Researcher / Builder / Verifier agents, running the iteration loop, and drafting the PR.
</process>

<success_criteria>
- Protocol logo committed at `public/protocols/{slug}.png` (real logo from an official source; no placeholders).
- Calldata integration tests at `tests/integration/protocol-{slug}-onchain.test.ts` pass via the shared `CHAIN_RPC_CONFIG` resolver pipeline (Patterns A, B, C all ungated; public RPC fallback ensures the test runs even without env vars).
- Coverage tests at `tests/e2e/vitest/protocol-coverage/{slug}/<chain-name>/coverage.test.ts` pass per chain in `TEST_DATA` against a running keeperhub server with `DATABASE_URL` set and `SKIP_INFRA_TESTS` unset (skipped is NOT pass). **Pattern A and C only**; Pattern B has no `TEST_DATA` and no coverage runner (see Phase 1.7).
- For Pattern B protocols: `docs/plugins/{slug}.md` includes a `## Why no testnet entry in the plugin` subsection. For Pattern B protocols that additionally need write-broadcast verification: `scripts/{slug}-fork-test.ts` exists and exits PASS against an anvil fork, AND the docs page includes a `## Testing Without Risking Real ETH` section.
- Unit tests at `tests/unit/protocol-{slug}.test.ts` pass.
- `pnpm test tests/unit/build-workflow.test.ts` passes.
- `pnpm tsx scripts/seed/seed-protocol-workflows.ts --protocol={slug}` is idempotent (first run inserts, immediate re-run refreshes, neither reports failures). **Pattern A and C only**; Pattern B has no seeded workflows.
- `pnpm check`, `pnpm type-check`, `pnpm discover-plugins` all exit 0.
- Chain, contract scope, TEST_DATA scope (setup + per-action bindings + skip list), and any TOKEN_REGISTRY additions were explicitly confirmed by the user in Phase 2 before any code was written. No fabricated chain entries in `contract.addresses`; no silent TOKEN_REGISTRY edits.
- Definition strategy is justified in the PR description (which of defineAbiProtocol / hybrid / fallback was used and why).
- Input docUrls populated for every input where a canonical per-page docs URL exists; absences noted in the PR.
- PR drafted but not created; user confirmation required to push and open.
</success_criteria>
