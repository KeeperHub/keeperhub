# Protocol Coverage Suite: Methodology and Limits

Status: living document. Covers `tests/e2e/vitest/protocol-coverage/`
(KEEP-458 originally, hardened under KEEP-590).

## What the suite is

A per-action execution suite for protocol registry actions. For each
`(protocol, chain)` with a `coverage.test.ts`, the runner iterates every
registered action of a phase (`read`, then `write`), builds a two-node
webhook-triggered workflow for it (`buildActionWorkflow`), inserts it for
the persistent test user, fires it over the real webhook endpoint, and
polls `workflow_executions` for a terminal status.

Enumeration is registry-driven: a newly added action is covered by
default. Excluding one requires a `skipped` entry with a written reason,
which the vitest reporter surfaces on every run.

## Assertion layers

1. Liveness (always): the execution reaches `status === "success"`.
   Because the executor flips the workflow to `error` when any step throws
   or returns `{success:false}`, and writes run a staticCall preflight,
   broadcast for real, and wait for the receipt (with an explicit
   `receipt.status === 0` guard in `confirmTransaction`), a green write
   proves a real signed transaction mined without reverting.
2. Output oracle (per-action, declared in testData `expectations`): after
   success, the runner loads the action node's recorded output from
   `workflow_execution_logs` (`output_raw`) and checks declarative
   assertions against `result`. See `OutputExpectation` in
   `lib/test-data/types.ts` and `_shared/oracle.ts`. Without an
   expectation entry, a read passes on any non-throwing call regardless of
   the value returned - expectations exist to close exactly that gap.

Expectation semantics: `field` is a dot-path into the structured result
(`structureAbiOutputs` keys multi-output and named-single-output reads by
ABI output name; unnamed single outputs are the bare value). Predicates:
`nonZero`, `notEmpty`, `equals`; every expectation implies existence.

Rules for writing expectations:

- Assert only values the suite provisions itself (positions opened by the
  setup workflow) or long-lived chain invariants (an exchange rate, a
  Safe's threshold).
- All suites share one Turnkey test wallet and vitest runs suite files
  concurrently. Do not assert values another suite can move (shared token
  balances). This is also why there is no balance-delta oracle for writes:
  deltas on a shared wallet are nondeterministic by design here, and the
  receipt-level guarantees already prove the write executed on-chain.
- On a long-lived local fork, state accumulates across runs. Do not
  assert values that depend on run history (see rocket-pool `balance-of`).

## Environments

- Ethereum mainnet suites run against a local anvil fork (chain 1 is in
  `FORK_CHAIN_IDS`); funding is `anvil_setBalance` plus whale
  impersonation (`FORK_WHALES`). No live mainnet is ever touched.
- No suite targets Sepolia anymore: chronicle and superfluid were
  re-homed to the mainnet fork (their live feeds/forwarders are
  canonical there), and the Safe roles orchestrator fork tests moved
  with them, so CI runs a single anvil fork. The orphaned aave-v3
  Sepolia testData remains and is reachable only through the local
  Tier 1 sim path (`scripts/protocol-local.sh sim sepolia`).
- Base (ajna) is live Base mainnet, reads only; every write is skipped and
  the gas preflight short-circuits, so no real ETH is spent.
- Tier 1 also sweeps L2 forks: Base (8453) and Arbitrum One (42161) run as
  anvil forks of a public upstream, gated on `PROTOCOL_SIM_RPC_8453` /
  `PROTOCOL_SIM_RPC_42161`. Simulations read forked state and never mine
  against the upstream, so a public endpoint suffices (no archive node),
  unlike the mainnet pinned fork. `chains.test.ts` iterates these chains
  and self-skips any whose RPC env is absent. Covered protocols: chainlink
  price-feed reads on both chains (ajna's Base reads run here too). The CI
  `tier1-simulations-l2` job runs one matrix leg per chain, in parallel
  with the chain-1 `tier1-simulations` job, each with its own executed-test
  floor (`scripts/protocol-coverage-floor.ts`). Locally:
  `scripts/protocol-local.sh sim base` / `sim arbitrum` (or bare `sim` for
  all chains) starts the fork and runs the sweep. `coverage:report` emits a
  per-chain row for 8453 and 42161 from each protocol's testData.
- Payable actions bind the virtual `ethValue` key (plain ETH string), and
  userSpecifiedAddress contracts bind the virtual `contractAddress` key.
- Fork-only privileged provisioning: a protocol whose fixtures need a
  third party's on-chain authority (chronicle's toll-gated mainnet
  feeds; no SelfKisser exists there) declares
  `setup.forkImpersonatedCalls` - the preflights fund and impersonate
  the privileged account (an authed ward) and run the declared call
  (kiss the test wallet) before provisioning. Shared by the Tier 1
  harness and the Tier 2 setup preflight; declaring it on a non-fork
  chain fails loudly.
- Fork-only state fabrication (KEEP-940,
  `_shared/fabricate-state.ts`): preconditions the setup phase can
  neither buy nor sequence are written into contract storage with
  anvil_setStorageAt. Two mechanisms, both slot-probing (candidate
  mapping slots are computed from the holder address and ascending
  indices in Solidity and Vyper layouts, each write is verified against
  the contract's own view function, and failed candidates are restored):
  ERC20 balances with no whale or faucet (`ensureErc20Acquired` falls
  back to `fabricateErc20Balance` - used for USDS, whose registered PSM
  whale drained; USDe; MKR; WETH); setup allowances
  (`setup.fabricatedApprovals` -> `fabricateErc20Allowance`, run by both
  tiers' preflight instead of emitting approve-token setup nodes, because
  that node's gas-sponsorship-fallback path takes minutes per approval on
  the CI fork and blows the 300s setup timeout); and per-action
  `fabrications` in testData (ethena's unstake declares
  `elapsed-cooldown`, which rewrites the timestamp of the wallet's real
  sUSDe cooldown while preserving the escrowed amount, so the claim moves
  genuinely silo-funded USDe).
  Derived accounting defeats balance fabrication by design - stETH's
  share-computed balanceOf fails the probe loudly, which is why lido's
  wrap/unwrap stay skipped pending a whale entry.
- Pinned-block fixtures: a protocol whose live bindings rot on a
  schedule (pendle - markets expire) declares `testData.pinnedBlock`;
  the Tier 1 harness runs it on a dedicated fork at that block instead
  of the shared near-head fork. See "Pendle pinned-block fixtures"
  below.

Fork RPC fetch cache: a pinned anvil fork persists every upstream fetch
(accounts, storage slots, block hashes - eth_call reads included) to its
on-disk cache, and a fresh fork started with that cache mounted at the
same pin serves all of it locally while staying pristine - the cache
holds upstream fetches, never local mutations, so the sweep re-runs
cleanly on top. The nightly `fork-cache-mainnet` job warms and publishes
this cache; the tier1 CI job consumes it, and
`scripts/protocol-local.sh` (`snapshot` subcommand,
`MAINNET_FORK_CACHE_DIR` / `SEPOLIA_FORK_CACHE_DIR`) produces and
consumes it locally. The upstream is still required at fork startup
(chain id, block env) and by the mining loop (block hashes), so the
cache removes hot-path state reads without replacing the upstream -
CI consumption is gated on `ANVIL_FORK_MAINNET_URL` for exactly that
reason. A note on the "archive" shorthand these docs use: the actual
requirement is an upstream that serves state at the fork's pinned
block. Public providers prune to a short recency window (which is what
bounds an unpinned public-upstream fork to ~15 minutes of health), so
in practice the pinned/day-old-cache flows need an archive-grade
endpoint, but any node that retains state for the pin works; full
history is not the requirement. Naming is aligned on one token, `mainnet`: the
artifact (`fork-cache-mainnet`), the tar
(`fork-cache-mainnet-<block>.tgz`), the cache dir (`mainnet-<block>/`),
and the env var (`MAINNET_FORK_CACHE_DIR`). That coupling is
load-bearing - the tier1 download step locates the tar by the exact
`fork-cache-mainnet-*.tgz` pattern the nightly packaging step writes,
so the two must change together.

## Event-trigger decode coverage

The registry declares protocol events consumed by the Event trigger. The
Tier 2 runner fires workflows over the webhook endpoint, which bypasses
trigger config, so event decoding otherwise has zero execution coverage.
The Tier 1 event harness
(`tests/e2e/vitest/protocol-simulation/events.test.ts` +
`_shared/simulate-events.ts`) closes that gap: for each registered event it
emits a real, impersonated transaction on the fork, then asserts the
registry's own event ABI fragment (`buildEventAbiFragment`, the exact
artifact the Event trigger stores as `contractABI`) decodes the emitted log
into the shape the trigger layer consumes - `eventName` plus every declared
input surfacing as a named, bigint-serializable arg (mirrors
`plugins/web3/steps/query-events.ts` `decodeEventArgs` and
`lib/workflow/editor/trigger-output-fields.ts`). A pass proves the registry
event definition (name, param types, indexed flags) matches the real
on-chain event.

Enumeration is registry-driven, like actions: a protocol opts into event
simulation on one chain by declaring an `events` block in its
`testData[chain]`; `events.skipped` (keyed by event slug) documents events
that cannot be emitted on the fork, each with a reason naming the real
constraint. Emitters reuse existing write fixtures where one already emits
the event (a rETH deposit emits `DepositReceived` and `TokensMinted`) and
fall back to targeted calls otherwise (a `stETH.submit` for `Submitted`; a
throwaway 1-of-1 Safe driven through its state-changing calls with an
approved-hash signature - no ECDSA key or EIP-712 hash needed - for the Safe
events). Coverage is counted by `pnpm coverage:report` from the same opt-in
maps, so it cannot drift from what the harness runs.

Pinned protocols route the same way as the action harness: a protocol whose
testData declares a `pinnedBlock` (pendle) is emitted on the dedicated pinned
fork (`PROTOCOL_SIM_RPC_<chainId>_PINNED`) and excluded from the near-head
fork, mirroring `chains.test.ts`.

Documented skips at first landing (18 of 31). Aerodrome's 7 are Base-only and
the tier1 CI job forks Ethereum mainnet (chain 1) only, so they have no
simulated chain. Rocket-pool's `TokensBurned` needs redeemable rETH
collateral the deposit pool can lack. Safe's `SignMsg` (SignMessageLib
delegatecall) and `ExecutionFailure` (needs a nonzero `safeTxGas`/gas-refund
path) are unreachable from the harness's happy-path self-calls. Pendle's 8:
its market (`market-swap/mint/burn`, `update-implied-rate`) and reward
(`redeem-rewards/interest`) events fire on operations pendle's testData binds
no write action for, so no fixture emits them; its `yt-mint`/`yt-burn` are
emittable via the pinned-fork `mint-py-from-sy`/`redeem-py-to-sy` fixtures,
but the event harness runs lightweight self-contained emitters and does not
yet perform pendle's pinned-fork setup provisioning (whale-funded SY plus
router approvals) - deferred follow-up.

## Pendle pinned-block fixtures (and the refresh procedure)

Pendle was deferred during the tiered-coverage work because its markets
expire: any hardcoded market/PT/YT binding rots on the market's
schedule, unlike yearn/morpho vaults, which are long-lived. The fix is
to bind against state recorded at a pinned mainnet block and run the
Tier 1 sweep for pendle on a dedicated fork at that block, so the
bindings stay verifiable regardless of wall clock (the fork's clock
starts at the pin's timestamp and never reaches the market's expiry).
The fixture is refreshed deliberately instead of rotting silently.

Mechanism: `testData.pinnedBlock` (lib/test-data/types.ts) marks a
(protocol, chain) as pinned. `chains.test.ts` routes pinned protocols to
`PROTOCOL_SIM_RPC_<chainId>_PINNED` (a fork at the pin) and excludes
them from the shared near-head fork; the rig
(`scripts/protocol-local.sh sim`) and the tier1 CI job start that fork
with the block printed by `scripts/protocol-pinned-block.ts`, which
resolves it from the registry - so the pin has exactly one source of
truth and a refresh touches only the protocol's testData (plus the
token entries and Tier 0 goldens below). A fixed pin needs an upstream
that serves historical state, so the pinned fork starts only when
`ANVIL_FORK_MAINNET_URL` is set; without it the pinned protocols
self-skip.

Recorded fixture (2026-07-08, block 25487331):

| Field | Value | How obtained |
|---|---|---|
| Pinned block | 25487331 | mainnet head minus a small margin at recording time |
| Market | `0x34280882267ffa6383B363E278B027Be083bBe3b` | Pendle active-markets API (`api-v2.pendle.finance/core/v1/1/markets/active`): the mature wstETH market - highest-liquidity market with the most distant expiry (2027-12-30) |
| SY / PT / YT | `0xcbC7...C0BC` / `0xb253...5a2c` / `0x04B7...3a95` | `readTokens()` (`0x2c8ce6bc`) via eth_call on the market at the pin |
| Expiry | 1830124800 (2027-12-30T00:00:00Z) | `expiry()` on the market at the pin; `isExpired()` = false |
| Underlying | wstETH `0x7f39...2Ca0` | market API `underlyingAsset`; matches TOKEN_REGISTRY WSTETH |
| SY whale | the market itself (held ~1306 SY at the pin) | `balanceOf(market)` on the SY at the pin |

Every address had code at the pin (eth_getCode) and SY/PT/YT report 18
decimals. The write path was verified routable on the router diamond:
`mintPyFromSy`/`redeemPyToSy` eth_calls revert with an ERC20 allowance
error (facet reached), where an unknown selector reverts
`INVALID_SELECTOR`.

The same bindings also serve the Tier 2 coverage suite, which runs on
the shared near-head fork - correct there as long as the market has not
expired in real time. The Tier 1 pinned fork stays deterministic past
expiry, but refresh before the recorded expiry keeps both tiers honest.

Refresh when any of: the recorded market's expiry is inside ~3 months;
the archive upstream stops serving the pin; or a better (higher-TVL,
more distant expiry) market should take over. Procedure:

1. Pick the new market from the active-markets API: mature, high
   liquidity, most distant expiry (maximizes fixture lifetime).
2. Pick a fresh pin a few blocks behind mainnet head, then verify at
   that pin via eth_call: `readTokens()` for SY/PT/YT, `expiry()` >
   now + a comfortable margin, `isExpired()` = false, `decimals()` on
   SY/PT/YT, eth_getCode on every address, and the SY balance of the
   market (the whale) covers `requiredTokens` many times over.
3. Update `protocols/pendle.ts`: the fixture constants
   (`MAINNET_PINNED_BLOCK`, market/SY/PT/YT, expiry) and the recording
   date in the comment.
4. Update `lib/test-data/chain-test-data.ts`: the SY/PT/YT
   `TOKEN_REGISTRY` entries and the SY `FORK_WHALES` entry.
5. Regenerate Tier 0 goldens:
   `UPDATE_GOLDENS=1 pnpm vitest run tests/unit/protocol-calldata.test.ts`.
6. Verify on the rig:
   `ANVIL_FORK_MAINNET_URL=<archive> scripts/protocol-local.sh sim ethereum`
   (the pendle suite must execute, not self-skip).

## Gating and the vacuous-pass hazard

Every suite self-skips when `DATABASE_URL`, `ANVIL_FORK_MAINNET_URL`
(mainnet suites), or `TESTNET_FUNDER_PK` (live-chain suites) is absent, or
when `SKIP_INFRA_TESTS=true`. A green `pnpm test:protocol` therefore does
not by itself mean anything executed; CI must run with the secrets
provisioned and should alarm on the executed-test count, not just the exit
code.

## Known limits (intentional, revisit when scope changes)

- Trigger *dispatch* is not tested. The runner fires workflows via webhook,
  which ignores trigger config; Schedule/Event trigger polling and
  dispatch behavior needs its own harness. Seeded trigger-variant workflows
  are dashboard fixtures, not test signal. The Event trigger's log-*decode*
  path is now covered at Tier 1 (see "Event-trigger decode coverage"): each
  registered event is emitted on the fork and the registry event ABI is
  asserted to decode the real log into the trigger-layer shape. What remains
  uncovered is the poll-and-fire loop that consumes that decoded shape.
- Partial multi-chain coverage. Tier 1 now sweeps Base and Arbitrum One
  forks, but only for protocols with L2 testData (chainlink price feeds on
  both; ajna reads on Base). Most protocols with declared L2 contract
  addresses (aave-v3, uniswap-v3, pendle, sky, etc.) still lack L2 testData
  and are exercised on the mainnet fork only. Extending them needs per-chain
  `FORK_WHALES`/`FAUCETS` before write fixtures with `requiredTokens` can
  run on those chains (read-only additions need neither).
- Actions with unmet on-chain prerequisites (vault/pool addresses, open
  auctions, cooldowns) are skipped with reasons. Skip reasons must name
  the real constraint - "payable" was wrong for frax/rocket-pool (the
  harness supports `ethValue`) and those are now exercised.
- Reads without an expectations entry remain liveness-only.

## Adding a new protocol/chain suite

1. Ensure the protocol's `TEST_DATA` has the chain: `setup` (gas floor,
   required tokens, approvals, optional protocol steps), `actions` input
   bindings, `skipped` reasons, `expectations` for reads.
2. For mainnet-fork tokens, add `TOKEN_REGISTRY` and `FORK_WHALES` entries
   in `lib/test-data/chain-test-data.ts`; for testnets add `FAUCETS`.
3. Copy an existing `coverage.test.ts` (lido for fork-gated mainnet,
   ajna for funder-gated live chains) and change the constants.
4. Verify third-party state assumptions empirically (eth_call) and record
   the date in a comment, as done in `protocols/safe.ts` and
   `protocols/aave-v3.ts`.

## Output-to-binding piping (fromSetupOutput)

Some actions can only run against an address the setup phase itself creates:
the four Superfluid GDA pool actions (update-member-units, distribute,
distribute-flow, connect-pool) need the pool address that create-pool
deploys. A static literal cannot supply it, so those actions were documented
skips.

The fixture layer resolves this with a capture binding. Instead of a literal,
an input binds `fromSetupOutput("create-pool", "pool")` - naming a producing
step and a field of its output. The producing action declares a matching
`captures` entry in its chain testData, and the harness records that field
into a per-run `SetupOutputs` context (`step -> field -> value`) that the
workflow builder consumes at call time (`lib/test-data/types.ts`,
`resolveBinding` in `lib/test-data/build-workflow.ts`).

The two tiers populate the context differently:

- **Fork simulation (Tier 1)** has no database. `captures` runs after setup
  provisioning and before the action sweep. The only kind today is
  `"gda-pool"`: eth_call create-pool's own calldata and decode its
  `(bool success, address pool)` return to predict the pool the create-pool
  action will deploy. The prediction holds because the pool address is a
  function of the GDA deployer nonce only and no other pool is created
  between the capture and the create-pool action (registry order runs the
  CFA writes first). The captured pool then resolves the GDA actions'
  fromSetupOutput bindings, so they execute against the real pool.
- **App coverage (Tier 2)** would record setup-step outputs the same way the
  output oracle reads them (`workflow_execution_logs.output_raw`, via
  `fetchNodeOutput`). That works for a read whose structured `result` carries
  the value, but not for create-pool: the executor's write step returns
  `result: undefined` with no logs, so the deployed pool address is not
  queryable from a write's recorded output today. Surfacing it (decoding the
  PoolCreated log, or a query-events step chained in setup) is an executor
  change tracked separately. Until then the four GDA actions stay in
  `skippedCoverage` - skipped by the app suite, run by the fork sweep - while
  create-pool and grant-flow-operator themselves run in both tiers.

`skippedCoverage` is the tier split: unlike `skipped` (both tiers), it skips
only the app coverage runner and the report, leaving the fork sweep to run
the action. A skipped/skippedCoverage action still builds (for the seeder and
the golden-calldata tests); when its capture is absent the builder substitutes
the same unused address placeholder an unbound address input gets, so those
build paths do not need a live capture.

## Validating workflow changes locally (act + rig)

Division of labor when touching the CI workflows:

- The rig (`scripts/protocol-local.sh`) validates step logic: run the
  exact command sequence a step executes (e.g. the vitest+floor pair)
  against the local stack before pushing.
- `act` validates workflow structure and wiring: parse, job graph,
  reusable-workflow resolution, gate conditions, and that jobs launch
  with their service containers. Recipe:

  ```
  act pull_request -W .github/workflows/ci-pipeline.yml \
    -e <event.json with the run-e2e-tests-ephemeral label> \
    --var ENABLE_E2E_EPHEMERAL_TESTS=true \
    [-n for dry-run | -j <job> to execute one job]
  ```

  Known boundaries: dry-run cannot traverse jobs whose `if:` reads
  another job's outputs (dry steps produce none); executing jobs that
  use artifact actions needs a runner image with node
  (`-P ubuntu-latest=catthehacker/ubuntu:act-latest`); service ports
  bind on the host, so local containers holding 5432 collide with the
  postgres service.

## Measured progress

Numbers come from `pnpm coverage:report` (the same planPhaseFixtures the
runner uses, so they cannot drift from what actually registers). One row
per landed phase of the local-first coverage plan; wall-clock times are
timed local runs unless marked CI.

| Date | Milestone | Runnable | Skipped | Value-asserted | Executing in CI | Feedback loop |
|---|---|---|---|---|---|---|
| 2026-07-02 | Baseline (post suite-hardening PR) | 232 of 394 (19 protocol-chains; 16 behind the hard-skipped chronicle suite, 7 in orphaned aave-v3 Sepolia testData) | 117 | 8 actions | ~35 (mainnet fork secret unprovisioned; chronicle hard-skipped) | 30-35 min per CI round |
| 2026-07-02 | Local rig codified (scripts/protocol-local.sh) | unchanged; all 232 runnable actions now executable locally (local mainnet fork needs no secret; writes need TURNKEY_* exported) | unchanged | unchanged | unchanged | local: cold up 7m49s (incl. build), warm up 59s, single suite validated end to end in 27s (safe 6/6 with oracle assertions); vs 30-35 min per CI round |
| 2026-07-02 | Tier 0 calldata tests (tests/unit/protocol-calldata.test.ts) | first 100% layer: all 394 registry actions encode-tested (synthetic), plus bound-encode goldens for every testData chain (18 golden files) | n/a (encoding layer has no skips; skipped-and-unencodable states recorded in goldens) | exact-calldata assertion for every bound action | adds 476 tests to the unit gate that already runs on every PR | 2.4s for the full layer; mutation check (scripts/protocol-mutation-check.sh) confirms a renamed ABI input goes red |
| 2026-07-03 | Tier 1 fork simulations (tests/e2e/vitest/protocol-simulation, scripts/protocol-local.sh sim) | chain 1: 275 tests collected (13 protocols), 144 pass through real fork execution (impersonation replaces signing, direct RPC replaces the executor; setup provisioning, ordered writes, oracle-asserted reads), 86 documented skips, 45 fail | unchanged | oracle assertions run per read at this tier too | not wired to CI yet (env-gated) | 155s for the chain-1 sweep with zero app/signing infrastructure. The 45 failures are newly exposed latent defects, not harness bugs: yearn's fallback vault is a 45-byte proxy with no implementation (27 reads), chainlink CCIP and curve bindings target codeless or reverting addresses on chain 1, morpho's set-authorization fixture duplicates its setup step, and rocket-pool's deposit reverts "Invalid or outdated contract" (stale registry address - a user-facing bug). None of these could surface before: the mainnet e2e suites have never executed in CI. Catalogued for the skip-unlock/testData-repair phase. |
| 2026-07-03 | Latent defect repairs (Tier 1 catalogue) | chain-1 Tier 1 sweep fully green: 185 pass, 90 documented skips, 0 fail in ~3 min. +41 actions actually work now: yearn (27) and curve (5) bind live contracts (userSpecifiedAddress contracts ignore the registry fallback, so unbound actions had no target at all), chainlink's generic feed reads bind the canonical ETH/USD aggregator (5), morpho's set-authorization polarity and its ABI order (supplyCollateral before borrow) fixed (3), and rocket-pool's deposit-pool registry address updated to the current deployment resolved from RocketStorage (1) - that one was a live user-facing bug. 4 CCIP token checks became honest skips (testnet-only surface). Tier 0 now rejects runnable actions that resolve no target address, closing the defect class. Output-to-binding piping (superfluid GDA pools, morpho vaults, pendle markets) remains open. | runnable 228 (was 232; 4 false-runnables became documented skips) | 121 | 8 | unit gate unchanged (goldens regenerated) | Tier 1 re-verification per fix: ~3 min |
| 2026-07-03 | CI alignment: executed-test floor + representatives mode | unchanged | unchanged | unchanged | the protocol step now fails when executed tests drop below 30 (floor verified both ways locally: 185-executed results pass, an all-skipped file trips it) and publishes counts to the step summary; PROTOCOL_E2E_REPRESENTATIVES=1 shrinks each phase to its first runnable action for a future PR-gate/nightly split | workflow changes validated locally: step logic on the rig, structure/gating/job-launch via act (recipe above); parallel-job refactor and the nightly workflow remain follow-ups |
| 2026-07-03 | MetaMorpho unlocks + Tier 1 in CI + nightly | chain-1 sweep 203 pass / 72 skips / 0 fail (stable across consecutive runs): morpho's 18 vault actions bind the live Steakhouse USDC vault (the yearn pattern; no piping needed), core sequence margin-hardened (borrow 10, repay 8, withdraw-collateral 0.02) after one borderline interest-timing failure. Pendle deliberately deferred: its markets expire, so hardcoded bindings rot - needs the state-snapshot fixture approach. Piping now applies only to superfluid GDA (4, blocked on the Sepolia archive upstream). | runnable 246 | 103 | 8 | tier1-simulations job added to the ephemeral workflow (parallel, no app build, floor 150) - per-action breadth reaches CI for the first time; protocol-nightly.yml runs the full e2e via workflow_call plus the Tier 0 mutation check | tier1 CI job ~8 min estimated; workflows actionlinted and act-validated (nightly dry-run traverses both jobs; schedule gate branch exercised) |
| 2026-07-07 | Parallel protocol gate split | unchanged | unchanged | unchanged | protocol-coverage runs as its own job, fed by a shared build-app artifact, in parallel with the e2e stack instead of serially at its tail. PR runs use representatives mode with an executed-test floor of 3 (ajna contributes one read representative and no write - all its writes are skipped; superfluid one read and one write; the mainnet suites self-skip until ANVIL_FORK_MAINNET_URL is provisioned, at which point the floor rises); nightly/push runs keep the full sweep, floor 30. Fork health probes (probe-forks action plus a post-restart upstream probe) guard both anvil forks. First CI round measured: representatives executed 3, passed 3 | protocol results no longer wait on the vitest e2e tail; dead forks or upstreams fail in seconds instead of as 300s vitest timeouts |
| 2026-07-07 | Hermetic fork state for tier1 (RPC fetch cache pivot) | unchanged | unchanged | unchanged | protocol-nightly's fork-cache-mainnet job warms a live pinned fork with the Tier 1 sweep (floor 150; a red sweep or floor breach publishes nothing) and publishes foundry's flushed RPC cache as fork-cache-mainnet-\<block\>.tgz, 3-day retention; the tier1-simulations job consumes the freshest staging-produced artifact under 36 hours old when ANVIL_FORK_MAINNET_URL is set, and falls back to a live fork on every failure mode. The nightly warm sweep runs on a live fork, so it is itself the live-fork canary | the first design (anvil_dumpState + --load-state) was structurally wrong twice over: the dump captured the warm sweep's own mutations (and the sweep is not idempotent on its residue - morpho set-authorization reverts "already set" on re-run, empirically confirmed) and missed eth_call-only fetches. The pivot packages foundry's on-disk RPC fetch cache instead. Measured (then-current foundry nightly, 2026-07-07; CI has since pinned anvil to 1.7.1 by digest, which writes the same layout): anvil persists upstream fetches to $HOME/.foundry/cache/rpc/\<chain\>/\<block\>/storage.json, flushing only on graceful shutdown (SIGTERM; SIGKILL loses it); a fresh fork with the cache mounted at the same pin serves every warmed read with zero upstream requests (counted through a logging proxy) and starts pristine - a warmed impersonated WETH deposit is invisible, totalSupply returns its exact pre-write value; cold reads against a dead upstream fail loudly (-32603); anvil still needs the upstream at startup (chain id, block env) and for the mining loop's block hashes; an unpinned fork also persists a cache keyed by its resolved head block, so pinning stays explicit everywhere |
| 2026-07-09 | Event-trigger decode coverage at Tier 1 | actions unchanged | actions unchanged | actions unchanged; event dimension added to coverage:report (13 covered / 31 total, 18 documented skips) | the tier1-simulations job's `pnpm vitest run tests/e2e/vitest/protocol-simulation` now also runs events.test.ts on chain 1 (rocket-pool, safe, lido emit + decode; pendle documented-skipped), adding event-decode assertions inside the existing floor/time budget | new events.test.ts + _shared/simulate-events.ts; emitters reuse the rETH deposit fixture, a targeted stETH.submit, and a deploy-and-drive Safe (approved-hash signature, no key/EIP-712). Aerodrome (Base-only) and Pendle (expiring userSpecifiedAddress markets) are reasoned skips |
| 2026-07-07 | Sepolia fork retirement: chronicle, superfluid, and the Safe roles orchestrator re-homed to the mainnet fork | 244 (was 246): 27 Sepolia-runnable actions retired, 24 return as chain-1 fixtures. Chronicle's toll-gated mainnet feeds are whitelisted by the new fork-only `setup.forkImpersonatedCalls` (an authed ward kisses the test wallet - shared by the Tier 1 harness and Tier 2 preflight); superfluid runs on DAI/DAIx (USDCx upgrade OOGs under exact-estimate gas - its underlying routes into Sky savings; ETHx is ABI-incompatible with wrap/unwrap), sized for mainnet's 69-DAI CFA minimum deposit, with create-pool and grant-flow-operator now executing (their Sepolia skips were public-upstream cold-fetch constraints) | 105 | 15 (chronicle feed reads nonZero; superfluid balance/underlying reads plus create-flow/delete-flow post-write oracles on get-flow) | chain-1 Tier 1 sweep 229 passed / 139 skipped / 0 failed (was 203/165/0). Chronicle Tier 2 verified through the app on the local rig: 12/12 with oracle assertions (all reads, no signing needed). Superfluid Tier 2 verified to the signing boundary (whale funding preflight green; setup approve fails at Turnkey wallet init without real keys). Orchestrator fork tests 2/2 on the mainnet fork. CI now runs a single anvil fork: the Sepolia fork service, restart step, post-restart probe, probe-forks line, chains-row patches, and PROTOCOL_E2E_SEPOLIA_FORK are gone; protocol-gate floors re-derived from planPhaseFixtures (representatives 22 / full 200 with ANVIL_FORK_MAINNET_URL, 1 / 20 without - ajna only) | one fork to start/restart instead of two; the ~15-minute Sepolia public-upstream window no longer bounds any CI job |
| 2026-07-08 | Pendle pinned-block fixtures | 255 (was 244): pendle's 11 deferred actions unlocked - market/PT/YT/SY reads plus the mint/redeem write pair bind the recorded wstETH market (expiry 2027-12-30) at pinned block 25487331, per the "Pendle pinned-block fixtures" section above | 94 | 22 (pendle adds market-expiry equals, expiry-flag equals, SY exchange-rate/balance nonZero read oracles, plus post-write oracles: mint asserts PT/YT balances nonZero, redeem asserts SY balance) | the tier1 CI job starts a second, pinned mainnet fork (block registry-resolved via scripts/protocol-pinned-block.ts, archive-secret-gated, health-probed at the pin) and chains.test.ts routes pinned protocols to it; the Tier 2 suite exercises the same bindings on the shared near-head fork in nightly/full runs | pinned fork is cold each run (no nightly cache covers its block) but pendle touches only a handful of contracts; without the archive secret the pinned suite self-skips instead of failing |
| 2026-07-09 | Multi-chain Tier 1: Base + Arbitrum forks | chainlink price-feed reads bound on Base (19: all named USD/ETH feeds except BTC/ETH, plus the custom-feed read set) and Arbitrum One (21: adds the BTC/ETH feed); ajna's existing Base reads now also execute on a Base fork instead of only live Base. CCIP and historical-round actions self-skip on both chains | unchanged on chain 1 | reads assert liveness through the same oracle; no new value-asserted expectations added for the L2 feeds | new `tier1-simulations-l2` job runs one matrix leg per chain (Base floor 15, Arbitrum floor 12) in parallel with the chain-1 tier1 job; each forks a public upstream (no archive node - sims never mine against upstream) and self-skips a chain whose `PROTOCOL_SIM_RPC_<id>` is unset. `coverage:report` now shows 8453 and 42161 rows | two L2 legs on separate runners add no time to the chain-1 budget; read-only L2 coverage needs no whales/faucets. Follow-up: write-bearing L2 protocols (aave-v3, uniswap-v3, sky) need per-chain FORK_WHALES/FAUCETS before their testData can run |
| 2026-07-13 | Output-expectations rollout: broadened asserted reads + write oracles across the registry | unchanged (324 runnable) | unchanged (87) | 150 (was 20 measured via coverage:report): read oracles added on sky, spark, ethena, morpho, yearn, lido, curve, safe, ajna, chainlink (chains 1/8453/42161), pendle. Write oracles broadened to sky/ethena/morpho (supply->position, stake->share balance), spark (supply->collateral, borrow->debt), and superfluid (update-flow->flowRate, wrap->super-token balance). History-safe throughout: nonZero on monotonic rates/supplies/prices/exchange-rates, equals only on true constants (ethena cooldown 86400, morpho lltv 86%, is-paused/is-shutdown flags, yearn share decimals). Caller-position reads (vault-balance, get-position, max-withdraw/redeem, aave/spark account-data at the read phase) and shared-wallet token balances are deliberately left unasserted. Field resolution is per-ABI: unnamed single outputs assert the bare result (sky/spark/ethena/yearn/lido/curve/safe/chainlink decimals-family), named outputs use the field (morpho totalAssets/lltv, ajna index/lup/price/inflator, chainlink latestRoundData answer). chainlink decimals-equals was tried then dropped as fragile - Base BTC/USD and USDC/USD report 18, not 8 - keeping the high-signal nonzero answer instead. | no CI change: the new assertions ride the existing tier1 floors and coverage:report count | validated locally on host-native anvil forks (no Docker/rig): chain-1 near-head + pendle pinned fork 287 pass / 0 fail, Base + Arbitrum One L2 67 pass / 0 fail. Fresh fork per run so non-idempotent writes (morpho set-authorization, curve crv-approve) stay clean. Bugs caught pre-merge by the sim: spark set-collateral probed the DAI reserve while the write acted on WETH (dropped - no aligned probe); ajna per-pool bucket-info price is zero at an empty bound index; the Arbitrum public upstream blocks archive reads (switched to an archive endpoint). Deferred to a follow-up (liveness-only for now, no incorrect assertions shipped): uniswap-v3 quotes (imported multi-output ABI), chronicle read-with-age (ambiguous multi-output keying), aave-v3 Sepolia mirror (needs the Sepolia fork) |
| 2026-08-13 | anvil pinned by digest (fork-image supply chain) | unchanged | unchanged | unchanged | every anvil call site (both CI workflows, both compose services, scripts/protocol-local.sh) moved off `ghcr.io/foundry-rs/foundry:latest` to `v1.7.1` at digest `sha256:8347b728...`. On GHCR `latest` is an alias for `nightly`, not a release, so the staging gate rode on an unreviewed build that changed daily; the 2026-08-13 nightly put OP-stack behind a compile-time feature it did not enable and every Base (8453) fork failed to start with "network family optimism is not enabled in this build", blocking staging deploys from 06:38Z until the pin landed. No release carries the regression - 1.7.1 still accepts `--network optimism`. `stable` is unmaintained (still 1.5.1, 2025-12-22), hence the explicit version tag | the fork RPC cache is written by protocol-nightly and read by tier1-simulations, and the consumer's only validity check is that `storage.json` exists: storage.json is zstd-compressed with no version stamp, so an anvil skew between writer and reader degrades silently to full upstream refetch rather than failing. Both workflows therefore pin the same digest and must be bumped together; artifacts written by the previous nightly stay eligible for 36h after this change and may refetch |
