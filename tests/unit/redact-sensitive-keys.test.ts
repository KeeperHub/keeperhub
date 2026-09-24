import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { redactSensitiveData } from "@/lib/utils/redact";

/**
 * The sensitive-key list is written in the spellings people use, which
 * includes camelCase. The lookup lowered the key it was given and compared it
 * against the list as written, so every camelCase entry with no snake_case
 * twin matched nothing and was logged verbatim into
 * `workflow_execution_logs.input`, which the executions API serves back.
 *
 * `fromEmail` is the one that is live today - this branch is the first to put
 * it in a step's input - but the same hole covered wallet keys and database
 * URLs, and would have opened silently the first time a plugin declared one.
 */
describe("redacting a step's input", () => {
  it.each([
    "fromEmail",
    "privateKey",
    "databaseUrl",
    "connectionString",
    "cardNumber",
    "phoneNumber",
    "socialSecurity",
    "creditCard",
  ])("masks %s, however it is capitalised", (key) => {
    const redacted = redactSensitiveData({
      [key]: "sensitive-value-1234",
    }) as Record<string, string>;
    expect(redacted[key]).not.toBe("sensitive-value-1234");
  });

  it("still masks the snake_case spellings it always did", () => {
    const redacted = redactSensitiveData({
      from_email: "alice@acme.io",
      private_key: "0xdeadbeef",
    }) as Record<string, string>;
    expect(redacted.from_email).not.toBe("alice@acme.io");
    expect(redacted.private_key).not.toBe("0xdeadbeef");
  });

  it("leaves ordinary fields alone", () => {
    expect(
      redactSensitiveData({ summary: "Vault stalled", severity: "error" })
    ).toEqual({ summary: "Vault stalled", severity: "error" });
  });
});
