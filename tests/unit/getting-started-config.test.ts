import { describe, expect, it } from "vitest";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID_NUM,
  getMonitorTargets,
  resolveTestnetWorkspace,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CHAIN_ID_NUM,
  TESTNET_AAVE_BASE_SEPOLIA_POOL,
  TESTNET_AAVE_SEPOLIA_POOL,
  TESTNET_READY_BADGE,
} from "@/lib/onboarding/getting-started-config";

describe("getMonitorTargets", () => {
  it("injects Sepolia Aave pool when testnet workspace is Sepolia", () => {
    const chips = getMonitorTargets({
      isTestnetWorkspace: true,
      chainId: SEPOLIA_CHAIN_ID,
    });
    const aave = chips.find((chip) => chip.id === "aave-health");
    expect(aave?.prompt).toContain(TESTNET_AAVE_SEPOLIA_POOL);
    expect(aave?.badge).toBe(TESTNET_READY_BADGE);
  });

  it("uses Base Sepolia Aave health prompt when testnet workspace is Base Sepolia", () => {
    const chips = getMonitorTargets({
      isTestnetWorkspace: true,
      chainId: BASE_SEPOLIA_CHAIN_ID,
    });
    const aave = chips.find((chip) => chip.id === "aave-health");
    expect(aave?.prompt).toContain(TESTNET_AAVE_BASE_SEPOLIA_POOL);
    expect(aave?.prompt).toContain("health factor");
    expect(aave?.badge).toBe(TESTNET_READY_BADGE);
  });

  it("uses generic prompts without badge for default context", () => {
    const chips = getMonitorTargets({});
    const aave = chips.find((chip) => chip.id === "aave-health");
    expect(aave?.prompt).toBe(
      "Monitor my Aave v3 health factor every hour and alert me when it drops below 1.5."
    );
    expect(aave?.badge).toBeUndefined();
    expect(aave?.prompt).not.toContain(TESTNET_AAVE_SEPOLIA_POOL);
  });

  it("resolves testnet Sepolia starter workflow slug when recommendations are present", () => {
    const chips = getMonitorTargets({
      isTestnetWorkspace: true,
      chainId: SEPOLIA_CHAIN_ID,
      resolvedIds: {
        "aave-health-sepolia": "wf-sepolia",
      },
    });
    const aave = chips.find((chip) => chip.id === "aave-health");
    expect(aave?.workflowId).toBe("wf-sepolia");
  });

  it("resolves mainnet starter workflow slug when not a testnet workspace", () => {
    const chips = getMonitorTargets({
      resolvedIds: {
        "aave-health": "wf-mainnet",
      },
    });
    const aave = chips.find((chip) => chip.id === "aave-health");
    expect(aave?.workflowId).toBe("wf-mainnet");
  });

  it("injects wallet address into whale withdrawal chip", () => {
    const chips = getMonitorTargets({
      walletAddress: "0xabc1234567890123456789012345678901234567",
    });
    const whale = chips.find((chip) => chip.id === "whale-withdrawal");
    expect(whale?.prompt).toContain(
      "0xabc1234567890123456789012345678901234567"
    );
  });
});

describe("resolveTestnetWorkspace", () => {
  it("returns false when balances are missing", () => {
    expect(resolveTestnetWorkspace(undefined)).toEqual({
      isTestnetWorkspace: false,
    });
  });

  it("returns false when no funded testnet balances exist", () => {
    expect(
      resolveTestnetWorkspace([
        {
          chainId: SEPOLIA_CHAIN_ID_NUM,
          isTestnet: true,
          nativeBalanceRaw: "0",
        },
      ])
    ).toEqual({ isTestnetWorkspace: false });
  });

  it("prefers Sepolia over Base Sepolia when both are funded", () => {
    expect(
      resolveTestnetWorkspace([
        {
          chainId: BASE_SEPOLIA_CHAIN_ID_NUM,
          isTestnet: true,
          nativeBalanceRaw: "1000",
        },
        {
          chainId: SEPOLIA_CHAIN_ID_NUM,
          isTestnet: true,
          nativeBalanceRaw: "1000",
        },
      ])
    ).toEqual({
      isTestnetWorkspace: true,
      chainId: SEPOLIA_CHAIN_ID,
    });
  });

  it("falls back to Base Sepolia when only Base Sepolia is funded", () => {
    expect(
      resolveTestnetWorkspace([
        {
          chainId: BASE_SEPOLIA_CHAIN_ID_NUM,
          isTestnet: true,
          nativeBalanceRaw: "1000",
        },
      ])
    ).toEqual({
      isTestnetWorkspace: true,
      chainId: BASE_SEPOLIA_CHAIN_ID,
    });
  });
});
