/**
 * KH-1: a `tools/call` with `arguments` explicitly `null` fails the SDK's
 * params schema with a raw Zod error, surfaced as -32603 (Internal error)
 * rather than a validation error - indistinguishable from the server being
 * down. Omitting `arguments` entirely doesn't hit that path - it fails one
 * layer in with a proper tool-scoped error instead - but on a tool with no
 * required parameters it should just run. This pins the dispatch-layer
 * default that fixes the null case and lets an all-optional tool run
 * without an arguments key.
 */
import { describe, expect, it } from "vitest";
import { normalizeToolCallArguments } from "@/lib/mcp/normalize-tool-call-arguments";

function toolCall(params: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params,
  };
}

describe("normalizeToolCallArguments", () => {
  it("defaults arguments to {} when the key is omitted entirely", () => {
    const body = toolCall({ name: "get_wallet_integration" });
    const result = normalizeToolCallArguments(body) as typeof body;
    expect(result.params.arguments).toEqual({});
  });

  it("defaults arguments to {} when it is explicitly null", () => {
    const body = toolCall({ name: "get_wallet_integration", arguments: null });
    const result = normalizeToolCallArguments(body) as typeof body;
    expect(result.params.arguments).toEqual({});
  });

  it("leaves a populated arguments object untouched", () => {
    const body = toolCall({
      name: "get_wallet_integration",
      arguments: { integrationId: "abc" },
    });
    const result = normalizeToolCallArguments(body) as typeof body;
    expect(result.params.arguments).toEqual({ integrationId: "abc" });
  });

  it("leaves non-tools/call messages untouched", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect(normalizeToolCallArguments(body)).toEqual(body);
  });

  it("normalizes each message in a JSON-RPC batch", () => {
    const body = [
      toolCall({ name: "list_integrations" }),
      toolCall({ name: "get_wallet_integration", arguments: null }),
    ];
    const result = normalizeToolCallArguments(body) as Array<{
      params: { arguments: unknown };
    }>;
    expect(result[0].params.arguments).toEqual({});
    expect(result[1].params.arguments).toEqual({});
  });

  it("leaves by-position array params untouched", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: [] };
    const result = normalizeToolCallArguments(body) as typeof body;
    expect(Array.isArray(result.params)).toBe(true);
    expect(result).toEqual(body);
  });

  it("passes through malformed bodies without throwing", () => {
    expect(normalizeToolCallArguments(null)).toBeNull();
    expect(normalizeToolCallArguments(undefined)).toBeUndefined();
    expect(normalizeToolCallArguments("not json-rpc")).toBe("not json-rpc");
  });
});
