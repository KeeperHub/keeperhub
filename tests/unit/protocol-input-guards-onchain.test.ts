import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// vi.mock factories are hoisted above const declarations, and these run while
// the module under test is imported, so the fns must be hoisted with them.
const { mockListOrgSafes, mockReadContractCore, mockResolveSignerForNode } =
  vi.hoisted(() => ({
    mockListOrgSafes: vi.fn(),
    mockReadContractCore: vi.fn(),
    mockResolveSignerForNode: vi.fn(),
  }));

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: mockReadContractCore,
}));
// Only the resolver call is replaced. SIGNER_MODE comes through real, so the
// branch picking the Safe over the EOA is compared against the enum the guard
// actually imports rather than against a copy this file wrote.
vi.mock("@/lib/safe/signer-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe/signer-resolver")>()),
  resolveSignerForNode: mockResolveSignerForNode,
}));
vi.mock("@/lib/safe/deployment", () => ({
  listOrgSafes: mockListOrgSafes,
}));

import { checkProtocolOnchainGuards } from "@/lib/protocol-input-guards-onchain";
import { registerProtocol } from "@/lib/protocol-registry";
import { SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { structureAbiOutputs } from "@/plugins/web3/steps/structure-abi-result";
import uniswapDef from "@/protocols/uniswap-v3";

const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SAFE = "0x1111111111111111111111111111111111111111";
// Synthetic: this only has to be an address the wallet does not control.
const STRANGER = "0x00000000000000000000000000000000000000a2";
const ZERO = "0x0000000000000000000000000000000000000000";

// The registry keys contract addresses by numeric chain id, so a named network
// resolves no address and the guard exits before it ever parses a chain id.
// This extra key is what lets a test reach that branch; every other case still
// goes through the numeric "1" the real callers pass.
registerProtocol({
  ...uniswapDef,
  contracts: {
    ...uniswapDef.contracts,
    positionManager: {
      ...uniswapDef.contracts.positionManager,
      addresses: {
        ...uniswapDef.contracts.positionManager.addresses,
        mainnet: uniswapDef.contracts.positionManager.addresses["1"],
      },
    },
  },
});

const increase = (
  inputs: Record<string, unknown>,
  overrides: { organizationId?: string; network?: string } = {}
) =>
  checkProtocolOnchainGuards({
    protocolSlug: "uniswap",
    functionName: "increaseLiquidity",
    inputs,
    network: overrides.network ?? "1",
    organizationId:
      "organizationId" in overrides ? overrides.organizationId : "org_1",
  });

// Output descriptors come from the ABI under test, not from hand-written
// ones. readContractCore runs every result through structureAbiOutputs, and
// whether a single output is wrapped as { name: value } or returned bare
// depends on whether the ABI names it. A fixture that invented the name
// `owner` is what let a guard reading `.owner` pass its own suite while
// refusing every real call, because the shared ABI declares that output as "".
const POSITION_MANAGER_ABI = JSON.parse(
  uniswapDef.contracts.positionManager.abi as string
) as Array<{ name?: string; outputs?: { name: string; type: string }[] }>;

const outputsOf = (fn: string): { name: string; type: string }[] => {
  const entry = POSITION_MANAGER_ABI.find((e) => e.name === fn);
  if (!entry?.outputs) {
    throw new Error(`ABI under test declares no outputs for ${fn}`);
  }
  return entry.outputs;
};

const abiResult = (
  outputs: { name: string; type: string }[],
  value: unknown
) => ({
  success: true,
  result: structureAbiOutputs([value], outputs),
  addressLink: "",
});

/** The one read the guard actually issues, shaped by the ABI it issues it with. */
const ownerResult = (owner: string) => abiResult(outputsOf("ownerOf"), owner);

/**
 * Answers the mocked read per ABI function rather than per call, so a guard
 * that reads more than `ownerOf` gets that function's answer. The approval
 * answers are the point: they let a case state "this position is approved to
 * our wallet" as chain state, so re-adding an approval-honouring bypass
 * changes a result instead of passing unnoticed.
 */
const onChain = (state: {
  owner: string;
  approvedTo?: string;
  approvedForAll?: boolean;
}) => {
  mockReadContractCore.mockImplementation((call: { abiFunction: string }) => {
    // The shared ABI declares neither approval view - the guard does not read
    // them - so these descriptors stay literal. They exist so that a bypass
    // reading an approval finds chain state to act on and changes a result,
    // rather than silently finding nothing.
    if (call.abiFunction === "getApproved") {
      return Promise.resolve(
        abiResult(
          [{ name: "operator", type: "address" }],
          state.approvedTo ?? ZERO
        )
      );
    }
    if (call.abiFunction === "isApprovedForAll") {
      return Promise.resolve(
        abiResult([{ name: "", type: "bool" }], state.approvedForAll === true)
      );
    }
    return Promise.resolve(ownerResult(state.owner));
  });
};

const ownerIs = (owner: string) => onChain({ owner });

const orgSafesOnChain1 = (...safeAddresses: string[]) => {
  mockListOrgSafes.mockResolvedValue(
    safeAddresses.map((safeAddress, index) => ({
      chainId: 1,
      id: `sw_${index}`,
      organizationId: "org_1",
      safeAddress,
    }))
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSignerForNode.mockResolvedValue({
    kind: SIGNER_MODE.EOA,
    ownerAddress: WALLET,
  });
  mockListOrgSafes.mockResolvedValue([]);
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

  // In safe mode the Safe is msg.sender at the position manager, so a position
  // it holds needs no further check. A stranger's still fails - and note the
  // EOA behind the Safe is a separate, allowed case, pinned further down.
  it("accepts the signing Safe as holder in safe mode", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: SIGNER_MODE.SAFE,
      ownerAddress: WALLET,
      safeAddress: SAFE,
      safeWalletId: "sw_1",
    });
    ownerIs(SAFE);
    expect((await increase({ tokenId: "180205" })).ok).toBe(true);

    ownerIs(STRANGER);
    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // An approval is granted by the holder to an address of their choosing, so
  // a stranger can approve this org's wallet on a position they keep. Deciding
  // on the approval would pass exactly the input this guard exists to refuse:
  // the deposit lands in their position and they withdraw it, and they can
  // revoke or transfer the NFT whenever they like. Only the holder's identity
  // survives the holder acting against us. The chain here answers both
  // approval forms affirmatively, so honouring either one fails this case.
  it("refuses a stranger's position even when it approves this wallet", async () => {
    onChain({ owner: STRANGER, approvedTo: WALLET, approvedForAll: true });

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not one of this organization's wallets");
      expect(result.error).toContain(STRANGER);
    }
  });

  // The same, one layer along: the Safe signs and the stranger has approved
  // the Safe rather than the EOA behind it.
  it("refuses a stranger's position approved to the signing Safe", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: SIGNER_MODE.SAFE,
      ownerAddress: WALLET,
      safeAddress: SAFE,
      safeWalletId: "sw_1",
    });
    onChain({ owner: STRANGER, approvedTo: SAFE, approvedForAll: true });

    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // The arrangement that motivated looking past owner equality: the EOA holds
  // the position and the Safe signs. The org controls both, so the deposit is
  // recoverable and this must not be refused.
  it("allows a position held by the org EOA while the Safe signs", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: SIGNER_MODE.SAFE,
      ownerAddress: WALLET,
      safeAddress: SAFE,
      safeWalletId: "sw_1",
    });
    ownerIs(WALLET);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("allows a position held by another Safe of the same org", async () => {
    const OTHER_SAFE = "0x2222222222222222222222222222222222222222";
    orgSafesOnChain1(SAFE, OTHER_SAFE);
    ownerIs(OTHER_SAFE);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  // Safes are per chain, so one on another chain says nothing about who holds
  // this position here.
  it("ignores an org Safe registered on a different chain", async () => {
    mockListOrgSafes.mockResolvedValue([
      {
        chainId: 8453,
        id: "sw_base",
        organizationId: "org_1",
        safeAddress: STRANGER,
      },
    ]);
    ownerIs(STRANGER);

    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // Previously a throw here returned ok, so anything that made signer
  // resolution fail switched the guard off. Failing to work out who signs is
  // not evidence that the position is owned. The error is one org-policy
  // resolution can actually raise now that no connection value reaches it.
  it("refuses when the signer cannot be resolved", async () => {
    ownerIs(WALLET);
    mockResolveSignerForNode.mockRejectedValue(
      new Error("No organization wallet found for organization org_1")
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

  it("does not call the chain for other protocol functions", async () => {
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
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });

  // ethers takes decimal and hex alike for a uint256, and both spellings of
  // one id encode to identical calldata - 0x2bfed is 180205. Nothing between
  // the body and the encoder rejects hex, so a guard that recognised only
  // decimal could be stepped around by rewriting the id.
  it("checks a hex token id against the same position", async () => {
    ownerIs(STRANGER);

    const result = await increase({ tokenId: "0x2bfed" });

    expect(result.ok).toBe(false);
    expect(mockReadContractCore).toHaveBeenCalledWith(
      // Normalised to decimal, so the read asks about the position the write
      // will touch rather than about the spelling it arrived in.
      expect.objectContaining({ functionArgs: JSON.stringify(["180205"]) })
    );
  });

  it("allows a hex token id the organization holds", async () => {
    ownerIs(WALLET);

    expect((await increase({ tokenId: "0X2BFED" })).ok).toBe(true);
  });

  // Previously passed through on the premise that the encoder would reject it.
  // It would not: validate-args only checks for empty values, so an id that is
  // neither spelling would have reached the chain unguarded.
  it("refuses an id that is neither decimal nor hex", async () => {
    ownerIs(STRANGER);

    for (const tokenId of ["not-a-number", "0x", "12.5", "0xzz", ""]) {
      expect((await increase({ tokenId })).ok, tokenId).toBe(false);
    }
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });

  // Unreachable from either route today, but WorkflowExecutionInput types the
  // organization optional, so a caller that omits it would otherwise switch
  // the guard off for every increaseLiquidity in that run.
  it("refuses when there is no organization context", async () => {
    ownerIs(STRANGER);

    // Passed directly: an explicit `undefined` argument would still take the
    // helper's default, which is the opposite of what this case checks.
    const result = await checkProtocolOnchainGuards({
      protocolSlug: "uniswap",
      functionName: "increaseLiquidity",
      inputs: { tokenId: "180205" },
      network: "1",
      organizationId: undefined,
    });

    expect(result.ok).toBe(false);
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });
});

// Nothing below establishes who holds the position. The deposit cannot be
// undone and the read shares a provider with the write it guards, so every one
// of these refuses rather than letting the position manager take the tokens.
describe("increase-liquidity ownership guard when ownership is unknown", () => {
  // failOnError=false softens a reverted or timed-out call to this shape: a
  // success carrying a message and a null result. A burned id and a 429 are
  // the same shape here, which is why both refuse.
  it("refuses when the read is softened to a null result", async () => {
    mockReadContractCore.mockResolvedValue({
      success: true,
      result: null,
      addressLink: "",
      error: "Contract call failed: execution reverted",
    });

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("tokenId");
      expect(result.error).toContain("Could not read who owns position 180205");
    }
  });

  // The destination failures keep success=false: an unresolvable RPC config is
  // the transport being down outright.
  it("refuses when the read fails outright", async () => {
    mockReadContractCore.mockResolvedValue({
      success: false,
      destinationError: true,
      error: "Failed to resolve RPC config",
    });

    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // The provider URL in a read error is not repeated to the caller.
  it("keeps the read's own message out of the refusal", async () => {
    mockReadContractCore.mockResolvedValue({
      success: true,
      result: null,
      addressLink: "",
      error: "Contract call failed: https://rpc.example/secret-key timed out",
    });

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("rpc.example");
    }
  });

  it("refuses when ownerOf decodes to no address", async () => {
    mockReadContractCore.mockResolvedValue(ownerResult(""));

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("returned no address");
    }
  });

  // Safe mode with no Safe address leaves nothing to compare the holder
  // against, so the check cannot run.
  it("refuses when the resolved signer has no address", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: SIGNER_MODE.SAFE,
      ownerAddress: WALLET,
      safeAddress: "",
      safeWalletId: "sw_1",
    });
    ownerIs(WALLET);

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });

  // Without a chain id the org's Safes cannot be matched to this chain.
  it("refuses a network that is not a chain id", async () => {
    ownerIs(WALLET);

    const result = await increase(
      { tokenId: "180205" },
      { network: "mainnet" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not a chain id");
    }
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });

  // The holder is already known not to be the sender at this point, so an
  // unreadable Safe list leaves the one question that could clear it open.
  it("refuses when the org's Safes cannot be listed", async () => {
    ownerIs(STRANGER);
    mockListOrgSafes.mockRejectedValue(new Error("connection terminated"));

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("could not be listed");
    }
  });

  // A readable, org-owned position is unaffected by any of the above.
  it("still allows a position the org holds", async () => {
    ownerIs(WALLET);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });
});
