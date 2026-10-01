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
  format?: string;
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

  describe("decimal-to-hex", () => {
    const UINT256_MAX =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    it("emits minimal hex by default", async () => {
      const result = (await run({
        operation: "decimal-to-hex",
        value: "255",
      })) as EncodeSuccess;

      expect(result.success).toBe(true);
      expect(result.result).toBe("0xff");
      expect(result.operation).toBe("decimal-to-hex");
      expect(result.format).toBe("hex");
    });

    it("left-pads to a uint256 word", async () => {
      const result = (await run({
        operation: "decimal-to-hex",
        value: "255",
        numberFormat: "uint256",
      })) as EncodeSuccess;

      expect(result.result).toBe(`0x${"ff".padStart(64, "0")}`);
      expect(result.format).toBe("uint256");
    });

    it("reports the number format the user chose, not the byte width", async () => {
      for (const numberFormat of ["hex", "uint256", "uint128", "uint64"]) {
        const result = (await run({
          operation: "decimal-to-hex",
          value: "1",
          numberFormat,
        })) as EncodeSuccess;

        expect(result.format).toBe(numberFormat);
      }
    });

    it("honours the narrower integer widths", async () => {
      const uint128 = (await run({
        operation: "decimal-to-hex",
        value: "1",
        numberFormat: "uint128",
      })) as EncodeSuccess;
      const uint64 = (await run({
        operation: "decimal-to-hex",
        value: "1",
        numberFormat: "uint64",
      })) as EncodeSuccess;

      expect(uint128.result).toBe(`0x${"1".padStart(32, "0")}`);
      expect(uint64.result).toBe(`0x${"1".padStart(16, "0")}`);
    });

    it("ignores the text padding side: a number is never right-padded", async () => {
      const result = (await run({
        operation: "decimal-to-hex",
        value: "255",
        numberFormat: "uint256",
        padding: "right",
      })) as EncodeSuccess;

      expect(result.result).toBe(`0x${"ff".padStart(64, "0")}`);
    });

    it("ignores the text format field", async () => {
      const result = (await run({
        operation: "decimal-to-hex",
        value: "255",
        format: "base64",
      })) as EncodeSuccess;

      expect(result.result).toBe("0xff");
    });

    it("keeps a uint256 exact", async () => {
      const result = (await run({
        operation: "decimal-to-hex",
        value: UINT256_MAX,
        numberFormat: "uint256",
      })) as EncodeSuccess;

      expect(result.result).toBe(`0x${"f".repeat(64)}`);
    });

    it("converts a JSON array into an array plus a lookup map", async () => {
      const result = (await run({
        operation: "decimal-to-hex",
        value: '["255", "4096"]',
      })) as EncodeSuccess;

      expect(result.result).toEqual(["0xff", "0x1000"]);
      expect(result.map).toEqual({ "255": "0xff", "4096": "0x1000" });
      expect(result.count).toBe(2);
    });

    it("accepts a JSON array of numbers as well as strings", async () => {
      const result = (await run({
        operation: "decimal-to-hex",
        value: "[255, 4096]",
      })) as EncodeSuccess;

      expect(result.result).toEqual(["0xff", "0x1000"]);
    });

    describe("boundaries", () => {
      it("converts zero, the minimum", async () => {
        const minimal = (await run({
          operation: "decimal-to-hex",
          value: "0",
        })) as EncodeSuccess;
        const word = (await run({
          operation: "decimal-to-hex",
          value: "0",
          numberFormat: "uint256",
        })) as EncodeSuccess;

        expect(minimal.result).toBe("0x0");
        expect(word.result).toBe(`0x${"0".repeat(64)}`);
      });

      it.each([
        ["uint64", 8, "18446744073709551615"],
        ["uint128", 16, "340282366920938463463374607431768211455"],
        [
          "uint256",
          32,
          "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        ],
      ])(
        "accepts the exact maximum of %s",
        async (numberFormat, bytes, max) => {
          const result = (await run({
            operation: "decimal-to-hex",
            value: max,
            numberFormat,
          })) as EncodeSuccess;

          expect(result.success).toBe(true);
          expect(result.result).toBe(`0x${"ff".repeat(bytes)}`);
        }
      );

      it.each([
        ["uint64", "18446744073709551616", "18446744073709551615"],
        [
          "uint128",
          "340282366920938463463374607431768211456",
          "340282366920938463463374607431768211455",
        ],
        [
          "uint256",
          "115792089237316195423570985008687907853269984665640564039457584007913129639936",
          "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        ],
      ])(
        "refuses one over the maximum of %s and names the maximum",
        async (numberFormat, overflow, max) => {
          const result = await run({
            operation: "decimal-to-hex",
            value: overflow,
            numberFormat,
          });

          expect(result.success).toBe(false);
          expect((result as EncodeFailure).error).toBe(
            `Decimal to hex failed: ${overflow} does not fit in ${numberFormat}: the maximum is ${max}.`
          );
        }
      );

      it("has no maximum for minimal hex", async () => {
        const result = (await run({
          operation: "decimal-to-hex",
          value:
            "115792089237316195423570985008687907853269984665640564039457584007913129639936",
        })) as EncodeSuccess;

        expect(result.result).toBe(`0x1${"0".repeat(64)}`);
      });

      it("accepts surrounding whitespace", async () => {
        const result = (await run({
          operation: "decimal-to-hex",
          value: " 255 ",
        })) as EncodeSuccess;

        expect(result.result).toBe("0xff");
      });
    });

    describe("refusals", () => {
      it("names a negative number", async () => {
        const result = await run({ operation: "decimal-to-hex", value: "-5" });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toBe(
          'Decimal to hex failed: "-5" is negative. Decimal to hex accepts a whole number from 0 upwards.'
        );
      });

      it("names a fraction", async () => {
        const result = await run({ operation: "decimal-to-hex", value: "1.5" });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toBe(
          'Decimal to hex failed: "1.5" is not a whole number. Decimal to hex accepts a whole number from 0 upwards.'
        );
      });

      it("names text", async () => {
        const result = await run({ operation: "decimal-to-hex", value: "abc" });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toBe(
          'Decimal to hex failed: "abc" is not a decimal number. Decimal to hex accepts a whole number from 0 upwards.'
        );
      });

      it("treats a hex value as text: this is the wrong operation for it", async () => {
        const result = await run({
          operation: "decimal-to-hex",
          value: "0xff",
        });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toContain(
          "is not a decimal number"
        );
      });

      it("fails the whole step when one array entry is invalid", async () => {
        const result = await run({
          operation: "decimal-to-hex",
          value: '["255", "-1"]',
        });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toContain('"-1" is negative');
      });

      it("still requires a value", async () => {
        const result = await run({ operation: "decimal-to-hex", value: "  " });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toBe(
          "Decimal to hex failed: Value is required."
        );
      });
    });
  });

  describe("hex-to-decimal", () => {
    it("converts prefixed hex to a decimal string", async () => {
      const result = (await run({
        operation: "hex-to-decimal",
        value: "0xff",
      })) as EncodeSuccess;

      expect(result.success).toBe(true);
      expect(result.result).toBe("255");
      expect(result.operation).toBe("hex-to-decimal");
    });

    it("reports no format: none took part in the conversion", async () => {
      const result = (await run({
        operation: "hex-to-decimal",
        value: "0xff",
        format: "bytes32",
      })) as EncodeSuccess;

      expect("format" in result).toBe(false);
      expect(result.format).toBeUndefined();
    });

    it("accepts hex without the 0x prefix", async () => {
      const result = (await run({
        operation: "hex-to-decimal",
        value: "ff",
      })) as EncodeSuccess;

      expect(result.result).toBe("255");
    });

    it("reads a left-padded uint256 word", async () => {
      const result = (await run({
        operation: "hex-to-decimal",
        value: `0x${"ff".padStart(64, "0")}`,
      })) as EncodeSuccess;

      expect(result.result).toBe("255");
    });

    it("keeps a uint256 exact instead of rounding through Number", async () => {
      const result = (await run({
        operation: "hex-to-decimal",
        value: `0x${"f".repeat(64)}`,
      })) as EncodeSuccess;

      expect(result.result).toBe(
        "115792089237316195423570985008687907853269984665640564039457584007913129639935"
      );
    });

    it("round-trips with decimal-to-hex", async () => {
      const encoded = (await run({
        operation: "decimal-to-hex",
        value: "123456789",
        numberFormat: "uint256",
      })) as EncodeSuccess;
      const decoded = (await run({
        operation: "hex-to-decimal",
        value: encoded.result as string,
      })) as EncodeSuccess;

      expect(decoded.result).toBe("123456789");
    });

    it("converts a JSON array into an array plus a lookup map", async () => {
      const result = (await run({
        operation: "hex-to-decimal",
        value: '["0xff", "0x1000"]',
      })) as EncodeSuccess;

      expect(result.result).toEqual(["255", "4096"]);
      expect(result.map).toEqual({ "0xff": "255", "0x1000": "4096" });
    });

    describe("boundaries", () => {
      it("converts zero, the minimum, however it is padded", async () => {
        for (const value of ["0x0", "0x00", "0", `0x${"0".repeat(64)}`]) {
          const result = (await run({
            operation: "hex-to-decimal",
            value,
          })) as EncodeSuccess;

          expect(result.result).toBe("0");
        }
      });

      it("has no maximum: a value above uint256 still converts", async () => {
        const result = (await run({
          operation: "hex-to-decimal",
          value: `0x1${"0".repeat(64)}`,
        })) as EncodeSuccess;

        expect(result.result).toBe(
          "115792089237316195423570985008687907853269984665640564039457584007913129639936"
        );
      });

      it("accepts odd-length hex and surrounding whitespace", async () => {
        const result = (await run({
          operation: "hex-to-decimal",
          value: " 0xf ",
        })) as EncodeSuccess;

        expect(result.result).toBe("15");
      });
    });

    describe("refusals", () => {
      it("names a non-hex value, as decode does", async () => {
        const result = await run({
          operation: "hex-to-decimal",
          value: "0xzz",
        });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toBe(
          'Hex to decimal failed: "0xzz" is not a hex string.'
        );
      });

      it("names a bare 0x prefix with no digits", async () => {
        const result = await run({ operation: "hex-to-decimal", value: "0x" });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toContain("not a hex string");
      });

      it("names a negative hex value", async () => {
        const result = await run({
          operation: "hex-to-decimal",
          value: "-0xff",
        });

        expect(result.success).toBe(false);
        expect((result as EncodeFailure).error).toBe(
          'Hex to decimal failed: "-0xff" is negative. Hex to decimal accepts an unsigned hex value, with or without 0x.'
        );
      });

      it("treats a decimal as text unless it happens to be valid hex", async () => {
        // Every decimal digit is a hex digit, so "255" reads as 0x255.
        const looksLikeHex = (await run({
          operation: "hex-to-decimal",
          value: "255",
        })) as EncodeSuccess;
        const doesNot = await run({
          operation: "hex-to-decimal",
          value: "25.5",
        });

        expect(looksLikeHex.result).toBe("597");
        expect(doesNot.success).toBe(false);
        expect((doesNot as EncodeFailure).error).toContain("not a hex string");
      });
    });
  });

  it("prefixes text failures with the text operation", async () => {
    const encode = await run({ value: "a-very-long-name", format: "bytes8" });
    const decode = await run({ operation: "decode", value: "not-hex" });

    expect((encode as EncodeFailure).error).toMatch(/^Encode failed: /);
    expect((decode as EncodeFailure).error).toMatch(/^Decode failed: /);
  });

  it("falls back to encode for an unknown operation", async () => {
    const result = (await run({
      operation: "rot13",
      value: "SKY",
      format: "hex",
    })) as EncodeSuccess;

    expect(result.operation).toBe("encode");
    expect(result.result).toBe("0x534b59");
  });
});
