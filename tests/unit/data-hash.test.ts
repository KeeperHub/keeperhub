import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import { ethers } from "ethers";
import {
  type HashCoreInput,
  type HashInput,
  hashStep,
} from "@/plugins/data/steps/hash";
import { ALGORITHMS } from "@/plugins/data/steps/hash-core";

type HashSuccess = {
  success: true;
  result: string | string[];
  map: Record<string, string>;
  count: number;
  algorithm: string;
  digestBytes: number;
};

type HashFailure = { success: false; error: string };

const FROB_SIG = "frob(bytes32,address,address,address,int256,int256)";
const FORK_SIG = "fork(bytes32,address,address,int256,int256)";
const GRAB_SIG = "grab(bytes32,address,address,address,int256,int256)";

function makeInput(overrides: Partial<HashCoreInput>): HashInput {
  return { value: FROB_SIG, ...overrides } as HashInput;
}

async function run(
  overrides: Partial<HashCoreInput>
): Promise<HashSuccess | HashFailure> {
  return (await hashStep(makeInput(overrides))) as HashSuccess | HashFailure;
}

describe("data/hash", () => {
  it("agrees with ethers.keccak256, the implementation used elsewhere in the repo", async () => {
    const expected = ethers.keccak256(ethers.toUtf8Bytes(FROB_SIG));

    const result = (await run({ algorithm: "keccak256" })) as HashSuccess;

    expect(result.success).toBe(true);
    expect(result.result).toBe(expected);
    expect(result.digestBytes).toBe(32);
  });

  it("defaults to keccak256, because every EVM use wants it", async () => {
    const result = (await run({})) as HashSuccess;

    expect(result.algorithm).toBe("keccak256");
    expect(result.result).toBe(ethers.id(FROB_SIG));
  });

  // The whole reason both algorithms are offered: NIST changed the padding
  // byte after Ethereum had shipped Keccak, so "SHA-3" is a different hash.
  it("does not treat sha3-256 as keccak256", async () => {
    const keccak = (await run({ algorithm: "keccak256" })) as HashSuccess;
    const sha3 = (await run({ algorithm: "sha3-256" })) as HashSuccess;

    expect(keccak.result).not.toBe(sha3.result);
    expect(keccak.result).toBe(
      "0x7608870335497de07dcbe6e81ea8b80ba07e558f715c9dc3370fcf2672212732"
    );
    expect(sha3.result).toBe(
      "0xe99307272267835e3e922bf24408613fa5d700470eca4f4b3b572763fdb4e889"
    );
  });

  describe("function selectors", () => {
    // Verified against the deployed Vat dispatcher at
    // 0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B - each of these four bytes
    // appears in its bytecode.
    it.each([
      [FROB_SIG, "0x76088703"],
      [FORK_SIG, "0x870c616d"],
      [GRAB_SIG, "0x7bab3f40"],
    ])("derives the selector for %s", async (signature, expected) => {
      const result = (await run({
        value: signature,
        outputBytes: 4,
      })) as HashSuccess;

      expect(result.result).toBe(expected);
      expect(result.digestBytes).toBe(4);
    });

    it("pads a selector to the bytes32 topic an anonymous LogNote is filtered by", async () => {
      const result = (await run({
        outputBytes: 4,
        padTo: 32,
      })) as HashSuccess;

      expect(result.result).toBe(
        "0x7608870300000000000000000000000000000000000000000000000000000000"
      );
      expect(result.digestBytes).toBe(32);
    });

    it("matches ethers' own selector derivation", async () => {
      const expected = ethers.FunctionFragment.from(FROB_SIG).selector;

      const result = (await run({ outputBytes: 4 })) as HashSuccess;

      expect(result.result).toBe(expected);
    });
  });

  describe("input encoding", () => {
    // Given 0x1234 both readings succeed and disagree. Nothing but this field
    // decides which one the caller gets.
    it("hashes characters as text and bytes as hex", async () => {
      const asText = (await run({
        value: "0x1234",
        inputEncoding: "utf8",
      })) as HashSuccess;
      const asBytes = (await run({
        value: "0x1234",
        inputEncoding: "hex",
      })) as HashSuccess;

      expect(asText.result).toBe(ethers.id("0x1234"));
      expect(asBytes.result).toBe(ethers.keccak256("0x1234"));
      expect(asText.result).not.toBe(asBytes.result);
    });

    it("never infers hex from a leading 0x", async () => {
      const result = (await run({ value: "0x1234" })) as HashSuccess;

      expect(result.result).toBe(ethers.id("0x1234"));
    });

    it("rejects a non-hex value when hex was declared", async () => {
      const result = (await run({
        value: "hello",
        inputEncoding: "hex",
      })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a hex string");
    });

    it("accepts hex with or without the 0x prefix", async () => {
      const prefixed = (await run({
        value: "0xdeadbeef",
        inputEncoding: "hex",
      })) as HashSuccess;
      const bare = (await run({
        value: "deadbeef",
        inputEncoding: "hex",
      })) as HashSuccess;

      expect(prefixed.result).toBe(bare.result);
    });
  });

  /**
   * Known-answer coverage for every algorithm the dropdown offers.
   *
   * Vectors were produced by independent implementations - Python hashlib for
   * sha256 / sha512 / sha3-256 / ripemd160 / blake2b, and a from-scratch
   * Keccak-256 for keccak256 - never by running this action. sha256("abc") and
   * sha3-256("abc") are the published NIST vectors, which cross-checks the
   * generator itself.
   *
   * "every algorithm has a vector" below fails CI if an algorithm is added to
   * HASHERS without a vector here, so this table cannot silently fall behind.
   */
  const VECTORS = [
    {
      algorithm: "blake2b-256",
      digestBytes: 32,
      abc: "0xbddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
      frob: "0x3ccf6cb7378a814888817b311aecd3e3b5ce135ced41fdedbd79ed6dcc2d21ee",
    },
    {
      algorithm: "keccak256",
      digestBytes: 32,
      abc: "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
      frob: "0x7608870335497de07dcbe6e81ea8b80ba07e558f715c9dc3370fcf2672212732",
    },
    {
      algorithm: "ripemd160",
      digestBytes: 20,
      abc: "0x8eb208f7e05d987a9b044a8e98c6b087f15a0bfc",
      frob: "0xc646765dd423dbf1ca62ea8c4b341b5897860728",
    },
    {
      algorithm: "sha256",
      digestBytes: 32,
      abc: "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      frob: "0xc212ddb6ad00e74cc6f6a6435a3847426ba3dad044e587bf35e4d0b5d928bd59",
    },
    {
      algorithm: "sha3-256",
      digestBytes: 32,
      abc: "0x3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532",
      frob: "0xe99307272267835e3e922bf24408613fa5d700470eca4f4b3b572763fdb4e889",
    },
    {
      algorithm: "sha512",
      digestBytes: 64,
      abc: "0xddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
      frob: "0x42e040e0c39ec4b91dfa5ef59036659fd7fc8923cbb533e83f32e7373fbfe66bd5752d83cb8e685ffec25d10d0d0fbcfa2eabc23f7efd68aef93169817333d55",
    },
  ] as const;

  describe("every algorithm", () => {
    it("has a known-answer vector", () => {
      expect([...VECTORS].map((vector) => vector.algorithm).sort()).toEqual(
        [...ALGORITHMS].sort()
      );
    });

    it.each(VECTORS)(
      "$algorithm hashes a short ASCII input",
      async ({ algorithm, abc }) => {
        const result = (await run({ algorithm, value: "abc" })) as HashSuccess;

        expect(result.success).toBe(true);
        expect(result.result).toBe(abc);
        expect(result.algorithm).toBe(algorithm);
      }
    );

    it.each(VECTORS)(
      "$algorithm hashes a function signature",
      async ({ algorithm, frob }) => {
        const result = (await run({ algorithm })) as HashSuccess;

        expect(result.result).toBe(frob);
      }
    );

    it.each(VECTORS)(
      "$algorithm reports its documented digest width",
      async ({ algorithm, digestBytes }) => {
        const result = (await run({ algorithm, value: "abc" })) as HashSuccess;

        expect(result.digestBytes).toBe(digestBytes);
        expect(result.result).toHaveLength(2 + digestBytes * 2);
      }
    );

    // "abc" as UTF-8 is the bytes 61 62 63, so both routes must converge.
    // Guards the toBytes branch for every algorithm, not just keccak256.
    it.each(VECTORS)(
      "$algorithm agrees between text and equivalent hex bytes",
      async ({ algorithm, abc }) => {
        const asHex = (await run({
          algorithm,
          value: "0x616263",
          inputEncoding: "hex",
        })) as HashSuccess;

        expect(asHex.result).toBe(abc);
      }
    );

    // Catches a wiring mistake that known-answer tests alone would miss only
    // if the wrong vector were also copied: two dropdown entries pointing at
    // the same hasher.
    it("gives a different digest per algorithm for the same input", async () => {
      const digests = await Promise.all(
        ALGORITHMS.map(async (algorithm) => {
          const result = (await run({
            algorithm,
            value: "abc",
          })) as HashSuccess;
          return result.result as string;
        })
      );

      expect(new Set(digests).size).toBe(ALGORITHMS.length);
    });

    it.each(VECTORS)(
      "$algorithm truncates and pads without touching the leading bytes",
      async ({ algorithm, abc }) => {
        const result = (await run({
          algorithm,
          value: "abc",
          outputBytes: 4,
          padTo: 32,
        })) as HashSuccess;

        expect(result.result).toBe(`${abc.slice(0, 10)}${"0".repeat(56)}`);
        expect(result.digestBytes).toBe(32);
      }
    );
  });

  describe("arrays", () => {
    // Assigning "__proto__" on a plain object literal hits the inherited
    // setter, which ignores a string, so the row vanishes while count and
    // result still report it. The value is a JSON array of arbitrary strings,
    // so the key is reachable from a workflow.
    it("keeps a __proto__ entry in map", async () => {
      const result = (await run({
        value: JSON.stringify(["abc", "__proto__", "xyz"]),
      })) as HashSuccess;

      expect(result.count).toBe(3);
      expect(Object.keys(result.map)).toHaveLength(3);
      expect(result.map.__proto__).toBe(ethers.id("__proto__"));
      expect(result.result).toEqual([
        ethers.id("abc"),
        ethers.id("__proto__"),
        ethers.id("xyz"),
      ]);
    });

    it("hashes a JSON array and keys map by the original value", async () => {
      const result = (await run({
        value: JSON.stringify([FROB_SIG, FORK_SIG, GRAB_SIG]),
        outputBytes: 4,
      })) as HashSuccess;

      expect(result.count).toBe(3);
      expect(result.result).toEqual(["0x76088703", "0x870c616d", "0x7bab3f40"]);
      expect(result.map[GRAB_SIG]).toBe("0x7bab3f40");
    });
  });

  describe("refusals", () => {
    it("refuses odd-length hex instead of padding it", async () => {
      const result = (await run({
        value: "0x123",
        inputEncoding: "hex",
      })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("odd number of hex digits");
    });

    it("refuses to truncate beyond the digest width", async () => {
      const result = (await run({
        algorithm: "ripemd160",
        outputBytes: 32,
      })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("only 20 bytes");
    });

    it("refuses to pad to less than the value it holds", async () => {
      const result = (await run({ outputBytes: 4, padTo: 2 })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("shorter than");
    });

    it("treats a blank width as unset rather than zero", async () => {
      const result = (await run({
        outputBytes: "",
        padTo: "",
      })) as HashSuccess;

      expect(result.success).toBe(true);
      expect(result.digestBytes).toBe(32);
    });

    it("rejects a fractional width", async () => {
      const result = (await run({ outputBytes: "2.5" })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("whole number");
    });
  });

  // keccak256 of nothing is a first-class Ethereum constant - EXTCODEHASH
  // returns it for an account that exists with no code (EIP-1052) - so an
  // empty value is hashed rather than refused. data/encode refuses it, which
  // is right there and wrong here.
  describe("empty input", () => {
    const EMPTY_KECCAK =
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

    it("hashes an empty value", async () => {
      const result = (await run({ value: "" })) as HashSuccess;

      expect(result.success).toBe(true);
      expect(result.result).toBe(EMPTY_KECCAK);
    });

    it("agrees with ethers on the empty digest", async () => {
      const result = (await run({ value: "" })) as HashSuccess;

      expect(result.result).toBe(ethers.keccak256("0x"));
    });

    // Reachable both ways before this was fixed, refused one way and not the
    // other. Text-empty and hex-empty are the same zero bytes.
    it("reaches the same digest through empty text and empty hex", async () => {
      const asText = (await run({ value: "" })) as HashSuccess;
      const asHex = (await run({
        value: "0x",
        inputEncoding: "hex",
      })) as HashSuccess;

      expect(asHex.result).toBe(asText.result);
    });

    it("still trims a single value, so a stray newline cannot move the digest", async () => {
      const padded = (await run({ value: `  ${FROB_SIG}\n` })) as HashSuccess;

      expect(padded.result).toBe(ethers.id(FROB_SIG));
    });

    // The escape hatch for whitespace that is meant to be hashed.
    it("does not trim array elements", async () => {
      const result = (await run({
        value: JSON.stringify(["  a  "]),
      })) as HashSuccess;

      expect(result.result).toBe(ethers.id("  a  "));
      expect(result.result).not.toBe(ethers.id("a"));
    });
  });

  // RFC 7693 mixes the digest length into BLAKE2's initial state, and
  // SHA-512/256 has its own IVs under FIPS 180-4, so a cut-down digest is
  // never the shorter standard hash of the same family. Truncation is for
  // selectors only.
  it("truncating sha512 does not produce another standard hash", async () => {
    const truncated = (await run({
      algorithm: "sha512",
      value: "abc",
      outputBytes: 32,
    })) as HashSuccess;
    const sha256 = (await run({
      algorithm: "sha256",
      value: "abc",
    })) as HashSuccess;

    expect(truncated.digestBytes).toBe(32);
    expect(truncated.result).not.toBe(sha256.result);
  });

  describe("invalid input is refused, never substituted", () => {
    // Blank must still fall back: defaults are seeded only on an actionType
    // change, so a node stored before a field existed carries no value for it.
    it.each(["algorithm", "inputEncoding", "outputFormat"])(
      "falls back when %s is blank",
      async (key) => {
        const result = (await run({ [key]: "" })) as HashSuccess;

        expect(result.success).toBe(true);
        expect(result.algorithm).toBe("keccak256");
        // Pins all three fallbacks at once: this value is only produced by
        // keccak256 over utf8 bytes rendered as 0x-hex.
        expect(result.result).toBe(ethers.id(FROB_SIG));
      }
    );

    // An unrecognised value is a typo or a hand-edited config. Substituting
    // the default would hash with an algorithm nobody asked for.
    it("refuses an unknown algorithm rather than defaulting to keccak256", async () => {
      const result = (await run({ algorithm: "md5" })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a recognised hash algorithm");
      expect(result.error).toContain("keccak256");
    });

    it("refuses an unknown input encoding", async () => {
      const result = (await run({ inputEncoding: "ascii" })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a recognised input encoding");
    });

    it("refuses an unknown output format", async () => {
      const result = (await run({ outputFormat: "base-64" })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a recognised output format");
    });

    it("refuses an empty array instead of succeeding with nothing", async () => {
      const result = (await run({ value: "[]" })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("nothing to hash");
    });

    it("refuses more entries than it will hash in one step", async () => {
      const result = (await run({
        value: JSON.stringify(Array.from({ length: 1001 }, (_, i) => `v${i}`)),
      })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("1001 entries");
    });

    // String(item) would have hashed "[object Object]" and "null" happily.
    it.each([
      ['[{"a":1}]', "object"],
      ["[null]", "null"],
    ])("refuses %s, naming the entry", async (value, kind) => {
      const result = (await run({ value })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("entry 0");
      expect(result.error).toContain(kind);
    });

    it("accepts numbers and booleans in an array, which have one text form", async () => {
      const result = (await run({ value: "[1, true]" })) as HashSuccess;

      expect(result.success).toBe(true);
      expect(result.map["1"]).toBe(ethers.id("1"));
      expect(result.map.true).toBe(ethers.id("true"));
    });

    // Number() alone would read each of these as a width without complaint.
    it.each(["1e3", "0x20", "+4", "4.0", "4px"])(
      "refuses %s as a width rather than coercing it",
      async (outputBytes) => {
        const result = (await run({ outputBytes })) as HashFailure;

        expect(result.success).toBe(false);
        expect(result.error).toContain("decimal digits");
      }
    );

    it("accepts a width with surrounding whitespace, which is trimmed first", async () => {
      const result = (await run({ outputBytes: " 4 " })) as HashSuccess;

      expect(result.success).toBe(true);
      expect(result.digestBytes).toBe(4);
    });

    it("explains a value that starts with [ but is not JSON", async () => {
      const result = (await run({ value: "[not json" })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("read as a JSON array");
      expect(result.error).toContain("wrap it");
    });

    it("caps the padded width so a slipped keypress cannot ask for a huge buffer", async () => {
      const result = (await run({ padTo: 1_000_000_000 })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain("above the 1024-byte maximum");
    });

    it("names the offending width in the message", async () => {
      const result = (await run({ outputBytes: "2.5" })) as HashFailure;

      expect(result.success).toBe(false);
      expect(result.error).toContain('"2.5"');
      expect(result.error).toContain("decimal digits");
    });

    it("reports every refusal through the step rather than throwing", async () => {
      for (const bad of [
        { algorithm: "md5" },
        { inputEncoding: "ascii" },
        { value: "[]" },
        { value: "0x123", inputEncoding: "hex" },
        { padTo: 99_999 },
      ]) {
        const result = (await run(
          bad as Partial<HashCoreInput>
        )) as HashFailure;

        expect(result.success).toBe(false);
        expect(result.error.startsWith("Hash failed: ")).toBe(true);
        expect(result.error.length).toBeGreaterThan(
          "Hash failed: ".length + 10
        );
      }
    });
  });

  describe("base64", () => {
    // Real values: base64 of keccak256(FROB) carries + and / and needs padding,
    // so it exercises every difference between the two alphabets at once.
    const B64 = "dgiHAzVJfeB9y+boHqi4C6B+VY9xXJ3DNw/PJnIhJzI=";
    const B64URL = "dgiHAzVJfeB9y-boHqi4C6B-VY9xXJ3DNw_PJnIhJzI";

    it("emits standard base64", async () => {
      const result = (await run({ outputFormat: "base64" })) as HashSuccess;

      expect(result.result).toBe(B64);
    });

    it("emits base64url: substituted characters, no padding", async () => {
      const result = (await run({ outputFormat: "base64url" })) as HashSuccess;

      expect(result.result).toBe(B64URL);
      expect(result.result).not.toContain("+");
      expect(result.result).not.toContain("/");
      expect(result.result).not.toContain("=");
    });

    it("decodes base64 input to the same bytes as text and hex", async () => {
      const asText = (await run({ value: "abc" })) as HashSuccess;
      const asHex = (await run({
        value: "0x616263",
        inputEncoding: "hex",
      })) as HashSuccess;
      const asBase64 = (await run({
        value: "YWJj",
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(asBase64.result).toBe(asText.result);
      expect(asBase64.result).toBe(asHex.result);
    });

    it("accepts the URL-safe alphabet on input", async () => {
      const std = (await run({
        value: B64,
        inputEncoding: "base64",
      })) as HashSuccess;
      const url = (await run({
        value: B64URL,
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(url.result).toBe(std.result);
    });

    it("accepts base64 without padding", async () => {
      const threeBytes = (await run({
        value: "YWJj",
        inputEncoding: "base64",
      })) as HashSuccess;
      const fourPadded = (await run({
        value: "YWJjZA==",
        inputEncoding: "base64",
      })) as HashSuccess;
      const fourStripped = (await run({
        value: "YWJjZA",
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(fourStripped.result).toBe(fourPadded.result);
      expect(fourStripped.result).not.toBe(threeBytes.result);
    });

    it("round-trips an empty payload", async () => {
      const asBase64 = (await run({
        value: "",
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(asBase64.result).toBe(ethers.keccak256("0x"));
    });

    it("ignores whitespace around a base64 payload", async () => {
      const clean = (await run({
        value: "YWJj",
        inputEncoding: "base64",
      })) as HashSuccess;
      const spaced = (await run({
        value: "  YWJj\n",
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(spaced.result).toBe(clean.result);
    });

    it("decodes every entry of an array", async () => {
      const result = (await run({
        value: JSON.stringify(["YWJj", "YWJjZA=="]),
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(result.count).toBe(2);
      expect(result.result).toEqual([ethers.id("abc"), ethers.id("abcd")]);
      expect(result.map.YWJj).toBe(ethers.id("abc"));
    });

    // The padding bytes encode to a long run of A, and the one trailing = the
    // 32-byte length produces is dropped. Worth pinning, since this is the
    // selector-to-topic value in the form a URL would carry it.
    it("encodes a truncated and padded digest", async () => {
      const result = (await run({
        outputBytes: 4,
        padTo: 32,
        outputFormat: "base64url",
      })) as HashSuccess;

      expect(result.result).toBe("dgiHAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      expect(result.digestBytes).toBe(32);
    });

    // 20 bytes is not a multiple of 3, so this is the padded case: one = in
    // standard base64 and none in base64url.
    it("handles a digest whose length is not a multiple of three", async () => {
      const std = (await run({
        algorithm: "ripemd160",
        outputFormat: "base64",
      })) as HashSuccess;
      const url = (await run({
        algorithm: "ripemd160",
        outputFormat: "base64url",
      })) as HashSuccess;

      expect(std.result).toBe("xkZ2XdQj2/HKYuqMSzQbWJeGByg=");
      expect(url.result).toBe("xkZ2XdQj2_HKYuqMSzQbWJeGByg");
    });

    // MIME wraps base64 at 64 or 76 columns, which is what openssl, PEM bodies
    // and most mail tooling emit. Refusing it would send the caller to Text
    // encoding, which hashes the base64 characters and the newlines and returns
    // a digest that looks valid over input they never meant.
    // Only CR and LF are stripped. Stripping spaces too would let prose through
    // whenever the de-spaced text lands on a canonical final character, which
    // is the failure this function exists to prevent, one field away: Text sits
    // one option above Base64 in the select.
    it.each([
      "the quick brown fox",
      "some text here",
      "a b c d",
      "hello world",
    ])(
      "refuses %s rather than hashing it with the spaces removed",
      async (value) => {
        const result = (await run({
          value,
          inputEncoding: "base64",
        })) as HashFailure;

        expect(result.success).toBe(false);
        expect(result.error).toContain("is not base64");
      }
    );

    it("accepts a CRLF-wrapped payload as well as LF", async () => {
      const lf = (await run({
        value: "YWJjZGVmZ2hpamts\nbW5vcHFyc3R1dnd4\neXo=",
        inputEncoding: "base64",
      })) as HashSuccess;
      const crlf = (await run({
        value: "YWJjZGVmZ2hpamts\r\nbW5vcHFyc3R1dnd4\r\neXo=",
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(crlf.result).toBe(lf.result);
    });

    it("accepts MIME line-wrapped base64", async () => {
      const oneLine = (await run({
        value: "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
        inputEncoding: "base64",
      })) as HashSuccess;
      const wrapped = (await run({
        value: "YWJjZGVmZ2hpamts\nbW5vcHFyc3R1dnd4\neXo=",
        inputEncoding: "base64",
      })) as HashSuccess;

      expect(wrapped.success).toBe(true);
      expect(wrapped.result).toBe(oneLine.result);
      expect(oneLine.result).toBe(ethers.id("abcdefghijklmnopqrstuvwxyz"));
    });

    describe("refusals", () => {
      // Buffer.from(x, "base64") silently skips what it does not recognise and
      // returns short, so each of these would otherwise hash different bytes
      // without a word.
      it("refuses a mixture of the two alphabets", async () => {
        const result = (await run({
          value: "ab-d+f",
          inputEncoding: "base64",
        })) as HashFailure;

        expect(result.success).toBe(false);
        expect(result.error).toContain("mixes the standard base64 alphabet");
      });

      it("refuses characters outside base64", async () => {
        const result = (await run({
          value: "not base64!",
          inputEncoding: "base64",
        })) as HashFailure;

        expect(result.success).toBe(false);
        expect(result.error).toContain("is not base64");
      });

      it("refuses a group that ends one character in", async () => {
        const result = (await run({
          value: "YWJjZ",
          inputEncoding: "base64",
        })) as HashFailure;

        expect(result.success).toBe(false);
        expect(result.error).toContain("ends mid-group");
      });

      // "YWJjZB" and "YWJjZA" decode to the same three bytes; only one is the
      // canonical encoding of them.
      it.each(["YWJj=", "YWJjZA=", "YWJj====="])(
        "refuses %s, whose padding does not complete its group",
        async (value) => {
          const result = (await run({
            value,
            inputEncoding: "base64",
          })) as HashFailure;

          expect(result.success).toBe(false);
          expect(result.error).toContain("does not complete its final group");
        }
      );

      it("refuses a non-canonical final character", async () => {
        const result = (await run({
          value: "YWJjZB",
          inputEncoding: "base64",
        })) as HashFailure;

        expect(result.success).toBe(false);
        expect(result.error).toContain("not a canonical base64 encoding");
      });
    });
  });

  it("emits base64 when asked", async () => {
    const result = (await run({ outputFormat: "base64" })) as HashSuccess;

    expect(result.result).toBe(
      Buffer.from(ethers.getBytes(ethers.id(FROB_SIG))).toString("base64")
    );
  });
});
