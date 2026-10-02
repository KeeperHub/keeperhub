import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PythRegistry } from "../../src/pyth/registry";

const { consume, submit, pendingLookup } = vi.hoisted(() => ({
  consume: vi.fn(),
  submit: vi.fn(),
  pendingLookup: vi.fn(),
}));
vi.mock("../../src/pyth/hermes-stream", () => ({
  consumeHermesStream: consume,
}));
vi.mock("../../src/pyth/client", () => ({
  submitPythObservation: submit,
  fetchPendingPythWorkflows: pendingLookup,
}));
vi.mock("../../lib/utils/logger", () => ({ logger: { warn: vi.fn() } }));
const first = {
  workflowId: "first",
  feedId: "a".repeat(64),
  configHash: "b".repeat(64),
};
const second = { ...first, workflowId: "second" };
let registry: PythRegistry;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  consume.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  submit.mockResolvedValue(undefined);
  pendingLookup.mockResolvedValue(new Set<string>());
  registry = new PythRegistry("test-only-key");
});
afterEach(async () => {
  await registry.stopAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Pyth stream lifecycle", () => {
  it("shares one feed connection and isolates a failing workflow", async () => {
    await registry.reconcile([first, second]);
    expect(consume).toHaveBeenCalledTimes(1);
    const price = {
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    };
    submit.mockRejectedValueOnce(new Error("first workflow unavailable"));
    await consume.mock.calls[0][0].onPrice(price);
    expect(submit.mock.calls.map((call) => call[0].workflowId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("recovers pending deliveries even when no price is arriving", async () => {
    pendingLookup.mockResolvedValue(new Set([first.workflowId]));
    await registry.reconcile([first]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(submit).toHaveBeenCalledWith(first, expect.any(String));
  });

  it("recovers only workflows that have a dispatch pending", async () => {
    pendingLookup.mockResolvedValue(new Set([second.workflowId]));
    await registry.reconcile([first, second]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(submit.mock.calls.map((call) => call[0].workflowId)).toEqual([
      "second",
    ]);
  });

  it("skips the pending lookup while nothing is registered", async () => {
    await vi.advanceTimersByTimeAsync(5000);
    expect(pendingLookup).not.toHaveBeenCalled();
  });

  it("keeps its lease identity across reconnects and asks for a fresh baseline", async () => {
    consume.mockResolvedValueOnce(undefined);
    submit.mockResolvedValue("baseline");
    await registry.reconcile([first]);
    const price = {
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    };
    await consume.mock.calls[0][0].onPrice(price);
    await vi.advanceTimersByTimeAsync(1500);
    expect(consume).toHaveBeenCalledTimes(2);
    const onPrice = consume.mock.calls[1][0].onPrice;
    await onPrice(price);
    submit.mockResolvedValue("observed");
    await onPrice(price);
    const sessions = submit.mock.calls.map((call) => call[1]);
    expect(new Set(sessions).size).toBe(1);
    expect(submit.mock.calls.map((call) => call[3])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("keeps requesting a baseline until the server records one", async () => {
    submit.mockResolvedValueOnce("out_of_order").mockResolvedValue("baseline");
    await registry.reconcile([first]);
    const price = {
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    };
    const { onPrice } = consume.mock.calls[0][0];
    await onPrice(price);
    await onPrice(price);
    await onPrice(price);
    expect(submit.mock.calls.map((call) => call[3])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("bounds concurrent observations on a crowded feed", async () => {
    const crowd = Array.from({ length: 10 }, (_, index) => ({
      ...first,
      workflowId: `workflow-${index}`,
    }));
    let inFlight = 0;
    let peak = 0;
    submit.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return "observed";
    });
    await registry.reconcile(crowd);
    await consume.mock.calls[0][0].onPrice({
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    });
    expect(submit).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });

  it("backs off a feed that drops right after delivering a price", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const price = {
      id: first.feedId,
      price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
    };
    consume.mockImplementation(
      async ({ onPrice }: { onPrice: (value: unknown) => Promise<void> }) => {
        await onPrice(price);
      },
    );
    await registry.reconcile([first]);
    // Connections at 0s, 1s, 3s and 7s: the delivered price does not reset
    // the backoff to its 1s floor.
    await vi.advanceTimersByTimeAsync(6900);
    expect(consume).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(consume).toHaveBeenCalledTimes(4);
  });

  it("does not create replacement streams if shutdown races with reconciliation", async () => {
    await registry.reconcile([first]);
    const reconciliation = registry.reconcile([
      { ...second, feedId: "c".repeat(64) },
    ]);
    await registry.stopAll();
    await reconciliation;
    await registry.reconcile([first]);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
