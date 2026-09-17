import { describe, expect, it } from "vitest";
import type { DisbursementLeg } from "@/lib/db/schema";
import {
  assetKey,
  canonicalAmount,
  type LegSpec,
  MAX_DISBURSE_LEGS,
  parseLegs,
  planLeg,
  receiptVerdict,
  recipientKey,
  STALE_CLAIM_MS,
  validateRunKey,
} from "@/lib/web3/disbursement-plan";

const NOW = new Date("2026-09-17T12:00:00Z");

const SPEC: LegSpec = {
  index: 0,
  chainId: 84_532,
  asset: "erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  recipient: "0x106175f175b940cca1816d75eb19937a88be7720",
  amount: "1",
};

function row(overrides: Partial<DisbursementLeg>): DisbursementLeg {
  return {
    organizationId: "org",
    runKey: "run",
    legIndex: 0,
    chainId: SPEC.chainId,
    asset: SPEC.asset,
    recipient: SPEC.recipient,
    amount: SPEC.amount,
    status: "claimed",
    claimToken: "t",
    claimedAt: NOW,
    executionId: "exec-1",
    nodeId: "disburse-1",
    transactionHash: null,
    sendTransactionStatusId: null,
    lastError: null,
    settledAt: null,
    resolvedBy: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("canonicalAmount", () => {
  it("treats reformatted amounts as the same amount", () => {
    expect(canonicalAmount("1.50")).toBe("1.5");
    expect(canonicalAmount("1.0")).toBe("1");
    expect(canonicalAmount(" 2 ")).toBe("2");
    expect(canonicalAmount("0.000001")).toBe("0.000001");
  });

  it("rejects anything that is not a positive plain decimal", () => {
    for (const bad of ["0", "0.0", "-1", "1e3", "01", ".5", "1.", "abc", ""]) {
      expect(canonicalAmount(bad), bad).toBeNull();
    }
  });
});

describe("assetKey and recipientKey", () => {
  it("normalises an ERC-20 address and refuses a malformed one", () => {
    expect(
      assetKey("erc20", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
    ).toBe("erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e");
    expect(assetKey("erc20", "0x1234")).toBeNull();
    expect(assetKey("erc20", undefined)).toBeNull();
  });

  it("keeps an SPL mint and native as they are", () => {
    expect(assetKey("spl", "So11111111111111111111111111111111111111112")).toBe(
      "spl:So11111111111111111111111111111111111111112"
    );
    expect(assetKey("native", undefined)).toBe("native");
  });

  it("compares EVM recipients case-insensitively but never Solana ones", () => {
    expect(recipientKey("0xABcd", false)).toBe("0xabcd");
    expect(recipientKey("AbCd", true)).toBe("AbCd");
  });
});

describe("parseLegs", () => {
  it("accepts a JSON string or an array, in order", () => {
    const text =
      '[{"recipient":"0xa","amount":"1"},{"recipient":"0xb","amount":2}]';
    expect(parseLegs(text)).toEqual({
      ok: true,
      legs: [
        { recipient: "0xa", amount: "1" },
        { recipient: "0xb", amount: "2" },
      ],
    });
    expect(parseLegs([{ recipient: "0xa", amount: "1" }])).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["", /required/],
    ["not json", /JSON array/],
    ["[]", /non-empty/],
    ['{"recipient":"0xa"}', /non-empty array/],
    ['[{"amount":"1"}]', /Leg 0 has no recipient/],
    ['[{"recipient":"0xa","amount":"-1"}]', /Leg 0 amount/],
    ["[1]", /Leg 0 is not an object/],
  ])("refuses %s", (input, error) => {
    const parsed = parseLegs(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(error);
    }
  });

  it("caps the number of legs", () => {
    const many = Array.from({ length: MAX_DISBURSE_LEGS + 1 }, () => ({
      recipient: "0xa",
      amount: "1",
    }));
    expect(parseLegs(many)).toMatchObject({ ok: false });
  });
});

describe("validateRunKey", () => {
  it("requires a non-empty key of bounded length", () => {
    expect(validateRunKey(" payroll-2026-09 ")).toBe("payroll-2026-09");
    expect(validateRunKey("")).toBeNull();
    expect(validateRunKey(undefined)).toBeNull();
    expect(validateRunKey("x".repeat(201))).toBeNull();
  });
});

describe("planLeg", () => {
  it("sends a leg the ledger has never seen", () => {
    expect(planLeg(SPEC, undefined, NOW)).toEqual({
      action: "send",
      reclaim: false,
    });
  });

  it("skips a settled leg, with the hash that paid it", () => {
    expect(
      planLeg(SPEC, row({ status: "settled", transactionHash: "0xpaid" }), NOW)
    ).toEqual({ action: "already_paid", transactionHash: "0xpaid" });
  });

  it("sends a failed leg again", () => {
    expect(planLeg(SPEC, row({ status: "failed" }), NOW)).toEqual({
      action: "send",
      reclaim: true,
    });
  });

  it("refuses a leg another run claimed recently, and takes over a stale claim", () => {
    expect(planLeg(SPEC, row({ status: "claimed" }), NOW)).toEqual({
      action: "in_progress",
    });
    const stale = new Date(NOW.getTime() - STALE_CLAIM_MS);
    expect(
      planLeg(SPEC, row({ status: "claimed", claimedAt: stale }), NOW)
    ).toEqual({ action: "send", reclaim: true });
  });

  // The rejected half of step-claim's pattern: a leg that reached the
  // pre-broadcast hook may already be on chain, and no amount of time makes it
  // safe to take over.
  it("never takes over a leg that may have been sent, however old", () => {
    const ancient = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
    for (const status of ["sending", "unknown"] as const) {
      expect(
        planLeg(
          SPEC,
          row({ status, claimedAt: ancient, updatedAt: ancient }),
          NOW
        )
      ).toEqual({ action: "check_evidence" });
    }
  });

  it.each([
    ["chainId", 8453, "network"],
    ["asset", "native", "asset"],
    ["recipient", "0xother", "recipient"],
    ["amount", "2", "amount"],
  ] as const)(
    "refuses a leg recorded with a different %s",
    (field, value, reported) => {
      expect(
        planLeg(SPEC, row({ status: "settled", [field]: value }), NOW)
      ).toEqual({ action: "conflict", field: reported });
    }
  );
});

describe("receiptVerdict", () => {
  const entry = {
    hash: "0xh",
    nodeId: "disburse-1",
    nodeName: "Disburse",
  };

  it("settles only on a verified successful receipt", () => {
    expect(
      receiptVerdict(
        [{ ...entry, verified: true, receiptStatus: "success" }],
        "0xh"
      )
    ).toBe("settled");
  });

  it("fails only on a reverted receipt", () => {
    expect(
      receiptVerdict(
        [{ ...entry, verified: false, receiptStatus: "reverted" }],
        "0xh"
      )
    ).toBe("failed");
  });

  // A failed run does not re-verify a hash from a step that succeeded, so an
  // unverified entry is common and proves nothing either way.
  it("leaves everything else unknown", () => {
    for (const entries of [
      undefined,
      [],
      [entry],
      [{ ...entry, verified: false, receiptStatus: "not_found" as const }],
      [{ ...entry, verified: false, receiptStatus: "timeout" as const }],
      [
        {
          ...entry,
          verified: true,
          receiptStatus: "success" as const,
          hash: "0xother",
        },
      ],
    ]) {
      expect(receiptVerdict(entries, "0xh")).toBe("unknown");
    }
  });
});
