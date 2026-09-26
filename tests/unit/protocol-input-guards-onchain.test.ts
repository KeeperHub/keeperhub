import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// vi.mock factories are hoisted above const declarations, and these run while
// the module under test is imported, so the fns must be hoisted with them.
const { mockReadContractCore, mockResolveSignerForNode } = vi.hoisted(() => ({
  mockReadContractCore: vi.fn(),
  mockResolveSignerForNode: vi.fn(),
}));

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: mockReadContractCore,
}));
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: mockResolveSignerForNode,
}));

import { checkProtocolOnchainGuards } from "@/lib/protocol-input-guards-onchain";
import { registerProtocol } from "@/lib/protocol-registry";
import { structureAbiOutputs } from "@/plugins/web3/steps/structure-abi-result";
import uniswapDef from "@/protocols/uniswap-v3";

const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SAFE = "0x1111111111111111111111111111111111111111";
// Synthetic: this only has to be an address the wallet does not control.
const STRANGER = "0x00000000000000000000000000000000000000a2";

registerProtocol(uniswapDef);

const increase = (inputs: Record<string, unknown>, organizationId = "org_1") =>
  checkProtocolOnchainGuards({
    protocolSlug: "uniswap",
    functionName: "increaseLiquidity",
    inputs,
    network: "1",
    organizationId,
  });

const ZERO = "0x0000000000000000000000000000000000000000";

// Built with the real structureAbiOutputs rather than by hand: readContractCore
// runs every result through it, and a single *named* output comes back as
// { owner: value }. A hand-written bare string here is what let a guard that
// compared "[object Object]" to an address pass its own tests.
//
// Keyed on abiFunction because the guard reads ownerOf and, only when that
// does not match, the two approval views the position manager itself checks.
const onChain = (state: {
  owner: string;
  approved?: string;
  approvedForAll?: boolean;
  approvalsFail?: boolean;
}) => {
  mockReadContractCore.mockImplementation(
    ({ abiFunction }: { abiFunction: string }) => {
      const ok = (value: unknown, name: string, type: string) =>
        Promise.resolve({
          success: true,
          result: structureAbiOutputs([value], [{ name, type }]),
          addressLink: "",
        });
      if (abiFunction === "ownerOf") {
        return ok(state.owner, "owner", "address");
      }
      if (state.approvalsFail) {
        return Promise.resolve({
          success: false,
          error: "call reverted",
          result: null,
          addressLink: "",
        });
      }
      if (abiFunction === "getApproved") {
        return ok(state.approved ?? ZERO, "operator", "address");
      }
      return ok(state.approvedForAll ?? false, "approved", "bool");
    }
  );
};

const ownerIs = (owner: string) => onChain({ owner });

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: WALLET,
  });
});

// increaseLiquidity is the only position function Uniswap does not gate on
// ownership, so a wrong id funds a stranger's position and reports success.
// Reading the owner first is the only thing that turns that into a revert.
describe("uniswap increase-liquidity ownership guard", () => {
  it("refuses a position owned by someone else", async () => {
    ownerIs(STRANGER);

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("tokenId");
      expect(result.error).toContain(STRANGER);
      expect(result.error).toContain(WALLET);
    }
  });

  it("returns the owner behind the ABI output name, not the result object", async () => {
    ownerIs(WALLET);

    // Guards the exact regression: if the guard read `result` instead of
    // `result.owner`, this comparison would stringify an object and refuse
    // every call, valid ones included.
    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
    ownerIs(STRANGER);
    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // A JSON body carries "tokenId": 180205 as a number, and the direct-execute
  // route passes the body through untouched.
  it("reads the owner for a numeric token id too", async () => {
    ownerIs(STRANGER);

    const result = await increase({ tokenId: 180_205 });

    expect(mockReadContractCore).toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("allows a position the workflow wallet owns", async () => {
    ownerIs(WALLET);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("compares case-insensitively", async () => {
    ownerIs(WALLET.toLowerCase());

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  // In safe mode the Safe is msg.sender at the position manager, so the Safe
  // must hold the NFT - not the owner EOA behind it.
  it("expects the Safe to own the position in safe mode", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: "safe",
      ownerAddress: WALLET,
      safeAddress: SAFE,
      safeWalletId: "sw_1",
    });
    ownerIs(SAFE);
    expect((await increase({ tokenId: "180205" })).ok).toBe(true);

    ownerIs(WALLET);
    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // A revert for a burned id and an RPC outage arrive in the same shape, and
  // refusing on an outage would break every scheduled compound.
  it("passes when the owner cannot be read", async () => {
    mockReadContractCore.mockResolvedValue({
      success: false,
      error: "call reverted",
      result: null,
      addressLink: "",
    });

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  // The position manager gates every recovering call (decreaseLiquidity,
  // collect, burn) on _isApprovedOrOwner, so an approved operator can withdraw
  // what this step adds. Owner equality alone would block a legitimate,
  // fully recoverable arrangement forever.
  it("allows a position the wallet is the approved operator for", async () => {
    onChain({ owner: STRANGER, approved: WALLET });

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("allows a position whose owner approved the wallet for all", async () => {
    onChain({ owner: STRANGER, approvedForAll: true });

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("refuses, and says so, when the approvals cannot be read", async () => {
    onChain({ owner: STRANGER, approvalsFail: true });

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("could not be read");
    }
  });

  // Previously a throw here returned ok, so any input that made signer
  // resolution fail switched the guard off. Failing to work out who signs is
  // not evidence that the position is owned.
  it("refuses when the signer cannot be resolved", async () => {
    ownerIs(WALLET);
    mockResolveSignerForNode.mockRejectedValue(
      new Error("Invalid web3Connection value 'x'")
    );

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });

  // Neither write honours a caller-supplied web3Connection - the direct route
  // records it as a rejected override and protocolWriteStep leaves it out of
  // the write - so the guard must resolve under org policy or it would compute
  // a sender the write never uses.
  it("resolves the signer under org policy, never a supplied connection", async () => {
    ownerIs(WALLET);

    await increase({ tokenId: "180205", web3Connection: "eoa" });

    expect(mockResolveSignerForNode).toHaveBeenCalledWith(
      expect.objectContaining({ web3Connection: undefined })
    );
  });

  it("does not call the chain for other functions, malformed ids, or no org", async () => {
    ownerIs(STRANGER);

    expect(
      (
        await checkProtocolOnchainGuards({
          protocolSlug: "uniswap",
          functionName: "collect",
          inputs: { tokenId: "180205" },
          network: "1",
          organizationId: "org_1",
        })
      ).ok
    ).toBe(true);
    expect((await increase({ tokenId: "not-a-number" })).ok).toBe(true);
    // Passed directly: an explicit `undefined` argument would still take the
    // helper's default, which is the opposite of what this case checks.
    expect(
      (
        await checkProtocolOnchainGuards({
          protocolSlug: "uniswap",
          functionName: "increaseLiquidity",
          inputs: { tokenId: "180205" },
          network: "1",
          organizationId: undefined,
        })
      ).ok
    ).toBe(true);
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });
});
