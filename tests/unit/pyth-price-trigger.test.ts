import { describe, expect, it } from "vitest";
import { executorMessageSchema } from "@/keeperhub-executor/message-schema";
import {
  buildTriggerInputSchema,
  detectListingTriggerType,
} from "@/lib/mcp/trigger-input-schema";
import {
  evaluatePythPrice,
  type PythCheckpoint,
  parsePythPriceUpdate,
  parsePythTriggerConfig,
} from "@/lib/pyth/price-trigger";
import { hashPythConfig } from "@/lib/pyth/trigger-config";
import { pythDispatchRefusal } from "@/lib/pyth/validate-dispatch";

const feedId = "a".repeat(64);
const config = parsePythTriggerConfig({
  feedId,
  direction: "above",
  threshold: "100",
  rearmThreshold: "95",
  maxAgeSeconds: 30,
});
const empty: PythCheckpoint = { lastPublishTime: null, armed: false };
const update = (price: string, time = 1000, expo = 0) =>
  parsePythPriceUpdate({
    id: feedId,
    price: { price, conf: "1", expo, publish_time: time },
  });

describe("Pyth threshold semantics", () => {
  it("establishes a baseline without firing, even when already above the threshold", () => {
    expect(evaluatePythPrice(config, empty, update("101"), 1000)).toMatchObject(
      { outcome: "baseline", checkpoint: { armed: false } }
    );
  });

  it("fires at equality, stays disarmed in the hysteresis band, then rearms", () => {
    let checkpoint = empty;
    const outcomes = ["94", "100", "101", "98", "100", "95", "100"].map(
      (price, index) => {
        const result = evaluatePythPrice(
          config,
          checkpoint,
          update(price, 1000 + index),
          1000 + index
        );
        checkpoint = result.checkpoint;
        return result.outcome;
      }
    );
    expect(outcomes).toEqual([
      "baseline",
      "crossed",
      "observed",
      "observed",
      "observed",
      "observed",
      "crossed",
    ]);
  });

  it("supports below crossings and negative prices", () => {
    const below = parsePythTriggerConfig({
      ...config,
      direction: "below",
      threshold: "-10",
      rearmThreshold: "-5",
    });
    const baseline = evaluatePythPrice(below, empty, update("-4"), 1000);
    expect(
      evaluatePythPrice(below, baseline.checkpoint, update("-10", 1001), 1001)
        .outcome
    ).toBe("crossed");
  });

  it("preserves integer precision beyond Number.MAX_SAFE_INTEGER", () => {
    const precise = parsePythTriggerConfig({
      ...config,
      threshold: "9007199254740993",
      rearmThreshold: "9007199254740991",
    });
    const first = evaluatePythPrice(
      precise,
      empty,
      update("9007199254740991"),
      1000
    );
    const below = evaluatePythPrice(
      precise,
      first.checkpoint,
      update("9007199254740992", 1001),
      1001
    );
    expect(below.outcome).toBe("observed");
    expect(
      evaluatePythPrice(
        precise,
        below.checkpoint,
        update("9007199254740993", 1002),
        1002
      ).outcome
    ).toBe("crossed");
  });

  it("compares prices across exponent changes without floating point rounding", () => {
    const precise = parsePythTriggerConfig({
      ...config,
      threshold: "0.000000000000000002",
      rearmThreshold: "0.000000000000000001",
    });
    const first = evaluatePythPrice(
      precise,
      empty,
      update("1", 1000, -18),
      1000
    );
    expect(
      evaluatePythPrice(
        precise,
        first.checkpoint,
        update("20", 1001, -19),
        1001
      ).outcome
    ).toBe("crossed");
  });

  it.each([
    ["stale", update("101", 970), 1000],
    ["future", update("101", 1006), 1000],
    ["out_of_order", update("101", 999), 1000],
    ["out_of_order", update("101", 1000), 1000],
    ["wrong_feed", { ...update("101"), id: "b".repeat(64) }, 1000],
  ] as const)(
    "rejects %s updates without changing the checkpoint",
    (outcome, price, now) => {
      const checkpoint = { lastPublishTime: 1000, armed: true };
      const result = evaluatePythPrice(config, checkpoint, price, now);
      expect(result.outcome).toBe(outcome);
      expect(result.checkpoint).toBe(checkpoint);
      expect(result.signal).toBeUndefined();
    }
  );

  it("rebaselines after disconnect or a long gap instead of inventing missed crossings", () => {
    const armed = { lastPublishTime: 1000, armed: true };
    expect(
      evaluatePythPrice(config, armed, update("101", 1001), 1001, true).outcome
    ).toBe("baseline");
    expect(
      evaluatePythPrice(config, armed, update("101", 1030), 1030).outcome
    ).toBe("baseline");
  });

  it("preserves the source identity, expiry and speculative flag through JSON persistence", () => {
    const result = evaluatePythPrice(
      config,
      { lastPublishTime: 999, armed: true },
      update("100"),
      1000
    );
    expect(JSON.parse(JSON.stringify(result.signal))).toMatchObject({
      sourceUpdateId: `pyth:${feedId}:1000`,
      expiresAt: 1_030_000,
      speculative: true,
      price: "100",
    });
  });
});

describe("Pyth configuration and execution boundaries", () => {
  it.each([
    { feedId: "https://attacker.invalid" },
    { direction: "sideways" },
    { threshold: "1e2" },
    { threshold: "Infinity" },
    { threshold: " 100" },
    { rearmThreshold: "100" },
    { rearmThreshold: "101" },
    { maxAgeSeconds: 0 },
    { maxAgeSeconds: 301 },
    { maxAgeSeconds: "5.5" },
  ])("rejects invalid configuration %j", (invalid) => {
    expect(() => parsePythTriggerConfig({ ...config, ...invalid })).toThrow();
  });

  it("normalizes hexadecimal feed IDs and numeric age strings", () => {
    const normalized = parsePythTriggerConfig({
      ...config,
      feedId: `0x${feedId.toUpperCase()}`,
      maxAgeSeconds: "30",
    });
    expect(normalized).toEqual(config);
    expect(hashPythConfig(normalized)).toBe(hashPythConfig(config));
  });

  it.each([
    { price: "NaN" },
    { conf: "-1" },
    { expo: 100_000 },
    { publish_time: 1.1 },
  ])("rejects malformed source data %j", (invalid) => {
    expect(() =>
      parsePythPriceUpdate({
        id: feedId,
        price: { ...update("100").price, ...invalid },
      })
    ).toThrow();
  });

  it("requires a durable execution ID on every upstream queue message", () => {
    expect(
      executorMessageSchema.safeParse({
        triggerType: "upstream",
        workflowId: "w",
        userId: "u",
      }).success
    ).toBe(false);
  });

  it("rejects expired or reconfigured queued signals and accepts a fresh matching one", () => {
    const nodes = [
      {
        data: {
          type: "trigger",
          config: { ...config, triggerType: "Pyth Price" },
        },
      },
    ];
    const signal = evaluatePythPrice(
      config,
      { lastPublishTime: 999, armed: true },
      update("100"),
      1000
    ).signal;
    const input = { ...signal, configHash: hashPythConfig(config) };
    expect(pythDispatchRefusal(nodes, input, 1_001_000)).toBeNull();
    expect(pythDispatchRefusal(nodes, input, 1_030_000)).toContain("expired");
    expect(
      pythDispatchRefusal(nodes, { ...input, configHash: "wrong" }, 1_001_000)
    ).toContain("changed");
  });
});

describe("Pyth MCP discovery", () => {
  it("describes native Pyth workflows as upstream and requires the price payload", () => {
    const kind = detectListingTriggerType([
      { data: { type: "trigger", config: { triggerType: "Pyth Price" } } },
    ]);
    expect(kind).toBe("upstream");
    expect(buildTriggerInputSchema(kind).safeParse({}).success).toBe(false);
  });
});
