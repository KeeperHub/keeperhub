import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  classifyRevert,
  decodeRevertReason,
  formatContractError,
} from "@/lib/web3/decode-revert-error";

/**
 * Coverage for the revert-decode + classify pipeline. Most of these
 * exercise the defensive paths in `classifyRevert` and the new Safe
 * GS-code classifier so a future refactor cannot silently flip the
 * fallback behavior.
 */

function encodeStringRevert(reason: string): string {
  // 0x08c379a0 = Error(string) selector
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string"],
    [reason]
  );
  return `0x08c379a0${encoded.slice(2)}`;
}

function encodeRoleConditionViolation(
  statusCode: number,
  paramOrKey = `0x${"00".repeat(32)}`
): string {
  const iface = new ethers.Interface([
    "error ConditionViolation(uint8 status, bytes32 paramOrAllowanceKey)",
  ]);
  return iface.encodeErrorResult("ConditionViolation", [
    statusCode,
    paramOrKey,
  ]);
}

describe("classifyRevert: defensive guards", () => {
  it("returns kind=unknown when error is null", () => {
    expect(classifyRevert(null)).toEqual({ kind: "unknown" });
  });

  it("returns kind=unknown when error is undefined", () => {
    expect(classifyRevert(undefined)).toEqual({ kind: "unknown" });
  });

  it("returns kind=unknown when error is a primitive", () => {
    expect(classifyRevert("not an error")).toEqual({ kind: "unknown" });
    expect(classifyRevert(42)).toEqual({ kind: "unknown" });
    expect(classifyRevert(true)).toEqual({ kind: "unknown" });
  });

  it("returns kind=unknown when revertData is 0x", () => {
    expect(classifyRevert({ data: "0x" })).toEqual({ kind: "unknown" });
  });

  it("returns kind=unknown when revertData is missing", () => {
    expect(classifyRevert({})).toEqual({ kind: "unknown" });
    expect(classifyRevert({ data: undefined })).toEqual({ kind: "unknown" });
  });

  it("returns kind=unknown when revertData is malformed (not 0x-prefixed)", () => {
    expect(classifyRevert({ data: "garbage" })).toEqual({ kind: "unknown" });
  });

  it("walks nested .error and .info wrappers without throwing", () => {
    const wrapped = {
      error: {
        info: {
          error: { data: encodeStringRevert("GS013") },
        },
      },
    };
    const result = classifyRevert(wrapped);
    expect(result.kind).toBe("safe-signature-invalid");
  });

  it("never throws on circular references", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { ref: a };
    a.ref = b;
    expect(() => classifyRevert(a)).not.toThrow();
  });
});

describe("classifyRevert: Safe GS-codes", () => {
  it("classifies GS013 as safe-signature-invalid", () => {
    const result = classifyRevert({ data: encodeStringRevert("GS013") });
    expect(result).toEqual({
      kind: "safe-signature-invalid",
      gsCode: "GS013",
      description: expect.stringContaining("signature"),
    });
  });

  it("classifies GS104 (only-from-enabled-module) as safe-not-authorized", () => {
    const result = classifyRevert({ data: encodeStringRevert("GS104") });
    expect(result.kind).toBe("safe-not-authorized");
  });

  it("classifies GS010/GS011/GS012 as safe-insufficient-gas", () => {
    for (const code of ["GS010", "GS011", "GS012"]) {
      const result = classifyRevert({ data: encodeStringRevert(code) });
      expect(result.kind).toBe("safe-insufficient-gas");
    }
  });

  it("classifies GS201 (threshold > owners) as safe-error", () => {
    const result = classifyRevert({ data: encodeStringRevert("GS201") });
    expect(result.kind).toBe("safe-error");
  });

  it("extracts embedded GS-code from prefixed revert string", () => {
    const result = classifyRevert({
      data: encodeStringRevert("Safe execution failed: GS013"),
    });
    expect(result.kind).toBe("safe-signature-invalid");
  });

  it("trims whitespace before matching", () => {
    const result = classifyRevert({
      data: encodeStringRevert("  GS013  "),
    });
    expect(result.kind).toBe("safe-signature-invalid");
  });

  it("matches the first GS-code in a chained wrapper string", () => {
    const result = classifyRevert({
      data: encodeStringRevert("Module call: GS104; downstream: GS013"),
    });
    if (result.kind !== "safe-not-authorized") {
      throw new Error(`expected safe-not-authorized, got ${result.kind}`);
    }
    expect(result.gsCode).toBe("GS104");
  });

  it("respects word boundaries (does not match GS01300)", () => {
    const result = classifyRevert({ data: encodeStringRevert("GS01300") });
    expect(result.kind).toBe("string-revert");
  });

  it("falls through to string-revert for unknown GS codes (GS999)", () => {
    const result = classifyRevert({ data: encodeStringRevert("GS999") });
    if (result.kind !== "string-revert") {
      throw new Error(`expected string-revert, got ${result.kind}`);
    }
    expect(result.reason).toBe("GS999");
  });

  it("returns string-revert for non-Safe revert reasons", () => {
    const result = classifyRevert({
      data: encodeStringRevert("amount must be positive"),
    });
    if (result.kind !== "string-revert") {
      throw new Error(`expected string-revert, got ${result.kind}`);
    }
    expect(result.reason).toBe("amount must be positive");
  });
});

describe("classifyRevert: Roles modifier", () => {
  it("decodes ConditionViolation with AllowanceExceeded (status 17)", () => {
    const result = classifyRevert({ data: encodeRoleConditionViolation(17) });
    if (result.kind !== "role-condition-violation") {
      throw new Error(`expected role-condition-violation, got ${result.kind}`);
    }
    expect(result.status).toBe("AllowanceExceeded");
    expect(result.statusCode).toBe(17);
  });

  it("decodes ConditionViolation with EtherAllowanceExceeded (status 19)", () => {
    const result = classifyRevert({ data: encodeRoleConditionViolation(19) });
    if (result.kind !== "role-condition-violation") {
      throw new Error(`expected role-condition-violation, got ${result.kind}`);
    }
    expect(result.status).toBe("EtherAllowanceExceeded");
  });

  it("falls back to Status{n} label for unknown status codes", () => {
    const result = classifyRevert({ data: encodeRoleConditionViolation(99) });
    if (result.kind !== "role-condition-violation") {
      throw new Error(`expected role-condition-violation, got ${result.kind}`);
    }
    expect(result.status).toBe("Status99");
  });
});

describe("classifyRevert: common OZ errors", () => {
  it("classifies ERC20InsufficientBalance with structured args", () => {
    const iface = new ethers.Interface([
      "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    ]);
    const data = iface.encodeErrorResult("ERC20InsufficientBalance", [
      ethers.ZeroAddress,
      BigInt(100),
      BigInt(200),
    ]);
    const result = classifyRevert({ data });
    expect(result).toEqual({
      kind: "erc20-insufficient-balance",
      balance: "100",
      needed: "200",
    });
  });

  it("classifies EnforcedPause as paused", () => {
    const iface = new ethers.Interface(["error EnforcedPause()"]);
    const data = iface.encodeErrorResult("EnforcedPause", []);
    expect(classifyRevert({ data })).toEqual({ kind: "paused" });
  });

  it("classifies ReentrancyGuardReentrantCall as reentrancy", () => {
    const iface = new ethers.Interface([
      "error ReentrancyGuardReentrantCall()",
    ]);
    const data = iface.encodeErrorResult("ReentrancyGuardReentrantCall", []);
    expect(classifyRevert({ data })).toEqual({ kind: "reentrancy" });
  });
});

describe("decodeRevertReason: string-form fallback", () => {
  it("formats the decoded Error(string) revert with name + arg", () => {
    // decodeRevertReason routes Error(string) through ethers'
    // built-in parser and emits the "Name(arg)" form. classifyRevert
    // unpacks to the bare string; this is the legacy formatter and
    // we keep its shape for callers that depend on it.
    expect(decodeRevertReason({ data: encodeStringRevert("EXPIRED") })).toBe(
      "Error(EXPIRED)"
    );
  });

  it("returns undefined for empty or malformed revert data", () => {
    expect(decodeRevertReason({ data: "0x" })).toBeUndefined();
    expect(decodeRevertReason({})).toBeUndefined();
    expect(decodeRevertReason(null)).toBeUndefined();
  });
});

describe("formatContractError: ABI output mismatch", () => {
  const MEMO_ABI = [
    "function transferWithMemo(address,uint256,bytes32) returns (bool)",
  ];

  function badDataError(abi: string[], data: string): unknown {
    const iface = new ethers.Interface(abi);
    try {
      iface.decodeFunctionResult("transferWithMemo", data);
    } catch (error) {
      return error;
    }
    throw new Error("expected decodeFunctionResult to throw");
  }

  it("names the supplied ABI when the contract returns no data", () => {
    const iface = new ethers.Interface(MEMO_ABI);
    const message = formatContractError(badDataError(MEMO_ABI, "0x"), iface);
    expect(message).toBe(
      "Contract call failed: Contract returned no data, but the ABI you supplied declares 1 output (bool) for transferWithMemo. If this function returns nothing, use outputs: []."
    );
  });

  it("reports the byte count when the returned data is the wrong shape", () => {
    const iface = new ethers.Interface([
      "function transferWithMemo(address,uint256,bytes32) returns (bool,uint256)",
    ]);
    const message = formatContractError(
      badDataError(
        [
          "function transferWithMemo(address,uint256,bytes32) returns (bool,uint256)",
        ],
        `0x${"00".repeat(32)}`
      ),
      iface
    );
    expect(message).toContain("Contract returned 32 bytes");
    expect(message).toContain("2 outputs (bool, uint256)");
  });

  it("still describes the mismatch without the contract interface", () => {
    const message = formatContractError(badDataError(MEMO_ABI, "0x"));
    expect(message).toContain("declares a return value for transferWithMemo");
  });

  it("leaves revert errors and their decoded reason untouched", () => {
    expect(
      formatContractError({ data: encodeStringRevert("LK: not yet due") })
    ).toBe("Contract call failed: Error(LK: not yet due)");
  });

  it("redacts a keyed provider URL from a pass-through message", () => {
    const message = formatContractError(
      new Error(
        'could not coalesce error (info={ "requestUrl": "https://lb.drpc.live/ethereum/FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAAAAAA" }, code=UNKNOWN_ERROR)'
      )
    );
    expect(message).not.toContain("drpc.live");
    expect(message).not.toContain("FAKE_TEST_KEY");
    expect(message).toContain("[REDACTED-URL]");
  });

  it("redacts an internal provider host carrying no key", () => {
    const message = formatContractError(
      new Error(
        'server response 500 (info={ "requestUrl": "https://rpc-internal.example.invalid/ethereum" }, code=SERVER_ERROR)'
      )
    );
    expect(message).not.toContain("rpc-internal.example.invalid");
    expect(message).toContain("[REDACTED-URL]");
  });

  it("drops the ethers version from pass-through messages", () => {
    const message = formatContractError(
      new Error(
        'missing revert data (action="estimateGas", code=CALL_EXCEPTION, version=6.16.0)'
      )
    );
    expect(message).not.toContain("version=");
    expect(message).toContain("code=CALL_EXCEPTION");
  });
});
