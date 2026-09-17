import { describe, expect, it } from "vitest";
import { detectListingTriggerType } from "@/lib/mcp/trigger-input-schema";
import { TRIGGERS } from "@/lib/mcp/workflow-schema-constants";
import { getTriggerOutputFields } from "@/lib/workflow/editor/trigger-output-fields";
import {
  isValidTraceCallTypes,
  isValidTraceSelector,
  normalizeTraceTriggerConfig,
  parseTraceCallTypes,
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

describe("normalizeTraceTriggerConfig", () => {
  it("turns a stored call-type string into the list the tracker expects", () => {
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      traceCallTypes: '["CALL"]',
      traceStatus: "reverted",
    };
    normalizeTraceTriggerConfig(config);
    expect(config).toEqual({
      triggerType: "Trace",
      traceCallTypes: ["CALL"],
      traceStatus: "reverted",
    });
  });

  it("trims the selector it validated trimmed, so a pasted space still matches", () => {
    // isValidTraceSelector accepts "  0x8456cb59  ", and the matcher compares
    // the selector as-is, so an untrimmed value would register and never fire.
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      traceSelector: "  0x8456cb59  ",
    };
    expect(isValidTraceSelector(config.traceSelector)).toBe(true);
    normalizeTraceTriggerConfig(config);
    expect(config.traceSelector).toBe("0x8456cb59");
  });

  it("upper-cases the call types it validated case-insensitively", () => {
    // The tracker upper-cases each entry before testing membership, so a
    // lowercase value from an MCP author is one it would accept. Refusing it
    // here, or forwarding it unchanged, both end in a workflow that shows as
    // enabled and never fires.
    const config: Record<string, unknown> = {
      triggerType: "Trace",
      traceCallTypes: '["call","DelegateCall"]',
    };
    expect(isValidTraceCallTypes(config.traceCallTypes)).toBe(true);
    normalizeTraceTriggerConfig(config);
    expect(config.traceCallTypes).toEqual(["CALL", "DELEGATECALL"]);
  });

  it("still refuses a frame type the matcher has no case for", () => {
    expect(isValidTraceCallTypes('["jump"]')).toBe(false);
  });

  it("does not add a call-type field that was never set", () => {
    const config: Record<string, unknown> = { triggerType: "Trace" };
    normalizeTraceTriggerConfig(config);
    expect(config).not.toHaveProperty("traceCallTypes");
  });
});
