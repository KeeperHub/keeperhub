/**
 * Wave 0 RED scaffold for lib/agentic-wallet/risk.ts.
 *
 * Contract anchor: 33-RESEARCH.md Pattern 6 (lines 542-566).
 *
 * Tier rules:
 *   - block: amount > 100 USDC (>100_000_000 with 6 decimals) OR selector
 *            matches the unlimited-approve selector `0x095ea7b3`.
 *   - ask:   amount >= 50 USDC (>=50_000_000) OR unknown non-empty selector.
 *   - auto:  everything else (paid workflow calls under $5).
 *
 * Pure function, no I/O. Baseline: every case throws because the helper body
 * is a stub. Plan 33-01a flips this suite GREEN.
 */
import { describe, expect, it } from "vitest";
import { classifyRisk } from "@/lib/agentic-wallet/risk";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";

describe("classifyRisk", () => {
  it("classifies a small Base paid call (1 USDC, no selector) as auto", () => {
    const result = classifyRisk({
      chain: "base",
      challenge: { amount: "1000000", payTo: BASE_USDC, selector: undefined },
    });
    expect(result).toBe("auto");
  });

  it("classifies Base 50.000001 USDC as ask (crosses ask threshold)", () => {
    const result = classifyRisk({
      chain: "base",
      challenge: { amount: "50000001", payTo: BASE_USDC },
    });
    expect(result).toBe("ask");
  });

  it("classifies exactly 100 USDC as ask (inclusive upper-ask boundary)", () => {
    const result = classifyRisk({
      chain: "base",
      challenge: { amount: "100000000", payTo: BASE_USDC },
    });
    expect(result).toBe("ask");
  });

  it("classifies Base 100.000001 USDC (>100 USDC) as block", () => {
    const result = classifyRisk({
      chain: "base",
      challenge: { amount: "100000001", payTo: BASE_USDC },
    });
    expect(result).toBe("block");
  });

  it("classifies selector 0x095ea7b3 (ERC-20 approve) as block regardless of amount", () => {
    const result = classifyRisk({
      chain: "base",
      challenge: {
        amount: "1",
        payTo: BASE_USDC,
        selector: "0x095ea7b3",
      },
    });
    expect(result).toBe("block");
  });

  it("classifies unknown selector with small amount as ask", () => {
    const result = classifyRisk({
      chain: "base",
      challenge: {
        amount: "100000",
        payTo: BASE_USDC,
        selector: "0xdeadbeef",
      },
    });
    expect(result).toBe("ask");
  });

  it("classifies a small Tempo paid call (1 USDC) as auto", () => {
    const result = classifyRisk({
      chain: "tempo",
      challenge: { amount: "1000000", payTo: TEMPO_USDC },
    });
    expect(result).toBe("auto");
  });
});
