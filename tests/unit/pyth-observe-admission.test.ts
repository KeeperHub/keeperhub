import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  observePythPrice,
  PythAdmissionRequired,
} from "@/lib/pyth/observe-price";

const { checkDispatchAdmission } = vi.hoisted(() => ({
  checkDispatchAdmission: vi.fn(),
}));
vi.mock("@/lib/billing/dispatch-admission", () => ({ checkDispatchAdmission }));

const nodes = [{ id: "trigger" }];
const transaction = vi.fn();
const database = { transaction } as unknown as Parameters<
  typeof observePythPrice
>[2];
const request = new Request("http://localhost/api/internal/pyth-triggers", {
  method: "POST",
});
const command = {
  action: "observe" as const,
  workflowId: "workflow-test",
  configHash: "b".repeat(64),
  sessionId: "00000000-0000-4000-8000-000000000000",
  update: {
    id: "a".repeat(64),
    price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  checkDispatchAdmission.mockResolvedValue(null);
});

describe("Pyth observation admission", () => {
  it("does not resolve admission for an observation that does not cross", async () => {
    transaction.mockResolvedValueOnce({ outcome: "observed" });

    expect(await observePythPrice(command, request, database)).toEqual({
      outcome: "observed",
    });
    expect(checkDispatchAdmission).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("resolves admission between transactions when a crossing needs it", async () => {
    transaction
      .mockRejectedValueOnce(new PythAdmissionRequired("org-test", nodes))
      .mockResolvedValueOnce({ outcome: "crossed" });

    expect(await observePythPrice(command, request, database)).toEqual({
      outcome: "crossed",
    });
    expect(checkDispatchAdmission).toHaveBeenCalledWith({
      organizationId: "org-test",
      nodes,
    });
    const [first, second] = transaction.mock.invocationCallOrder;
    const [admission] = checkDispatchAdmission.mock.invocationCallOrder;
    expect(admission).toBeGreaterThan(first);
    expect(admission).toBeLessThan(second);
  });

  it("does not swallow other transaction failures", async () => {
    transaction.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(observePythPrice(command, request, database)).rejects.toThrow(
      "database unavailable"
    );
    expect(checkDispatchAdmission).not.toHaveBeenCalled();
  });
});
