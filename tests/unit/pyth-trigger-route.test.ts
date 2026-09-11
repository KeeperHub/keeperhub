import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/internal/pyth-triggers/route";
import { signInternalServiceHeaders } from "../utils/internal-service-auth";

const { observe, select, secrets } = vi.hoisted(() => ({
  observe: vi.fn(),
  select: vi.fn(),
  secrets: vi.fn(),
}));
vi.mock("@/lib/pyth/observe-price", () => ({ observePythPrice: observe }));
vi.mock("@/lib/db", () => ({ db: { select } }));
vi.mock("@/lib/internal-service-hmac-store", () => ({
  lookupHmacSecret: vi.fn(),
  listActiveHmacSecrets: secrets,
}));
vi.mock("@/lib/logging", () => ({
  logInternalAuthEvent: vi.fn(),
  logWarn: vi.fn(),
}));

const url = "http://localhost/api/internal/pyth-triggers";
const secret = "pyth-route-test-secret-only";
const command = {
  action: "observe",
  workflowId: "workflow-test",
  configHash: "b".repeat(64),
  sessionId: randomUUID(),
  update: {
    id: "a".repeat(64),
    price: { price: "100", conf: "1", expo: 0, publish_time: 1000 },
  },
};
function signed(method: "GET" | "POST", body = "", caller = "events") {
  return new Request(url, {
    method,
    headers: signInternalServiceHeaders({ method, url, body, caller, secret }),
    ...(method === "POST" ? { body } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PYTH_API_KEY = "test-pyth-api-key";
  secrets.mockResolvedValue([{ secret, keyVersion: 1 }]);
  observe.mockResolvedValue({ outcome: "baseline" });
});

describe("Pyth internal route authorization", () => {
  it("disables discovery and mutation when the Pyth API key is absent", async () => {
    delete process.env.PYTH_API_KEY;

    const discovery = await GET(signed("GET"));
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({ workflows: [] });

    const mutation = await POST(signed("POST", JSON.stringify(command)));
    expect(mutation.status).toBe(503);
    expect(select).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("discovers only valid Pyth configurations and returns no credentials", async () => {
    const config = {
      triggerType: "Pyth Price",
      feedId: "a".repeat(64),
      direction: "above",
      threshold: "100",
      rearmThreshold: "90",
    };
    const where = vi.fn().mockResolvedValue([
      { id: "valid", nodes: [{ data: { type: "trigger", config } }] },
      {
        id: "invalid",
        nodes: [
          { data: { type: "trigger", config: { triggerType: "Pyth Price" } } },
        ],
      },
      {
        id: "manual",
        nodes: [
          { data: { type: "trigger", config: { triggerType: "Manual" } } },
        ],
      },
    ]);
    select.mockReturnValue({ from: () => ({ innerJoin: () => ({ where }) }) });
    const response = await GET(signed("GET"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workflows).toEqual([
      {
        workflowId: "valid",
        feedId: config.feedId,
        configHash: expect.any(String),
      },
    ]);
    expect(where).toHaveBeenCalledOnce();
  });

  it("rejects unsigned discovery and mutation without touching the database", async () => {
    expect((await GET(new Request(url))).status).toBe(401);
    expect(
      (
        await POST(
          new Request(url, { method: "POST", body: JSON.stringify(command) })
        )
      ).status
    ).toBe(401);
    expect(select).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("rejects an authenticated service other than events", async () => {
    expect(
      (await POST(signed("POST", JSON.stringify(command), "executor"))).status
    ).toBe(403);
    expect(observe).not.toHaveBeenCalled();
  });

  it("binds the signature to the actual request body", async () => {
    const request = signed("POST", JSON.stringify(command));
    const tampered = new Request(url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ ...command, workflowId: "another-workflow" }),
    });
    expect((await POST(tampered)).status).toBe(401);
    expect(observe).not.toHaveBeenCalled();
  });

  it("accepts an events signature and strips caller-supplied ownership", async () => {
    const request = signed(
      "POST",
      JSON.stringify({ ...command, userId: "forged-owner" })
    );
    expect((await POST(request)).status).toBe(200);
    expect(observe).toHaveBeenCalledWith(command, request);
  });

  it.each([
    { ...command, sessionId: "not-a-session" },
    {
      ...command,
      update: {
        ...command.update,
        price: { ...command.update.price, expo: 99 },
      },
    },
    { ...command, action: "execute" },
  ])("rejects malformed authenticated observations", async (invalid) => {
    expect((await POST(signed("POST", JSON.stringify(invalid)))).status).toBe(
      400
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies", async () => {
    expect((await POST(signed("POST", "x".repeat(16_385)))).status).toBe(413);
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not substitute a successful response for a database failure", async () => {
    observe.mockRejectedValue(new Error("database unavailable"));
    await expect(POST(signed("POST", JSON.stringify(command)))).rejects.toThrow(
      "database unavailable"
    );
  });
});
