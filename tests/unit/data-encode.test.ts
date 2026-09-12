import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type EncodeCoreInput,
  type EncodeInput,
  encodeStep,
} from "@/plugins/data/steps/encode";

type EncodeSuccess = {
  success: true;
  result: string | string[];
  map: Record<string, string>;
  count: number;
  operation: string;
  format: string;
};

type EncodeFailure = { success: false; error: string };

function makeInput(overrides: Partial<EncodeCoreInput>): EncodeInput {
  return { value: "SKY", ...overrides } as EncodeInput;
}

async function run(
  overrides: Partial<EncodeCoreInput>
): Promise<EncodeSuccess | EncodeFailure> {
  return (await encodeStep(makeInput(overrides))) as
    | EncodeSuccess
    | EncodeFailure;
}

describe("data/encode", () => {
  it("matches the hand-written string-to-bytes32 loop it replaces", async () => {
    // The duplicated script builds the hex, then right-pads to 64 chars.
    const expected = `0x${Buffer.from("SKY", "utf8").toString("hex").padEnd(64, "0")}`;
    const result = await run({ value: "SKY" });

    expect(result.success).toBe(true);
    expect((result as EncodeSuccess).result).toBe(expected);
    expect((result as EncodeSuccess).map.SKY).toBe(expected);
    expect((result as EncodeSuccess).count).toBe(1);
  });

  it("encodes a JSON array into an array plus a lookup map", async () => {
    const result = (await run({ value: '["SKY", "MKR"]' })) as EncodeSuccess;

    expect(result.success).toBe(true);
    expect(Array.isArray(result.result)).toBe(true);
    expect(result.count).toBe(2);
    expect(result.map.MKR).toBe(
      `0x${Buffer.from("MKR", "utf8").toString("hex").padEnd(64, "0")}`
    );
  });

  it("pads left when asked, for big-endian style values", async () => {
    const result = (await run({
      value: "SKY",
      format: "bytes32",
      padding: "left",
    })) as EncodeSuccess;

    expect(result.result).toBe(
      `0x${Buffer.from("SKY", "utf8").toString("hex").padStart(64, "0")}`
    );
  });

  it("honours the smaller fixed sizes", async () => {
    const bytes8 = (await run({
      value: "SKY",
      format: "bytes8",
    })) as EncodeSuccess;
    const bytes16 = (await run({
      value: "SKY",
      format: "bytes16",
    })) as EncodeSuccess;

    expect(bytes8.result).toHaveLength(2 + 16);
    expect(bytes16.result).toHaveLength(2 + 32);
  });

  it("leaves hex unpadded", async () => {
    const result = (await run({
      value: "SKY",
      format: "hex",
    })) as EncodeSuccess;

    expect(result.result).toBe("0x534b59");
  });

  it("round-trips through base64", async () => {
    const encoded = (await run({
      value: "SKY",
      format: "base64",
    })) as EncodeSuccess;
    const decoded = (await run({
      operation: "decode",
      value: encoded.result as string,
      format: "base64",
    })) as EncodeSuccess;

    expect(decoded.result).toBe("SKY");
  });

  it("decodes a padded bytes32 back to the original string", async () => {
    const result = (await run({
      operation: "decode",
      value: `0x${Buffer.from("SKY", "utf8").toString("hex").padEnd(64, "0")}`,
      format: "bytes32",
    })) as EncodeSuccess;

    expect(result.result).toBe("SKY");
  });

  it("decodes a left-padded value when told the padding side", async () => {
    const result = (await run({
      operation: "decode",
      value: `0x${Buffer.from("SKY", "utf8").toString("hex").padStart(64, "0")}`,
      format: "bytes32",
      padding: "left",
    })) as EncodeSuccess;

    expect(result.result).toBe("SKY");
  });

  it("fails when the value does not fit the chosen size", async () => {
    const result = await run({ value: "a-very-long-name", format: "bytes8" });

    expect(result.success).toBe(false);
    expect((result as EncodeFailure).error).toContain("does not fit");
  });

  it("fails on a non-hex value when decoding hex", async () => {
    const result = await run({ operation: "decode", value: "not-hex" });

    expect(result.success).toBe(false);
    expect((result as EncodeFailure).error).toContain("not a hex string");
  });

  it("fails on an empty value", async () => {
    const result = await run({ value: "   " });

    expect(result.success).toBe(false);
    expect((result as EncodeFailure).error).toContain("required");
  });
});
