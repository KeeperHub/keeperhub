import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SQS_CALLER_ATTR,
  SQS_SIGNATURE_ATTR,
  SQS_TIMESTAMP_ATTR,
  signSqsMessageAttributes,
  verifySqsMessageSignature,
} from "../lib/sqs-message-auth";
import { executorMessageSchema } from "./message-schema";

// Shared anti-drift vector: the scheduler and event-tracker keep byte-identical
// SIGN-only copies of the scheme. These exact inputs must produce this exact
// signature in all three packages (mirrored in their own unit suites), so a
// divergence in any copy fails CI.
const FIXED_SECRET = "test-shared-secret";
const FIXED_CALLER = "scheduler";
const FIXED_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/123456789012/keeperhub-workflow-queue-test";
const FIXED_BODY = JSON.stringify({
  workflowId: "wf_1",
  scheduleId: "sch_1",
  triggerTime: "2026-01-01T00:00:00.000Z",
  triggerType: "schedule",
});
const FIXED_TS = 1_700_000_000;
const FIXED_SIG =
  "52a1fbfe8524879f745928cde4565fb86bbe4e00c75f3ad9f4935e633c7e7328";

// Queue URL used for the round-trip tests below.
const QUEUE = "https://sqs.us-east-1.amazonaws.com/000000000000/local-queue";

let savedSecret: string | undefined;
let savedPrevious: string | undefined;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  savedSecret = process.env.INTERNAL_SERVICE_HMAC_SECRET;
  savedPrevious = process.env.INTERNAL_SERVICE_HMAC_SECRET_PREVIOUS;
  process.env.INTERNAL_SERVICE_HMAC_SECRET = "unit-secret";
  delete process.env.INTERNAL_SERVICE_HMAC_SECRET_PREVIOUS;
});

afterEach(() => {
  setEnv("INTERNAL_SERVICE_HMAC_SECRET", savedSecret);
  setEnv("INTERNAL_SERVICE_HMAC_SECRET_PREVIOUS", savedPrevious);
});

describe("sqs-message-auth signing", () => {
  it("matches the shared anti-drift vector", () => {
    process.env.INTERNAL_SERVICE_HMAC_SECRET = FIXED_SECRET;
    const attrs = signSqsMessageAttributes(
      FIXED_CALLER,
      FIXED_QUEUE_URL,
      FIXED_BODY,
      FIXED_TS
    );
    expect(attrs[SQS_SIGNATURE_ATTR].StringValue).toBe(FIXED_SIG);
    expect(attrs[SQS_CALLER_ATTR].StringValue).toBe(FIXED_CALLER);
    expect(attrs[SQS_TIMESTAMP_ATTR].StringValue).toBe(String(FIXED_TS));
  });

  it("verifies a freshly signed message", () => {
    const body = JSON.stringify({ workflowId: "wf1", triggerType: "schedule" });
    const attrs = signSqsMessageAttributes("scheduler", QUEUE, body);
    const result = verifySqsMessageSignature(QUEUE, body, attrs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.caller).toBe("scheduler");
      expect(Math.abs(result.ageSeconds)).toBeLessThan(5);
    }
  });

  it("throws when the signing secret is unset (fails loud, not silent)", () => {
    delete process.env.INTERNAL_SERVICE_HMAC_SECRET;
    expect(() => signSqsMessageAttributes("scheduler", QUEUE, "{}")).toThrow(
      /INTERNAL_SERVICE_HMAC_SECRET/
    );
  });
});

describe("sqs-message-auth verification failures", () => {
  it("rejects a tampered body", () => {
    const body = JSON.stringify({ workflowId: "wf1", triggerType: "schedule" });
    const attrs = signSqsMessageAttributes("scheduler", QUEUE, body);
    const tampered = JSON.stringify({
      workflowId: "victim",
      triggerType: "schedule",
    });
    const result = verifySqsMessageSignature(QUEUE, tampered, attrs);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a message signed for a different queue (cross-environment replay)", () => {
    const body = JSON.stringify({ workflowId: "wf1", triggerType: "schedule" });
    const attrs = signSqsMessageAttributes("scheduler", QUEUE, body);
    const otherQueue =
      "https://sqs.us-east-1.amazonaws.com/999999999999/other-queue";
    const result = verifySqsMessageSignature(otherQueue, body, attrs);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a message with no signature attributes", () => {
    const result = verifySqsMessageSignature(QUEUE, "{}", undefined);
    expect(result).toEqual({ ok: false, reason: "unsigned" });
  });

  it("rejects an unknown caller", () => {
    const body = "{}";
    const attrs = signSqsMessageAttributes("scheduler", QUEUE, body);
    attrs[SQS_CALLER_ATTR].StringValue = "attacker";
    const result = verifySqsMessageSignature(QUEUE, body, attrs);
    expect(result).toEqual({ ok: false, reason: "unknown_caller" });
  });

  it("rejects a malformed (non 64-hex) signature", () => {
    const body = "{}";
    const attrs = signSqsMessageAttributes("scheduler", QUEUE, body);
    attrs[SQS_SIGNATURE_ATTR].StringValue = "deadbeef";
    const result = verifySqsMessageSignature(QUEUE, body, attrs);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts a signature made with the previous secret during rotation", () => {
    const body = JSON.stringify({ workflowId: "wf1", triggerType: "schedule" });
    // Producer still signs with the old secret.
    process.env.INTERNAL_SERVICE_HMAC_SECRET = "old-secret";
    const attrs = signSqsMessageAttributes("scheduler", QUEUE, body);
    // Executor has rotated: new secret is primary, old is retained as previous.
    process.env.INTERNAL_SERVICE_HMAC_SECRET = "new-secret";
    process.env.INTERNAL_SERVICE_HMAC_SECRET_PREVIOUS = "old-secret";
    expect(verifySqsMessageSignature(QUEUE, body, attrs).ok).toBe(true);
  });

  it("reports a large positive age for an old timestamp", () => {
    const body = JSON.stringify({ workflowId: "wf1", triggerType: "schedule" });
    const oldTs = Math.floor(Date.now() / 1000) - 10_000;
    const attrs = signSqsMessageAttributes("scheduler", QUEUE, body, oldTs);
    const result = verifySqsMessageSignature(QUEUE, body, attrs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ageSeconds).toBeGreaterThan(9_000);
    }
  });
});

describe("executorMessageSchema", () => {
  it("accepts a valid schedule message", () => {
    expect(
      executorMessageSchema.safeParse({
        triggerType: "schedule",
        workflowId: "wf1",
        scheduleId: "s1",
        triggerTime: "2026-01-01T00:00:00.000Z",
      }).success
    ).toBe(true);
  });

  it("accepts a valid block message", () => {
    expect(
      executorMessageSchema.safeParse({
        triggerType: "block",
        workflowId: "wf1",
        userId: "u1",
        triggerData: {
          blockNumber: 1,
          blockHash: "0xhash",
          blockTimestamp: 1,
          parentHash: "0xparent",
        },
      }).success
    ).toBe(true);
  });

  it("accepts a valid event message with arbitrary triggerData", () => {
    expect(
      executorMessageSchema.safeParse({
        triggerType: "event",
        workflowId: "wf1",
        userId: "u1",
        triggerData: { contractAddress: "0xabc", anything: [1, 2, 3] },
      }).success
    ).toBe(true);
  });

  it("accepts valid manual and webhook messages", () => {
    const base = {
      workflowId: "wf1",
      userId: "u1",
      executionId: "e1",
      input: { foo: "bar" },
    };
    expect(
      executorMessageSchema.safeParse({ ...base, triggerType: "manual" }).success
    ).toBe(true);
    expect(
      executorMessageSchema.safeParse({ ...base, triggerType: "webhook" })
        .success
    ).toBe(true);
  });

  it("rejects a missing workflowId", () => {
    expect(
      executorMessageSchema.safeParse({
        triggerType: "schedule",
        scheduleId: "s1",
        triggerTime: "t",
      }).success
    ).toBe(false);
  });

  it("rejects an unknown triggerType", () => {
    expect(
      executorMessageSchema.safeParse({
        triggerType: "attacker",
        workflowId: "wf1",
      }).success
    ).toBe(false);
  });

  it("rejects a manual message without an executionId", () => {
    expect(
      executorMessageSchema.safeParse({
        triggerType: "manual",
        workflowId: "wf1",
        userId: "u1",
        input: {},
      }).success
    ).toBe(false);
  });
});
