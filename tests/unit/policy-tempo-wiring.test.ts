import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const assertSigningAllowed = vi.fn();
const resolveSignerMode = vi.fn();
const getOrganizationWallet = vi.fn();
const getRpcProvider = vi.fn();

vi.mock("@/lib/policy/signing-guard", () => ({
  assertSigningAllowed: (...a: unknown[]) => assertSigningAllowed(...a),
}));
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe" },
  resolveSignerMode: (...a: unknown[]) => resolveSignerMode(...a),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: (...a: unknown[]) => getOrganizationWallet(...a),
}));
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...a: unknown[]) => getRpcProvider(...a),
}));
vi.mock("@/lib/turnkey/turnkey-client", () => ({
  getTurnkeySignerConfig: () => ({ client: {} }),
}));
vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: () => ({ getGasConfig: async () => ({}) }),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {},
  logSystemError: () => undefined,
}));

const { signTempoTx } = await import("@/plugins/tempo/steps/tempo-tx-core");

const CALLS = [
  {
    to: "0xaaaa000000000000000000000000000000000001" as const,
    data: "0x11" as const,
  },
  {
    to: "0xbbbb000000000000000000000000000000000002" as const,
    data: "0x22" as const,
  },
];

const params = {
  organizationId: "org_1",
  chainId: 4217,
  calls: CALLS,
  feeToken: "0xcccc000000000000000000000000000000000003" as const,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  assertSigningAllowed.mockResolvedValue(undefined);
  resolveSignerMode.mockResolvedValue({ kind: "eoa" });
  getOrganizationWallet.mockResolvedValue({
    turnkeySubOrgId: "sub_1",
    walletAddress: "0xdddd000000000000000000000000000000000004",
  });
  getRpcProvider.mockRejectedValue(new Error("rpc reached"));
});

describe("a Tempo envelope is judged before it is built", () => {
  it("checks every call the envelope carries, not just the first", async () => {
    await signTempoTx(params).catch(() => undefined);
    expect(assertSigningAllowed).toHaveBeenCalledTimes(2);
    for (const [index, call] of CALLS.entries()) {
      expect(assertSigningAllowed).toHaveBeenNthCalledWith(
        index + 1,
        { organizationId: "org_1", chainId: 4217 },
        { to: call.to, data: call.data, value: BigInt(0) }
      );
    }
  });

  it("stops before the wallet is fetched when a call is refused", async () => {
    // The point of checking early: a refusal must cost no wallet read, no RPC
    // round trip and no signature attempt.
    assertSigningAllowed.mockRejectedValue(new Error("refused by policy"));
    await expect(signTempoTx(params)).rejects.toThrow("refused by policy");
    expect(getOrganizationWallet).not.toHaveBeenCalled();
    expect(getRpcProvider).not.toHaveBeenCalled();
  });

  it("refuses on the second call even when the first is permitted", async () => {
    assertSigningAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("refused by policy"));
    await expect(signTempoTx(params)).rejects.toThrow("refused by policy");
    expect(getOrganizationWallet).not.toHaveBeenCalled();
  });
});
