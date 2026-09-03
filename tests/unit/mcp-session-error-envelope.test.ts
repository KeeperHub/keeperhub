/**
 * KEEP-474: MCP session bootstrap errors must be JSON-RPC 2.0 compliant
 * with structured `error.code` / `error.data.{reason,hint}` so clients can
 * recover programmatically instead of regex-matching the message body.
 */
import { describe, expect, it } from "vitest";
import {
  buildSessionErrorEnvelope,
  buildSessionErrorResponse,
  SESSION_ERROR_DESCRIPTORS,
  sessionErrorBody,
} from "@/lib/mcp/session-error";

describe("MCP session error envelope (KEEP-474)", () => {
  it("returns a JSON-RPC 2.0 envelope with the documented shape", () => {
    const env = buildSessionErrorEnvelope("session_not_found");
    expect(env.jsonrpc).toBe("2.0");
    expect(env.id).toBeNull();
    expect(env.error.code).toBe(-32_001);
    expect(env.error.message).toBe("Session not found");
    expect(env.error.data.reason).toBe("session_not_found");
    expect(env.error.data.hint.length).toBeGreaterThan(20);
  });

  it.each([
    ["session_not_found", -32_001, 404],
    ["session_expired", -32_002, 404],
    ["session_not_initialized", -32_003, 400],
    ["missing_session_id", -32_004, 400],
  ] as const)("%s maps to JSON-RPC code %d and HTTP %d", (reason, jsonRpcCode, httpStatus) => {
    const env = buildSessionErrorEnvelope(reason);
    expect(env.error.code).toBe(jsonRpcCode);
    expect(env.error.data.reason).toBe(reason);
    expect(SESSION_ERROR_DESCRIPTORS[reason].httpStatus).toBe(httpStatus);
  });

  it("falls back to session_not_found descriptor for unknown codes", () => {
    const env = buildSessionErrorEnvelope("totally-unknown-code");
    expect(env.error.code).toBe(-32_001);
    // The reason field still preserves whatever the caller passed in so
    // logs/telemetry can capture the original code.
    expect(env.error.data.reason).toBe("totally-unknown-code");
  });

  it("sessionErrorBody returns valid JSON that parses to the envelope", () => {
    const body = sessionErrorBody("session_expired");
    const parsed = JSON.parse(body);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.error.code).toBe(-32_002);
    expect(parsed.error.data.reason).toBe("session_expired");
  });

  it("every descriptor has a non-empty recovery hint (clients depend on it)", () => {
    for (const code of Object.keys(SESSION_ERROR_DESCRIPTORS)) {
      const descriptor =
        SESSION_ERROR_DESCRIPTORS[
          code as keyof typeof SESSION_ERROR_DESCRIPTORS
        ];
      expect(descriptor.hint.length).toBeGreaterThan(20);
      expect(descriptor.message.length).toBeGreaterThan(0);
    }
  });

  describe("buildSessionErrorResponse", () => {
    it("returns a Response with descriptor-derived HTTP status", async () => {
      const res = buildSessionErrorResponse("session_not_found");
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      const json = (await res.json()) as {
        jsonrpc: string;
        error: { code: number; data: { reason: string } };
      };
      expect(json.jsonrpc).toBe("2.0");
      expect(json.error.code).toBe(-32_001);
      expect(json.error.data.reason).toBe("session_not_found");
    });

    it("uses HTTP 400 for the previously-dead -32003 / -32004 codes", () => {
      expect(buildSessionErrorResponse("session_not_initialized").status).toBe(
        400
      );
      expect(buildSessionErrorResponse("missing_session_id").status).toBe(400);
    });

    it("merges caller-supplied headers (CORS) without clobbering Content-Type", () => {
      const res = buildSessionErrorResponse("session_expired", {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Content-Type")).toBe("application/json");
    });

    it("respects statusOverride when callers need a non-descriptor status", () => {
      const res = buildSessionErrorResponse("session_not_found", {
        statusOverride: 410,
      });
      expect(res.status).toBe(410);
    });
  });
});
