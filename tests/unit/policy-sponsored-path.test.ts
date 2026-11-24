import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const policy = vi.hoisted(() => ({ assert: vi.fn() }));
vi.mock("@/lib/policy/signing-guard", () => ({
  assertSigningAllowed: policy.assert,
}));

const turnkey = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/turnkey/turnkey-client", () => ({
  getTurnkeyClientForOrg: () => ({
    apiClient: () => ({ ethSendTransaction: turnkey.send }),
  }),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    EXTERNAL_SERVICE: "external_service",
    TRANSACTION: "transaction",
  },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { submitTurnkeySponsoredTransaction } from "@/lib/web3/turnkey-sponsored-tx";

/**
 * A sponsored transaction never builds a signer, so the proxy that guards one
 * cannot reach it. It posts the payload straight to the gas station, which made
 * it the one way to move value with no policy decision at all, and the path a
 * contract write tries first.
 */
const PARAMS = {
  organizationId: "org_1",
  subOrgId: "sub_1",
  walletAddress: "0xWallet",
  chainId: 8453,
  to: "0xTarget",
  data: "0xdeadbeef" as `0x${string}`,
};

describe("a sponsored transaction", () => {
  beforeEach(() => {
    policy.assert.mockReset().mockResolvedValue(undefined);
    turnkey.send.mockReset().mockResolvedValue({ activity: { id: "act_1" } });
  });

  it("is judged before it reaches the gas station", async () => {
    await submitTurnkeySponsoredTransaction(PARAMS).catch(() => undefined);

    expect(policy.assert).toHaveBeenCalledTimes(1);
    const [context, tx] = policy.assert.mock.calls[0] as [
      { organizationId: string; chainId: number },
      { to: string; data: string | null },
    ];
    expect(context).toEqual({ organizationId: "org_1", chainId: 8453 });
    expect(tx.to).toBe("0xTarget");
    expect(tx.data).toBe("0xdeadbeef");
  });

  it("does not submit when policy refuses", async () => {
    policy.assert.mockRejectedValue(
      new Error("Blocked by an organization policy")
    );

    await expect(submitTurnkeySponsoredTransaction(PARAMS)).rejects.toThrow(
      "Blocked by an organization policy"
    );
    // A refusal that still submitted would be no refusal at all, and falling
    // back to the unsponsored route would send the very same payload.
    expect(turnkey.send).not.toHaveBeenCalled();
  });
});
