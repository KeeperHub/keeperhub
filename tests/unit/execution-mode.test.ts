import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {},
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

import { CONFIG } from "../../keeperhub-executor/config";
import { resolveDispatchTarget } from "../../keeperhub-executor/execution-mode";
import type { WorkflowNode } from "../../lib/workflow/store";

function makeNode(
  type: "trigger" | "action" | "add",
  actionType?: string
): WorkflowNode {
  return {
    id: `node-${Math.random()}`,
    position: { x: 0, y: 0 },
    data: {
      label: "Test",
      type,
      config: actionType ? { actionType } : {},
    },
  } as WorkflowNode;
}

describe("resolveDispatchTarget", () => {
  describe("complex mode", () => {
    const originalMode = CONFIG.executionMode;

    beforeEach(() => {
      (CONFIG as { executionMode: string }).executionMode = "complex";
    });

    afterEach(() => {
      (CONFIG as { executionMode: string }).executionMode = originalMode;
    });

    it("returns in-process for empty nodes", () => {
      expect(resolveDispatchTarget([])).toBe("in-process");
    });

    it("returns in-process for trigger-only nodes", () => {
      const nodes = [makeNode("trigger")];
      expect(resolveDispatchTarget(nodes)).toBe("in-process");
    });

    it("returns in-process for read-only web3 actions", () => {
      const nodes = [
        makeNode("trigger"),
        makeNode("action", "web3/check-balance"),
        makeNode("action", "web3/read-contract"),
      ];
      expect(resolveDispatchTarget(nodes)).toBe("in-process");
    });

    it("returns in-process for web2 actions", () => {
      const nodes = [
        makeNode("trigger"),
        makeNode("action", "discord/send-message"),
        makeNode("action", "webhook/send-webhook"),
      ];
      expect(resolveDispatchTarget(nodes)).toBe("in-process");
    });

    it("returns k8s-job for web3 write actions", () => {
      const nodes = [
        makeNode("trigger"),
        makeNode("action", "web3/transfer-funds"),
      ];
      expect(resolveDispatchTarget(nodes)).toBe("k8s-job");
    });

    it("returns k8s-job if any node is a write action", () => {
      const nodes = [
        makeNode("trigger"),
        makeNode("action", "web3/check-balance"),
        makeNode("action", "web3/write-contract"),
        makeNode("action", "discord/send-message"),
      ];
      expect(resolveDispatchTarget(nodes)).toBe("k8s-job");
    });

    it("returns k8s-job for transfer-token", () => {
      const nodes = [makeNode("action", "web3/transfer-token")];
      expect(resolveDispatchTarget(nodes)).toBe("k8s-job");
    });

    it("returns k8s-job for approve-token", () => {
      const nodes = [makeNode("action", "web3/approve-token")];
      expect(resolveDispatchTarget(nodes)).toBe("k8s-job");
    });

    it("returns in-process for unknown action types", () => {
      const nodes = [makeNode("action", "nonexistent/action")];
      expect(resolveDispatchTarget(nodes)).toBe("in-process");
    });

    it("returns in-process for nodes without actionType", () => {
      const nodes = [makeNode("action")];
      expect(resolveDispatchTarget(nodes)).toBe("in-process");
    });
  });

  describe("isolated mode (default)", () => {
    it("always returns k8s-job regardless of nodes", () => {
      expect(resolveDispatchTarget([])).toBe("k8s-job");
      expect(
        resolveDispatchTarget([makeNode("action", "web3/check-balance")])
      ).toBe("k8s-job");
      expect(
        resolveDispatchTarget([makeNode("action", "discord/send-message")])
      ).toBe("k8s-job");
    });
  });

  describe("process mode", () => {
    const originalMode = CONFIG.executionMode;

    it("always returns api regardless of nodes", () => {
      (CONFIG as { executionMode: string }).executionMode = "process";
      expect(resolveDispatchTarget([])).toBe("api");
      expect(
        resolveDispatchTarget([makeNode("action", "web3/transfer-funds")])
      ).toBe("api");
      (CONFIG as { executionMode: string }).executionMode = originalMode;
    });
  });
});
