import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkConfig, NetworksMap, RawWorkflow } from "../../lib/types";
import { logger } from "../../lib/utils/logger";
import { isTraceRegistration } from "../../src/listener/registry";
import { buildRegistration } from "../../src/listener/workflow-mapper";

/**
 * Mapping of a `Trace` trigger node (issue #2464).
 *
 * Nothing built a `TraceRegistration` before this branch existed, so a saved
 * and enabled Trace workflow was admitted by the API and then fell through to
 * `missing eventName` here. The user saw a live workflow that never fired,
 * and the only record of it was one warn line.
 *
 * The filter is re-validated here rather than trusted from the endpoint. A
 * filter the matcher cannot read produces a trigger that registers, never
 * fires and reports nothing anywhere, which is the most expensive failure
 * shape this trigger has.
 */

const CHAIN_ID = 31_337;

const NETWORK: NetworkConfig = {
  id: "local",
  chainId: CHAIN_ID,
  name: "Anvil",
  symbol: "ETH",
  chainType: "evm",
  defaultPrimaryRpc: "http://localhost:8546",
  defaultFallbackRpc: "http://localhost:8546",
  defaultPrimaryWss: "ws://localhost:8546",
  defaultFallbackWss: "ws://localhost:8546",
  isTestnet: true,
  isEnabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const NETWORKS: NetworksMap = { [CHAIN_ID]: NETWORK };

const WATCHED = "0x1111111111111111111111111111111111111111";
const CALLER = "0x2222222222222222222222222222222222222222";
const PAUSE_SELECTOR = "0x8456cb59";

function makeWorkflow(
  configOverrides: Record<string, unknown> = {},
): RawWorkflow {
  return {
    id: "wf-trace-1",
    name: "Pause watcher",
    userId: "user-1",
    nodes: [
      {
        data: {
          config: {
            network: String(CHAIN_ID),
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
    // `frameMatchesSubscriber` compares `frame.to` against
    // `sub.contractAddress.toLowerCase()`, and the frame side is already
    // lower-cased, so a mixed-case config that reached the matcher unchanged
    // would still match. Normalising here keeps the config hash stable
    // instead, so re-saving with different casing does not restart the
    // listener.
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
