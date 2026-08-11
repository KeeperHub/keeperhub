import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getTrialPeriodDays,
  getTrialRepeatCooldownDays,
  getTrialTier,
  isTrialEligible,
  isTrialOfferEligible,
  isTrialPlan,
} from "@/lib/billing/trial";

const DAY_MS = 24 * 60 * 60 * 1000;

type TrialSub = NonNullable<Parameters<typeof isTrialEligible>[0]>;

function makeSub(overrides: Partial<TrialSub> = {}): TrialSub {
  return {
    plan: "free",
    status: "active",
    providerSubscriptionId: null,
    trialStartedAt: null,
    ...overrides,
  } as TrialSub;
}

// Pin the trial tier so tests don't inherit a developer's local TRIAL_TIER
// from .env (getTrialTier reads process.env at call time; CI has no .env).
// Tests that exercise a specific tier re-stub it and unstub after.
beforeEach(() => {
  vi.stubEnv("TRIAL_TIER", "25k");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTrialPeriodDays", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 14 when unset", () => {
    vi.stubEnv("STRIPE_TRIAL_PERIOD_DAYS", undefined);
    expect(getTrialPeriodDays()).toBe(14);
  });

  it("reads the env override", () => {
    vi.stubEnv("STRIPE_TRIAL_PERIOD_DAYS", "7");
    expect(getTrialPeriodDays()).toBe(7);
  });

  it("clamps below the minimum", () => {
    vi.stubEnv("STRIPE_TRIAL_PERIOD_DAYS", "0");
    expect(getTrialPeriodDays()).toBe(14); // 0 is falsy -> default
    vi.stubEnv("STRIPE_TRIAL_PERIOD_DAYS", "-5");
    expect(getTrialPeriodDays()).toBe(1);
  });

  it("clamps above the maximum", () => {
    vi.stubEnv("STRIPE_TRIAL_PERIOD_DAYS", "365");
    expect(getTrialPeriodDays()).toBe(90);
  });

  it("floors fractional values", () => {
    vi.stubEnv("STRIPE_TRIAL_PERIOD_DAYS", "14.9");
    expect(getTrialPeriodDays()).toBe(14);
  });
});

describe("getTrialTier", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 25k when unset", () => {
    vi.stubEnv("TRIAL_TIER", undefined);
    expect(getTrialTier()).toBe("25k");
  });

  it("stays on 25k for the higher Pro tiers", () => {
    vi.stubEnv("TRIAL_TIER", "50k");
    expect(getTrialTier()).toBe("25k");
    vi.stubEnv("TRIAL_TIER", "100k");
    expect(getTrialTier()).toBe("25k");
  });

  it("falls back to the default for a non-Pro or unknown tier", () => {
    vi.stubEnv("TRIAL_TIER", "250k"); // a Business tier, not trial-eligible
    expect(getTrialTier()).toBe("25k");
    vi.stubEnv("TRIAL_TIER", "nonsense");
    expect(getTrialTier()).toBe("25k");
  });
});

describe("isTrialPlan", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true only for the trial tier (25k)", () => {
    expect(isTrialPlan("pro", "25k")).toBe(true);
  });

  it("is false for the paid Pro tiers", () => {
    expect(isTrialPlan("pro", "50k")).toBe(false);
    expect(isTrialPlan("pro", "100k")).toBe(false);
    expect(isTrialPlan("pro", null)).toBe(false);
  });

  it("stays on 25k even when env asks for another tier", () => {
    vi.stubEnv("TRIAL_TIER", "50k");
    expect(isTrialPlan("pro", "25k")).toBe(true);
    expect(isTrialPlan("pro", "50k")).toBe(false);
  });

  it("is false for other plans", () => {
    expect(isTrialPlan("business", "250k")).toBe(false);
    expect(isTrialPlan("free", "25k")).toBe(false);
  });
});

describe("isTrialEligible", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is eligible for a brand-new org with no subscription row", () => {
    expect(isTrialEligible(undefined, "pro", "25k")).toBe(true);
  });

  it("is eligible for a fresh free org", () => {
    expect(isTrialEligible(makeSub(), "pro", "25k")).toBe(true);
  });

  // The plan column is free text and unknown values read as free everywhere
  // else, so eligibility must not disagree with what the org is shown as.
  it("is eligible for a row whose plan parses to free", () => {
    expect(isTrialEligible(makeSub({ plan: "payg" }), "pro", "25k")).toBe(true);
    expect(isTrialEligible(makeSub({ plan: "" }), "pro", "25k")).toBe(true);
  });

  it("is not eligible for non-Pro plans", () => {
    expect(isTrialEligible(undefined, "business", "250k")).toBe(false);
    expect(isTrialEligible(undefined, "enterprise", null)).toBe(false);
    expect(isTrialEligible(undefined, "free", "25k")).toBe(false);
  });

  it("is not eligible for Pro tiers other than 25k", () => {
    expect(isTrialEligible(undefined, "pro", "50k")).toBe(false);
    expect(isTrialEligible(undefined, "pro", "100k")).toBe(false);
    expect(isTrialEligible(undefined, "pro", null)).toBe(false);
  });

  it("is not eligible once a trial was consumed", () => {
    expect(
      isTrialEligible(makeSub({ trialStartedAt: new Date() }), "pro", "25k")
    ).toBe(false);
  });

  it("is not eligible while currently subscribed", () => {
    expect(
      isTrialEligible(
        makeSub({ providerSubscriptionId: "sub_123", plan: "pro" }),
        "pro",
        "25k"
      )
    ).toBe(false);
  });

  it("is not eligible after a prior subscription was reset to free", () => {
    expect(isTrialEligible(makeSub({ status: "canceled" }), "pro", "25k")).toBe(
      false
    );
  });

  it("is not eligible when the trials feature flag is off", () => {
    vi.stubEnv("TRIALS_ENABLED", "false");
    expect(isTrialEligible(undefined, "pro", "25k")).toBe(false);
    expect(isTrialEligible(makeSub(), "pro", "25k")).toBe(false);
  });
});

describe("isTrialOfferEligible", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mirrors isTrialEligible for the fixed Pro 25k offer", () => {
    expect(isTrialOfferEligible(undefined)).toBe(true);
    expect(isTrialOfferEligible(makeSub())).toBe(true);
    expect(isTrialOfferEligible(makeSub({ trialStartedAt: new Date() }))).toBe(
      false
    );
  });

  it("is not eligible when the trials feature flag is off", () => {
    vi.stubEnv("TRIALS_ENABLED", "false");
    expect(isTrialOfferEligible(undefined)).toBe(false);
  });
});

describe("repeat trials (cooldown)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function trialedSub(daysAgo: number): TrialSub {
    // Trialed once, converted, then reset back to free (canceled).
    return makeSub({
      status: "canceled",
      trialStartedAt: new Date(Date.now() - daysAgo * DAY_MS),
    });
  }

  it("stays ineligible after cooldown when repeat trials are off", () => {
    expect(isTrialEligible(trialedSub(200), "pro", "25k")).toBe(false);
  });

  it("re-enables a cold org once the cooldown has elapsed", () => {
    vi.stubEnv("TRIAL_ALLOW_REPEAT", "true");
    // Default cooldown is 90 days; 100 days ago is past it.
    expect(isTrialEligible(trialedSub(100), "pro", "25k")).toBe(true);
  });

  it("stays ineligible before the cooldown elapses", () => {
    vi.stubEnv("TRIAL_ALLOW_REPEAT", "true");
    expect(isTrialEligible(trialedSub(10), "pro", "25k")).toBe(false);
  });

  it("respects a custom cooldown length", () => {
    vi.stubEnv("TRIAL_ALLOW_REPEAT", "true");
    vi.stubEnv("TRIAL_REPEAT_COOLDOWN_DAYS", "30");
    expect(isTrialEligible(trialedSub(45), "pro", "25k")).toBe(true);
    expect(isTrialEligible(trialedSub(20), "pro", "25k")).toBe(false);
  });

  it("never re-enables while the org is actively subscribed", () => {
    vi.stubEnv("TRIAL_ALLOW_REPEAT", "true");
    expect(
      isTrialEligible(
        makeSub({
          plan: "pro",
          status: "active",
          providerSubscriptionId: "sub_live",
          trialStartedAt: new Date(Date.now() - 200 * DAY_MS),
        }),
        "pro",
        "25k"
      )
    ).toBe(false);
  });
});

describe("getTrialRepeatCooldownDays", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 90 when unset", () => {
    vi.stubEnv("TRIAL_REPEAT_COOLDOWN_DAYS", undefined);
    expect(getTrialRepeatCooldownDays()).toBe(90);
  });

  it("reads the env override", () => {
    vi.stubEnv("TRIAL_REPEAT_COOLDOWN_DAYS", "30");
    expect(getTrialRepeatCooldownDays()).toBe(30);
  });

  it("clamps below the minimum", () => {
    vi.stubEnv("TRIAL_REPEAT_COOLDOWN_DAYS", "-5");
    expect(getTrialRepeatCooldownDays()).toBe(1);
  });
});
