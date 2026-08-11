import { describe, expect, it } from "vitest";
import {
  projectEdgesForPublicFeed,
  projectNodesForPublicFeed,
} from "@/lib/workflow/public-feed-projection";

describe("projectNodesForPublicFeed", () => {
  const node = {
    id: "node-1",
    type: "action",
    position: { x: 120, y: 240 },
    width: 320,
    height: 80,
    selected: true,
    data: {
      type: "action",
      label: "Send funds",
      config: {
        actionType: "web3/transfer",
        triggerType: undefined,
        integrationId: "int_secret_123",
        recipientAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        amount: "5.0",
        privateKey: "0xPRIVATEKEYSHOULDNEVERLEAK",
        webhookUrl: "https://internal.example.com/hook?token=abc",
      },
    },
  };

  it("keeps the fields the marketplace minimap and icons render", () => {
    const [projected] = projectNodesForPublicFeed([node]);
    expect(projected).toEqual({
      id: "node-1",
      type: "action",
      position: { x: 120, y: 240 },
      data: {
        type: "action",
        config: { actionType: "web3/transfer", triggerType: undefined },
      },
    });
  });

  it("strips every sensitive node-config field", () => {
    const serialized = JSON.stringify(projectNodesForPublicFeed([node]));
    expect(serialized).not.toContain("int_secret_123");
    expect(serialized).not.toContain("PRIVATEKEY");
    expect(serialized).not.toContain("0xdeadbeef");
    expect(serialized).not.toContain("internal.example.com");
    expect(serialized).not.toContain("recipientAddress");
    expect(serialized).not.toContain("integrationId");
  });

  it("reads the legacy top-level data.actionType and normalizes the colon form", () => {
    const [projected] = projectNodesForPublicFeed([
      {
        id: "legacy-1",
        type: "action",
        position: { x: 1, y: 2 },
        data: {
          type: "action",
          // Legacy / in-flight shape: actionType at the top of data (colon
          // form), with config holding only sensitive params.
          actionType: "code:run-code",
          config: { contractAddress: "0xSECRETLEGACYADDRESS" },
        },
      },
    ]);
    expect(projected.data).toEqual({
      type: "action",
      config: { actionType: "code/run-code", triggerType: undefined },
    });
    expect(JSON.stringify(projected)).not.toContain("0xSECRETLEGACYADDRESS");
  });

  it("prefers data.config.actionType over the legacy top-level field", () => {
    const [projected] = projectNodesForPublicFeed([
      {
        id: "both-1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          type: "action",
          actionType: "legacy/value",
          config: { actionType: "web3/transfer" },
        },
      },
    ]);
    expect(
      (projected.data as { config: { actionType: unknown } }).config.actionType
    ).toBe("web3/transfer");
  });

  it("preserves trigger type for the trigger icon", () => {
    const [projected] = projectNodesForPublicFeed([
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { type: "trigger", config: { triggerType: "schedule" } },
      },
    ]);
    expect(
      (projected.data as { config: { triggerType: unknown } }).config
        .triggerType
    ).toBe("schedule");
  });

  it("returns an empty array for non-array or malformed input", () => {
    expect(projectNodesForPublicFeed(undefined)).toEqual([]);
    expect(projectNodesForPublicFeed(null)).toEqual([]);
    expect(projectNodesForPublicFeed("nodes")).toEqual([]);
    const [fromGarbage] = projectNodesForPublicFeed([null]);
    expect(fromGarbage).toEqual({
      id: undefined,
      type: undefined,
      position: { x: 0, y: 0 },
      data: {
        type: undefined,
        config: { actionType: undefined, triggerType: undefined },
      },
    });
  });
});

describe("projectEdgesForPublicFeed", () => {
  it("keeps only id, source, and target", () => {
    const [projected] = projectEdgesForPublicFeed([
      {
        id: "edge-1",
        source: "node-1",
        target: "node-2",
        sourceHandle: "out-secret",
        targetHandle: "in-secret",
        data: { condition: "balance > 1000" },
      },
    ]);
    expect(projected).toEqual({
      id: "edge-1",
      source: "node-1",
      target: "node-2",
    });
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("balance");
  });

  it("returns an empty array for non-array input", () => {
    expect(projectEdgesForPublicFeed(undefined)).toEqual([]);
    expect(projectEdgesForPublicFeed({})).toEqual([]);
  });
});
