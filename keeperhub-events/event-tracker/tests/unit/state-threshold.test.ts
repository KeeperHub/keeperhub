import { describe, expect, it } from "vitest";
import {
  buildMulticallPayload,
  evaluateThreshold,
  type StateThresholdSubscription,
  type SubscriptionArmState,
} from "../../src/listener/state-threshold";

const BASE: StateThresholdSubscription = {
  subscriptionId: "sub-1",
  workflowId: "wf-1",
  chainId: 1,
  contractAddress: "0x1111111111111111111111111111111111111111",
  callData: "0xdeadbeef",
  threshold: 100n,
  comparator: "lt",
};

const UNARMED: SubscriptionArmState = { armed: false };

describe("evaluateThreshold", () => {
  it("does not fire when the condition does not hold and was not armed", () => {
    const r = evaluateThreshold(BASE, 200n, 10, UNARMED);
    expect(r.fired).toBeNull();
    expect(r.nextState).toEqual({ armed: false });
  });

  it("fires on the false->true edge and becomes armed", () => {
    const r = evaluateThreshold(BASE, 50n, 10, UNARMED);
    expect(r.fired).not.toBeNull();
    expect(r.fired?.dedupKey).toBe("state:sub-1:10");
    expect(r.fired?.observedValue).toBe(50n);
    expect(r.nextState).toEqual({ armed: true });
  });

  it("does not re-fire on the next block while still in breach", () => {
    const armed: SubscriptionArmState = { armed: true };
    const r = evaluateThreshold(BASE, 40n, 11, armed);
    expect(r.fired).toBeNull();
    expect(r.nextState).toEqual({ armed: true });
  });

  it("re-arms (without firing) once the condition clears, no hysteresis", () => {
    const armed: SubscriptionArmState = { armed: true };
    const r = evaluateThreshold(BASE, 150n, 12, armed);
    expect(r.fired).toBeNull();
    expect(r.nextState).toEqual({ armed: false });
  });

  it("fires again on the next false->true edge after re-arming", () => {
    const r1 = evaluateThreshold(BASE, 150n, 12, { armed: true });
    expect(r1.nextState).toEqual({ armed: false });
    const r2 = evaluateThreshold(BASE, 90n, 13, r1.nextState);
    expect(r2.fired).not.toBeNull();
    expect(r2.fired?.dedupKey).toBe("state:sub-1:13");
  });

  it("honors an asymmetric clearThreshold (hysteresis band)", () => {
    const withHysteresis: StateThresholdSubscription = {
      ...BASE,
      threshold: 100n, // fires when value < 100
      clearThreshold: 120n, // re-arms only once value >= 120
    };
    const armed: SubscriptionArmState = { armed: true };
    // Value crossed back above 100 but not yet past clearThreshold=120:
    // stays armed, no re-fire, no re-arm yet.
    const r1 = evaluateThreshold(withHysteresis, 110n, 20, armed);
    expect(r1.fired).toBeNull();
    expect(r1.nextState).toEqual({ armed: true });

    // Now past clearThreshold: re-arms.
    const r2 = evaluateThreshold(withHysteresis, 125n, 21, r1.nextState);
    expect(r2.fired).toBeNull();
    expect(r2.nextState).toEqual({ armed: false });
  });

  it("supports gt/gte/lte comparators symmetrically", () => {
    const gt: StateThresholdSubscription = { ...BASE, comparator: "gt", threshold: 100n };
    const fireGt = evaluateThreshold(gt, 101n, 1, UNARMED);
    expect(fireGt.fired).not.toBeNull();

    const gte: StateThresholdSubscription = { ...BASE, comparator: "gte", threshold: 100n };
    const fireGte = evaluateThreshold(gte, 100n, 1, UNARMED);
    expect(fireGte.fired).not.toBeNull();

    const lte: StateThresholdSubscription = { ...BASE, comparator: "lte", threshold: 100n };
    const fireLte = evaluateThreshold(lte, 100n, 1, UNARMED);
    expect(fireLte.fired).not.toBeNull();
  });
});

describe("buildMulticallPayload", () => {
  it("wraps calls with allowFailure:true so one revert cannot poison the batch", () => {
    const payload = buildMulticallPayload([
      { contractAddress: "0xaaaa000000000000000000000000000000000a", callData: "0x1111" },
      { contractAddress: "0xbbbb000000000000000000000000000000000b", callData: "0x2222" },
    ]);
    const calls = payload.args[0] as Array<{ target: string; allowFailure: boolean; callData: string }>;
    expect(calls).toHaveLength(2);
    expect(calls[0].allowFailure).toBe(true);
    expect(calls[1].allowFailure).toBe(true);
  });
});
