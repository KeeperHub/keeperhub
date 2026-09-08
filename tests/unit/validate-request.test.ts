/**
 * KEEP-828: shared request-body validation helper. A valid body passes through
 * typed; a malformed body returns a ready-to-send 400.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateBody, validateData } from "@/lib/validate-request";

const schema = z.object({ name: z.string().min(1) }).strict();

function jsonRequest(body: string): Request {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("validateData", () => {
  it("returns typed data on success", () => {
    const result = validateData({ name: "ok" }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("ok");
    }
  });

  it("returns a 400 with flattened details on failure", async () => {
    const result = validateData({ name: "" }, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as {
        error: string;
        details: unknown;
      };
      expect(body.error).toBe("Validation failed");
      expect(body.details).toBeDefined();
    }
  });

  it("rejects unknown fields under strict", () => {
    expect(validateData({ name: "x", extra: 1 }, schema).success).toBe(false);
  });
});

describe("validateBody", () => {
  it("parses and validates a JSON body", async () => {
    const result = await validateBody(
      jsonRequest(JSON.stringify({ name: "a" })),
      schema
    );
    expect(result.success).toBe(true);
  });

  it("returns 400 for malformed JSON", async () => {
    const result = await validateBody(jsonRequest("{not json"), schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toBe("Invalid JSON body");
    }
  });
});
