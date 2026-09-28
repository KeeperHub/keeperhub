/**
 * #2430: extra error sources for the decode path.
 *
 * A direct execution decodes a revert against the ABI `abi` names - the
 * contract being called. That is the wrong ABI when the revert is raised in a
 * callee (a hook, a proxy implementation, a router). These tests pin both
 * halves of the field that fixes it:
 *
 *   - the request field is refused rather than silently inert when it cannot
 *     do what it says (unparseable, not an array, no error entries, over the
 *     count and size bounds)
 *   - `buildErrorDecodeInterface` puts the extras on the DECODE path only,
 *     after the target's own ABI, and never adds a function fragment
 *
 * The revert payload is the one from the issue: a hook reverting with
 * `ReleaseBlocked(uint256,bytes32)`, selector 0x5192a3c5.
 */

import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { decodeRevertReason } from "@/lib/web3/decode-revert-error";
import {
  buildErrorDecodeInterface,
  MAX_ERROR_ABI_DOCUMENT_BYTES,
  MAX_ERROR_ABI_DOCUMENTS,
  normalizeErrorAbiDocuments,
  readErrorAbiDocuments,
} from "@/lib/web3/extra-error-abis";

const TARGET_ABI = JSON.stringify([
  {
    type: "function",
    name: "complete",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "error",
    name: "NotReady",
    inputs: [{ name: "jobId", type: "uint256" }],
  },
]);

/** The hook's own errors, as a caller building the release gate would send. */
const HOOK_ERRORS = JSON.stringify([
  {
    type: "error",
    name: "ReleaseBlocked",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "reason", type: "bytes32" },
    ],
  },
]);

const REASON_CODE =
  "0x455f5354414c4500000000000000000000000000000000000000000000000000";

/** Revert data for the hook's error, built from the fragment itself. */
const RELEASE_BLOCKED_DATA = new ethers.Interface([
  "error ReleaseBlocked(uint256 jobId, bytes32 reason)",
]).encodeErrorResult("ReleaseBlocked", [BigInt(8), REASON_CODE]);

describe("readErrorAbiDocuments", () => {
  it("treats an absent field as no extras", () => {
    expect(readErrorAbiDocuments(undefined)).toEqual({
      ok: true,
      documents: [],
    });
    expect(readErrorAbiDocuments(null)).toEqual({ ok: true, documents: [] });
    expect(normalizeErrorAbiDocuments(undefined)).toEqual([]);
  });

  it("accepts a document that declares an error", () => {
    expect(readErrorAbiDocuments([HOOK_ERRORS])).toEqual({
      ok: true,
      documents: [HOOK_ERRORS],
    });
  });

  it("refuses a non-array field", () => {
    const result = readErrorAbiDocuments(HOOK_ERRORS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Invalid field type");
      expect(result.details).toContain("array");
    }
  });

  it("refuses more documents than the bound allows", () => {
    const many = Array.from(
      { length: MAX_ERROR_ABI_DOCUMENTS + 1 },
      () => HOOK_ERRORS
    );
    const result = readErrorAbiDocuments(many);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain(String(MAX_ERROR_ABI_DOCUMENTS));
    }
  });

  it("refuses a document over the size bound", () => {
    const oversized = `[{"type":"error","name":"Big","inputs":[],"description":"${"x".repeat(MAX_ERROR_ABI_DOCUMENT_BYTES)}"}]`;
    expect(oversized.length).toBeGreaterThan(MAX_ERROR_ABI_DOCUMENT_BYTES);
    const result = readErrorAbiDocuments([oversized]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("bytes");
    }
  });

  it("refuses an entry that is not a non-empty string", () => {
    for (const entry of ["", "   ", 42, null, {}]) {
      const result = readErrorAbiDocuments([entry]);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a document that is not JSON", () => {
    const result = readErrorAbiDocuments(["{not json"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("errorAbis[0]");
      expect(result.details).toContain("not valid JSON");
    }
  });

  it("refuses a document that is not a JSON array", () => {
    const result = readErrorAbiDocuments([JSON.stringify({ abi: [] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("JSON array");
    }
  });

  it("refuses a document with no error entries", () => {
    // A functions-only document cannot decode anything, so accepting it would
    // read as though the extra source had been consulted.
    const functionsOnly = JSON.stringify([
      { type: "function", name: "complete", inputs: [], outputs: [] },
    ]);
    const result = readErrorAbiDocuments([functionsOnly]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("no error entry");
    }
  });

  it("refuses an error entry the decoder cannot build", () => {
    // `Paused()` is how a Solidity signature looks, not how an ABI entry's
    // name is written. ethers skips it with a warning, so the document would
    // be inert - the failure this field exists to remove.
    const signatureName = JSON.stringify([
      { type: "error", name: "Paused()", inputs: [] },
    ]);
    const result = readErrorAbiDocuments([signatureName]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("no error entry the decoder can build");
    }
  });

  it("names the offending index", () => {
    const result = readErrorAbiDocuments([HOOK_ERRORS, "{not json"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("errorAbis[1]");
    }
  });
});

describe("buildErrorDecodeInterface", () => {
  it("decodes a callee's custom error with its arguments", () => {
    // The reported case: `abi` is the target's, so the hook's error has no
    // fragment on the decode path and the caller gets hex.
    const withTargetOnly = decodeRevertReason(
      { data: RELEASE_BLOCKED_DATA },
      new ethers.Interface(JSON.parse(TARGET_ABI))
    );
    expect(withTargetOnly).toBeUndefined();
    expect(RELEASE_BLOCKED_DATA.slice(0, 10)).toBe("0x5192a3c5");

    const decoded = decodeRevertReason(
      { data: RELEASE_BLOCKED_DATA },
      buildErrorDecodeInterface(TARGET_ABI, [HOOK_ERRORS])
    );
    expect(decoded).toBeDefined();
    expect(decoded).toContain("ReleaseBlocked(8");
    expect(decoded).toContain("0x455f5354414c45");
  });

  it("keeps the target's own errors decoding", () => {
    const targetError = new ethers.Interface(JSON.parse(TARGET_ABI));
    const notReady = targetError.encodeErrorResult("NotReady", [BigInt(3)]);
    expect(
      decodeRevertReason(
        { data: notReady },
        buildErrorDecodeInterface(TARGET_ABI, [HOOK_ERRORS])
      )
    ).toBe("NotReady(3)");
  });

  it("returns the target interface untouched when there is nothing to add", () => {
    const target = new ethers.Interface(JSON.parse(TARGET_ABI));
    expect(buildErrorDecodeInterface(TARGET_ABI, undefined)).toBeDefined();
    expect(buildErrorDecodeInterface(target, [])).toBe(target);
    expect(buildErrorDecodeInterface(undefined, undefined)).toBeUndefined();
  });

  it("does not admit a function fragment from an extra document", () => {
    // Encoding always uses `abi`, but the merged interface is also what the
    // error formatter reads. A function here must stay invisible to it.
    const withFunction = JSON.stringify([
      ...JSON.parse(HOOK_ERRORS),
      { type: "function", name: "drainAll", inputs: [], outputs: [] },
    ]);
    const merged = buildErrorDecodeInterface(TARGET_ABI, [withFunction]);
    expect(merged).toBeDefined();
    expect(
      merged?.fragments.some(
        (fragment) => "name" in fragment && fragment.name === "drainAll"
      )
    ).toBe(false);
    // The target's own function is still there, so the interface is the
    // target's plus errors and not something narrower.
    expect(merged?.getFunction("complete")).toBeDefined();
  });

  it("keeps one fragment when the target already declares the error", () => {
    const targetWithSameError = JSON.stringify([
      ...JSON.parse(TARGET_ABI),
      {
        type: "error",
        name: "ReleaseBlocked",
        inputs: [
          { name: "jobId", type: "uint256" },
          { name: "reason", type: "bytes32" },
        ],
      },
    ]);
    const merged = buildErrorDecodeInterface(targetWithSameError, [
      HOOK_ERRORS,
    ]);
    const matches = merged?.fragments.filter(
      (fragment) =>
        fragment.type === "error" &&
        "name" in fragment &&
        fragment.name === "ReleaseBlocked"
    );
    expect(matches).toHaveLength(1);
    expect(
      decodeRevertReason({ data: RELEASE_BLOCKED_DATA }, merged)
    ).toContain("ReleaseBlocked(8");
  });

  it("takes an error from any of the documents, in order", () => {
    // An error with no arguments formats as its bare name, the same shape a
    // decoded common error takes.
    const second = JSON.stringify([
      {
        type: "error",
        name: "Paused",
        inputs: [],
      },
    ]);
    const secondData = new ethers.Interface([
      "error Paused()",
    ]).encodeErrorResult("Paused", []);
    expect(
      decodeRevertReason(
        { data: secondData },
        buildErrorDecodeInterface(TARGET_ABI, [HOOK_ERRORS, second])
      )
    ).toBe("Paused");
  });

  it("skips a document it cannot parse and still decodes from the others", () => {
    const decoded = decodeRevertReason(
      { data: RELEASE_BLOCKED_DATA },
      buildErrorDecodeInterface(TARGET_ABI, ["{not json", HOOK_ERRORS])
    );
    expect(decoded).toContain("ReleaseBlocked(8");
  });

  it("decodes from the extras alone when there is no target ABI", () => {
    const decoded = decodeRevertReason(
      { data: RELEASE_BLOCKED_DATA },
      buildErrorDecodeInterface(undefined, [HOOK_ERRORS])
    );
    expect(decoded).toContain("ReleaseBlocked(8");
  });

  it("lets two differently-typed errors share a name", () => {
    // `format()` is the signature without argument names, so a same-signature
    // duplicate dedupes and a differently-typed one coexists. Each decodes by
    // its own selector.
    const differentTypes = JSON.stringify([
      {
        type: "error",
        name: "NotReady",
        inputs: [{ name: "jobId", type: "bytes32" }],
      },
    ]);
    const merged = buildErrorDecodeInterface(TARGET_ABI, [differentTypes]);
    const targetNotReady = new ethers.Interface(
      JSON.parse(TARGET_ABI)
    ).encodeErrorResult("NotReady", [BigInt(3)]);
    expect(decodeRevertReason({ data: targetNotReady }, merged)).toBe(
      "NotReady(3)"
    );

    const bytes32NotReady = new ethers.Interface([
      "error NotReady(bytes32 jobId)",
    ]).encodeErrorResult("NotReady", [REASON_CODE]);
    expect(decodeRevertReason({ data: bytes32NotReady }, merged)).toContain(
      "NotReady(0x455f5354414c45"
    );
  });
});
