import { describe, expect, it } from "vitest";
import { detectListingTriggerType } from "@/lib/mcp/trigger-input-schema";
import { TRIGGERS } from "@/lib/mcp/workflow-schema-constants";
import { getTriggerOutputFields } from "@/lib/workflow/editor/trigger-output-fields";
import {
  normalizeTraceTriggerConfig,
  parseTraceCallTypes,
} from "@/lib/workflow/trace-trigger-config";

// The Trace trigger's triggerData is produced by buildTracePayload in
// keeperhub-events/event-tracker/src/listener/trace-trigger.ts, and its config
// is read by buildTraceRegistration in
// keeperhub-events/event-tracker/src/listener/workflow-mapper.ts. The tracker
// is a separate package this suite cannot import, so the names are listed here
// and these tests guard the app side against drifting from them.
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
] as const;

const TRACE_CONFIG_KEYS = [
  "traceCaller",
  "traceSelector",
  "abiFunction",
  "contractABI",
  "traceCallTypes",
  "traceMinValueWei",
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

  it("leaves an unreadable value for the tracker to refuse, not a wildcard", () => {
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

  it("does not add a call-type field that was never set", () => {
    const config: Record<string, unknown> = { triggerType: "Trace" };
    normalizeTraceTriggerConfig(config);
    expect(config).not.toHaveProperty("traceCallTypes");
  });
});
