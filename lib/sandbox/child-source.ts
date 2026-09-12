/**
 * Shared grandchild source for the Code workflow node's sandbox runner.
 *
 * Both the in-pod local path (plugins/code/steps/run-code.ts) and the
 * standalone sandbox service (@keeperhub/sandbox) spawn a disposable Node
 * process via `node -e <SANDBOX_CHILD_SOURCE>` to execute user JS inside a
 * scrubbed vm.createContext sandbox. The two call sites used to inline
 * ~240 lines of this grandchild source verbatim; this module is the single
 * source of truth.
 *
 * Module imports here are restricted to pure data. The exported string is
 * passed intact to `node -e`, so any TypeScript-level import is only
 * usable at template-render time via `JSON.stringify` interpolation - no
 * runtime behaviour can cross into the grandchild because the grandchild
 * has no access to npm or to the rest of this codebase. Importing pure
 * data is the SSRF-blocklist sharing pattern used here (see
 * `lib/ssrf-blocklist.ts`); importing anything with runtime side effects
 * or third-party deps would not propagate to the grandchild.
 *
 * The grandchild uses only node: builtins (node:vm, node:v8, node:dns,
 * node:net, plus node:http / node:https / node:zlib / node:stream for the
 * IP-pinned fetch) so the downstream sandbox package can remain
 * zero-runtime-dep by design. Adding third-party packages (e.g. undici)
 * would enlarge the supply-chain attack surface of the sandbox container --
 * which is exactly why the SSRF pin is built on node:http/https rather than
 * an undici connect hook (see pinnedFetch / F-024).
 */
// The blocklist data is imported as JSON (not as a `.ts` module) because
// this file is compiled by two separate tsconfigs with incompatible
// `.js`/`.ts` resolution conventions: the keeperhub app (Next.js
// Turbopack) wants extension-less imports for `.ts` sources, while the
// standalone @keeperhub/sandbox package is `"type": "module"` and its
// strict ESM runtime requires explicit file extensions. A `.json`
// extension resolves identically in both contexts, so the data lives in
// `lib/ssrf-blocklist.json` and `lib/ssrf-blocklist.ts` is just a typed
// re-export used by the keeperhub-side consumers.
import blocklist from "../ssrf-blocklist.json" with { type: "json" };

/**
 * F-010: the grandchild returns its result as TAGGED JSON on a DEDICATED pipe
 * (fd 3), not stdout. The result is a single length-prefixed frame (4-byte
 * big-endian byte count, then a UTF-8 JSON body) and the parent recovers it
 * with JSON.parse + decodeSandboxResult.
 *
 * Two independent properties close the finding:
 *   - The parent NEVER runs v8.deserialize on bytes the child produced. JSON
 *     is safe to parse on untrusted input (the decoder additionally rebuilds
 *     "__proto__" keys as own data properties, so it cannot be used to pollute
 *     the parent's prototypes). This removes the root cause: even a fully
 *     compromised child can only deliver inert data, never a deserialization
 *     gadget. Fidelity (BigInt/Map/Set/Date/typed arrays/...) is preserved by
 *     the tag codec rather than by structured-clone.
 *   - stdout (fd 1) is left purely user-facing; nothing there is deserialized,
 *     so a sandbox escape writing to stdout cannot masquerade as a result (the
 *     old design scanned stdout for a 6-byte sentinel via lastIndexOf, which
 *     an escaped child defeated by appending a later sentinel). The parent
 *     also accepts only the FIRST complete fd-3 frame, and the genuine frame
 *     is written through a fs.writeSync reference captured at child startup,
 *     so a post-escape forged frame -- even with process.exit/fs.writeSync
 *     reassigned -- loses to the genuine one.
 *
 * Residual: a sandbox escape is still arbitrary code running AS the user, so
 * it can return any DATA it likes (exactly as legitimate user code can). What
 * it can no longer do is hand the parent untrusted bytes to deserialize. The
 * vector is gated behind a vm escape, the sandbox context shares no object
 * with this realm (see sandboxBootstrap), and the child is env-scrubbed and
 * NetworkPolicy-isolated.
 */
export const SANDBOX_RESULT_FD = 3;

/** Width of the big-endian length prefix on the fd-3 result frame. */
const SANDBOX_RESULT_HEADER_BYTES = 4;

/**
 * Upper bound on the declared frame length the parent will buffer. Checked
 * against the length prefix before any payload bytes are accumulated, so a
 * malicious child cannot pin parent memory by declaring a huge frame. The
 * child process is itself memory-bounded, so legitimate results never
 * approach this; it is a denial-of-service backstop, not a product limit.
 */
export const SANDBOX_RESULT_MAX_BYTES = 96 * 1024 * 1024;

/**
 * Identifier for the HTTP wire format between the main app and the standalone
 * sandbox service (JSON request + tagged-JSON response). The client sends it as
 * the `X-KH-Sandbox-Wire` request header and the server echoes it on the response;
 * each side rejects a mismatch so a deploy-time version skew fails fast with a
 * clear error instead of a confusing parse failure. Bump when the wire changes.
 */
export const SANDBOX_WIRE_VERSION = "json-v1";

export type SandboxResultReader = {
  /** Feed a chunk from the parent's fd-3 stream. Chunks after the first
   * complete frame are ignored (first-frame-wins). */
  push: (chunk: Buffer) => void;
  /** The first complete frame's v8 bytes, or null until one is complete. */
  readonly frame: Buffer | null;
  /** True once the first frame is complete or the stream is known-malformed. */
  readonly done: boolean;
  /** Set when the declared length exceeds SANDBOX_RESULT_MAX_BYTES. */
  readonly error: string | null;
};

/**
 * Streaming reader for the fd-3 result frame. The parent attaches it to the
 * child's fd-3 pipe and resolves as soon as `done` is true with a non-null
 * `frame`. Only the first length-prefixed frame is read; any trailing bytes
 * (e.g. a forged frame a sandbox escape appends later) are discarded.
 */
export function createSandboxResultReader(
  maxBytes: number = SANDBOX_RESULT_MAX_BYTES
): SandboxResultReader {
  let chunks: Buffer[] = [];
  let size = 0;
  let frame: Buffer | null = null;
  let done = false;
  let error: string | null = null;

  return {
    push(chunk: Buffer): void {
      if (done) {
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size < SANDBOX_RESULT_HEADER_BYTES) {
        return;
      }
      const buf =
        chunks.length === 1
          ? (chunks[0] as Buffer)
          : Buffer.concat(chunks, size);
      chunks = [buf];
      const declared = buf.readUInt32BE(0);
      if (declared > maxBytes) {
        error = `Sandbox result exceeds maximum size (${declared} > ${maxBytes} bytes)`;
        done = true;
        return;
      }
      const total = SANDBOX_RESULT_HEADER_BYTES + declared;
      if (buf.length >= total) {
        frame = buf.subarray(SANDBOX_RESULT_HEADER_BYTES, total);
        done = true;
      }
    },
    get frame(): Buffer | null {
      return frame;
    },
    get done(): boolean {
      return done;
    },
    get error(): string | null {
      return error;
    },
  };
}

/**
 * Tag key for the result codec. The child encodes its outcome as tagged JSON
 * (see `encodeResult` in the template) so the parent can recover it with a
 * SAFE `JSON.parse` instead of `v8.deserialize` -- which Node documents as
 * unsafe on untrusted data. A 1-key `{ "$": <tag> }` object carries a typed
 * value (bigint, Date, Map, ...); plain user objects that happen to contain a
 * literal "$" key are escaped as `{ "$": "obj", "v": {...} }` so they cannot
 * be mistaken for a tag.
 */
const SANDBOX_RESULT_TAG = "$";

function reviveSandboxNumber(token: string): number {
  switch (token) {
    case "NaN":
      return Number.NaN;
    case "Inf":
      return Number.POSITIVE_INFINITY;
    case "-Inf":
      return Number.NEGATIVE_INFINITY;
    case "-0":
      return -0;
    default:
      return Number(token);
  }
}

/**
 * Allowlisted view constructors the decoder will instantiate from a "bytes"
 * tag. The sandbox payload is UNTRUSTED, so the decoder never resolves an
 * arbitrary global by name: a forged `k` such as "fetch" would otherwise let a
 * compromised child select any global constructor (`new fetch(ab)` returns a
 * promise that rejects unhandled and can crash the process via the server's
 * unhandledRejection handler). Anything off this list falls back to raw bytes.
 */
const SANDBOX_VIEW_CTORS: Record<
  string,
  new (
    buffer: ArrayBuffer
  ) => ArrayBufferView
> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

function reviveSandboxBytes(kind: string, base64: string): unknown {
  const buf = Buffer.from(base64, "base64");
  // Copy into a standalone ArrayBuffer so the result does not alias Node's
  // shared Buffer pool.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (kind === "ArrayBuffer") {
    return ab;
  }
  const Ctor: (new (buffer: ArrayBuffer) => ArrayBufferView) | undefined =
    SANDBOX_VIEW_CTORS[kind];
  if (Ctor) {
    try {
      return new Ctor(ab);
    } catch {
      // A known kind whose byte length is not a multiple of its element size
      // (a forged/malformed frame would make `new Uint32Array(ab)` throw):
      // hand back raw bytes rather than throwing on the untrusted boundary.
      return new Uint8Array(ab);
    }
  }
  // Unknown/forged view kind: never resolve an arbitrary global by name; hand
  // back raw bytes rather than instantiating it.
  return new Uint8Array(ab);
}

// Bound the decoder's recursion on UNTRUSTED input. Legitimate results nest
// shallowly; a forged frame with thousands of nested tags would otherwise
// recurse until a RangeError - now thrown in the main-app client, since the
// server relays the frame unrevived (it does not decode it). Throwing a clear,
// bounded error here keeps the failure well below the JS stack limit.
const SANDBOX_MAX_DEPTH = 256;

/**
 * Rebuild a plain object key-by-key, defining each property so a "__proto__"
 * key lands as an own data property instead of invoking the prototype setter
 * (the prototype-pollution guard that makes deserializing untrusted input
 * safe).
 */
function decodeSandboxObject(
  obj: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    Object.defineProperty(result, key, {
      value: decodeSandboxNode(obj[key], depth),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function decodeSandboxNode(node: unknown, depth = 0): unknown {
  if (depth > SANDBOX_MAX_DEPTH) {
    throw new Error("sandbox result nesting too deep");
  }
  const next = depth + 1;
  if (Array.isArray(node)) {
    return node.map((item) => decodeSandboxNode(item, next));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const obj = node as Record<string, unknown>;
  if (!Object.hasOwn(obj, SANDBOX_RESULT_TAG)) {
    return decodeSandboxObject(obj, next);
  }
  switch (obj[SANDBOX_RESULT_TAG]) {
    case "undef":
      return undefined;
    case "bigint":
      return BigInt(obj.v as string);
    case "num":
      return reviveSandboxNumber(obj.v as string);
    case "date":
      // A non-number v means an Invalid Date: every encoder emits
      // value.getTime(), and JSON.stringify(NaN) === null, so an Invalid Date
      // arrives as null. Revive it as Invalid Date rather than coercing null
      // (new Date(null)) to the Unix epoch.
      return new Date(typeof obj.v === "number" ? obj.v : Number.NaN);
    case "regexp":
      return new RegExp(obj.src as string, obj.flags as string);
    case "map":
      return new Map(
        (obj.v as [unknown, unknown][]).map((e) => [
          decodeSandboxNode(e[0], next),
          decodeSandboxNode(e[1], next),
        ])
      );
    case "set":
      return new Set(
        (obj.v as unknown[]).map((item) => decodeSandboxNode(item, next))
      );
    case "bytes":
      return reviveSandboxBytes(obj.k as string, obj.v as string);
    case "obj":
      // Escaped plain object: its keys are literal data, never tags.
      return decodeSandboxObject(obj.v as Record<string, unknown>, next);
    default:
      // Unknown tag from a malformed/compromised child: treat as plain data.
      return decodeSandboxObject(obj, next);
  }
}

/**
 * Parse a child result frame. `text` is the UTF-8 body of the fd-3 frame.
 * Uses `JSON.parse` (safe on untrusted input) and rebuilds the typed values
 * the child tagged. Throws on malformed JSON / tags; callers map that to an
 * error outcome.
 */
export function decodeSandboxResult(text: string): unknown {
  return decodeSandboxNode(JSON.parse(text));
}

function encodeSandboxNumber(value: number): unknown {
  if (Number.isFinite(value) && !Object.is(value, -0)) {
    return value;
  }
  let token = "-0";
  if (Number.isNaN(value)) {
    token = "NaN";
  } else if (value === Number.POSITIVE_INFINITY) {
    token = "Inf";
  } else if (value === Number.NEGATIVE_INFINITY) {
    token = "-Inf";
  }
  return { [SANDBOX_RESULT_TAG]: "num", v: token };
}

function encodeSandboxMap(
  value: Map<unknown, unknown>,
  seen: Set<unknown>
): unknown {
  const entries: [unknown, unknown][] = [];
  for (const [k, v] of value) {
    entries.push([encodeSandboxNode(k, seen), encodeSandboxNode(v, seen)]);
  }
  return { [SANDBOX_RESULT_TAG]: "map", v: entries };
}

function encodeSandboxSet(value: Set<unknown>, seen: Set<unknown>): unknown {
  const items: unknown[] = [];
  for (const item of value) {
    items.push(encodeSandboxNode(item, seen));
  }
  return { [SANDBOX_RESULT_TAG]: "set", v: items };
}

function encodeSandboxView(value: ArrayBufferView): unknown {
  // Mirror the inline encodeResult's falsy check: a missing or empty
  // constructor name falls back to Uint8Array.
  const ctorName = value.constructor?.name;
  const kind =
    ctorName === undefined || ctorName === "" ? "Uint8Array" : ctorName;
  return {
    [SANDBOX_RESULT_TAG]: "bytes",
    k: kind,
    v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
      "base64"
    ),
  };
}

function encodeSandboxPlainObject(
  value: Record<string, unknown>,
  seen: Set<unknown>
): unknown {
  const out: Record<string, unknown> = {};
  let hasTagKey = false;
  for (const key of Object.keys(value)) {
    if (key === SANDBOX_RESULT_TAG) {
      hasTagKey = true;
    }
    const encoded = encodeSandboxNode(value[key], seen);
    if (key === "__proto__") {
      // Only "__proto__" needs defineProperty: a plain `out[key] =` invokes the
      // prototype setter and silently drops it (decodeSandboxObject preserves it
      // as a data property, so dropping would break the round-trip). Every other
      // key uses cheap assignment.
      Object.defineProperty(out, key, {
        value: encoded,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      out[key] = encoded;
    }
  }
  // Escape a plain object that literally carries a "$" key so the parent does
  // not mistake it for a type tag.
  return hasTagKey ? { [SANDBOX_RESULT_TAG]: "obj", v: out } : out;
}

function encodeSandboxComposite(value: object, seen: Set<unknown>): unknown {
  if (Array.isArray(value)) {
    // for...of yields `undefined` for holes (Array.prototype.map SKIPS them and
    // JSON would render them as null), matching the inline encoder so a sparse
    // array round-trips identically through both codecs.
    const arr: unknown[] = [];
    for (const item of value) {
      arr.push(encodeSandboxNode(item, seen));
    }
    return arr;
  }
  if (value instanceof Date) {
    return { [SANDBOX_RESULT_TAG]: "date", v: value.getTime() };
  }
  if (value instanceof RegExp) {
    return {
      [SANDBOX_RESULT_TAG]: "regexp",
      src: value.source,
      flags: value.flags,
    };
  }
  if (value instanceof Map) {
    return encodeSandboxMap(value, seen);
  }
  if (value instanceof Set) {
    return encodeSandboxSet(value, seen);
  }
  if (value instanceof ArrayBuffer) {
    return {
      [SANDBOX_RESULT_TAG]: "bytes",
      k: "ArrayBuffer",
      v: Buffer.from(value).toString("base64"),
    };
  }
  if (ArrayBuffer.isView(value)) {
    return encodeSandboxView(value);
  }
  return encodeSandboxPlainObject(value as Record<string, unknown>, seen);
}

function encodeSandboxNode(value: unknown, seen: Set<unknown>): unknown {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return { [SANDBOX_RESULT_TAG]: "undef" };
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return encodeSandboxNumber(value);
  }
  if (typeof value === "bigint") {
    return { [SANDBOX_RESULT_TAG]: "bigint", v: value.toString() };
  }
  if (typeof value === "function" || typeof value === "symbol") {
    // Bare reason; the caller (writeRunResult / writeResult) adds the
    // "Result is not serializable: " prefix so the message is not doubled.
    throw new Error(typeof value);
  }
  if (seen.has(value)) {
    throw new Error("circular reference");
  }
  seen.add(value);
  try {
    return encodeSandboxComposite(value, seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * Encode an arbitrary value as the tagged-JSON wire form `decodeSandboxResult`
 * reads back; the exact inverse of `decodeSandboxNode`. Used by the standalone
 * sandbox server to put a result on the HTTP response (the in-pod grandchild
 * uses the inline `encodeResult` instead, since it cannot import this module).
 *
 * keep in lockstep with decodeSandboxNode and the inline encodeResult in
 * SANDBOX_CHILD_SOURCE: the three share one tag scheme ("$"-keyed envelopes for
 * undefined, non-finite/-0 numbers, bigint, Date, RegExp, Map, Set, byte views,
 * and "$"-collision escaping). Throws on a value with no safe representation
 * (function, symbol, or a circular reference), mirroring the inline encodeResult.
 */
export function encodeSandboxResult(value: unknown): string {
  return JSON.stringify(encodeSandboxNode(value, new Set<unknown>()));
}

/**
 * JavaScript source string for the sandbox grandchild. Passed verbatim to
 * `node -e`, so it must be standalone (no imports, no TypeScript syntax).
 *
 * Responsibilities:
 *   - Read a JSON payload from stdin: `{ code: string, timeoutMs: number }`
 *   - Execute `code` inside a fresh vm.createContext realm, then rebuild the
 *     non-ECMAScript globals (console, fetch, URL, TextEncoder, ...) inside
 *     that realm rather than copying this process's objects in
 *   - Apply an SSRF guard to `fetch` (DNS-resolved denylist mirroring
 *     lib/safe-fetch.ts from KEEP-314)
 *   - Apply a wall-clock timeout (beyond the vm's sync CPU timeout) that
 *     catches never-settling user promises
 *   - Write a length-prefixed, tagged-JSON outcome to the dedicated
 *     result pipe (fd SANDBOX_RESULT_FD), leaving stdout user-facing
 */
export const SANDBOX_CHILD_SOURCE = `
"use strict";
const { createContext, runInContext } = require("node:vm");
const fs = require("node:fs");
// Cross-realm type predicates. User values now come from the sandbox's own
// realm, so \`value instanceof Date\` (host Date) is false for a sandbox Date;
// these read internal slots instead and work across realms.
const types = require("node:util").types;
const dnsPromises = require("node:dns").promises;
const { BlockList, isIP } = require("node:net");
const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const { Readable, Transform } = require("node:stream");

// Captured BEFORE any user code runs so the result frame is written through a
// reference a sandbox escape cannot monkeypatch. The genuine result therefore
// reaches fd ${SANDBOX_RESULT_FD} first even if escaped user code reassigns
// fs.writeSync / process.exit; the parent's first-frame-wins read then ignores
// any later forged frame (F-010).
const RESULT_FD = ${SANDBOX_RESULT_FD};
const RESULT_HEADER_BYTES = ${SANDBOX_RESULT_HEADER_BYTES};
const __writeSync = fs.writeSync.bind(fs);
const __exit = process.exit.bind(process);

const MAX_LOG_ENTRIES = 200;

// Cap on redirect hops a single sandboxed fetch will follow before giving
// up, mirroring undici's built-in maxRedirections default.
const MAX_SANDBOX_REDIRECTS = 20;

// SSRF guard: ported from lib/safe-fetch.ts. Modeled on the main-app
// pattern but inlined here because the sandbox package is
// zero-runtime-dep by design and the grandchild gets only node: builtins.
// Two layers fire before the wrapped fetch dials anything:
//   1. Pre-DNS hostname denylist (isBlockedHost) catches localhost and
//      patterns like *.local, *.internal, *.svc.cluster.local,
//      *.pod.cluster.local. Defense-in-depth on top of the IP check;
//      also surfaces in error messages as the original hostname.
//   2. DNS-resolved IP denylist catches hostnames that resolve to RFC
//      1918, loopback, link-local (IMDS), CGNAT, reserved ranges, ULA,
//      multicast, and the additional IPv6 transition prefixes
//      (64:ff9b:1::/48, 2001::/32 Teredo, 2002::/16 6to4, 2001:db8::/32).
// NAT64 (64:ff9b::/96): the well-known prefix is treated specially. In
// dual-stack / IPv6-preferred pods (typical for our AWS prod VPC) the
// resolver synthesises NAT64 AAAA records for every IPv4-only public
// host (discord.com, slack.com, telegram.org, etc.). Blanket-blocking
// the prefix would block all of them. Instead, on a NAT64 hit we
// extract the embedded IPv4 and recheck it against the IPv4 list —
// preserving the SSRF property without false positives on public IPv4.
// TOCTOU (F-024): the wrapped fetch resolves and validates the hostname EXACTLY
// ONCE (resolveValidatedAddresses) and then pins that validated address set.
// pinnedFetch dials it through node:http / node:https with a custom lookup that
// returns the pre-validated addresses verbatim, performing no second DNS lookup
// (mirroring lib/safe-fetch.ts validatingConnect). Because net.connect dials
// exactly the address the lookup returns, the address that was validated is the
// address that is dialed -- a guard that saw a public A record cannot be raced
// into dialing a private one (DNS rebinding) because there is no second
// resolution to race. The hostname stays in the request options so TLS SNI,
// certificate validation, and the Host header still use the real name. IP
// literals never reach the custom lookup (net.connect dials a literal
// directly), so for them the resolveValidatedAddresses isBlockedIp check is the
// only control -- which is sufficient because a literal cannot be rebound.
// Redirects: lacking the per-connect hook, the wrapped fetch uses
// redirect:"manual" and re-runs these same checks on each 3xx Location
// before following it, so a redirect cannot chase a public host into a
// blocked one (IMDS, K8s apiserver, *.svc.cluster.local).
// Testing note: the sandbox guard is not unit-tested directly because
// this entire file is a template literal executed in a subprocess via
// "node -e". The parallel behavior in lib/safe-fetch.ts is unit-tested
// (tests/unit/safe-fetch.test.ts) and these CIDR / hostname denylists
// are kept in lockstep with that file by convention.
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const IPV4_MAPPED_PREFIX = "::ffff:";
const IPV4_MAPPED_HEX_REGEX = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
// NAT64 well-known prefix (RFC 6052): 64:ff9b::/96 — last 32 bits encode an
// IPv4. We accept three textual forms a resolver may return.
const NAT64_CANONICAL_REGEX = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const NAT64_UNCOMPRESSED_REGEX = /^64:ff9b:0:0:0:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const NAT64_DOTTED_REGEX = /^64:ff9b::(\\d+\\.\\d+\\.\\d+\\.\\d+)$/;

// CIDR ranges and special prefixes interpolated from
// lib/ssrf-blocklist.ts at module-render time. See that file for the
// rationale on which ranges are blanket-blocked vs handled specially.
// Note: ::ffff:0:0/96 (IPv4-mapped IPv6) is intentionally not added —
// Node treats that subnet as "all IPv4" which would make every IPv4
// check return true. IPv4-mapped IPv6 pointing at private IPv4 is
// caught via the mapped extraction below. The NAT64 well-known prefix
// (64:ff9b::/96) is also kept separate for the same reason - dual-stack
// resolvers synthesise it for every IPv4-only public host, so we extract
// the embedded IPv4 and recheck it against the IPv4 list.
const SSRF_IPV4_CIDRS = ${JSON.stringify(blocklist.ipv4Cidrs)};
const SSRF_IPV4_BROADCAST_ADDRESSES = ${JSON.stringify(blocklist.ipv4BroadcastAddresses)};
const SSRF_IPV6_LITERAL_ADDRESSES = ${JSON.stringify(blocklist.ipv6LiteralAddresses)};
const SSRF_IPV6_CIDRS = ${JSON.stringify(blocklist.ipv6Cidrs)};
const SSRF_NAT64_PREFIX_CIDR = ${JSON.stringify(blocklist.nat64PrefixCidr)};

const SSRF_BLOCK_LIST = new BlockList();
for (const cidr of SSRF_IPV4_CIDRS) {
  SSRF_BLOCK_LIST.addSubnet(cidr[0], cidr[1], "ipv4");
}
for (const addr of SSRF_IPV4_BROADCAST_ADDRESSES) {
  SSRF_BLOCK_LIST.addAddress(addr, "ipv4");
}
for (const addr of SSRF_IPV6_LITERAL_ADDRESSES) {
  SSRF_BLOCK_LIST.addAddress(addr, "ipv6");
}
for (const cidr of SSRF_IPV6_CIDRS) {
  SSRF_BLOCK_LIST.addSubnet(cidr[0], cidr[1], "ipv6");
}

const NAT64_BLOCK_LIST = new BlockList();
NAT64_BLOCK_LIST.addSubnet(SSRF_NAT64_PREFIX_CIDR[0], SSRF_NAT64_PREFIX_CIDR[1], "ipv6");

function hexGroupsToIpv4(highHex, lowHex) {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  if (!(Number.isFinite(high) && Number.isFinite(low))) {
    return undefined;
  }
  return [((high >> 8) & 0xff), (high & 0xff), ((low >> 8) & 0xff), (low & 0xff)].join(".");
}

function extractMappedIpv4(ipv6) {
  const lower = ipv6.toLowerCase();
  if (!lower.startsWith(IPV4_MAPPED_PREFIX)) {
    return undefined;
  }
  const suffix = lower.slice(IPV4_MAPPED_PREFIX.length);
  if (isIP(suffix) === 4) {
    return suffix;
  }
  const hexMatch = suffix.match(IPV4_MAPPED_HEX_REGEX);
  if (!hexMatch) {
    return undefined;
  }
  return hexGroupsToIpv4(hexMatch[1] || "", hexMatch[2] || "");
}

function extractNat64Ipv4(ipv6) {
  const lower = ipv6.toLowerCase();
  const canonical = lower.match(NAT64_CANONICAL_REGEX);
  if (canonical && canonical[1] && canonical[2]) {
    return hexGroupsToIpv4(canonical[1], canonical[2]);
  }
  const uncompressed = lower.match(NAT64_UNCOMPRESSED_REGEX);
  if (uncompressed && uncompressed[1] && uncompressed[2]) {
    return hexGroupsToIpv4(uncompressed[1], uncompressed[2]);
  }
  const dotted = lower.match(NAT64_DOTTED_REGEX);
  if (dotted && dotted[1] && isIP(dotted[1]) === 4) {
    return dotted[1];
  }
  return undefined;
}

function isBlockedIp(ip) {
  const family = isIP(ip);
  if (family === 0) {
    return { blocked: false };
  }
  if (family === 6 && NAT64_BLOCK_LIST.check(ip, "ipv6")) {
    const embedded = extractNat64Ipv4(ip);
    if (embedded === undefined) {
      // Inside 64:ff9b::/96 but textual form is unfamiliar — block
      // defensively rather than pass an unvalidated v6 through.
      return { blocked: true, ip: ip };
    }
    if (SSRF_BLOCK_LIST.check(embedded, "ipv4")) {
      return { blocked: true, ip: embedded };
    }
    return { blocked: false };
  }
  const familyKey = family === 4 ? "ipv4" : "ipv6";
  if (SSRF_BLOCK_LIST.check(ip, familyKey)) {
    return { blocked: true, ip: ip };
  }
  if (family === 6) {
    const mapped = extractMappedIpv4(ip);
    if (mapped && SSRF_BLOCK_LIST.check(mapped, "ipv4")) {
      return { blocked: true, ip: mapped };
    }
  }
  return { blocked: false };
}

function stripIpv6Brackets(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

// Rewrite the method/body for the next hop the way undici's follow mode
// would: 301/302 downgrade a POST to GET, 303 downgrades any non-GET/HEAD
// to GET, and 307/308 preserve both. Keeps manual redirect following
// behaviourally equivalent to the network layer's own follow.
function applyRedirectMethod(init, status) {
  const next = Object.assign({}, init);
  const method = (typeof next.method === "string" ? next.method : "GET").toUpperCase();
  const downgrade =
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET" && method !== "HEAD");
  if (downgrade) {
    next.method = "GET";
    delete next.body;
  }
  return next;
}

// Pre-DNS hostname denylist interpolated from lib/ssrf-blocklist.ts at
// module-render time. See that module for the rationale (case handling,
// suffix semantics, cluster-domain assumption).
const BLOCKED_HOST_EXACT = new Set(${JSON.stringify(blocklist.blockedHostExact)});
const BLOCKED_HOST_SUFFIXES = ${JSON.stringify(blocklist.blockedHostSuffixes)};

function isBlockedHost(host) {
  if (host === "") {
    return false;
  }
  let normalised = host.trim().toLowerCase();
  if (normalised.endsWith(".")) {
    normalised = normalised.slice(0, -1);
  }
  if (normalised === "") {
    return false;
  }
  if (BLOCKED_HOST_EXACT.has(normalised)) {
    return true;
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (normalised.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

// Resolve + validate the hostname ONCE and return the validated address set to
// pin. This is the single load-bearing SSRF control: pinnedFetch dials exactly
// the addresses returned here, so the validated address is the dialed address
// (mirrors lib/safe-fetch.ts validatingConnect, but keeps all:true so the whole
// A/AAAA set is checked). Returns { blocked: true, ip } for a denied target, or
// { blocked: false, addresses: [{ address, family }] } otherwise. isBlockedHost
// is a pre-DNS denylist (localhost, *.svc.cluster.local, ... ) that also yields
// nicer hostname-based errors. IP literals are validated directly and returned
// as their own single address (net.connect dials a literal without invoking the
// pinned lookup, so this is their only check - sufficient because a literal
// cannot be rebound). For names, all:true catches split-horizon DNS where A and
// AAAA differ - one private address in the response is enough to reject.
async function resolveValidatedAddresses(hostname) {
  if (isBlockedHost(hostname)) {
    return { blocked: true, ip: hostname };
  }
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    const check = isBlockedIp(hostname);
    if (check.blocked) {
      return check;
    }
    return {
      blocked: false,
      addresses: [{ address: hostname, family: literalFamily }],
    };
  }
  const DNS_TIMEOUT_MS = 3000;
  let dnsTimer;
  const dnsTimeoutPromise = new Promise((_, reject) => {
    dnsTimer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
  });
  const records = await Promise.race([
    dnsPromises.lookup(hostname, { all: true }),
    dnsTimeoutPromise,
  ]).finally(() => clearTimeout(dnsTimer));
  const validated = [];
  for (const rec of records) {
    const check = isBlockedIp(rec.address);
    if (check.blocked) {
      return check;
    }
    validated.push({ address: rec.address, family: rec.family });
  }
  return { blocked: false, addresses: validated };
}

// F-024 IP pin. The grandchild has no undici connect hook (the standalone
// @keeperhub/sandbox image is zero-runtime-dep, so undici cannot be required),
// so the wrapped fetch is issued through node:http / node:https. The caller
// resolves + validates the hostname once (resolveValidatedAddresses) and hands
// the validated address set to pinnedFetch, whose custom lookup returns those
// addresses verbatim with NO second DNS lookup. net.connect dials exactly the
// address the lookup returns, so the address that was validated is the address
// that is dialed -- closing the DNS-rebinding TOCTOU. The hostname stays in the
// request options so TLS SNI, certificate validation, and the Host header still
// use the real name.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Upper bound on the bytes a single gzip-decoded response body may expand to,
// tied to the sandbox result byte budget (SANDBOX_RESULT_MAX_BYTES). The
// pinned fetch advertises "Accept-Encoding: identity", so this gzip path is
// only a fallback for a misbehaving server that compresses anyway; the cap
// makes a decompression bomb error out instead of pinning unbounded memory in
// the child. Enforced by countingByteCap below: zlib's own maxOutputLength only
// bounds a single output buffer, not the cumulative stream, so a bomb delivered
// across chunks would otherwise slip past it.
const GZIP_MAX_OUTPUT_BYTES = ${SANDBOX_RESULT_MAX_BYTES};

// Upper bound on a response body the sandbox will buffer before handing it to
// user code. The body is marshalled into the sandbox realm as base64 text (a
// host Response object would hand user code the host realm), so it has to be
// read fully; this bounds that read at the same budget as the gzip path.
const MAX_RESPONSE_BODY_BYTES = ${SANDBOX_RESULT_MAX_BYTES};

// Transform that errors the stream once cumulative bytes exceed maxBytes. zlib's
// maxOutputLength is per-output-buffer, so this is the load-bearing cumulative
// cap on a decompressed body; it tears the pipe down with an error rather than
// letting a decompression bomb accumulate unboundedly.
function countingByteCap(maxBytes) {
  let total = 0;
  return new Transform({
    transform: function capTransform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(new Error("sandbox fetch: decoded body exceeds " + maxBytes + " bytes"));
        return;
      }
      cb(null, chunk);
    },
  });
}

// Classify a response Content-Encoding. Because the request asks for identity,
// the common case is "none". gzip is still honoured as a fallback; any other
// non-identity coding is reported as "unsupported" so the response handling
// can surface a clear error instead of returning still-compressed bytes under
// a now-misleading content-encoding header. deflate/brotli were removed: raw
// deflate framing is ambiguous (the old createInflate path regressed on it)
// and brotli only widened the decode surface for no real-world benefit.
function classifyContentEncoding(encoding) {
  const normalised = (encoding || "").trim().toLowerCase();
  if (normalised === "" || normalised === "identity") {
    return { kind: "identity" };
  }
  if (normalised === "gzip" || normalised === "x-gzip") {
    return { kind: "gzip" };
  }
  return { kind: "unsupported", encoding: normalised };
}

// Mirror undici's default outbound request headers so the node:http/https path
// behaves like the global fetch it replaces (some hosts gate on these).
function applyDefaultRequestHeaders(headers) {
  if (!("user-agent" in headers)) {
    headers["user-agent"] = "node";
  }
  if (!("accept" in headers)) {
    headers["accept"] = "*/*";
  }
  if (!("accept-encoding" in headers)) {
    // Request uncompressed so the grandchild does not need a general-purpose
    // decompression layer. gzip is still honoured as a fallback below for a
    // misbehaving server that compresses despite this.
    headers["accept-encoding"] = "identity";
  }
}

function buildResponseHeaders(rawHeaders) {
  const headers = new Headers();
  const keys = Object.keys(rawHeaders);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = rawHeaders[key];
    if (Array.isArray(value)) {
      for (let j = 0; j < value.length; j++) {
        headers.append(key, value[j]);
      }
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

// Drop-in replacement for global fetch used by the wrapped sandbox fetch. Dials
// only the pre-validated pinnedAddresses (resolved + validated once by the
// caller) instead of letting the network layer re-resolve, and returns a
// genuine WHATWG Response so status, headers and body decoding all behave as
// the network layer would; marshalResponse then flattens it for the sandbox
// realm. Redirects are NOT auto-followed here; the caller's loop re-validates
// and follows each hop.
async function pinnedFetch(request, pinnedAddresses, signal) {
  // request is the WHATWG Request the caller already built and validated.
  // pinnedFetch reads the dial URL from THIS object and never re-derives it from
  // a raw resource: a crafted resource whose toString() / .url disagree could
  // otherwise make the dialed URL diverge from the validated one and slip past
  // the SSRF guard (F-024 follow-up). The caller normalised method/headers/body
  // on this Request too, so multipart, urlencoded, content-type and
  // content-length handling still match global fetch.
  const parsed = new URL(request.url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  const headers = {};
  request.headers.forEach(function copyHeader(value, key) {
    headers[key] = value;
  });
  applyDefaultRequestHeaders(headers);

  const method = request.method.toUpperCase();
  let bodyBuffer = null;
  if (method !== "GET" && method !== "HEAD" && request.body !== null) {
    bodyBuffer = Buffer.from(await request.arrayBuffer());
    headers["content-length"] = String(bodyBuffer.length);
  }

  const hostname = stripIpv6Brackets(parsed.hostname);
  // Load-bearing backstop for the IP-literal dial path. net.connect dials an IP
  // literal directly and NEVER invokes pinnedLookup below, so for a literal the
  // only thing between user code and the socket is that this exact literal was in
  // the validated, pinned set. Assert it. For DNS names pinnedLookup returns only
  // pre-validated addresses, so the dial is already constrained to them. This
  // makes "the address dialed is the address validated" a hard invariant even if
  // a future change reintroduces a URL derivation that diverges from the guard
  // (the F-024 class).
  if (isIP(hostname) !== 0) {
    const isValidatedLiteral = pinnedAddresses.some(function matchPinned(addr) {
      return stripIpv6Brackets(addr.address) === hostname;
    });
    if (!isValidatedLiteral) {
      throw new Error(
        "sandbox fetch: SSRF blocked (unvalidated dial target " + hostname + ")"
      );
    }
  }
  const callerSignal = signal;

  return await new Promise(function dial(resolve, reject) {
    const options = {
      protocol: parsed.protocol,
      hostname: hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: headers,
      lookup: function pinnedLookup(_lookupHost, lookupOptions, lookupCallback) {
        // Return the pre-validated, pinned addresses verbatim - no second DNS
        // lookup. net.connect dials exactly these, so the validated address is
        // the dialed address (the F-024 pin). all:true (Happy Eyeballs) gets the
        // whole set, each entry already past isBlockedIp; else the first.
        if (lookupOptions && lookupOptions.all) {
          lookupCallback(null, pinnedAddresses);
        } else {
          lookupCallback(null, pinnedAddresses[0].address, pinnedAddresses[0].family);
        }
      },
    };
    if (callerSignal) {
      options.signal = callerSignal;
    }
    const clientRequest = transport.request(options, function onResponse(incoming) {
      const status = incoming.statusCode || 0;
      const responseHeaders = buildResponseHeaders(incoming.headers);
      if (NULL_BODY_STATUSES.has(status) || method === "HEAD") {
        incoming.resume();
        resolve(
          new Response(null, {
            status: status,
            statusText: incoming.statusMessage || "",
            headers: responseHeaders,
          })
        );
        return;
      }
      const encodingPlan = classifyContentEncoding(
        responseHeaders.get("content-encoding")
      );
      if (encodingPlan.kind === "unsupported") {
        // We asked for identity and only decode gzip. Returning the still
        // -compressed bytes under their content-encoding header would silently
        // hand user code an undecodable body, so fail loudly instead.
        incoming.resume();
        reject(
          new Error(
            "sandbox fetch: unsupported content-encoding: " + encodingPlan.encoding
          )
        );
        return;
      }
      let bodyStream = incoming;
      if (encodingPlan.kind === "gzip") {
        // Bounded output so a gzip bomb errors instead of OOMing the child.
        // maxOutputLength caps a single output buffer; countingByteCap enforces
        // the cumulative limit across the whole stream.
        const decoder = zlib.createGunzip({ maxOutputLength: GZIP_MAX_OUTPUT_BYTES });
        const cap = countingByteCap(GZIP_MAX_OUTPUT_BYTES);
        // The decoded bytes no longer match the on-wire length/encoding.
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        incoming.on("error", function onIncomingError(streamErr) {
          decoder.destroy(streamErr);
        });
        decoder.on("error", function onDecoderError(streamErr) {
          cap.destroy(streamErr);
        });
        bodyStream = incoming.pipe(decoder).pipe(cap);
      }
      resolve(
        new Response(Readable.toWeb(bodyStream), {
          status: status,
          statusText: incoming.statusMessage || "",
          headers: responseHeaders,
        })
      );
    });
    clientRequest.on("error", function onRequestError(err) {
      reject(err);
    });
    if (bodyBuffer) {
      clientRequest.write(bodyBuffer);
    }
    clientRequest.end();
  });
}

// Release the node socket behind a 3xx response we are not going to follow.
// pinnedFetch wraps the incoming message in a web ReadableStream, so cancelling
// it tears down the underlying socket. Must run before every redirect-loop exit
// (both the success hop and each throw) or the connection leaks.
async function cancelResponseBody(response) {
  if (response && response.body) {
    try {
      await response.body.cancel();
    } catch (_e) {
      // body may already be consumed or unsupported; ignore
    }
  }
}

// Bootstrap evaluated INSIDE the vm context (via Function.prototype.toString,
// see installSandboxGlobals), so every object it builds belongs to the sandbox
// realm.
//
// The sandbox used to be populated by copying ~55 host intrinsics into
// createContext(): Array, JSON, Math, Object, the typed arrays, URL, Response
// and so on. Each of them was an object from THIS process's realm, so
// X.constructor.constructor resolved to the host Function and user code could
// compile a function that runs outside the sandbox and reach process /
// process.binding from there. A fresh createContext({}) already owns a
// complete set of ECMAScript intrinsics that lead nowhere, so the fix is to
// inject none of them and rebuild the non-ECMAScript surface here, in-realm.
//
// Two rules keep it closed, and both are load-bearing:
//   - This function must stay self-contained. It runs in the other realm, so
//     it can reference only its own locals, its parameter, and the realm's own
//     globals -- never an identifier from the surrounding (host) scope.
//   - The host \`bridge\` functions it closes over are the only host values that
//     cross, they are never exposed to user code, and they exchange PRIMITIVES
//     only. Handing back a host object (a Response, a plain {} built in the
//     host realm, a rejected host Error) would reopen the hole, so fetch
//     results arrive as JSON text and are rebuilt here.
function sandboxBootstrap(bridge) {
  "use strict";

  const HEX = "0123456789ABCDEF";
  const B64_CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_INDEX = new Map();
  for (let i = 0; i < B64_CHARS.length; i++) {
    B64_INDEX.set(B64_CHARS.charAt(i), i);
  }

  // Every bridge call that can fail answers with this envelope, so a host
  // exception never crosses into user code as a catchable host Error.
  function unwrap(json) {
    const envelope = JSON.parse(json);
    if (envelope.ok !== true) {
      throw new TypeError(envelope.e);
    }
    return envelope.v;
  }

  function isAsciiWhitespace(charCode) {
    return (
      charCode === 32 ||
      charCode === 9 ||
      charCode === 10 ||
      charCode === 13 ||
      charCode === 12
    );
  }

  function bytesToBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const hasSecond = i + 1 < bytes.length;
      const hasThird = i + 2 < bytes.length;
      const b0 = bytes[i];
      const b1 = hasSecond ? bytes[i + 1] : 0;
      const b2 = hasThird ? bytes[i + 2] : 0;
      out += B64_CHARS.charAt(b0 >> 2);
      out += B64_CHARS.charAt(((b0 & 3) << 4) | (b1 >> 4));
      out += hasSecond ? B64_CHARS.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
      out += hasThird ? B64_CHARS.charAt(b2 & 63) : "=";
    }
    return out;
  }

  function base64ToBytes(input) {
    let clean = "";
    for (let i = 0; i < input.length; i++) {
      if (!isAsciiWhitespace(input.charCodeAt(i))) {
        clean += input.charAt(i);
      }
    }
    while (clean.length > 0 && clean.charAt(clean.length - 1) === "=") {
      clean = clean.slice(0, -1);
    }
    if (clean.length % 4 === 1) {
      throw new TypeError("atob: invalid base64 length");
    }
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let bits = 0;
    let bitCount = 0;
    let outIndex = 0;
    for (let i = 0; i < clean.length; i++) {
      const value = B64_INDEX.get(clean.charAt(i));
      if (value === undefined) {
        throw new TypeError("atob: invalid base64 character");
      }
      bits = (bits << 6) | value;
      bitCount += 6;
      if (bitCount >= 8) {
        bitCount -= 8;
        out[outIndex] = (bits >> bitCount) & 255;
        outIndex += 1;
      }
    }
    return out;
  }

  function utf8Encode(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let point = text.charCodeAt(i);
      if (point >= 0xd800 && point <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          point = (point - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
          i += 1;
        }
      }
      if (point >= 0xd800 && point <= 0xdfff) {
        point = 0xfffd;
      }
      if (point < 0x80) {
        bytes.push(point);
      } else if (point < 0x800) {
        bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
      } else if (point < 0x10000) {
        bytes.push(
          0xe0 | (point >> 12),
          0x80 | ((point >> 6) & 63),
          0x80 | (point & 63)
        );
      } else {
        bytes.push(
          0xf0 | (point >> 18),
          0x80 | ((point >> 12) & 63),
          0x80 | ((point >> 6) & 63),
          0x80 | (point & 63)
        );
      }
    }
    return new Uint8Array(bytes);
  }

  function utf8Decode(bytes) {
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const first = bytes[i];
      i += 1;
      let point;
      let continuation;
      if (first < 0x80) {
        point = first;
        continuation = 0;
      } else if ((first & 0xe0) === 0xc0) {
        point = first & 31;
        continuation = 1;
      } else if ((first & 0xf0) === 0xe0) {
        point = first & 15;
        continuation = 2;
      } else if ((first & 0xf8) === 0xf0) {
        point = first & 7;
        continuation = 3;
      } else {
        out += String.fromCharCode(0xfffd);
        continue;
      }
      let valid = true;
      for (let k = 0; k < continuation; k++) {
        const next = bytes[i];
        if (next === undefined || (next & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        point = (point << 6) | (next & 63);
        i += 1;
      }
      if (!valid || point > 0x10ffff) {
        out += String.fromCharCode(0xfffd);
        continue;
      }
      if (point > 0xffff) {
        const rest = point - 0x10000;
        out += String.fromCharCode(0xd800 + (rest >> 10), 0xdc00 + (rest & 1023));
      } else {
        out += String.fromCharCode(point);
      }
    }
    return out;
  }

  function toByteView(input) {
    if (input instanceof Uint8Array) {
      return input;
    }
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    throw new TypeError("expected an ArrayBuffer or a typed array");
  }

  function btoa(data) {
    const text = String(data);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      if (charCode > 255) {
        throw new TypeError(
          "btoa: the string contains characters outside of the Latin1 range"
        );
      }
      bytes[i] = charCode;
    }
    return bytesToBase64(bytes);
  }

  function atob(data) {
    const bytes = base64ToBytes(String(data));
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += String.fromCharCode(bytes[i]);
    }
    return out;
  }

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input) {
      return utf8Encode(input === undefined ? "" : String(input));
    }
    encodeInto(source, destination) {
      const text = String(source);
      let read = 0;
      let written = 0;
      let i = 0;
      while (i < text.length) {
        const high = text.charCodeAt(i);
        const isPair =
          high >= 0xd800 &&
          high <= 0xdbff &&
          i + 1 < text.length &&
          text.charCodeAt(i + 1) >= 0xdc00 &&
          text.charCodeAt(i + 1) <= 0xdfff;
        const unit = text.slice(i, i + (isPair ? 2 : 1));
        const encoded = utf8Encode(unit);
        if (written + encoded.length > destination.length) {
          break;
        }
        destination.set(encoded, written);
        written += encoded.length;
        read += unit.length;
        i += unit.length;
      }
      return { read: read, written: written };
    }
  }

  class TextDecoder {
    constructor(label) {
      const name = label === undefined ? "utf-8" : String(label).toLowerCase();
      if (name !== "utf-8" && name !== "utf8" && name !== "unicode-1-1-utf-8") {
        throw new RangeError(
          "TextDecoder: the sandbox only supports the utf-8 encoding"
        );
      }
    }
    get encoding() {
      return "utf-8";
    }
    decode(input) {
      if (input === undefined) {
        return "";
      }
      return utf8Decode(toByteView(input));
    }
  }

  function cloneValue(value, seen) {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function" || typeof value === "symbol") {
        throw new TypeError(
          "structuredClone: a " + typeof value + " could not be cloned"
        );
      }
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (value instanceof Date) {
      const clone = new Date(value.getTime());
      seen.set(value, clone);
      return clone;
    }
    if (value instanceof RegExp) {
      const clone = new RegExp(value.source, value.flags);
      seen.set(value, clone);
      return clone;
    }
    if (value instanceof ArrayBuffer) {
      const clone = value.slice(0);
      seen.set(value, clone);
      return clone;
    }
    if (ArrayBuffer.isView(value)) {
      const buffer = cloneValue(value.buffer, seen);
      const clone =
        value instanceof DataView
          ? new DataView(buffer, value.byteOffset, value.byteLength)
          : new value.constructor(buffer, value.byteOffset, value.length);
      seen.set(value, clone);
      return clone;
    }
    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      seen.set(value, clone);
      for (let i = 0; i < value.length; i++) {
        clone[i] = cloneValue(value[i], seen);
      }
      return clone;
    }
    if (value instanceof Map) {
      const clone = new Map();
      seen.set(value, clone);
      for (const pair of value) {
        clone.set(cloneValue(pair[0], seen), cloneValue(pair[1], seen));
      }
      return clone;
    }
    if (value instanceof Set) {
      const clone = new Set();
      seen.set(value, clone);
      for (const item of value) {
        clone.add(cloneValue(item, seen));
      }
      return clone;
    }
    if (value instanceof Error) {
      const clone = new value.constructor(value.message);
      clone.name = value.name;
      clone.stack = value.stack;
      seen.set(value, clone);
      return clone;
    }
    const clone = {};
    seen.set(value, clone);
    for (const key of Object.keys(value)) {
      clone[key] = cloneValue(value[key], seen);
    }
    return clone;
  }

  function structuredClone(value) {
    return cloneValue(value, new Map());
  }

  // ---- Headers -------------------------------------------------------------

  const headerEntries = new WeakMap();

  function normalizeHeaderName(name) {
    const normalized = String(name).toLowerCase();
    if (normalized.length === 0) {
      throw new TypeError("Headers: the header name must not be empty");
    }
    return normalized;
  }

  function combinedHeaderNames(list) {
    const names = [];
    for (const entry of list) {
      if (!names.includes(entry[0])) {
        names.push(entry[0]);
      }
    }
    names.sort();
    return names;
  }

  class Headers {
    constructor(init) {
      headerEntries.set(this, []);
      if (init === undefined || init === null) {
        return;
      }
      if (init instanceof Headers) {
        for (const entry of headerEntries.get(init)) {
          this.append(entry[0], entry[1]);
        }
        return;
      }
      if (Array.isArray(init)) {
        for (const entry of init) {
          this.append(entry[0], entry[1]);
        }
        return;
      }
      if (typeof init === "object") {
        for (const key of Object.keys(init)) {
          this.append(key, init[key]);
        }
        return;
      }
      throw new TypeError("Headers: unsupported initializer");
    }
    append(name, value) {
      headerEntries.get(this).push([normalizeHeaderName(name), String(value).trim()]);
    }
    set(name, value) {
      const key = normalizeHeaderName(name);
      const kept = [];
      for (const entry of headerEntries.get(this)) {
        if (entry[0] !== key) {
          kept.push(entry);
        }
      }
      kept.push([key, String(value).trim()]);
      headerEntries.set(this, kept);
    }
    get(name) {
      const key = normalizeHeaderName(name);
      const values = [];
      for (const entry of headerEntries.get(this)) {
        if (entry[0] === key) {
          values.push(entry[1]);
        }
      }
      return values.length === 0 ? null : values.join(", ");
    }
    getSetCookie() {
      const values = [];
      for (const entry of headerEntries.get(this)) {
        if (entry[0] === "set-cookie") {
          values.push(entry[1]);
        }
      }
      return values;
    }
    has(name) {
      return this.get(name) !== null;
    }
    delete(name) {
      const key = normalizeHeaderName(name);
      const kept = [];
      for (const entry of headerEntries.get(this)) {
        if (entry[0] !== key) {
          kept.push(entry);
        }
      }
      headerEntries.set(this, kept);
    }
    get size() {
      return combinedHeaderNames(headerEntries.get(this)).length;
    }
    entries() {
      const out = [];
      for (const name of combinedHeaderNames(headerEntries.get(this))) {
        out.push([name, this.get(name)]);
      }
      return out[Symbol.iterator]();
    }
    keys() {
      return combinedHeaderNames(headerEntries.get(this))[Symbol.iterator]();
    }
    values() {
      const out = [];
      for (const name of combinedHeaderNames(headerEntries.get(this))) {
        out.push(this.get(name));
      }
      return out[Symbol.iterator]();
    }
    forEach(callback, thisArg) {
      for (const entry of this.entries()) {
        callback.call(thisArg, entry[1], entry[0], this);
      }
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }

  // ---- URLSearchParams -----------------------------------------------------

  const searchParamsState = new WeakMap();

  function encodeFormComponent(text) {
    const bytes = utf8Encode(String(text));
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      const char = String.fromCharCode(byte);
      const isUnreserved =
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        char === "*" ||
        char === "-" ||
        char === "." ||
        char === "_";
      if (isUnreserved) {
        out += char;
      } else if (byte === 0x20) {
        out += "+";
      } else {
        out += "%" + HEX.charAt(byte >> 4) + HEX.charAt(byte & 15);
      }
    }
    return out;
  }

  function decodeFormComponent(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const char = text.charAt(i);
      if (char === "+") {
        bytes.push(0x20);
        continue;
      }
      if (char === "%" && i + 2 < text.length) {
        const hex = text.slice(i + 1, i + 3);
        const parsed = Number.parseInt(hex, 16);
        if (!Number.isNaN(parsed)) {
          bytes.push(parsed);
          i += 2;
          continue;
        }
      }
      const encoded = utf8Encode(char);
      for (let k = 0; k < encoded.length; k++) {
        bytes.push(encoded[k]);
      }
    }
    return utf8Decode(new Uint8Array(bytes));
  }

  function parseQueryString(query) {
    const list = [];
    let text = String(query);
    if (text.charAt(0) === "?") {
      text = text.slice(1);
    }
    if (text.length === 0) {
      return list;
    }
    for (const chunk of text.split("&")) {
      if (chunk.length === 0) {
        continue;
      }
      const separator = chunk.indexOf("=");
      const rawName = separator === -1 ? chunk : chunk.slice(0, separator);
      const rawValue = separator === -1 ? "" : chunk.slice(separator + 1);
      list.push([decodeFormComponent(rawName), decodeFormComponent(rawValue)]);
    }
    return list;
  }

  function notifyParamsOwner(params) {
    const state = searchParamsState.get(params);
    if (state.onChange) {
      state.onChange(params.toString());
    }
  }

  class URLSearchParams {
    constructor(init) {
      searchParamsState.set(this, { list: [], onChange: null });
      if (init === undefined || init === null) {
        return;
      }
      if (init instanceof URLSearchParams) {
        for (const entry of searchParamsState.get(init).list) {
          this.append(entry[0], entry[1]);
        }
        return;
      }
      if (typeof init === "string") {
        searchParamsState.get(this).list = parseQueryString(init);
        return;
      }
      if (Array.isArray(init)) {
        for (const entry of init) {
          this.append(entry[0], entry[1]);
        }
        return;
      }
      if (typeof init === "object") {
        for (const key of Object.keys(init)) {
          this.append(key, init[key]);
        }
        return;
      }
      throw new TypeError("URLSearchParams: unsupported initializer");
    }
    append(name, value) {
      searchParamsState.get(this).list.push([String(name), String(value)]);
      notifyParamsOwner(this);
    }
    set(name, value) {
      const key = String(name);
      const state = searchParamsState.get(this);
      const kept = [];
      let replaced = false;
      for (const entry of state.list) {
        if (entry[0] !== key) {
          kept.push(entry);
          continue;
        }
        if (!replaced) {
          kept.push([key, String(value)]);
          replaced = true;
        }
      }
      if (!replaced) {
        kept.push([key, String(value)]);
      }
      state.list = kept;
      notifyParamsOwner(this);
    }
    get(name) {
      const key = String(name);
      for (const entry of searchParamsState.get(this).list) {
        if (entry[0] === key) {
          return entry[1];
        }
      }
      return null;
    }
    getAll(name) {
      const key = String(name);
      const out = [];
      for (const entry of searchParamsState.get(this).list) {
        if (entry[0] === key) {
          out.push(entry[1]);
        }
      }
      return out;
    }
    has(name) {
      return this.get(name) !== null;
    }
    delete(name) {
      const key = String(name);
      const state = searchParamsState.get(this);
      const kept = [];
      for (const entry of state.list) {
        if (entry[0] !== key) {
          kept.push(entry);
        }
      }
      state.list = kept;
      notifyParamsOwner(this);
    }
    sort() {
      const state = searchParamsState.get(this);
      state.list.sort(function byName(left, right) {
        if (left[0] < right[0]) {
          return -1;
        }
        return left[0] > right[0] ? 1 : 0;
      });
      notifyParamsOwner(this);
    }
    get size() {
      return searchParamsState.get(this).list.length;
    }
    entries() {
      const out = [];
      for (const entry of searchParamsState.get(this).list) {
        out.push([entry[0], entry[1]]);
      }
      return out[Symbol.iterator]();
    }
    keys() {
      const out = [];
      for (const entry of searchParamsState.get(this).list) {
        out.push(entry[0]);
      }
      return out[Symbol.iterator]();
    }
    values() {
      const out = [];
      for (const entry of searchParamsState.get(this).list) {
        out.push(entry[1]);
      }
      return out[Symbol.iterator]();
    }
    forEach(callback, thisArg) {
      for (const entry of this.entries()) {
        callback.call(thisArg, entry[1], entry[0], this);
      }
    }
    toString() {
      const parts = [];
      for (const entry of searchParamsState.get(this).list) {
        parts.push(
          encodeFormComponent(entry[0]) + "=" + encodeFormComponent(entry[1])
        );
      }
      return parts.join("&");
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }

  // ---- URL -----------------------------------------------------------------
  //
  // Parsing stays with the host's WHATWG implementation through the bridge, so
  // normalisation matches what the fetch guard will later re-parse; only
  // strings cross, and the component bag is rebuilt in this realm.

  const urlState = new WeakMap();

  function applyUrlComponents(url, components) {
    const state = urlState.get(url);
    state.components = components;
    if (state.params) {
      const paramsState = searchParamsState.get(state.params);
      paramsState.onChange = null;
      paramsState.list = parseQueryString(components.search);
      paramsState.onChange = state.onParamsChange;
    }
  }

  function hrefOf(value) {
    return value instanceof URL ? value.href : String(value);
  }

  class URL {
    constructor(input, base) {
      const state = { components: null, params: null, onParamsChange: null };
      urlState.set(this, state);
      const baseHref =
        base === undefined || base === null ? null : hrefOf(base);
      state.components = unwrap(bridge.parseUrl(hrefOf(input), baseHref));
      const self = this;
      state.onParamsChange = function onParamsChange(query) {
        const next = unwrap(
          bridge.setUrl(urlState.get(self).components.href, "search", query)
        );
        urlState.get(self).components = next;
      };
    }
    get searchParams() {
      const state = urlState.get(this);
      if (!state.params) {
        state.params = new URLSearchParams(state.components.search);
        searchParamsState.get(state.params).onChange = state.onParamsChange;
      }
      return state.params;
    }
    get origin() {
      return urlState.get(this).components.origin;
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
  }

  for (const name of [
    "href",
    "protocol",
    "username",
    "password",
    "host",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
  ]) {
    Object.defineProperty(URL.prototype, name, {
      enumerable: true,
      configurable: true,
      get: function readComponent() {
        return urlState.get(this).components[name];
      },
      set: function writeComponent(value) {
        applyUrlComponents(
          this,
          unwrap(
            bridge.setUrl(
              urlState.get(this).components.href,
              name,
              String(value)
            )
          )
        );
      },
    });
  }

  // ---- AbortController -----------------------------------------------------

  const signalState = new WeakMap();

  function makeAbortError(reason) {
    if (reason !== undefined) {
      return reason;
    }
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    return error;
  }

  class AbortSignal {
    constructor() {
      signalState.set(this, { aborted: false, reason: undefined, listeners: [], onabort: null });
    }
    get aborted() {
      return signalState.get(this).aborted;
    }
    get reason() {
      return signalState.get(this).reason;
    }
    get onabort() {
      return signalState.get(this).onabort;
    }
    set onabort(listener) {
      signalState.get(this).onabort = listener;
    }
    throwIfAborted() {
      const state = signalState.get(this);
      if (state.aborted) {
        throw state.reason;
      }
    }
    addEventListener(type, listener, options) {
      if (type !== "abort" || typeof listener !== "function") {
        return;
      }
      signalState.get(this).listeners.push({
        listener: listener,
        once: Boolean(options && options.once),
      });
    }
    removeEventListener(type, listener) {
      if (type !== "abort") {
        return;
      }
      const state = signalState.get(this);
      const kept = [];
      for (const entry of state.listeners) {
        if (entry.listener !== listener) {
          kept.push(entry);
        }
      }
      state.listeners = kept;
    }
    static abort(reason) {
      const signal = new AbortSignal();
      abortSignal(signal, reason);
      return signal;
    }
  }

  function abortSignal(signal, reason) {
    const state = signalState.get(signal);
    if (state.aborted) {
      return;
    }
    state.aborted = true;
    state.reason = makeAbortError(reason);
    const event = { type: "abort", target: signal };
    const pending = state.listeners;
    state.listeners = [];
    for (const entry of pending) {
      if (!entry.once) {
        state.listeners.push(entry);
      }
      entry.listener.call(signal, event);
    }
    if (typeof state.onabort === "function") {
      state.onabort.call(signal, event);
    }
  }

  const controllerSignals = new WeakMap();

  class AbortController {
    constructor() {
      controllerSignals.set(this, new AbortSignal());
    }
    get signal() {
      return controllerSignals.get(this);
    }
    abort(reason) {
      abortSignal(controllerSignals.get(this), reason);
    }
  }

  // ---- fetch ---------------------------------------------------------------

  const responseState = new WeakMap();

  class SandboxResponse {
    constructor(payload) {
      responseState.set(this, { payload: payload, bytes: null });
      this.status = payload.status;
      this.statusText = payload.statusText;
      this.url = payload.url;
      this.redirected = payload.redirected;
      this.ok = payload.status >= 200 && payload.status <= 299;
      this.headers = new Headers(payload.headers);
      this.bodyUsed = false;
    }
    bytes() {
      const state = responseState.get(this);
      if (!state.bytes) {
        state.bytes = base64ToBytes(state.payload.bodyBase64);
      }
      this.bodyUsed = true;
      return Promise.resolve(state.bytes);
    }
    arrayBuffer() {
      return this.bytes().then(function toBuffer(bytes) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      });
    }
    text() {
      return this.bytes().then(function toText(bytes) {
        return utf8Decode(bytes);
      });
    }
    json() {
      return this.text().then(function toJson(text) {
        return JSON.parse(text);
      });
    }
    clone() {
      return new SandboxResponse(responseState.get(this).payload);
    }
  }

  function headerPairsFrom(init) {
    const headers = new Headers(init === undefined ? undefined : init);
    const pairs = [];
    for (const entry of headers.entries()) {
      pairs.push([entry[0], entry[1]]);
    }
    return pairs;
  }

  function encodeRequestBody(body, pairs) {
    if (body === undefined || body === null) {
      return null;
    }
    let hasContentType = false;
    for (const pair of pairs) {
      if (pair[0] === "content-type") {
        hasContentType = true;
      }
    }
    if (body instanceof URLSearchParams) {
      if (!hasContentType) {
        pairs.push([
          "content-type",
          "application/x-www-form-urlencoded;charset=UTF-8",
        ]);
      }
      return bytesToBase64(utf8Encode(body.toString()));
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return bytesToBase64(toByteView(body));
    }
    if (!hasContentType) {
      pairs.push(["content-type", "text/plain;charset=UTF-8"]);
    }
    return bytesToBase64(utf8Encode(String(body)));
  }

  function buildRequestSpec(resource, init) {
    // The resource is coerced to a string EXACTLY ONCE here, and that single
    // string is what the host validates and dials. A resource whose toString()
    // and .url disagree therefore cannot show one URL to the SSRF guard and
    // another to the socket.
    const url = hrefOf(resource);
    const options = init === undefined || init === null ? {} : init;
    const method = options.method === undefined ? "GET" : String(options.method).toUpperCase();
    const pairs = headerPairsFrom(options.headers);
    const bodyBase64 =
      method === "GET" || method === "HEAD"
        ? null
        : encodeRequestBody(options.body, pairs);
    return { url: url, method: method, headers: pairs, bodyBase64: bodyBase64 };
  }

  function fetch(resource, init) {
    return new Promise(function startRequest(resolve, reject) {
      if (resource === undefined) {
        throw new TypeError("fetch: the resource argument is required");
      }
      const spec = buildRequestSpec(resource, init);
      const signal = init === undefined || init === null ? undefined : init.signal;
      if (signal && signal.aborted) {
        reject(signal.reason);
        return;
      }
      const id = bridge.startFetch(
        JSON.stringify(spec),
        function onFulfilled(payloadJson) {
          resolve(new SandboxResponse(JSON.parse(payloadJson)));
        },
        function onRejected(message, kind) {
          if (kind === "TypeError") {
            reject(new TypeError(message));
            return;
          }
          if (kind === "AbortError") {
            const error = new Error(message);
            error.name = "AbortError";
            reject(error);
            return;
          }
          reject(new Error(message));
        }
      );
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener(
          "abort",
          function onAbort() {
            bridge.abortFetch(id);
          },
          { once: true }
        );
      }
    });
  }

  // ---- install -------------------------------------------------------------

  const provided = {
    console: {
      log: function log() {
        bridge.log("log", Array.prototype.slice.call(arguments));
      },
      warn: function warn() {
        bridge.log("warn", Array.prototype.slice.call(arguments));
      },
      error: function error() {
        bridge.log("error", Array.prototype.slice.call(arguments));
      },
    },
    crypto: {
      randomUUID: function randomUUID() {
        return bridge.randomUUID();
      },
    },
    fetch: fetch,
    atob: atob,
    btoa: btoa,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    structuredClone: structuredClone,
    Headers: Headers,
    URL: URL,
    URLSearchParams: URLSearchParams,
    AbortController: AbortController,
    AbortSignal: AbortSignal,
  };

  for (const key of Object.keys(provided)) {
    Object.defineProperty(globalThis, key, {
      value: provided[key],
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

// Defense in depth on the bridge: with a null prototype, a bridge function
// that somehow leaked into the sandbox would still have no .constructor, and
// so no path to the host Function. The bridge is never published to user code
// in the first place; this makes a future mistake non-fatal.
function severPrototypes(target) {
  for (const key of Object.keys(target)) {
    if (typeof target[key] === "function") {
      Object.setPrototypeOf(target[key], null);
    }
  }
  Object.setPrototypeOf(target, null);
  return target;
}

const URL_SETTABLE_COMPONENTS = new Set([
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
  "href",
]);

// Flatten a host URL into the plain string bag the sandbox realm's own URL
// class is backed by. Parsing stays on the host's WHATWG implementation so
// normalisation matches what the fetch guard re-parses later.
function urlComponents(url) {
  return {
    href: url.href,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    origin: url.origin,
  };
}

// Read a response body into a single buffer, bounded by MAX_RESPONSE_BODY_BYTES.
// The sandbox realm cannot be handed the host Response itself, so the bytes are
// buffered here and cross as base64 text.
async function readResponseBody(response) {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    total += step.value.byteLength;
    if (total > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel();
      throw new Error(
        "sandbox fetch: response body exceeds " +
          String(MAX_RESPONSE_BODY_BYTES) +
          " bytes"
      );
    }
    chunks.push(
      Buffer.from(step.value.buffer, step.value.byteOffset, step.value.byteLength)
    );
  }
  return Buffer.concat(chunks);
}

// Flatten a host Response into the plain, primitive-only payload the sandbox
// realm rebuilds its own Response-shaped object from. Returning the host
// Response itself would hand user code a host object, and with it the host
// realm through Response.constructor.constructor.
async function marshalResponse(response, finalUrl, redirected) {
  const body = await readResponseBody(response);
  const headerPairs = [];
  response.headers.forEach(function collectHeader(value, key) {
    // forEach joins repeated headers with ", "; set-cookie is carried
    // separately below so each cookie survives as its own entry.
    if (key !== "set-cookie") {
      headerPairs.push([key, value]);
    }
  });
  for (const cookie of response.headers.getSetCookie()) {
    headerPairs.push(["set-cookie", cookie]);
  }
  return {
    url: finalUrl,
    status: response.status,
    statusText: response.statusText,
    redirected: redirected,
    headers: headerPairs,
    bodyBase64: body.toString("base64"),
  };
}

function safeCloneArg(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    try {
      return String(value);
    } catch (_e) {
      return "[unserializable]";
    }
  }
}

function run(input) {
  const { code, timeoutMs } = input;
  const logs = [];

  function captureLog(level, args) {
    if (logs.length >= MAX_LOG_ENTRIES) {
      return;
    }
    const cloned = new Array(args.length);
    for (let i = 0; i < args.length; i++) {
      cloned[i] = safeCloneArg(args[i]);
    }
    logs.push({ level: level, args: cloned });
  }

  // Turn the request spec the sandbox realm handed over (strings only) back
  // into a WHATWG Request. spec.url was coerced from the user's resource
  // EXACTLY ONCE, in-realm, and both the SSRF validation below and the actual
  // dial (pinnedFetch) read the URL from the single Request built from it, so
  // the address validated is provably the address dialed. An earlier version
  // validated resource.url while pinnedFetch dialed String(resource); a
  // crafted resource ({ url: <allowed>, toString: () => <IMDS> }) made those
  // diverge, and when the dialed value was an IP literal it skipped the pinned
  // lookup entirely and reached the blocked target (F-024 follow-up). Coercing
  // once also means a hostile toString / Symbol.toPrimitive runs a single
  // time, so it cannot hand one value to the guard and another to the socket.
  async function performFetch(spec, externalSignal) {
    let request;
    try {
      const headers = new Headers();
      for (const pair of spec.headers) {
        headers.append(pair[0], pair[1]);
      }
      const requestInit = {
        method: spec.method,
        headers: headers,
        redirect: "manual",
      };
      if (spec.bodyBase64 !== null) {
        requestInit.body = Buffer.from(spec.bodyBase64, "base64");
      }
      request = new Request(spec.url, requestInit);
    } catch (err) {
      throw new TypeError(
        "sandbox fetch: invalid request: " +
          (err && err.message ? err.message : String(err))
      );
    }
    const init = {
      method: request.method,
      headers: request.headers,
      body: spec.bodyBase64 === null ? undefined : Buffer.from(spec.bodyBase64, "base64"),
    };
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch (_e) {
      throw new TypeError("sandbox fetch: invalid URL: " + request.url);
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new Error("sandbox fetch: scheme not allowed: " + parsed.protocol);
    }

    const hostname = stripIpv6Brackets(parsed.hostname);
    const resolved = await resolveValidatedAddresses(hostname);
    if (resolved.blocked) {
      const targetIp = resolved.ip;
      const suffix = targetIp && targetIp !== hostname ? " -> " + targetIp : "";
      throw new Error(
        "sandbox fetch: SSRF blocked (" + hostname + suffix + ")"
      );
    }
    if (resolved.addresses.length === 0) {
      throw new Error("sandbox fetch: could not resolve " + hostname);
    }

    const controller = new AbortController();
    const timer = setTimeout(function onTimeout() {
      controller.abort();
    }, timeoutMs);

    if (externalSignal && externalSignal.aborted) {
      controller.abort();
    } else if (externalSignal) {
      externalSignal.addEventListener(
        "abort",
        function onCallerAbort() {
          controller.abort();
        },
        { once: true }
      );
    }

    // Follow redirects manually so every hop is re-validated. undici's
    // built-in follow mode would transparently chase a 3xx Location into a
    // blocked host (IMDS, K8s apiserver, *.svc.cluster.local) because the
    // SSRF guard above only sees the initial URL. "manual" returns the real
    // 3xx response with a readable Location header, so we re-run the same
    // scheme + SSRF checks before issuing the next request.
    const baseInit = Object.assign({}, init, {
      signal: controller.signal,
      redirect: "manual",
    });

    // currentRequest is the single, already-built Request dialed this hop.
    // currentInit only carries the method/body/headers used to build the NEXT
    // hop's request; the abort signal is passed to pinnedFetch directly.
    let currentRequest = request;
    let currentBase = parsed;
    let currentInit = baseInit;
    let currentAddresses = resolved.addresses;
    let redirectsLeft = MAX_SANDBOX_REDIRECTS;

    try {
      while (true) {
        // pinnedFetch dials only the SSRF-validated addresses (F-024); it does
        // not auto-follow redirects, so this loop re-resolves + re-validates
        // each hop below and pins the next hop's addresses before dialing it.
        const response = await pinnedFetch(
          currentRequest,
          currentAddresses,
          controller.signal
        );
        const location = REDIRECT_STATUSES.has(response.status)
          ? response.headers.get("location")
          : null;
        if (location === null) {
          // Marshal inside the try so the wall-clock timer above still covers
          // the body read.
          return await marshalResponse(
            response,
            currentRequest.url,
            redirectsLeft !== MAX_SANDBOX_REDIRECTS
          );
        }
        if (redirectsLeft <= 0) {
          await cancelResponseBody(response);
          throw new Error("sandbox fetch: too many redirects");
        }
        redirectsLeft -= 1;

        let nextUrl;
        try {
          nextUrl = new URL(location, currentBase);
        } catch (_e) {
          await cancelResponseBody(response);
          throw new Error("sandbox fetch: invalid redirect location: " + location);
        }
        if (!ALLOWED_SCHEMES.has(nextUrl.protocol)) {
          await cancelResponseBody(response);
          throw new Error("sandbox fetch: scheme not allowed: " + nextUrl.protocol);
        }
        const nextHostname = stripIpv6Brackets(nextUrl.hostname);
        const nextResolved = await resolveValidatedAddresses(nextHostname);
        if (nextResolved.blocked) {
          const nextIp = nextResolved.ip;
          const nextSuffix = nextIp && nextIp !== nextHostname ? " -> " + nextIp : "";
          await cancelResponseBody(response);
          throw new Error(
            "sandbox fetch: SSRF blocked (" + nextHostname + nextSuffix + ")"
          );
        }
        if (nextResolved.addresses.length === 0) {
          await cancelResponseBody(response);
          throw new Error("sandbox fetch: could not resolve " + nextHostname);
        }

        // Discard the redirect body so the underlying socket is freed before
        // issuing the next hop.
        await cancelResponseBody(response);

        currentInit = applyRedirectMethod(currentInit, response.status);
        // Build the next hop's request from the server-provided, re-validated
        // URL string (never a raw object), so its dial URL cannot diverge from
        // what nextResolved just validated.
        currentRequest = new Request(nextUrl.href, currentInit);
        currentBase = nextUrl;
        currentAddresses = nextResolved.addresses;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  let nextFetchId = 1;
  const inflightFetches = new Map();

  function errorMessageOf(err) {
    return err && err.message ? String(err.message) : String(err);
  }

  function errorKindOf(err) {
    if (err && err.name === "AbortError") {
      return "AbortError";
    }
    return err instanceof TypeError ? "TypeError" : "Error";
  }

  // The bridge is the ONLY host value the sandbox realm can reach, and it is
  // held in the bootstrap's closure rather than published as a global. Every
  // entry takes and returns primitives, and none of them may throw: a host
  // exception crossing into user code would be a catchable host Error, and
  // err.constructor.constructor is the host Function again. Failures therefore
  // come back as a JSON envelope or through the reject callback.
  const bridge = {
    log: function bridgeLog(level, args) {
      try {
        captureLog(level, args);
      } catch (_e) {
        // a hostile toString on a logged value must not break the run
      }
    },
    randomUUID: function bridgeRandomUUID() {
      return crypto.randomUUID();
    },
    parseUrl: function bridgeParseUrl(input, base) {
      try {
        const url = base === null ? new URL(input) : new URL(input, base);
        return JSON.stringify({ ok: true, v: urlComponents(url) });
      } catch (_e) {
        return JSON.stringify({ ok: false, e: "Invalid URL: " + input });
      }
    },
    setUrl: function bridgeSetUrl(href, name, value) {
      try {
        if (!URL_SETTABLE_COMPONENTS.has(name)) {
          return JSON.stringify({ ok: false, e: "Invalid URL component: " + name });
        }
        const url = new URL(href);
        url[name] = value;
        return JSON.stringify({ ok: true, v: urlComponents(url) });
      } catch (err) {
        return JSON.stringify({ ok: false, e: errorMessageOf(err) });
      }
    },
    startFetch: function bridgeStartFetch(specJson, onFulfilled, onRejected) {
      const id = nextFetchId;
      nextFetchId += 1;
      try {
        const abort = new AbortController();
        inflightFetches.set(id, abort);
        performFetch(JSON.parse(specJson), abort.signal).then(
          function onSettled(payload) {
            inflightFetches.delete(id);
            try {
              onFulfilled(JSON.stringify(payload));
            } catch (_e) {
              // the sandbox realm rejected its own promise; nothing to do here
            }
          },
          function onFailed(err) {
            inflightFetches.delete(id);
            try {
              onRejected(errorMessageOf(err), errorKindOf(err));
            } catch (_e) {
              // as above
            }
          }
        );
      } catch (err) {
        inflightFetches.delete(id);
        try {
          onRejected(errorMessageOf(err), "Error");
        } catch (_e) {
          // as above
        }
      }
      return id;
    },
    abortFetch: function bridgeAbortFetch(id) {
      const abort = inflightFetches.get(id);
      if (!abort) {
        return;
      }
      inflightFetches.delete(id);
      try {
        abort.abort();
      } catch (_e) {
        // already settled
      }
    },
  };
  severPrototypes(bridge);

  // A fresh context owns a complete set of realm-local intrinsics (Array,
  // JSON, Math, Object, the typed arrays, the Error hierarchy, Intl) whose
  // constructor chain terminates inside the sandbox. Nothing from this realm
  // is copied in; SharedArrayBuffer is the one deliberate override, blanking
  // the realm's own.
  //
  // The carrier object is null-prototype on purpose. createContext keeps it as
  // the context's contextified object and the global proxy forwards property
  // lookups to it, INCLUDING inherited ones -- so a plain {} carrier publishes
  // this realm's Object.prototype as globalThis.constructor, and
  // globalThis.constructor.constructor is the host Function. With no prototype
  // there is nothing to inherit and the lookup falls through to the context's
  // own global.
  const carrier = Object.create(null);
  carrier.SharedArrayBuffer = undefined;
  const sandbox = createContext(carrier);
  const installSandboxGlobals = runInContext(
    "(" + sandboxBootstrap.toString() + ")",
    sandbox,
    { filename: "sandbox-bootstrap.js" }
  );
  installSandboxGlobals(bridge);

  const wrappedCode = "(async () => {\\n" + code + "\\n})()";

  const userPromise = runInContext(wrappedCode, sandbox, {
    timeout: timeoutMs,
    filename: "user-code.js",
  }).then(
    function onResult(result) {
      return { ok: true, result: result, logs: logs };
    },
    function onError(err) {
      return {
        ok: false,
        errorMessage:
          err && err.message ? String(err.message) : String(err),
        errorStack: err && err.stack ? String(err.stack) : undefined,
        logs: logs,
      };
    }
  );

  // In-child wall-clock timeout. The vm \`timeout\` option only covers sync
  // CPU; a user promise that never settles (e.g. \`await new Promise(() => {})\`)
  // would otherwise let the child exit cleanly with code 0 the moment stdin
  // EOFs and no handles remain, producing a no-result outcome in the parent
  // instead of a timeout. The timer also keeps the event loop alive until a
  // race resolution.
  let timeoutTimer;
  const timeoutPromise = new Promise(function onTimeoutRace(resolveRace) {
    timeoutTimer = setTimeout(function onTimeoutFire() {
      resolveRace({
        ok: false,
        errorMessage:
          "Script execution timed out after " + String(timeoutMs) + " ms",
        logs: logs,
      });
    }, timeoutMs);
  });
  const settledUserPromise = userPromise.finally(function clearTimer() {
    clearTimeout(timeoutTimer);
  });
  return Promise.race([settledUserPromise, timeoutPromise]);
}

// Encode an outcome as tagged JSON. The PARENT recovers it with JSON.parse
// (safe on untrusted input) plus decodeSandboxResult(), so it never runs
// v8.deserialize on bytes a sandbox escape could control. Mirrors
// decodeSandboxNode in this module exactly; keep the two in lockstep.
// Throws on a value with no safe representation (function, symbol, cycle),
// which writeResult maps to a structured "not serializable" outcome.
function encodeResult(value, seen) {
  if (value === null) {
    return null;
  }
  const t = typeof value;
  if (t === "undefined") {
    return { "$": "undef" };
  }
  if (t === "boolean" || t === "string") {
    return value;
  }
  if (t === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) {
      return value;
    }
    let token = "-0";
    if (Number.isNaN(value)) {
      token = "NaN";
    } else if (value === Infinity) {
      token = "Inf";
    } else if (value === -Infinity) {
      token = "-Inf";
    }
    return { "$": "num", "v": token };
  }
  if (t === "bigint") {
    return { "$": "bigint", "v": value.toString() };
  }
  if (t === "function" || t === "symbol") {
    // Bare reason; writeResult's catch adds the "Result is not serializable: "
    // prefix so the message is not doubled.
    throw new Error(t);
  }
  if (seen.has(value)) {
    throw new Error("circular reference");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const arr = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        arr[i] = encodeResult(value[i], seen);
      }
      return arr;
    }
    // node:util type predicates, not instanceof: the value was built by the
    // sandbox realm's own Date / Map / Set, which are not this realm's.
    if (types.isDate(value)) {
      return { "$": "date", "v": value.getTime() };
    }
    if (types.isRegExp(value)) {
      return { "$": "regexp", "src": value.source, "flags": value.flags };
    }
    if (types.isMap(value)) {
      const entries = [];
      for (const pair of value) {
        entries.push([encodeResult(pair[0], seen), encodeResult(pair[1], seen)]);
      }
      return { "$": "map", "v": entries };
    }
    if (types.isSet(value)) {
      const items = [];
      for (const item of value) {
        items.push(encodeResult(item, seen));
      }
      return { "$": "set", "v": items };
    }
    if (types.isArrayBuffer(value)) {
      return {
        "$": "bytes",
        "k": "ArrayBuffer",
        "v": Buffer.from(value).toString("base64"),
      };
    }
    if (ArrayBuffer.isView(value)) {
      const kind =
        value.constructor && value.constructor.name
          ? value.constructor.name
          : "Uint8Array";
      return {
        "$": "bytes",
        "k": kind,
        "v": Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
          "base64"
        ),
      };
    }
    const out = {};
    let hasTagKey = false;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "$") {
        hasTagKey = true;
      }
      const encoded = encodeResult(value[key], seen);
      if (key === "__proto__") {
        // Only "__proto__" needs defineProperty (a plain assignment invokes the
        // prototype setter and drops it); every other key uses cheap assignment.
        Object.defineProperty(out, key, {
          value: encoded,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[key] = encoded;
      }
    }
    // Escape a user object that literally carries a "$" key so the parent does
    // not mistake it for a type tag.
    return hasTagKey ? { "$": "obj", "v": out } : out;
  } finally {
    seen.delete(value);
  }
}

function writeResult(message) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(encodeResult(message, new Set())), "utf8");
  } catch (cloneErr) {
    payload = Buffer.from(
      JSON.stringify(
        encodeResult(
          {
            ok: false,
            errorMessage:
              "Result is not serializable: " +
              (cloneErr && cloneErr.message
                ? cloneErr.message
                : String(cloneErr)),
            errorStack: undefined,
            logs: [],
          },
          new Set()
        )
      ),
      "utf8"
    );
  }
  // F-010: emit the result as a single length-prefixed frame on the dedicated
  // result pipe (fd RESULT_FD), NOT on stdout. The 4-byte big-endian length
  // lets the parent read exactly one frame and ignore anything appended after
  // it, and stdout stays purely user-facing (never deserialized). Use the
  // startup-captured __writeSync so escaped user code that reassigned
  // fs.writeSync cannot suppress the genuine frame.
  const header = Buffer.allocUnsafe(RESULT_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  const out = Buffer.concat([header, payload]);
  let written = 0;
  while (written < out.length) {
    try {
      written += __writeSync(RESULT_FD, out, written, out.length - written);
    } catch (writeErr) {
      if (writeErr && writeErr.code === "EAGAIN") {
        continue;
      }
      break;
    }
  }
  // Hard-exit through the captured reference so a lingering escaped child that
  // reassigned process.exit is still reaped promptly. Correctness does not
  // depend on this: the parent already took the first frame above.
  __exit(0);
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function onData(chunk) {
  stdinBuf += chunk;
});
process.stdin.on("end", async function onEnd() {
  let input;
  try {
    input = JSON.parse(stdinBuf);
  } catch (e) {
    writeResult({
      ok: false,
      errorMessage: "Bad input to sandbox: " + (e && e.message ? e.message : String(e)),
      logs: [],
    });
    return;
  }
  try {
    const outcome = await run(input);
    writeResult(outcome);
  } catch (err) {
    writeResult({
      ok: false,
      errorMessage: err && err.message ? String(err.message) : String(err),
      errorStack: err && err.stack ? String(err.stack) : undefined,
      logs: [],
    });
  }
});
`;
