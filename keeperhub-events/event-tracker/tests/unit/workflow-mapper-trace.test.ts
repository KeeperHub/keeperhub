import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkConfig, NetworksMap, RawWorkflow } from "../../lib/types";
import { logger } from "../../lib/utils/logger";
import {
  TRACE_CAPABILITY_ENV_VAR,
  forgetTraceRefusalsFor,
  resetTraceCapabilityCache,
} from "../../src/chains/trace-capability";
import { isTraceRegistration } from "../../src/listener/registry";
import { buildRegistration } from "../../src/listener/workflow-mapper";

/**
 * Mapping of a `Trace` trigger node (issue #2464).
 *
 * Nothing built a `TraceRegistration` before this branch existed, so a Trace
 * config reaching `buildRegistration` fell through to `missing eventName` and
 * was skipped. Nothing upstream produces one against `staging` yet either:
 * `app/api/workflows/events/route.ts` admits only `WorkflowTriggerEnum.EVENT`
 * and `.TEMPO_PAYMENT`, and `WorkflowTriggerEnum` has no `Trace` member. This
 * suite is therefore the only current caller of the branch, which is why the
 * payloads below are hand-built rather than fixtures captured from the API.
 *
 * The filter is re-validated here rather than trusted from the endpoint. A
 * filter the matcher cannot read produces a trigger that registers, never
 * fires and reports nothing anywhere, which is the most expensive failure
 * shape this trigger has.
 */

/**
 * A chain the upstream survey found serving `debug_traceBlockByNumber`.
 *
 * Plasma mainnet: `.planning/issue-2247-trace-upstream-survey.md` records the
 * official `https://rpc.plasma.to` answering `callTracer` unauthenticated.
 * This is not incidental to the fixture - `buildTraceRegistration` refuses a
 * Trace trigger on a chain that is not known to answer the method, so a
 * mapping test has to sit on one that is. See `UNTRACEABLE_CHAIN_ID` below.
 */
const CHAIN_ID = 9745;

/**
 * A chain the same survey found refusing it: Ethereum mainnet, where the
 * configured primary answers `-32601` for the debug namespace and the
 * fallback is quota-gated.
 */
const UNTRACEABLE_CHAIN_ID = 1;

/**
 * A second one, so a case can show the refusal latch keying on the
 * workflow+chain pair rather than on the workflow. Polygon, which the same
 * survey also recorded refusing the debug namespace on its public default.
 */
const SECOND_UNTRACEABLE_CHAIN_ID = 137;

const NETWORK: NetworkConfig = {
  id: "plasma-mainnet",
  chainId: CHAIN_ID,
  name: "Plasma",
  symbol: "XPL",
  chainType: "evm",
  defaultPrimaryRpc: "http://localhost:8546",
  defaultFallbackRpc: "http://localhost:8546",
  defaultPrimaryWss: "ws://localhost:8546",
  defaultFallbackWss: "ws://localhost:8546",
  isTestnet: false,
  isEnabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const UNTRACEABLE_NETWORK: NetworkConfig = {
  ...NETWORK,
  id: "eth-mainnet",
  chainId: UNTRACEABLE_CHAIN_ID,
  name: "Ethereum",
  symbol: "ETH",
};

const SECOND_UNTRACEABLE_NETWORK: NetworkConfig = {
  ...NETWORK,
  id: "polygon-mainnet",
  chainId: SECOND_UNTRACEABLE_CHAIN_ID,
  name: "Polygon",
  symbol: "POL",
};

const NETWORKS: NetworksMap = {
  [CHAIN_ID]: NETWORK,
  [UNTRACEABLE_CHAIN_ID]: UNTRACEABLE_NETWORK,
  [SECOND_UNTRACEABLE_CHAIN_ID]: SECOND_UNTRACEABLE_NETWORK,
};

const WATCHED = "0x1111111111111111111111111111111111111111";
const CALLER = "0x2222222222222222222222222222222222222222";
const PAUSE_SELECTOR = "0x8456cb59";

/**
 * The documented spelling for "no chain here traces". A literal rather than an
 * import of the module constant, because it is the operator-facing contract the
 * README states: renaming the constant must fail this suite.
 */
const NONE_SENTINEL = "none";

/** The id `makeWorkflow` stamps, named so the refusal-latch cases can prune it. */
const WORKFLOW_ID = "wf-trace-1";

function makeWorkflow(
  configOverrides: Record<string, unknown> = {},
  chainId: number = CHAIN_ID,
  workflowId: string = WORKFLOW_ID,
): RawWorkflow {
  return {
    id: workflowId,
    name: "Pause watcher",
    userId: "user-1",
    nodes: [
      {
        data: {
          config: {
            network: String(chainId),
            // The value WorkflowTriggerEnum.TRACE serialises to.
            triggerType: "Trace",
            contractAddress: WATCHED,
            ...configOverrides,
          },
        },
      },
    ],
  } as RawWorkflow;
}

function build(configOverrides: Record<string, unknown> = {}) {
  const reg = buildRegistration(makeWorkflow(configOverrides), NETWORKS);
  return reg !== null && isTraceRegistration(reg) ? reg : null;
}

describe("buildRegistration - Trace", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    // `vi.spyOn` on an already-spied method hands back the same spy, so its
    // recorded calls otherwise survive into the next case and an assertion
    // about which line was emitted reads a line from an earlier one.
    warn.mockClear();
  });

  it("builds a trace registration at all", () => {
    // The whole point. Before this branch, `buildRegistration` returned only
    // WorkflowRegistration | StateThresholdRegistration, and a Trace config
    // reached the eventName check and was skipped.
    const reg = build();
    expect(reg).not.toBeNull();
    expect(reg?.kind).toBe("trace");
    expect(reg?.chainId).toBe(CHAIN_ID);
    expect(reg?.wssUrl).toBe("ws://localhost:8546");
    expect(reg?.userId).toBe("user-1");
    expect(reg?.subscription.contractAddress).toBe(WATCHED);
  });

  it("does not fall through to the event path", () => {
    // The old failure mode, pinned so a future edit that reorders the
    // branches cannot quietly restore it.
    const reg = buildRegistration(makeWorkflow(), NETWORKS);
    expect(reg).not.toBeNull();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("missing eventName")),
    ).toBe(false);
  });

  it("carries every filter the editor stores", () => {
    const reg = build({
      traceCaller: CALLER,
      traceSelector: PAUSE_SELECTOR,
      traceCallTypes: ["DELEGATECALL", "CALL"],
      traceMinValueWei: "1000000000000000000",
      traceStatus: "reverted",
    });
    expect(reg?.subscription).toEqual({
      contractAddress: WATCHED,
      caller: CALLER,
      selector: PAUSE_SELECTOR,
      callTypes: ["DELEGATECALL", "CALL"],
      minValueWei: "1000000000000000000",
      status: "reverted",
    });
  });

  it("reads the wei field that registers, not the display one", () => {
    // The editor stores two: `traceMinValueWei` is what registers, and
    // `traceMinValue` is the same number in native token units, kept only so
    // the box shows what was typed. Reading the display field would apply a
    // floor 1e18 times too small.
    const reg = build({ traceMinValue: "1", traceMinValueWei: "5" });
    expect(reg?.subscription.minValueWei).toBe("5");
  });

  it("normalises the wei floor so equal floors hash equal", () => {
    const decimal = build({ traceMinValueWei: "100" });
    const padded = build({ traceMinValueWei: "0000100" });
    expect(padded?.subscription.minValueWei).toBe("100");
    expect(padded?.configHash).toBe(decimal?.configHash);
  });

  it("lower-cases the addresses the matcher compares", () => {
    const reg = build({
      contractAddress: WATCHED.toUpperCase().replace("0X", "0x"),
      traceCaller: CALLER.toUpperCase().replace("0X", "0x"),
    });
    // `frameMatches` compares `call.to` against `filter.callee.toLowerCase()`,
    // and the frame side is already lower-cased, so a mixed-case config that
    // reached the matcher unchanged would still match. Normalising here keeps
    // the config hash stable instead, so re-saving with different casing does
    // not restart the listener.
    expect(reg?.subscription.contractAddress).toBe(WATCHED);
    expect(reg?.subscription.caller).toBe(CALLER);
  });

  it("upper-cases call types to the casing the matcher uses", () => {
    const reg = build({ traceCallTypes: ["delegatecall"] });
    expect(reg?.subscription.callTypes).toEqual(["DELEGATECALL"]);
  });

  it("treats an absent filter as any, not as an error", () => {
    const reg = build();
    expect(reg).not.toBeNull();
    expect(reg?.subscription.caller).toBeUndefined();
    expect(reg?.subscription.selector).toBeUndefined();
    expect(reg?.subscription.callTypes).toBeUndefined();
    expect(reg?.subscription.minValueWei).toBeUndefined();
    expect(reg?.subscription.status).toBeUndefined();
  });

  it("treats an empty string as absent, which is what the editor stores", () => {
    const reg = build({
      traceCaller: "",
      traceSelector: "",
      traceMinValueWei: "",
      traceStatus: "",
    });
    expect(reg).not.toBeNull();
    expect(reg?.subscription.caller).toBeUndefined();
    expect(reg?.subscription.selector).toBeUndefined();
    expect(reg?.subscription.minValueWei).toBeUndefined();
    expect(reg?.subscription.status).toBeUndefined();
  });

  it("carries an empty call-type list as absent rather than as an empty array", () => {
    // The matcher already treats an empty list as the wildcard. Carrying it
    // as `[]` would hash differently from the same filter saved before any
    // box was ticked, and restart the listener for no behavioural change.
    const none = build({ traceCallTypes: [] });
    expect(none).not.toBeNull();
    expect(none?.subscription.callTypes).toBeUndefined();
    expect(none?.configHash).toBe(build()?.configHash);
  });

  describe("refuses a filter the matcher cannot read", () => {
    function refused(overrides: Record<string, unknown>, needle: string): void {
      expect(build(overrides)).toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).includes(needle))).toBe(
        true,
      );
    }

    it("a selector that is not four bytes", () => {
      // `pause()` or a truncated `0x845` matches nothing. Dropping it rather
      // than refusing would widen the filter to every function on the
      // contract, which fires a workflow nobody asked for.
      refused({ traceSelector: "pause()" }, "not a 4-byte selector");
      refused({ traceSelector: "0x845" }, "not a 4-byte selector");
      refused(
        { traceSelector: `${PAUSE_SELECTOR}00` },
        "not a 4-byte selector",
      );
    });

    it("a call type outside the frame types geth emits", () => {
      refused({ traceCallTypes: ["TELEPORT"] }, "is not one of");
    });

    it("call types that arrived unparsed", () => {
      // The endpoint parses the editor's JSON-array string before sending. A
      // value still a string got past it, and `.some` on a string inside the
      // per-block matcher is not something to find out at runtime.
      refused({ traceCallTypes: '["CALL"]' }, "not an array");
    });

    it("a caller that is not an address", () => {
      refused({ traceCaller: "0xdeadbeef" }, "not a 20-byte address");
    });

    it("a watched address that is not an address", () => {
      refused({ contractAddress: "not-an-address" }, "not a 20-byte address");
    });

    it("a wei floor that is not an integer", () => {
      refused({ traceMinValueWei: "1.5" }, "is not an integer");
      refused({ traceMinValueWei: "lots" }, "is not an integer");
    });

    it("a negative wei floor", () => {
      refused({ traceMinValueWei: "-1" }, "is negative");
    });

    it("a status outside the three the matcher understands", () => {
      refused({ traceStatus: "failed" }, "is not one of");
    });
  });

  describe("the chain has to be able to answer the method", () => {
    /**
     * On the upstream survey's own evidence, silently never firing was the
     * default outcome rather than an edge case.
     *
     * `debug_traceBlockByNumber` is unavailable on the tree-configured public
     * defaults for Ethereum, Base, Arbitrum, Polygon, BNB, OP and Avalanche.
     * A registration there used to be accepted, refuse once at the first
     * drain, set `traceUnsupported`, report the range served so the shared
     * high-water mark kept advancing, and stop asking until reconnect. The
     * user was left with an enabled workflow that never fired.
     */
    function buildOn(
      chainId: number,
      configOverrides: Record<string, unknown> = {},
    ) {
      const reg = buildRegistration(
        makeWorkflow(configOverrides, chainId),
        NETWORKS,
      );
      return reg !== null && isTraceRegistration(reg) ? reg : null;
    }

    beforeEach(() => {
      // The parse warns once per distinct variable value and a refusal warns
      // once per workflow+chain, both for the life of the process. Without
      // this a case asserting that a line was emitted reads a latch set by an
      // earlier case that used the same value or the same pair.
      resetTraceCapabilityCache();
    });

    afterEach(() => {
      delete process.env[TRACE_CAPABILITY_ENV_VAR];
      resetTraceCapabilityCache();
    });

    /** Every warn line matching `needle`, in emission order. */
    function warnLines(needle: string): string[] {
      return warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes(needle));
    }

    const REFUSAL = "is not known to answer";
    const FELL_BACK = "named no usable chain ID";

    it("refuses a chain the survey found refusing the method", () => {
      expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes(
            "is not known to answer debug_traceBlockByNumber",
          ),
        ),
      ).toBe(true);
    });

    it("names the chain and the allowed set in the refusal", () => {
      // The operator reading this line has to be able to act on it without
      // reading the source, so it carries both the chain that was refused and
      // what would have been accepted.
      buildOn(UNTRACEABLE_CHAIN_ID);
      const line = warn.mock.calls
        .map((c) => String(c[0]))
        .find((c) => c.includes("is not known to answer"));
      expect(line).toContain(`chain ${UNTRACEABLE_CHAIN_ID}`);
      expect(line).toContain("trace-capable chains:");
      expect(line).toContain(String(CHAIN_ID));
      expect(line).toContain("surveyed default");
    });

    it("accepts a chain the survey found serving it", () => {
      // The other half. Without this the case above passes against a mapper
      // that refuses every Trace registration.
      expect(buildOn(CHAIN_ID)).not.toBeNull();
    });

    it("refuses before the filter, so the chain is the reported reason", () => {
      // A workflow that is wrong twice over reports the chain, not the
      // selector: the chain is the condition the user cannot fix by editing
      // the filter.
      expect(
        buildOn(UNTRACEABLE_CHAIN_ID, { traceSelector: "not-a-selector" }),
      ).toBeNull();
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("is not known to answer"))).toBe(
        true,
      );
      expect(lines.some((l) => l.includes("is not a 4-byte selector"))).toBe(
        false,
      );
    });

    it("honours an operator override naming the chain", () => {
      // The survey measured the public defaults and records that nobody has
      // checked what production resolves to. A deployment on a keyed plan
      // that does serve the method must not be refused.
      process.env[TRACE_CAPABILITY_ENV_VAR] = String(UNTRACEABLE_CHAIN_ID);
      expect(buildOn(UNTRACEABLE_CHAIN_ID)).not.toBeNull();
    });

    it("lets an override replace the default rather than extend it", () => {
      // An operator whose upstream does not serve Plasma has to be able to
      // remove it, so the override is not a union with the surveyed set.
      process.env[TRACE_CAPABILITY_ENV_VAR] = String(UNTRACEABLE_CHAIN_ID);
      expect(buildOn(CHAIN_ID)).toBeNull();
    });

    it("trusts every chain on the wildcard", () => {
      process.env[TRACE_CAPABILITY_ENV_VAR] = "*";
      expect(buildOn(UNTRACEABLE_CHAIN_ID)).not.toBeNull();
    });

    it("drops an unparseable override entry without widening the set", () => {
      // A typo must not become a wildcard. The good entry still applies and
      // the bad one is named.
      process.env[TRACE_CAPABILITY_ENV_VAR] = `nonsense,${CHAIN_ID}`;
      expect(buildOn(CHAIN_ID)).not.toBeNull();
      expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes('entry "nonsense" is not a chain ID'),
        ),
      ).toBe(true);
    });

    describe("an override that names no usable chain falls back", () => {
      /**
       * The blocker. `traceCapableChainIds()` was
       * `configuredOverride() ?? new Set(SURVEYED...)`, and an override whose
       * every token was dropped returned an empty `Set`. An empty Set is not
       * nullish, so the surveyed default never applied and
       * `isTraceCapableChain` was false for every chain:
       * `TRACE_CAPABLE_CHAIN_IDS=mainnet` silently turned off every Trace
       * trigger in the deployment. That is the outcome dropping a bad token
       * exists to avoid.
       */
      it("keeps the surveyed set when every token was dropped", () => {
        process.env[TRACE_CAPABILITY_ENV_VAR] = "mainnet";
        expect(buildOn(CHAIN_ID)).not.toBeNull();
      });

      it("falls back to the surveyed set, not to the wildcard", () => {
        // The other half: falling back must not admit a chain the survey
        // found refusing, or a typo becomes `*`.
        process.env[TRACE_CAPABILITY_ENV_VAR] = "mainnet";
        expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
      });

      it("says that it fell back, and how to mean it", () => {
        // An operator who mistyped every token must not silently get a
        // different policy than the one they think they set.
        process.env[TRACE_CAPABILITY_ENV_VAR] = "mainnet";
        buildOn(CHAIN_ID);
        const line = warnLines(FELL_BACK)[0];
        expect(line).toContain('"mainnet"');
        expect(line).toContain("falling back to the surveyed default set");
        expect(line).toContain(`${TRACE_CAPABILITY_ENV_VAR}=none`);
      });

      it("blames the surveyed default in the refusal, not the override", () => {
        // `describeTraceCapableChains` used to decide provenance by re-reading
        // the variable, which is non-empty here, so it credited the override
        // for a set the override did not produce.
        process.env[TRACE_CAPABILITY_ENV_VAR] = "mainnet";
        buildOn(UNTRACEABLE_CHAIN_ID);
        const line = warnLines(REFUSAL)[0];
        expect(line).toContain("surveyed default");
        expect(line).not.toContain(`(${TRACE_CAPABILITY_ENV_VAR})`);
      });

      it("treats 0 as a typo, so =0 is not a silent one-element set", () => {
        // The docstring offered `=0` as the way to say "no chain here traces",
        // but `Number("0")` is a valid integer, so it produced `{0}`: every
        // real chain refused, for a reason no operator could read out of the
        // log line. 0 is not an EIP-155 chain ID.
        process.env[TRACE_CAPABILITY_ENV_VAR] = "0";
        expect(buildOn(CHAIN_ID)).not.toBeNull();
        expect(
          warn.mock.calls.some((c) =>
            String(c[0]).includes('entry "0" is not a chain ID'),
          ),
        ).toBe(true);
      });
    });

    describe("none is the way to say no chain traces", () => {
      it("refuses a surveyed-capable chain", () => {
        process.env[TRACE_CAPABILITY_ENV_VAR] = NONE_SENTINEL;
        expect(buildOn(CHAIN_ID)).toBeNull();
      });

      it("refuses a non-capable chain too", () => {
        process.env[TRACE_CAPABILITY_ENV_VAR] = NONE_SENTINEL;
        expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
      });

      it("names itself as the reason, so the refusal is actionable", () => {
        process.env[TRACE_CAPABILITY_ENV_VAR] = NONE_SENTINEL;
        buildOn(CHAIN_ID);
        const line = warnLines(REFUSAL)[0];
        expect(line).toContain("no chain is configured as trace-capable");
        expect(line).toContain(`${TRACE_CAPABILITY_ENV_VAR}=${NONE_SENTINEL}`);
      });

      it("is not read as an override that failed to parse", () => {
        // It must not take the fallback path, which would restore the
        // surveyed set and make `none` mean its opposite.
        process.env[TRACE_CAPABILITY_ENV_VAR] = NONE_SENTINEL;
        buildOn(CHAIN_ID);
        expect(warnLines(FELL_BACK)).toHaveLength(0);
        expect(
          warn.mock.calls.some((c) =>
            String(c[0]).includes("is not a chain ID"),
          ),
        ).toBe(false);
      });

      it("is case-insensitive, since it is prose rather than an ID", () => {
        process.env[TRACE_CAPABILITY_ENV_VAR] = "NONE";
        expect(buildOn(CHAIN_ID)).toBeNull();
        expect(warnLines(FELL_BACK)).toHaveLength(0);
      });
    });

    describe("the refusal does not repeat on every reconcile", () => {
      it("reports one refusal across repeated reconciles", () => {
        // `synchronizeData` runs on a 30 second interval and re-maps every
        // workflow, so an unlatched refusal is one line per refused workflow
        // every 30 seconds for the life of the pod, which buries the first.
        for (let i = 0; i < 3; i += 1) {
          expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
        }
        expect(warnLines(REFUSAL)).toHaveLength(1);
      });

      it("reports a different chain separately", () => {
        // Latched on the pair, not the workflow: moving a workflow to another
        // non-capable chain is a new fact.
        buildOn(UNTRACEABLE_CHAIN_ID);
        buildOn(SECOND_UNTRACEABLE_CHAIN_ID);
        expect(warnLines(REFUSAL)).toHaveLength(2);
      });

      it("reports again after the pair registered in between", () => {
        // A transition latch, not a permanent gag. The mirror of `reconnect()`
        // clearing `traceUnsupported` so the runtime verdict is re-learned.
        process.env[TRACE_CAPABILITY_ENV_VAR] = NONE_SENTINEL;
        expect(buildOn(CHAIN_ID)).toBeNull();
        delete process.env[TRACE_CAPABILITY_ENV_VAR];
        expect(buildOn(CHAIN_ID)).not.toBeNull();
        process.env[TRACE_CAPABILITY_ENV_VAR] = NONE_SENTINEL;
        expect(buildOn(CHAIN_ID)).toBeNull();
        expect(warnLines(REFUSAL)).toHaveLength(2);
      });

      it("parses a bad token once per refusal, not once per lookup", () => {
        // The refusal path asks twice, through `isTraceCapableChain` and
        // through `describeTraceCapableChains`. Re-reading and re-parsing the
        // variable on each call emitted the dropped-token warn twice.
        process.env[TRACE_CAPABILITY_ENV_VAR] = `nonsense,${CHAIN_ID}`;
        expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
        expect(warnLines('entry "nonsense" is not a chain ID')).toHaveLength(1);
      });

      it("parses a bad token once across repeated reconciles", () => {
        process.env[TRACE_CAPABILITY_ENV_VAR] = `nonsense,${CHAIN_ID}`;
        for (let i = 0; i < 3; i += 1) {
          expect(buildOn(CHAIN_ID)).not.toBeNull();
        }
        expect(warnLines('entry "nonsense" is not a chain ID')).toHaveLength(1);
      });

      it("re-resolves when the value actually changes", () => {
        // Memoised on the value, not resolved once at module load: the
        // override stays live-readable, which is what lets these cases set it
        // without a module-registry reset.
        process.env[TRACE_CAPABILITY_ENV_VAR] = String(UNTRACEABLE_CHAIN_ID);
        expect(buildOn(UNTRACEABLE_CHAIN_ID)).not.toBeNull();
        process.env[TRACE_CAPABILITY_ENV_VAR] = String(CHAIN_ID);
        expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
      });

      describe("a workflow leaving the active set forgets its refusals", () => {
        // The reconciler prunes its own skip latch when a workflow leaves the
        // active set, and calls this on the same trigger. Clearing the two on
        // different triggers left a disable-then-enable reporting the generic
        // `invalid config` line while the line that names the chain and the
        // allowed set stayed latched, which is the wrong half to keep.

        it("reports again after the workflow left and came back", () => {
          expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
          expect(warnLines(REFUSAL)).toHaveLength(1);

          forgetTraceRefusalsFor(WORKFLOW_ID);

          expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
          expect(warnLines(REFUSAL)).toHaveLength(2);
        });

        it("forgets every chain the workflow was refused on", () => {
          // The reconciler knows the workflow left, not which chains it was
          // refused on, so one call has to drop them all.
          buildOn(UNTRACEABLE_CHAIN_ID);
          buildOn(SECOND_UNTRACEABLE_CHAIN_ID);
          expect(warnLines(REFUSAL)).toHaveLength(2);

          forgetTraceRefusalsFor(WORKFLOW_ID);

          buildOn(UNTRACEABLE_CHAIN_ID);
          buildOn(SECOND_UNTRACEABLE_CHAIN_ID);
          expect(warnLines(REFUSAL)).toHaveLength(4);
        });

        it("leaves another workflow's latch alone", () => {
          // Pruning one workflow must not re-arm the rest, or one disable
          // re-reports every refusal in the deployment.
          expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
          expect(warnLines(REFUSAL)).toHaveLength(1);

          forgetTraceRefusalsFor(`${WORKFLOW_ID}-other`);

          expect(buildOn(UNTRACEABLE_CHAIN_ID)).toBeNull();
          expect(warnLines(REFUSAL)).toHaveLength(1);
        });

        it("does not let one workflow id prune another it prefixes", () => {
          // A workflow id is free-form text, so the latch key's workflow half
          // is compared whole. `wf-trace-1:1` on chain 1 keys
          // `wf-trace-1:1:1`, which a `wf-trace-1:` prefix test would match
          // and wrongly re-arm.
          const nested = `${WORKFLOW_ID}:1`;
          const buildNested = () =>
            buildRegistration(
              makeWorkflow({}, UNTRACEABLE_CHAIN_ID, nested),
              NETWORKS,
            );

          expect(buildNested()).toBeNull();
          expect(warnLines(nested)).toHaveLength(1);

          forgetTraceRefusalsFor(WORKFLOW_ID);

          expect(buildNested()).toBeNull();
          expect(warnLines(nested)).toHaveLength(1);
        });
      });
    });
  });

  describe("configHash", () => {
    it("is stable for an unchanged filter", () => {
      const hash = build({ traceSelector: PAUSE_SELECTOR })?.configHash;
      // Asserted non-empty first. Two undefined hashes compare equal, so
      // without this the case passes against a mapper that builds no trace
      // registration at all.
      expect(hash).toEqual(expect.any(String));
      expect(build({ traceSelector: PAUSE_SELECTOR })?.configHash).toBe(hash);
    });

    it("changes when any part of the filter changes", () => {
      const base = build({ traceSelector: PAUSE_SELECTOR })?.configHash;
      const hashes = [
        build({ traceSelector: "0xdeadbeef" })?.configHash,
        build({ traceSelector: PAUSE_SELECTOR, traceCaller: CALLER })
          ?.configHash,
        build({ traceSelector: PAUSE_SELECTOR, traceStatus: "any" })
          ?.configHash,
        build({ traceSelector: PAUSE_SELECTOR, traceMinValueWei: "1" })
          ?.configHash,
        build({
          traceSelector: PAUSE_SELECTOR,
          traceCallTypes: ["DELEGATECALL"],
        })?.configHash,
      ];
      for (const hash of hashes) {
        expect(hash).not.toBe(base);
      }
      // All distinct from each other too, so two different filters cannot
      // collide into one listener.
      expect(new Set([base, ...hashes]).size).toBe(hashes.length + 1);
    });
  });
});
