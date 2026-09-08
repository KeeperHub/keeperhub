import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseNativeValueWei,
  parseNodeNativeValueWei,
} from "@/app/api/execute/_lib/reserved-value";

describe("parseNativeValueWei", () => {
  it("parses a decimal ETH amount to wei", () => {
    expect(parseNativeValueWei("1.5")).toEqual({
      ok: true,
      valueWei: "1500000000000000000",
    });
  });

  it("treats undefined/null/empty as 0", () => {
    expect(parseNativeValueWei(undefined)).toEqual({ ok: true, valueWei: "0" });
    expect(parseNativeValueWei(null)).toEqual({ ok: true, valueWei: "0" });
    expect(parseNativeValueWei("")).toEqual({ ok: true, valueWei: "0" });
  });

  it("rejects a non-numeric amount", () => {
    expect(parseNativeValueWei("abc").ok).toBe(false);
  });

  it("rejects a negative amount (would bank credit against the cap)", () => {
    // ethers.parseEther("-5") returns a negative BigInt without throwing.
    expect(parseNativeValueWei("-5").ok).toBe(false);
  });

  it("rejects more than 18 decimals", () => {
    expect(parseNativeValueWei("1.0000000000000000001").ok).toBe(false);
  });
});

describe("parseNodeNativeValueWei", () => {
  it("charges a native transfer's amount", () => {
    expect(
      parseNodeNativeValueWei("transferFundsStep", { amount: "2" })
    ).toEqual({ ok: true, kind: "evm", valueWei: "2000000000000000000" });
  });

  it("charges a contract write's ethValue", () => {
    expect(
      parseNodeNativeValueWei("writeContractStep", { ethValue: "0.1" })
    ).toEqual({ ok: true, kind: "evm", valueWei: "100000000000000000" });
  });

  it("ignores a token transfer's amount (no native value moved)", () => {
    expect(
      parseNodeNativeValueWei("transferTokenStep", { amount: "1000000" })
    ).toEqual({ ok: true, kind: "evm", valueWei: "0" });
  });

  it("reserves 0 for off-chain / unrecognized steps with no ethValue", () => {
    expect(parseNodeNativeValueWei("httpRequestStep", { amount: "5" })).toEqual(
      { ok: true, kind: "evm", valueWei: "0" }
    );
  });

  it("charges any step that forwards ethValue, not just writeContractStep", () => {
    // A future value-forwarding action reserves its ethValue instead of
    // silently bypassing the cap with "0".
    expect(
      parseNodeNativeValueWei("someFutureWriteStep", { ethValue: "0.25" })
    ).toEqual({ ok: true, kind: "evm", valueWei: "250000000000000000" });
  });

  it("propagates a parse failure for a value-bearing step", () => {
    expect(
      parseNodeNativeValueWei("transferFundsStep", { amount: "-5" }).ok
    ).toBe(false);
  });
});

describe("parseNodeNativeValueWei Solana steps", () => {
  it("requires maxSol on a raw instruction rather than reserving 0", () => {
    const result = parseNodeNativeValueWei("sendRawSolanaInstructionStep", {
      network: "103",
      instructions: "[]",
    });

    // The bypass this guards: with no maxSol these steps previously fell
    // through to the ethValue branch and reserved "0" while being able to move
    // arbitrary SOL.
    expect(result.ok).toBe(false);
  });

  it("requires maxSol on an Anchor program call", () => {
    expect(
      parseNodeNativeValueWei("callSolanaProgramStep", { network: "103" }).ok
    ).toBe(false);
  });

  it("charges a declared maxSol in lamports, not wei", () => {
    expect(
      parseNodeNativeValueWei("sendRawSolanaInstructionStep", {
        network: "103",
        maxSol: "1.5",
      })
      // 1.5 SOL at SOL's native 9 decimals. An 18-decimal parse would yield
      // 1500000000000000000 and charge the wrong cap.
    ).toEqual({ ok: true, kind: "solana", valueLamports: "1500000000" });
  });

  it("rejects a blank maxSol instead of treating it as zero", () => {
    expect(
      parseNodeNativeValueWei("callSolanaProgramStep", {
        network: "103",
        maxSol: "   ",
      }).ok
    ).toBe(false);
  });

  it("parses a native transfer on a Solana network as lamports", () => {
    // transferFundsStep is chain-agnostic, so its unit comes from the network,
    // not the step name.
    expect(
      parseNodeNativeValueWei("transferFundsStep", {
        network: "103",
        amount: "0.001",
      })
    ).toEqual({ ok: true, kind: "solana", valueLamports: "1000000" });
  });

  it("still parses a native transfer on an EVM network as wei", () => {
    expect(
      parseNodeNativeValueWei("transferFundsStep", {
        network: "1",
        amount: "2",
      })
    ).toEqual({ ok: true, kind: "evm", valueWei: "2000000000000000000" });
  });

  it("reserves worst-case SPL fee lamports for transferSplTokenStep", () => {
    expect(
      parseNodeNativeValueWei("transferSplTokenStep", {
        network: "103",
      })
    ).toEqual({ ok: true, kind: "solana", valueLamports: "2105000" });
  });

  it("rejects transferSplTokenStep on a non-Solana network", () => {
    expect(
      parseNodeNativeValueWei("transferSplTokenStep", {
        network: "1",
      }).ok
    ).toBe(false);
  });
});
