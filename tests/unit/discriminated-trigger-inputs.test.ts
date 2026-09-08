/**
 * Discriminated trigger inputs — Vitest fixture (TEST-02)
 *
 * Covers:
 *   - 4 discriminants × accept-payload (manual / schedule / webhook /
 *     on-chain-event)
 *   - 4 discriminants × reject-malformed-payload
 *   - on-chain-event field-name regression guard (Pitfall 2):
 *     the wrong field names `event` / `contract` MUST NOT alias to the
 *     correct names `eventName` / `address`. Both must be silently
 *     dropped as extras.
 *   - Backward-compat normalization (Pitfall 10): payload without `type`
 *     is treated as { type: "manual", ...rest }; existing flat-bag
 *     callers of MANUAL-trigger workflows keep working.
 *   - detectListingTriggerType DB-enum mapping for all 5 values
 *     including Block → on-chain-event (Block shares the discriminant
 *     with Event for input-shape purposes).
 *
 * NB on schedule/webhook/on-chain-event + missing `type`:
 *   The contract is "flat-bag payloads default to manual." This benefits
 *   manual-trigger workflows. For non-manual triggers the per-slug tool
 *   advertises the correct discriminant in its inputSchema; agents that
 *   omit `type` get a Zod error pointing at the missing discriminant.
 *   This is INTENDED — event-trigger workflows were not historically
 *   callable via call_workflow_<slug> with a flat-bag payload (they are
 *   fired by the event-tracker, not by MCP), so there is no regression
 *   surface here. Do NOT "fix" the schedule-rejects-empty-payload test.
 */
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  buildTriggerInputSchema,
  detectListingTriggerType,
  normalizeTriggerInput,
} from "@/lib/mcp/trigger-input-schema";

function makeNodes(triggerType: string): unknown[] {
  return [
    {
      id: "n1",
      type: "trigger",
      data: {
        type: "trigger",
        label: "Trigger",
        config: { triggerType },
      },
    },
    {
      id: "n2",
      type: "action",
      data: { type: "action", label: "Action", config: {} },
    },
  ];
}

function expectParseThrows(schema: ZodTypeAny, payload: unknown): void {
  expect(() => schema.parse(payload)).toThrow();
}

describe("discriminated trigger inputs (TEST-02)", () => {
  describe("buildTriggerInputSchema — manual discriminant", () => {
    const schema = buildTriggerInputSchema("manual");

    it("parses { type: 'manual' } unchanged", () => {
      expect(schema.parse({ type: "manual" })).toEqual({ type: "manual" });
    });

    it("parses {} via preprocess → { type: 'manual' }", () => {
      expect(schema.parse({})).toEqual({ type: "manual" });
    });

    it("parses null via preprocess → { type: 'manual' }", () => {
      expect(schema.parse(null)).toEqual({ type: "manual" });
    });

    it("parses undefined via preprocess → { type: 'manual' }", () => {
      expect(schema.parse(undefined)).toEqual({ type: "manual" });
    });

    it("parses a flat-bag payload — extras are stripped (backward compat)", () => {
      // This is the canonical PITFALL 10 regression case: existing agents
      // calling call_workflow_<slug> with { someField: "value" } continue
      // to succeed. Extras are stripped by Zod's default strip-mode.
      expect(schema.parse({ someField: "value" })).toEqual({
        type: "manual",
      });
    });

    it("rejects { type: 'webhook' } under the manual schema", () => {
      expectParseThrows(schema, { type: "webhook" });
    });
  });

  describe("buildTriggerInputSchema — schedule discriminant", () => {
    const schema = buildTriggerInputSchema("schedule");

    it("parses { type: 'schedule' } unchanged", () => {
      expect(schema.parse({ type: "schedule" })).toEqual({
        type: "schedule",
      });
    });

    it("rejects {} (preprocess defaults to manual, fails the schedule branch — INTENDED, see file header)", () => {
      expectParseThrows(schema, {});
    });

    it("rejects { type: 'manual' } under the schedule schema", () => {
      expectParseThrows(schema, { type: "manual" });
    });
  });

  describe("buildTriggerInputSchema — webhook discriminant", () => {
    const schema = buildTriggerInputSchema("webhook");

    it("parses the full webhook payload with all optional fields", () => {
      const payload = {
        type: "webhook",
        method: "POST",
        query: { a: "b" },
        body: { x: 1 },
        headers: { h: "v" },
      };
      expect(schema.parse(payload)).toEqual(payload);
    });

    it("parses the minimal { type: 'webhook' } — all fields are optional", () => {
      expect(schema.parse({ type: "webhook" })).toEqual({
        type: "webhook",
      });
    });

    it("rejects { type: 'webhook', method: 123 } — method must be a string", () => {
      expectParseThrows(schema, { type: "webhook", method: 123 });
    });

    it("rejects { type: 'webhook', query: { a: 1 } } — query values must be strings", () => {
      expectParseThrows(schema, { type: "webhook", query: { a: 1 } });
    });

    it("silently drops chainId (extra field from wrong discriminant)", () => {
      // chainId is not a webhook field; Zod strips it by default. This
      // documents the strip-extras behavior — not a rejection.
      const parsed = schema.parse({ type: "webhook", chainId: 1 }) as Record<
        string,
        unknown
      >;
      expect(parsed.type).toBe("webhook");
      expect(parsed).not.toHaveProperty("chainId");
    });
  });

  describe("buildTriggerInputSchema — on-chain-event discriminant (PITFALL 2 regression guard)", () => {
    const schema = buildTriggerInputSchema("on-chain-event");

    it("parses the full Event-trigger payload", () => {
      const payload = {
        type: "on-chain-event",
        chainId: 1,
        eventName: "Transfer",
        address: "0xabc",
        blockNumber: 12_345,
      };
      expect(schema.parse(payload)).toEqual(payload);
    });

    it("parses the minimal Block-trigger payload — only chainId required", () => {
      expect(schema.parse({ type: "on-chain-event", chainId: 8453 })).toEqual({
        type: "on-chain-event",
        chainId: 8453,
      });
    });

    it("rejects { type: 'on-chain-event' } — chainId is required", () => {
      expectParseThrows(schema, { type: "on-chain-event" });
    });

    it("rejects chainId as a string — must be a number", () => {
      expectParseThrows(schema, { type: "on-chain-event", chainId: "1" });
    });

    it("rejects negative chainId", () => {
      expectParseThrows(schema, { type: "on-chain-event", chainId: -1 });
    });

    it("REGRESSION GUARD: wrong field names `event` and `contract` MUST NOT alias to `eventName` and `address`", () => {
      // PITFALL 2: the canonical Event trigger outputFields in
      // app/api/mcp/schemas/route.ts use `eventName` and `address`.
      // A payload using n8n's conceptual names `event` and `contract`
      // must NOT be silently accepted as if those names were aliases.
      // Zod strips them as extras and the parsed result has neither
      // eventName nor address set.
      const parsed = schema.parse({
        type: "on-chain-event",
        chainId: 1,
        event: "Transfer",
        contract: "0xabc",
      }) as Record<string, unknown>;
      expect(parsed.type).toBe("on-chain-event");
      expect(parsed.chainId).toBe(1);
      expect(parsed).not.toHaveProperty("event");
      expect(parsed).not.toHaveProperty("contract");
      expect(parsed.eventName).toBeUndefined();
      expect(parsed.address).toBeUndefined();
    });
  });

  describe("normalizeTriggerInput — backward compatibility (PITFALL 10)", () => {
    it("undefined → { type: 'manual' }", () => {
      expect(normalizeTriggerInput(undefined)).toEqual({ type: "manual" });
    });

    it("null → { type: 'manual' }", () => {
      expect(normalizeTriggerInput(null)).toEqual({ type: "manual" });
    });

    it("{} → { type: 'manual' }", () => {
      expect(normalizeTriggerInput({})).toEqual({ type: "manual" });
    });

    it("{ someField: 'value' } → { type: 'manual', someField: 'value' }", () => {
      expect(normalizeTriggerInput({ someField: "value" })).toEqual({
        type: "manual",
        someField: "value",
      });
    });

    it("{ type: 'webhook', method: 'POST' } → unchanged", () => {
      expect(
        normalizeTriggerInput({ type: "webhook", method: "POST" })
      ).toEqual({ type: "webhook", method: "POST" });
    });

    it("string → throws TypeError", () => {
      expect(() => normalizeTriggerInput("string")).toThrow(TypeError);
    });

    it("array → throws TypeError", () => {
      expect(() => normalizeTriggerInput([1, 2, 3])).toThrow(TypeError);
    });

    it("number → throws TypeError", () => {
      expect(() => normalizeTriggerInput(42)).toThrow(TypeError);
    });
  });

  describe("detectListingTriggerType — DB enum mapping", () => {
    it("maps 'Manual' → 'manual'", () => {
      expect(detectListingTriggerType(makeNodes("Manual"))).toBe("manual");
    });

    it("maps 'Schedule' → 'schedule'", () => {
      expect(detectListingTriggerType(makeNodes("Schedule"))).toBe("schedule");
    });

    it("maps legacy 'Scheduled' → 'schedule'", () => {
      expect(detectListingTriggerType(makeNodes("Scheduled"))).toBe("schedule");
    });

    it("maps 'Webhook' → 'webhook'", () => {
      expect(detectListingTriggerType(makeNodes("Webhook"))).toBe("webhook");
    });

    it("maps 'Event' → 'on-chain-event'", () => {
      expect(detectListingTriggerType(makeNodes("Event"))).toBe(
        "on-chain-event"
      );
    });

    it("maps 'Block' → 'on-chain-event' (Block shares the discriminant)", () => {
      // CRITICAL: Block triggers do not get their own discriminant.
      // They share `on-chain-event` because the wire payload for a
      // manual-fire of a Block-trigger workflow uses the same fields
      // (chainId required, blockNumber optional). If a future spec
      // demands a separate `block` discriminant, that is a Plan 48+
      // concern and the test here will catch the change.
      expect(detectListingTriggerType(makeNodes("Block"))).toBe(
        "on-chain-event"
      );
    });

    it("maps unknown triggerType string → 'manual' (defensive default)", () => {
      expect(detectListingTriggerType(makeNodes("FutureTrigger"))).toBe(
        "manual"
      );
    });

    it("empty array → 'manual' (no trigger node)", () => {
      expect(detectListingTriggerType([])).toBe("manual");
    });

    it("null → 'manual' (defensive — not an array)", () => {
      expect(detectListingTriggerType(null)).toBe("manual");
    });

    it("string → 'manual' (defensive — not an array)", () => {
      expect(detectListingTriggerType("not an array")).toBe("manual");
    });

    it("array with no trigger node → 'manual'", () => {
      expect(detectListingTriggerType([{ data: { type: "action" } }])).toBe(
        "manual"
      );
    });

    it("nodes array where trigger node has no config → 'manual'", () => {
      expect(detectListingTriggerType([{ data: { type: "trigger" } }])).toBe(
        "manual"
      );
    });
  });
});
