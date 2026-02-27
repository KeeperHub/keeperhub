import { beforeAll, describe, expect, it } from "vitest";
import { registerProtocol } from "@/keeperhub/lib/protocol-registry";
import { resolveProtocolMeta } from "@/keeperhub/plugins/protocol/steps/resolve-protocol-meta";
import pendleDef from "@/keeperhub/protocols/pendle";

beforeAll(() => {
  registerProtocol(pendleDef);
});

describe("resolveProtocolMeta", () => {
  describe("_actionType resolution (authoritative)", () => {
    it("derives metadata from a valid _actionType", () => {
      const result = resolveProtocolMeta({
        _actionType: "pendle/get-ve-pendle-balance",
      });

      expect(result).toEqual({
        protocolSlug: "pendle",
        contractKey: "vePendle",
        functionName: "balanceOf",
        actionType: "read",
      });
    });

    it("derives write action metadata", () => {
      const result = resolveProtocolMeta({
        _actionType: "pendle/mint-py-from-sy",
      });

      expect(result).toEqual({
        protocolSlug: "pendle",
        contractKey: "router",
        functionName: "mintPyFromSy",
        actionType: "write",
      });
    });

    it("returns undefined for unknown protocol slug", () => {
      const result = resolveProtocolMeta({
        _actionType: "nonexistent/some-action",
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for unknown action slug", () => {
      const result = resolveProtocolMeta({
        _actionType: "pendle/nonexistent-action",
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for malformed _actionType without slash", () => {
      const result = resolveProtocolMeta({
        _actionType: "no-slash-here",
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for empty _actionType", () => {
      const result = resolveProtocolMeta({
        _actionType: "",
      });

      expect(result).toBeUndefined();
    });
  });

  describe("_protocolMeta fallback (legacy nodes)", () => {
    it("parses valid _protocolMeta JSON when _actionType is absent", () => {
      const meta = {
        protocolSlug: "pendle",
        contractKey: "vePendle",
        functionName: "balanceOf",
        actionType: "read" as const,
      };

      const result = resolveProtocolMeta({
        _protocolMeta: JSON.stringify(meta),
      });

      expect(result).toEqual(meta);
    });

    it("returns undefined for invalid JSON in _protocolMeta", () => {
      const result = resolveProtocolMeta({
        _protocolMeta: "not valid json{",
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for empty _protocolMeta string", () => {
      const result = resolveProtocolMeta({
        _protocolMeta: "",
      });

      expect(result).toBeUndefined();
    });
  });

  describe("resolution priority", () => {
    it("_actionType takes priority over _protocolMeta when both are valid", () => {
      const staleMeta = {
        protocolSlug: "pendle",
        contractKey: "market",
        functionName: "expiry",
        actionType: "read" as const,
      };

      const result = resolveProtocolMeta({
        _actionType: "pendle/get-ve-pendle-balance",
        _protocolMeta: JSON.stringify(staleMeta),
      });

      expect(result).toEqual({
        protocolSlug: "pendle",
        contractKey: "vePendle",
        functionName: "balanceOf",
        actionType: "read",
      });
    });

    it("falls back to _protocolMeta when _actionType is non-protocol", () => {
      const meta = {
        protocolSlug: "pendle",
        contractKey: "vePendle",
        functionName: "balanceOf",
        actionType: "read" as const,
      };

      const result = resolveProtocolMeta({
        _actionType: "webhook/send-webhook",
        _protocolMeta: JSON.stringify(meta),
      });

      expect(result).toEqual(meta);
    });
  });

  describe("edge cases", () => {
    it("returns undefined when neither field is provided", () => {
      const result = resolveProtocolMeta({});

      expect(result).toBeUndefined();
    });

    it("returns undefined when both fields are undefined", () => {
      const result = resolveProtocolMeta({
        _actionType: undefined,
        _protocolMeta: undefined,
      });

      expect(result).toBeUndefined();
    });

    it("handles _actionType starting with slash", () => {
      const result = resolveProtocolMeta({
        _actionType: "/get-ve-pendle-balance",
      });

      expect(result).toBeUndefined();
    });
  });
});
