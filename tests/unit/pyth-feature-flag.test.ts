import { afterEach, describe, expect, it } from "vitest";
import {
  hasPythPriceTrigger,
  isPythPriceTriggerEnabled,
} from "@/lib/pyth/feature-flag";

const originalPythApiKey = process.env.PYTH_API_KEY;

afterEach(() => {
  if (originalPythApiKey === undefined) {
    delete process.env.PYTH_API_KEY;
  } else {
    process.env.PYTH_API_KEY = originalPythApiKey;
  }
});

describe("Pyth Price feature gate", () => {
  it("is enabled only for a non-blank API key", () => {
    delete process.env.PYTH_API_KEY;
    expect(isPythPriceTriggerEnabled()).toBe(false);

    process.env.PYTH_API_KEY = "   ";
    expect(isPythPriceTriggerEnabled()).toBe(false);

    process.env.PYTH_API_KEY = "pyth-api-key";
    expect(isPythPriceTriggerEnabled()).toBe(true);
  });

  it("finds Pyth trigger nodes without treating unrelated data as enabled", () => {
    expect(
      hasPythPriceTrigger([
        { data: { type: "action", config: { actionType: "math" } } },
        { data: { type: "trigger", config: { triggerType: "Pyth Price" } } },
      ])
    ).toBe(true);
    expect(hasPythPriceTrigger(null)).toBe(false);
    expect(
      hasPythPriceTrigger([
        { data: { type: "trigger", config: { triggerType: "Webhook" } } },
      ])
    ).toBe(false);
  });

  // The gate must agree with registration, which only ever reads the first
  // trigger node. A Pyth config anywhere else can never fire.
  it("matches only the node registration would listen for", () => {
    expect(
      hasPythPriceTrigger([
        { data: { type: "action", config: { triggerType: "Pyth Price" } } },
      ])
    ).toBe(false);
    expect(
      hasPythPriceTrigger([
        { data: { type: "trigger", config: { triggerType: "Manual" } } },
        { data: { type: "trigger", config: { triggerType: "Pyth Price" } } },
      ])
    ).toBe(false);
  });
});
