import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logInfo: vi.fn(),
  logSystemWarn: vi.fn(),
}));
vi.mock("@/lib/utils", async () =>
  (await import("../mocks/step-mocks")).utilsGetErrorMessage()
);

const broker = {
  expireDueHeldPayments: vi.fn(),
  selectDueHeldPayments: vi.fn(),
  claimHeldPayment: vi.fn(),
  markBroadcast: vi.fn(),
  markConfirmed: vi.fn(),
  markFailed: vi.fn(),
  selectBroadcastToReconcile: vi.fn(),
};
vi.mock("@/lib/tempo/held-payments", () => ({
  expireDueHeldPayments: (...a: unknown[]) =>
    broker.expireDueHeldPayments(...a),
  selectDueHeldPayments: (...a: unknown[]) =>
    broker.selectDueHeldPayments(...a),
  claimHeldPayment: (...a: unknown[]) => broker.claimHeldPayment(...a),
  markBroadcast: (...a: unknown[]) => broker.markBroadcast(...a),
  markConfirmed: (...a: unknown[]) => broker.markConfirmed(...a),
  markFailed: (...a: unknown[]) => broker.markFailed(...a),
  selectBroadcastToReconcile: (...a: unknown[]) =>
    broker.selectBroadcastToReconcile(...a),
}));

const mockBroadcast = vi.fn();
const mockCheckReceipt = vi.fn();
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  broadcastStoredTempoTx: (...a: unknown[]) => mockBroadcast(...a),
  checkTempoReceipt: (...a: unknown[]) => mockCheckReceipt(...a),
}));

import { processDueHeldPayments } from "@/lib/tempo/broadcast-due";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    chainId: 42_431,
    serializedTx: "0x76blob",
    precomputedHash: "0xhash",
    broadcastTxHash: null,
    status: "pending",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  broker.expireDueHeldPayments.mockResolvedValue(0);
  broker.selectDueHeldPayments.mockResolvedValue([]);
  broker.selectBroadcastToReconcile.mockResolvedValue([]);
  broker.claimHeldPayment.mockImplementation((id: string) =>
    Promise.resolve(row({ id, status: "broadcasting" }))
  );
  broker.markBroadcast.mockResolvedValue({});
  broker.markConfirmed.mockResolvedValue({});
  broker.markFailed.mockResolvedValue({});
  mockBroadcast.mockResolvedValue({ hash: "0xsent", confirmed: false });
});

describe("processDueHeldPayments - broadcast phase", () => {
  it("claims and broadcasts each due row without waiting", async () => {
    broker.selectDueHeldPayments.mockResolvedValue([row({ id: "p1" })]);

    const res = await processDueHeldPayments();

    expect(broker.claimHeldPayment).toHaveBeenCalledWith("p1");
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedHash: "0xhash",
        waitForConfirmation: false,
      })
    );
    expect(broker.markBroadcast).toHaveBeenCalledWith("p1", "0xsent");
    expect(res.broadcast).toBe(1);
  });

  it("skips a row it loses the claim on", async () => {
    broker.selectDueHeldPayments.mockResolvedValue([row({ id: "p1" })]);
    broker.claimHeldPayment.mockResolvedValue(null);

    const res = await processDueHeldPayments();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(res.broadcast).toBe(0);
  });

  it("marks failed when broadcast throws", async () => {
    broker.selectDueHeldPayments.mockResolvedValue([row({ id: "p1" })]);
    mockBroadcast.mockRejectedValue(new Error("underpriced"));

    const res = await processDueHeldPayments();
    expect(broker.markFailed).toHaveBeenCalledWith("p1", "underpriced");
    expect(res.failed).toBe(1);
    expect(res.broadcast).toBe(0);
  });
});

describe("processDueHeldPayments - reconcile phase", () => {
  it("confirms a mined broadcast", async () => {
    broker.selectBroadcastToReconcile.mockResolvedValue([
      row({ id: "p2", status: "broadcast", broadcastTxHash: "0xsent" }),
    ]);
    mockCheckReceipt.mockResolvedValue("confirmed");

    const res = await processDueHeldPayments();
    expect(broker.markConfirmed).toHaveBeenCalledWith("p2", "0xsent");
    expect(res.confirmed).toBe(1);
  });

  it("fails a reverted broadcast", async () => {
    broker.selectBroadcastToReconcile.mockResolvedValue([
      row({ id: "p2", status: "broadcast", broadcastTxHash: "0xsent" }),
    ]);
    mockCheckReceipt.mockResolvedValue("reverted");

    const res = await processDueHeldPayments();
    expect(broker.markFailed).toHaveBeenCalledWith(
      "p2",
      expect.stringContaining("reverted")
    );
    expect(res.failed).toBe(1);
  });

  it("leaves an unmined broadcast pending", async () => {
    broker.selectBroadcastToReconcile.mockResolvedValue([
      row({ id: "p2", status: "broadcast", broadcastTxHash: "0xsent" }),
    ]);
    mockCheckReceipt.mockResolvedValue("pending");

    const res = await processDueHeldPayments();
    expect(broker.markConfirmed).not.toHaveBeenCalled();
    expect(broker.markFailed).not.toHaveBeenCalled();
    expect(res.stillPending).toBe(1);
  });
});

describe("processDueHeldPayments - expiry", () => {
  it("reports expired count from the broker", async () => {
    broker.expireDueHeldPayments.mockResolvedValue(3);
    const res = await processDueHeldPayments();
    expect(res.expired).toBe(3);
  });
});
