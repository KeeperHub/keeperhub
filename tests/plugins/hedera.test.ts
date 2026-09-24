import { submitMessage, verifyMessage } from "../../src/plugins/hedera";
import { jest } from "@jest/globals";

describe("Hedera HCS plugin", () => {
  // These tests are integration style and will only run if the environment
  // variables are correctly set and a real Hedera testnet topic is available.
  // They are marked as skipped by default to avoid accidental execution.
  test.skip("submit and verify a message", async () => {
    const payload = { foo: "bar" };
    const result = await submitMessage(payload);
    expect(result.topicId).toBeDefined();
    expect(result.sequenceNumber).toBeDefined();

    const verify = await verifyMessage(
      result.topicId,
      result.sequenceNumber,
      payload
    );
    expect(verify.verified).toBe(true);
    expect(verify.payload).toBe(JSON.stringify(payload));
  });
});
