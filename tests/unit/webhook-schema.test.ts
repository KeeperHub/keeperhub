/**
 * KEEP-828: webhook payload envelope. Contents stay freeform (forwarded to the
 * workflow as trigger input), but the payload must be a JSON object so template
 * references resolve. Arrays and primitives are rejected.
 */
import { describe, expect, it } from "vitest";
import { webhookPayloadSchema } from "@/lib/schemas/webhook";

describe("webhookPayloadSchema", () => {
  it("accepts an object payload with arbitrary fields", () => {
    expect(
      webhookPayloadSchema.safeParse({ foo: "bar", count: 1, nested: {} })
        .success
    ).toBe(true);
  });

  it("accepts an empty object", () => {
    expect(webhookPayloadSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an array payload", () => {
    expect(webhookPayloadSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it("rejects a primitive payload", () => {
    expect(webhookPayloadSchema.safeParse("nope").success).toBe(false);
  });

  it("rejects null", () => {
    expect(webhookPayloadSchema.safeParse(null).success).toBe(false);
  });
});
