import { describe, expect, it } from "vitest";
import { detectListingTriggerType } from "@/lib/mcp/trigger-input-schema";
import { TRIGGERS } from "@/lib/mcp/workflow-schema-constants";
import { getTriggerOutputFields } from "@/lib/workflow/editor/trigger-output-fields";
import {
  isValidTraceCallTypes,
  isValidTraceSelector,
  parseTraceCallTypes,
  prepareTraceTriggerConfig,
} from "@/lib/workflow/trace-trigger-config";

// The Trace trigger's payload and config are produced and read by the event
// tracker, a separate package this suite cannot import, so the agreed names
// are listed here and these tests guard the app side against drifting from
// them.
//
// Their limit is worth stating plainly: they compare the app against this
// hand-copied list, not against the tracker. A divergence introduced on the
// tracker side -- a different key spelling, or a value in hex where this side
// documents decimal -- passes every test here. They catch drift within the
// app, and nothing more.
const TRACE_PAYLOAD_KEYS = [
  "blockNumber",
  "transactionHash",
  "transactionIndex",
  "frameIndex",
  "callType",
  "from",
  "to",
  "value",
  "selector",
  "input",
  "depth",
  "reverted",
  "chainId",
] as const;

const TRACE_CONFIG_KEYS = [
  "traceCaller",
  "traceSelector",
  "abiFunction",
  "contractABI",
  "traceCallTypes",
  "traceMinValueWei",
  "traceMinValue",
  "traceStatus",
] as const;

describe("Trace trigger schema", () => {
  it("documents every field the tracker puts in triggerData", () => {
    const fields = TRIGGERS.Trace.outputFields as Record<string, string>;
    for (const key of TRACE_PAYLOAD_KEYS) {
      expect(fields).toHaveProperty(key);
    }
    expect(fields).toHaveProperty("triggeredAt");
  });

  it("offers the same fields to template autocomplete", () => {
    const autocomplete = getTriggerOutputFields("Trace", {}).map(
      (field) => field.field
    );
    expect(autocomplete.sort()).toEqual(
      Object.keys(TRIGGERS.Trace.outputFields).sort()
    );
  });

  it("documents every config key the tracker reads", () => {
    expect(Object.keys(TRIGGERS.Trace.requiredFields).sort()).toEqual([
      "contractAddress",
      "network",
    ]);
    expect(Object.keys(TRIGGERS.Trace.optionalFields).sort()).toEqual(
      [...TRACE_CONFIG_KEYS].sort()
    );
  });

  it("accepts only a 4-byte selector, since anything else matches nothing", () => {
    // The failure being prevented is silent: a selector the matcher can
    // never match registers happily and then never fires, which is
    // indistinguishable from a quiet contract.
    expect(isValidTraceSelector("0x8456cb59")).toBe(true);
    expect(isValidTraceSelector("")).toBe(true);
    expect(isValidTraceSelector(undefined)).toBe(true);
    for (const bad of [
      "pause()",
      "0x845",
      "0x8456cb5",
      "8456cb59",
      "0xzzzzzzzz",
    ]) {
      expect(isValidTraceSelector(bad), bad).toBe(false);
    }
  });

  it("accepts only call types the tracker can read", () => {
    expect(isValidTraceCallTypes(undefined)).toBe(true);
    expect(isValidTraceCallTypes('["CALL","CREATE2"]')).toBe(true);
    expect(isValidTraceCallTypes(["DELEGATECALL"])).toBe(true);
    // A bare string reaching the matcher has .some called on it inside the
    // per-block drain, so it is refused here rather than forwarded.
    expect(isValidTraceCallTypes("CALL")).toBe(false);
    expect(isValidTraceCallTypes('["NOT_A_TYPE"]')).toBe(false);
    expect(isValidTraceCallTypes("{oops")).toBe(false);
  });

  it("shares the on-chain-event input discriminant for MCP callers", () => {
    const nodes = [
      { data: { type: "trigger", config: { triggerType: "Trace" } } },
    ];
    expect(detectListingTriggerType(nodes)).toBe("on-chain-event");
  });
});

describe("parseTraceCallTypes", () => {
  it("parses the JSON string the editor stores", () => {
    expect(parseTraceCallTypes('["CALL","DELEGATECALL"]')).toEqual([
      "CALL",
      "DELEGATECALL",
    ]);
  });

  it("passes an array through and reads an empty string as no filter", () => {
    expect(parseTraceCallTypes(["CALL"])).toEqual(["CALL"]);
    expect(parseTraceCallTypes("")).toEqual([]);
  });

  it("leaves an unreadable value for the validator to refuse, not a wildcard", () => {
    // Returning [] here would silently widen the filter to every frame type.
    expect(parseTraceCallTypes("CALL")).toBe("CALL");
    expect(parseTraceCallTypes('{"a":1}')).toBe('{"a":1}');
  });
});

const WATCHED = "0x1111111111111111111111111111111111111111";

describe("prepareTraceTriggerConfig", () => {
  it("turns a stored call-type string into the list the tracker expects", () => {
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      contractAddress: WATCHED,
      traceCallTypes: '["CALL"]',
      traceStatus: "reverted",
    };
    expect(prepareTraceTriggerConfig(config)).toEqual({ ok: true });
    expect(config).toEqual({
      triggerType: "Trace",
      contractAddress: WATCHED,
      traceCallTypes: ["CALL"],
      traceStatus: "reverted",
    });
  });

  it("trims the selector it validated trimmed, so a pasted space still matches", () => {
    // isValidTraceSelector accepts "  0x8456cb59  ", and the matcher compares
    // the selector as-is, so an untrimmed value would register and never fire.
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      contractAddress: WATCHED,
      traceSelector: "  0x8456cb59  ",
    };
    expect(prepareTraceTriggerConfig(config).ok).toBe(true);
    expect(config.traceSelector).toBe("0x8456cb59");
  });

  it("upper-cases the call types it validated case-insensitively", () => {
    // The tracker upper-cases each entry before testing membership, so a
    // lowercase value from an MCP author is one it would accept. Refusing it
    // here, or forwarding it unchanged, both end in a workflow that shows as
    // enabled and never fires.
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      contractAddress: WATCHED,
      traceCallTypes: '["call","DelegateCall"]',
    };
    expect(prepareTraceTriggerConfig(config).ok).toBe(true);
    expect(config.traceCallTypes).toEqual(["CALL", "DELEGATECALL"]);
  });

  it("still refuses a frame type the matcher has no case for", () => {
    expect(isValidTraceCallTypes('["jump"]')).toBe(false);
  });

  it("does not add a call-type field that was never set", () => {
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      contractAddress: WATCHED,
    };
    prepareTraceTriggerConfig(config);
    expect(config).not.toHaveProperty("traceCallTypes");
  });

  it("refuses a trigger with no watched contract, which would match every frame", () => {
    // Every optional filter is wildcard-on-empty, so this config would fire
    // on every call frame on the chain. `required` in the panel blocks no
    // save, so this check is the only thing that stops it.
    for (const contractAddress of [
      undefined,
      "",
      "   ",
      "0x1234",
      "{{Lookup.address}}",
    ]) {
      const config: Record<string, unknown> = {
        triggerType: "Trace",
        network: "9745",
        contractAddress,
      };
      expect(
        prepareTraceTriggerConfig(config),
        String(contractAddress)
      ).toEqual({ ok: false, reason: "contract-address" });
    }
  });

  it("trims the watched contract it accepted", () => {
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      contractAddress: `  ${WATCHED}  `,
    };
    expect(prepareTraceTriggerConfig(config).ok).toBe(true);
    expect(config.contractAddress).toBe(WATCHED);
  });

  it("leaves a refused config untouched rather than half-normalized", () => {
    // Normalizing without validating would forward a bare string to a
    // matcher that calls .some on it; refusing must not normalize either.
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      contractAddress: WATCHED,
      traceCallTypes: "garbage",
    };
    expect(prepareTraceTriggerConfig(config)).toEqual({
      ok: false,
      reason: "call-types",
    });
    expect(config.traceCallTypes).toBe("garbage");
    expect(config).not.toHaveProperty("traceStatus");
  });

  it("defaults the call outcome to success, which is what the panel shows", () => {
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      contractAddress: WATCHED,
    };
    expect(prepareTraceTriggerConfig(config).ok).toBe(true);
    expect(config.traceStatus).toBe("success");
  });
});
