/**
 * Hashing for the Data plugin's Hash step.
 *
 * No "use step" directive: the step file may export only the step function,
 * _integrationType and types, so the algorithm list the tests read lives here
 * rather than being exported from the bundle. The action definition carries its
 * own copy of the option list; data-hash-definition.test.ts asserts the two
 * agree.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";

const HEX_PREFIX = "0x";
const HEX_PATTERN = /^(0x)?[0-9a-fA-F]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*$/;
const DECIMAL_PATTERN = /^[0-9]+$/;
const BASE64_STANDARD_CHARS = /[+/]/;
const BASE64_URL_SAFE_CHARS = /[-_]/;
const BASE64_TRAILING_PADDING = /=+$/;
const BASE64_LINE_BREAKS = /[\r\n]+/g;
const BASE64_DASH = /-/g;
const BASE64_UNDERSCORE = /_/g;
const BASE64_PLUS = /\+/g;
const BASE64_SLASH = /\//g;

/** Widest digest here is 64 bytes and an EVM word is 32; this is only a guard. */
const MAX_WIDTH_BYTES = 1024;

/** Mirrors the cap flatten-findings puts on a runaway source array. */
const MAX_VALUES = 1000;

/**
 * Keccak-256 is NOT SHA3-256. Ethereum adopted Keccak before NIST finalised
 * SHA-3, and NIST then changed the padding byte (0x01 -> 0x06). Same sponge,
 * one byte different, completely unrelated output:
 *
 *   keccak256("frob(bytes32,address,address,address,int256,int256)")
 *     -> 0x76088703...  the selector the Vat dispatcher actually contains
 *   sha3-256(same string)
 *     -> 0xe9930727...  a valid hash that matches nothing on any chain
 *
 * Both are offered, under names that cannot be confused, so nobody has to
 * discover this by watching an eth_getLogs filter silently return zero rows.
 * Anything touching the EVM wants keccak256.
 */
const HASHERS = {
  "blake2b-256": (bytes: Uint8Array) => blake2b(bytes, { dkLen: 32 }),
  keccak256: keccak_256,
  ripemd160,
  sha256,
  "sha3-256": sha3_256,
  sha512,
} as const satisfies Record<string, (bytes: Uint8Array) => Uint8Array>;

export type Algorithm = keyof typeof HASHERS;

export const ALGORITHMS = Object.keys(HASHERS) as Algorithm[];

const INPUT_ENCODINGS = ["utf8", "hex", "base64"] as const;
const OUTPUT_FORMATS = ["hex", "base64", "base64url"] as const;

type InputEncoding = (typeof INPUT_ENCODINGS)[number];
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type HashCoreInput = {
  algorithm?: string;
  value: string;
  inputEncoding?: string;
  outputBytes?: string | number;
  padTo?: string | number;
  outputFormat?: string;
};

export type HashResult =
  | {
      success: true;
      result: string | string[];
      map: Record<string, string>;
      count: number;
      algorithm: Algorithm;
      digestBytes: number;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): HashResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

/**
 * Blank falls back; anything else must be a value we know.
 *
 * The blank case is real: defaults are seeded only on an actionType change, so
 * a node stored before a field existed carries no value for it and has to keep
 * working. A NON-blank value we do not recognise is different - it is a typo,
 * a renamed option or a hand-edited config, and quietly substituting the
 * default there would hash with an algorithm the caller did not ask for, or
 * read their input in an encoding they did not choose. Both are silently wrong
 * answers of exactly the kind this action exists to stop.
 */
function resolveEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string
): T {
  if (raw === undefined || raw === null || `${raw}`.trim() === "") {
    return fallback;
  }
  const candidate = `${raw}`.trim() as T;
  if (!allowed.includes(candidate)) {
    throw new Error(
      `"${raw}" is not a recognised ${label}. Choose one of: ${allowed.join(", ")}.`
    );
  }
  return candidate;
}

/**
 * Blank means "not set" rather than zero: an empty form field must not be read
 * as a request for a zero-byte digest.
 */
function resolveCount(
  raw: string | number | undefined,
  label: string
): number | undefined {
  if (raw === undefined || raw === null || `${raw}`.trim() === "") {
    return undefined;
  }
  const text = `${raw}`.trim();
  // Number() alone would accept "1e3" as 1000, "0x20" as 32 and "+4" as 4, all
  // silently. A width is typed by a person or resolved from a template, so only
  // plain decimal digits are a width. Matches DECIMAL_PATTERN in encode.ts.
  if (!DECIMAL_PATTERN.test(text)) {
    throw new Error(
      `${label} is "${text}", which is not a whole number written in decimal digits.`
    );
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${label} is "${text}", which is not a whole number of 1 or more.`
    );
  }
  // Upper bound so a mistyped width cannot ask for a huge allocation. The
  // widest digest here is 64 bytes and an EVM word is 32, so this is far above
  // any real use; it exists to turn a slipped keypress into a message rather
  // than an out-of-memory in a shared runtime.
  if (parsed > MAX_WIDTH_BYTES) {
    throw new Error(
      `${label} is ${parsed} bytes, which is above the ${MAX_WIDTH_BYTES}-byte maximum.`
    );
  }
  return parsed;
}

/**
 * The single most dangerous field in this action. Given 0x1234, hashing the
 * six characters and hashing the two bytes both succeed and give different
 * answers, with nothing to tell you which one you got. Signatures are text;
 * CREATE2 salts and storage keys are bytes. So the caller states which, and a
 * leading 0x is never treated as a hint.
 */
function toBytes(value: string, encoding: InputEncoding): Uint8Array {
  if (encoding === "utf8") {
    return utf8ToBytes(value);
  }
  if (encoding === "base64") {
    return fromBase64(value);
  }
  return fromHex(value);
}

/**
 * Strict, because Buffer.from(x, "base64") is not: it skips characters it does
 * not recognise and hands back a shorter buffer, so one mistyped character in
 * a payload would hash cleanly as different bytes. Anything that is not one
 * unambiguous encoding of some byte string is refused.
 *
 * Line breaks are the exception, and are stripped rather than refused. MIME
 * wraps base64 at 64 or 76 columns, which is what openssl, PEM bodies and most
 * mail and HTTP tooling emit, and the decoded bytes are identical either way.
 * Refusing it would be worse than useless here: the message would send the
 * caller to Text encoding, which hashes the base64 characters and the newlines
 * and returns a digest that looks entirely valid over input they never meant.
 *
 * Only CR and LF, never \s. Stripping spaces as well would let ordinary prose
 * through whenever the de-spaced text happens to land on a canonical final
 * character: "some text here" would decode and hash, while "hello world" would
 * not, which is both wrong and arbitrary. Input encoding is a select with Text
 * one option above Base64, so that mistake is a single click away.
 */
function fromBase64(value: string): Uint8Array {
  const trimmed = value.trim().replace(BASE64_LINE_BREAKS, "");

  // The alphabets differ in exactly two characters, so a string carrying both
  // encodes nothing in either and guessing which was meant is a coin toss.
  const standard = BASE64_STANDARD_CHARS.test(trimmed);
  const urlSafe = BASE64_URL_SAFE_CHARS.test(trimmed);
  if (standard && urlSafe) {
    throw new Error(
      `"${value}" mixes the standard base64 alphabet (+ and /) with the URL-safe one (- and _), so it encodes nothing in either.`
    );
  }

  const normalised = trimmed.replace(BASE64_DASH, "+").replace(BASE64_UNDERSCORE, "/");
  const body = normalised.replace(BASE64_TRAILING_PADDING, "");
  const padding = normalised.length - body.length;

  if (!BASE64_PATTERN.test(body)) {
    throw new Error(
      `"${value}" is not base64. Set Input encoding to Text to hash it as characters.`
    );
  }

  // A base64 group is four characters; a remainder of one encodes no whole byte.
  if (body.length % 4 === 1) {
    throw new Error(
      `"${value}" ends mid-group, so it does not decode to a whole number of bytes.`
    );
  }

  // Padding is checked rather than merely stripped. At most two characters, and
  // the padded length must complete the final group, so "YWJj=" and "YWJjZA="
  // are refused instead of quietly decoding as though the padding were absent.
  if (padding > 0 && (padding > 2 || (body.length + padding) % 4 !== 0)) {
    throw new Error(
      `"${value}" carries ${padding} padding character${padding === 1 ? "" : "s"}, which does not complete its final group.`
    );
  }

  const bytes = new Uint8Array(Buffer.from(body, "base64"));

  // Re-encoding catches what the pattern cannot: a final character carrying
  // bits that decode to no byte, which several different strings would share.
  if (
    Buffer.from(bytes).toString("base64").replace(BASE64_TRAILING_PADDING, "") !==
    body
  ) {
    throw new Error(
      `"${value}" is not a canonical base64 encoding: its last character carries bits that decode to no byte.`
    );
  }

  return bytes;
}

function fromHex(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!HEX_PATTERN.test(trimmed)) {
    throw new Error(
      `"${value}" is not a hex string. Set Input encoding to Text to hash it as characters.`
    );
  }
  const raw = trimmed.startsWith(HEX_PREFIX) ? trimmed.slice(2) : trimmed;

  // Odd length is refused rather than padded. Prepending a zero nibble would
  // hash 0x0123 for an input of 0x123 without a word, which is the class of
  // wrong-but-plausible answer this action exists to prevent. Left-padding is
  // right for a quantity; hex here declares data, and ethers refuses the same
  // input ("a DataHexstring must have an even number of nibbles"). Which nibble
  // is missing is the caller's to say.
  if (raw.length % 2 !== 0) {
    throw new Error(
      `"${value}" has an odd number of hex digits, so it is not a whole number of bytes. Write the missing nibble explicitly - 0x0123 rather than 0x123 - or hash it as text.`
    );
  }
  return hexToBytes(raw);
}

/**
 * Accept either a single value or a JSON array of values, matching data/encode
 * so the two actions feel the same on the canvas.
 *
 * Empty is hashed, not refused. data/encode rejects it because encoding nothing
 * yields nothing, but every hash is defined over the empty input and
 * keccak256("") is a first-class Ethereum constant: EXTCODEHASH returns
 * c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470 for an
 * account that exists with no code (EIP-1052), which is how a contract tells an
 * empty account from a missing one. Refusing it also made the action
 * inconsistent with itself, since hex "0x" reached the same digest.
 *
 * The field stays required at save time, so a blank config cannot be stored.
 * An empty value at run time means an upstream node resolved to one, and
 * hashing that is the correct answer rather than a failed step.
 *
 * A single value is trimmed - a textarea that picked up a trailing newline must
 * not change the digest. Array elements are not, so ["  a  "] is the way to
 * hash a value whose surrounding whitespace is significant.
 */
function parseInputValues(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    // A leading bracket is read as the array form, so a payload that merely
    // begins with one needs to say so. Without this the caller sees a raw
    // JSON.parse message and no way to act on it.
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `Value starts with "[" so it is read as a JSON array, but it is not valid JSON. To hash it as one string, wrap it: ["${trimmed.slice(0, 20)}..."].`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Value must be a string or a JSON array of strings.");
    }
    // An empty array carries no digest at all, and count 0 reads as "it worked"
    // downstream. Nothing asked for is a mistake rather than an answer.
    if (parsed.length === 0) {
      throw new Error("Value is an empty array, so there is nothing to hash.");
    }
    if (parsed.length > MAX_VALUES) {
      throw new Error(
        `Value holds ${parsed.length} entries, above the ${MAX_VALUES} this node will hash in one step.`
      );
    }
    return parsed.map((item, index) => {
      // String(item) would turn an object into "[object Object]" and null into
      // "null", then hash that happily. Only values with an unambiguous text
      // form are accepted; anything else names its position.
      if (typeof item === "string") {
        return item;
      }
      if (typeof item === "number" || typeof item === "boolean") {
        return String(item);
      }
      throw new Error(
        `Value entry ${index} is ${item === null ? "null" : typeof item}, which has no text form to hash. Use a string.`
      );
    });
  }
  return [trimmed];
}

/**
 * Truncate and right-pad exist for one concrete job that no other node can do:
 * turning a signature into the bytes32 topic an anonymous LogNote event is
 * filtered by.
 *
 *   keccak256("frob(...)")  -> 0x76088703 3549 7de0 ...   (32 bytes)
 *   outputBytes 4           -> 0x76088703                  (the selector)
 *   padTo 32                -> 0x76088703 0000 ... 0000    (the topic)
 *
 * Padding is on the right because that is where the EVM puts it: the note
 * modifier writes the selector left-aligned in the topic word. data/encode
 * pads text, not raw hex, so it cannot stand in here.
 *
 * A truncated digest is NOT the shorter standard variant of the same family,
 * and nothing here can make it one. BLAKE2 mixes the digest length into its
 * initial state (RFC 7693: h[0] ^= 0x01010000 ^ (kk << 8) ^ nn), so
 * BLAKE2b-256 is unrelated to the first 32 bytes of BLAKE2b-512; SHA-512/256
 * likewise has its own initial values under FIPS 180-4. Truncating sha512 to
 * 32 bytes gives a truncated SHA-512 and nothing else. Selectors are the
 * reason this exists; deriving a shorter named hash is not a use for it.
 */
function shapeDigest(
  digest: Uint8Array,
  outputBytes: number | undefined,
  padTo: number | undefined
): Uint8Array {
  let shaped = digest;

  if (outputBytes !== undefined) {
    if (outputBytes > digest.length) {
      throw new Error(
        `Output bytes is ${outputBytes}, but the digest is only ${digest.length} bytes.`
      );
    }
    shaped = shaped.slice(0, outputBytes);
  }

  if (padTo !== undefined) {
    if (padTo < shaped.length) {
      throw new Error(
        `Pad to is ${padTo} bytes, which is shorter than the ${shaped.length}-byte value it would hold.`
      );
    }
    const padded = new Uint8Array(padTo);
    padded.set(shaped, 0);
    shaped = padded;
  }

  return shaped;
}

function formatDigest(bytes: Uint8Array, format: OutputFormat): string {
  if (format === "hex") {
    return HEX_PREFIX + bytesToHex(bytes);
  }
  const base64 = Buffer.from(bytes).toString("base64");
  // base64url swaps the two characters that need escaping in a URL or a
  // filename and drops the padding, so the value survives being pasted into a
  // query string or a header without further encoding.
  return format === "base64url"
    ? base64
        .replace(BASE64_PLUS, "-")
        .replace(BASE64_SLASH, "_")
        .replace(BASE64_TRAILING_PADDING, "")
    : base64;
}

export function hashValues(input: HashCoreInput): HashResult {
  try {
    const algorithm = resolveEnum(
      input.algorithm,
      ALGORITHMS,
      "keccak256",
      "hash algorithm"
    );
    const inputEncoding = resolveEnum(
      input.inputEncoding,
      INPUT_ENCODINGS,
      "utf8",
      "input encoding"
    );
    const outputFormat = resolveEnum(
      input.outputFormat,
      OUTPUT_FORMATS,
      "hex",
      "output format"
    );
    const outputBytes = resolveCount(input.outputBytes, "Output bytes");
    const padTo = resolveCount(input.padTo, "Pad to");
    const values = parseInputValues(input.value ?? "");

    // Annotated rather than inferred: HASHERS[algorithm] is a union of six
    // noble CHash intersections, and resolving a call against that union is
    // fragile. Assignability to one plain signature is not.
    const hasher: (bytes: Uint8Array) => Uint8Array = HASHERS[algorithm];
    // Object.create(null) rather than a literal: assigning the key "__proto__"
    // on a normal object hits the inherited setter, which ignores a string, so
    // the row vanishes while count and result still include it. The value is a
    // JSON array of arbitrary strings, so that key is reachable.
    const map = Object.create(null) as Record<string, string>;
    const hashed: string[] = [];
    let digestBytes = 0;

    for (const value of values) {
      const digest = hasher(toBytes(value, inputEncoding));
      const shaped = shapeDigest(digest, outputBytes, padTo);
      digestBytes = shaped.length;
      const output = formatDigest(shaped, outputFormat);
      map[value] = output;
      hashed.push(output);
    }

    return {
      success: true,
      result: hashed.length === 1 ? hashed[0] : hashed,
      map,
      count: hashed.length,
      algorithm,
      digestBytes,
    };
  } catch (error) {
    return failed(`Hash failed: ${getErrorMessage(error)}`);
  }
}
