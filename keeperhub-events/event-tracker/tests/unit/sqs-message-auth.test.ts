import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SQS_SIGNATURE_ATTR,
  signSqsMessageAttributes,
} from "../../lib/sqs-message-auth";

// Shared anti-drift vector. These exact inputs must produce this exact
// signature here, in the app's lib/sqs-message-auth.ts, and in the scheduler
// copy. A mismatch means a copy drifted from the scheme and the executor would
// reject this producer's messages.
const FIXED_SECRET = "test-shared-secret";
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

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.INTERNAL_SERVICE_HMAC_SECRET;
  process.env.INTERNAL_SERVICE_HMAC_SECRET = FIXED_SECRET;
});

afterEach(() => {
  process.env.INTERNAL_SERVICE_HMAC_SECRET = savedSecret;
});

describe("event-tracker sqs-message-auth", () => {
  it("matches the shared anti-drift signature vector", () => {
    const attrs = signSqsMessageAttributes(
      "scheduler",
      FIXED_QUEUE_URL,
      FIXED_BODY,
      FIXED_TS,
    );
    expect(attrs[SQS_SIGNATURE_ATTR].StringValue).toBe(FIXED_SIG);
  });
});
