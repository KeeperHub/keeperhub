/**
 * Shared types + binding helpers for KEEP-458 protocol-coverage test data.
 *
 * Each `protocols/<slug>.ts` co-locates a `TEST_DATA: ProtocolTestData` export
 * alongside its `defineProtocol` definition. The shared builder in
 * `lib/test-data/build-workflow.ts` resolves bindings against the protocol
 * registry + `TOKEN_REGISTRY` + a per-environment wallet address (looked up
 * from `organization_wallets` by the consumer) at call time.
 *
 * Bindings are plain strings or one of four tagged objects:
 *   "DAI"                       -> address-typed input: TOKEN_REGISTRY[chain].DAI.address
 *   "0xabc..."                  -> literal value, passed through verbatim
 *   wallet()                    -> persistent test user's Turnkey wallet address
 *                                  (KEEP-529 made this per-environment; the
 *                                  builder receives it as a parameter)
 *   amount("DAI", "10")         -> wei using DAI's decimals
 *   contract("pool")            -> protocol.contracts.pool.addresses[chain]
 *   native("0.001")             -> wei at 18 decimals
 *   fromSetupOutput("create-pool", "pool")
 *                               -> a field captured from a prior step's
 *                                  output (see OutputCapture / SetupOutputs);
 *                                  used for actions that can only run against
 *                                  an address the setup phase itself creates
 *                                  (Superfluid GDA pool actions need the pool
 *                                  address create-pool deploys).
 *
 * The builder uses the action's input type information (from
 * `lib/protocol-registry.ts`) to disambiguate.
 */

import type { TokenSymbol } from "./chain-test-data";

export type WalletBinding = { _wallet: true };
export type AmountBinding = { _amount: { symbol: TokenSymbol; human: string } };
export type ContractBinding = { _contract: { key: string } };
export type NativeBinding = { _native: { human: string } };
export type FromSetupOutputBinding = {
  _fromSetupOutput: { step: string; field: string };
};

export type InputBinding =
  | string
  | WalletBinding
  | AmountBinding
  | ContractBinding
  | NativeBinding
  | FromSetupOutputBinding;

export function wallet(): WalletBinding {
  return { _wallet: true };
}

export function amount(symbol: TokenSymbol, human: string): AmountBinding {
  return { _amount: { symbol, human } };
}

export function contract(key: string): ContractBinding {
  return { _contract: { key } };
}

export function native(human: string): NativeBinding {
  return { _native: { human } };
}

/**
 * Bind an action input to a value captured from a prior step's output (a
 * "setup output"). `step` names the producing step (an action slug like
 * "create-pool"); `field` names the field to read from that step's captured
 * output. The captured values are supplied to the builder as `SetupOutputs`;
 * see OutputCapture for how each tier populates them. Resolving a
 * fromSetupOutput binding whose capture is absent throws, unless the action
 * is a documented skip (then the builder substitutes an unused placeholder,
 * same as any other unbound address input on a skipped action).
 */
export function fromSetupOutput(
  step: string,
  field: string
): FromSetupOutputBinding {
  return { _fromSetupOutput: { step, field } };
}

export function isWalletBinding(v: InputBinding): v is WalletBinding {
  return typeof v === "object" && v !== null && "_wallet" in v;
}

export function isAmountBinding(v: InputBinding): v is AmountBinding {
  return typeof v === "object" && v !== null && "_amount" in v;
}

export function isContractBinding(v: InputBinding): v is ContractBinding {
  return typeof v === "object" && v !== null && "_contract" in v;
}

export function isNativeBinding(v: InputBinding): v is NativeBinding {
  return typeof v === "object" && v !== null && "_native" in v;
}

export function isFromSetupOutputBinding(
  v: InputBinding
): v is FromSetupOutputBinding {
  return typeof v === "object" && v !== null && "_fromSetupOutput" in v;
}

/**
 * Values captured from prior steps, keyed `step -> field -> value`, consumed
 * by fromSetupOutput bindings. Each tier populates this differently: the fork
 * simulation tier records it from the producing step's receipt/return (there
 * is no database), and it is passed to the workflow builders at call time.
 */
export type SetupOutputs = Record<string, Record<string, string>>;

/** Read a captured value, or undefined when the step/field is absent. */
export function readSetupOutput(
  outputs: SetupOutputs | undefined,
  step: string,
  field: string
): string | undefined {
  return outputs?.[step]?.[field];
}

/** Map of action-input-name -> binding, plus optional virtual `contractAddress`
 *  for actions whose contract is userSpecifiedAddress (Superfluid SuperTokens). */
export type ActionInputBindings = Record<string, InputBinding>;

/**
 * Declarative assertion on one field of a step's output, checked by the
 * coverage runner after the execution reaches `success`. Without these the
 * suite only proves liveness: any non-throwing read passes regardless of
 * the value it returned.
 *
 * `field` is a dot-path into the step output's `result` (the structured
 * ABI output from `structureAbiOutputs`, so multi-output reads key by
 * output name, e.g. "totalCollateralBase"). Omit `field` to target
 * `result` itself (single-output reads).
 *
 * Every expectation implies existence (resolved value is not
 * null/undefined). Predicates are optional and additive:
 *   - `nonZero`: numeric value (BigInt-serialized string) is not zero
 *   - `notEmpty`: array/string has length, object has keys
 *   - `equals`: String(value) matches exactly (booleans: "true"/"false")
 *
 * Keep expectations to values the suite provisions itself (positions the
 * setup workflow opened) or long-lived chain invariants (an exchange rate,
 * a Safe's threshold). Do not assert values another concurrently-running
 * suite can move: all protocol-coverage suites share one test wallet.
 */
export type OutputExpectation = {
  field?: string;
  nonZero?: boolean;
  notEmpty?: boolean;
  equals?: string;
};

/** Setup bootstrap per (protocol, chain). */
export type SetupSpec = {
  /** Native gas floor (preflight asserts before the setup workflow runs). */
  minNativeHuman: string;
  /** ERC20 balances the wallet must hold; preflight asserts and throws on shortfall. */
  requiredTokens: Array<{ symbol: TokenSymbol; human: string }>;
  /**
   * Approvals emitted as web3/approve-token nodes inside the setup workflow.
   * `spender` is a regular InputBinding: plain string is treated like any
   * address-typed input (resolved against TOKEN_REGISTRY first, then as a
   * literal 0x address); use `contract("key")` for a protocol contract.
   */
  approvals: Array<{
    token: TokenSymbol;
    spender: InputBinding;
    human: string;
  }>;
  /**
   * Fork-only allowances fabricated with anvil_setStorageAt (the
   * TS preflight in both tiers, via runFabricatedApprovals), instead of
   * emitted as approve-token setup nodes. Same shape as `approvals`. Use
   * on the mainnet fork where the approve-token node's
   * gas-sponsorship-fallback path takes minutes per approval and blows
   * the setup timeout; declaring these on a chain outside FORK_CHAIN_IDS
   * fails loudly, same as forkImpersonatedCalls. See
   * fabricateErc20Allowance in
   * tests/e2e/vitest/protocol-coverage/_shared/fabricate-state.ts.
   */
  fabricatedApprovals?: Array<{
    token: TokenSymbol;
    spender: InputBinding;
    human: string;
  }>;
  /** Optional protocol-action prep (e.g. wrap fUSDC -> fUSDCx for Superfluid). */
  protocolSteps?: Array<{
    protocol: string;
    action: string;
    inputs: ActionInputBindings;
  }>;
  /**
   * Override the coverage runner's setup-execution wait (default 300s,
   * sized for a single cold first-touch transaction). For setups whose
   * transaction count makes that structurally too small: each real
   * signed tx through the app has been observed to take >100s under
   * CI's shared-wallet contention on a cold fork, so a three-approval
   * setup (pendle: SY, PT, and YT all need router allowances) cannot
   * fit the single-tx default. Use sparingly and note the constraint;
   * the default stays tight so genuinely hung setups fail fast with
   * their post-mortem intact. Keep the suite file's beforeAll timeout
   * above this value.
   */
  executionWaitMs?: number;
  /**
   * Fork-only provisioning calls that require impersonating a privileged
   * third party (anvil cheatcodes), e.g. an authed ward whitelisting the
   * test wallet on a toll-gated oracle. Each entry funds and impersonates
   * `impersonate`, then calls `functionName` on the resolved target with
   * the resolved args (wallet() supported on address params). Runs before
   * the setup workflow (coverage preflight) / setup steps (simulation
   * tier). Declaring these on a chain outside FORK_CHAIN_IDS is an
   * authoring error and fails loudly: impersonation does not exist on a
   * live chain, and silently skipping would let gated fixtures pass
   * vacuously or fail far downstream.
   */
  forkImpersonatedCalls?: Array<{
    /** Address to impersonate; must hold the required on-chain privilege
     *  (verify empirically against a fork and record the evidence). */
    impersonate: string;
    /** Target contract: contract("key") binding or a literal 0x address. */
    contract: InputBinding;
    /** Single-function ABI JSON for the call. */
    abi: string;
    functionName: string;
    args: InputBinding[];
  }>;
};

/**
 * Fork-only cheatcode fabrication of an on-chain precondition a single
 * action needs, run by the harnesses immediately before that action
 * executes (Tier 1 simulation and the Tier 2 coverage runner both call
 * runActionFabrications in
 * tests/e2e/vitest/protocol-coverage/_shared/funding.ts). Like
 * forkImpersonatedCalls, declaring these on a chain outside
 * FORK_CHAIN_IDS is an authoring error and fails loudly.
 *
 * The only kind today is "elapsed-cooldown": rewrite a
 * StakedUSDeV2-style cooldowns(address) packed struct
 * (uint104 cooldownEnd | uint152 underlyingAmount) so the wallet's
 * pending cooldown reads as elapsed. The preceding cooldown write must
 * be real (it escrows the funds the unstake then draws); only the
 * timestamp is fabricated. Slot located by probing; see
 * fabricateElapsedCooldown in
 * tests/e2e/vitest/protocol-coverage/_shared/fabricate-state.ts.
 */
export type StateFabrication = {
  kind: "elapsed-cooldown";
  /** Target contract: contract("key") binding or a literal 0x address. */
  contract: InputBinding;
};

/**
 * Fork-tier (Tier 1) capture of a value a prior action produces on-chain, so
 * a later action can bind it via fromSetupOutput(). Runs in the simulation
 * harness after setup provisioning and before the action sweep, populating
 * SetupOutputs under `as -> field -> value`.
 *
 * The only kind today is "gda-pool": eth_call the producer action's calldata
 * (Superfluid GDAv1Forwarder.createPool) and decode its (bool success,
 * address pool) return to predict the pool the create-pool action deploys.
 * The prediction is address = f(GDA deployer nonce) only, and no other pool
 * is created between the capture and the create-pool action (registry order
 * runs the CFA writes first), so the predicted address matches the deployed
 * one. Like the other fork-only setup constructs (forkImpersonatedCalls,
 * fabricatedApprovals), this is a simulation-tier concept: the app coverage
 * tier cannot capture a write's output today (the executor's write step
 * returns `result: undefined` and no logs), so a producer whose output the
 * app path needs must be listed in `skippedCoverage`.
 */
export type OutputCapture = {
  kind: "gda-pool";
  /** Step name referenced by fromSetupOutput's first arg. */
  as: string;
  /** Field name referenced by fromSetupOutput's second arg. */
  field: string;
};

export type ProtocolChainTestData = {
  /** When false, builder emits workflows marked _executable:false. */
  enabled?: boolean;
  /**
   * Fork block the chain's bindings were recorded at, for protocols whose
   * fixtures rot on live state (Pendle markets expire). The Tier 1 harness
   * runs these protocols against a dedicated fork pinned here (gated on
   * PROTOCOL_SIM_RPC_<chainId>_PINNED) instead of the shared near-head
   * fork, so the recorded bindings stay verifiable regardless of wall
   * clock. The rig and CI resolve the pin from the registry via
   * scripts/protocol-pinned-block.ts; refresh procedure in
   * specs/protocol-coverage-methodology.md.
   */
  pinnedBlock?: number;
  setup: SetupSpec;
  /** Per-action input bindings keyed by action.slug. */
  actions: Record<string, ActionInputBindings>;
  /**
   * Optional per-action output assertions keyed by action.slug, checked by
   * the coverage runner after execution success. See OutputExpectation.
   */
  expectations?: Record<string, OutputExpectation[]>;
  /**
   * Per-action execution-wait overrides (ms) for the coverage runner,
   * keyed by action.slug. For writes whose first-touch contract fan-out
   * through the fork upstream exceeds the default two-minute wait (a
   * cold GDA pool creation can take several minutes on a fresh fork).
   * Use sparingly and note the constraint; the default stays tight so
   * genuinely broken actions fail fast. Warmed fork caches make these
   * overrides progressively irrelevant.
   */
  executionWaitMs?: Record<string, number>;
  /**
   * Post-write oracles for the fork simulation tier, keyed by write
   * action slug. After the write mines, the harness runs the referenced
   * read action of the same protocol/chain (with its normal testData
   * bindings) and asserts on the structured result, so a write that
   * mines but does the wrong thing cannot pass on receipt status alone.
   * Simulation tier only: the coverage suites' shared wallet makes
   * post-write state nondeterministic, but the simulation tier's
   * dedicated impersonated wallet does not. Keep assertions
   * history-safe on a long-lived fork (nonZero on a balance that only
   * grows; never equals on accumulated state).
   */
  writeExpectations?: Record<
    string,
    Array<{ read: string; expect: OutputExpectation }>
  >;
  /**
   * Per-action pre-execution state fabrications, keyed by action slug.
   * See StateFabrication above.
   */
  fabrications?: Record<string, StateFabrication[]>;
  /**
   * Fork-tier output captures, keyed by the producing action's slug. The
   * simulation harness runs these after setup and exposes the results to
   * fromSetupOutput bindings on later actions. See OutputCapture.
   */
  captures?: Record<string, OutputCapture>;
  /**
   * Action slugs skipped in the app coverage tier (Tier 2) only, keyed to a
   * reason, while still runnable in the fork simulation tier (Tier 1). Use
   * for actions the fork tier can provision via a capture (fromSetupOutput)
   * but the app path cannot, because the executor does not surface the
   * producing write's output today. Distinct from `skipped`, which skips in
   * both tiers. The coverage runner and the coverage report treat these as
   * skips; the simulation harness ignores them.
   */
  skippedCoverage?: Record<string, string>;
  /**
   * Action slugs the test runner should mark as `test.skip` with a reason.
   * Builders still produce these workflows (so the seeder surfaces them in
   * the dashboard), but the integration suite skips execution in both tiers.
   * Use for actions whose on-chain prerequisites neither tier provisions. For
   * actions the fork tier can provision (via a capture) but the app tier
   * cannot, use `skippedCoverage` instead so the fork sweep still runs them.
   */
  skipped?: Record<string, string>;
  /**
   * Event-trigger simulation opt-in for this (protocol, chain). When present,
   * the Tier 1 event harness (tests/e2e/vitest/protocol-simulation) emits an
   * impersonated transaction on the fork for each registered protocol event
   * and asserts the event-trigger decoder parses the resulting log into the
   * shape the trigger layer consumes. Declare it on exactly one chain per
   * protocol (the chain the harness emits on). `skipped` documents events
   * that cannot be emitted on the fork, keyed by event slug, with a reason
   * naming the real constraint — mirrors `skipped` for actions.
   */
  events?: {
    skipped?: Record<string, string>;
  };
};

/** A protocol's test data, keyed by chainId. */
export type ProtocolTestData = Record<string, ProtocolChainTestData>;
