import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockSign = vi.fn();
const mockGetOrgWallet = vi.fn();

vi.mock("@/lib/agentic-wallet/sign-typed-data", () => {
  class PolicyBlockedError extends Error {
    override readonly name = "PolicyBlockedError";
  }
  class TurnkeyUpstreamError extends Error {
    override readonly name = "TurnkeyUpstreamError";
  }
  return {
    PolicyBlockedError,
    TurnkeyUpstreamError,
    signTypedDataWithTurnkey: (...args: unknown[]) => mockSign(...args),
  };
});

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: (...args: unknown[]) => mockGetOrgWallet(...args),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn().mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: "user-1",
  }),
}));

vi.mock("@/lib/address-utils", () => ({
  toChecksumAddress: (addr: string) => addr,
}));

const { signTypedDataCore } = await import(
  "@/plugins/web3/steps/sign-typed-data-core"
);
const { PolicyBlockedError, TurnkeyUpstreamError } = await import(
  "@/lib/agentic-wallet/sign-typed-data"
);

const JSON_ERROR_RE = /JSON/i;
const PRIMARY_TYPE_ERROR_RE = /primaryType/;
const SIGNATURE_HEX_RE = /^0x[a-f0-9]{130}$/;

const VALID_TYPED_DATA = {
  domain: { name: "USD Coin", version: "2", chainId: 8453 },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Transfer: [{ name: "to", type: "address" }],
  },
  primaryType: "Transfer",
  message: { to: "0x0000000000000000000000000000000000000001" },
};

const WALLET = {
  walletAddress: "0xA3CD000000000000000000000000000000007Eb3",
  turnkeySubOrgId: "sub-org-1",
};

describe("signTypedDataCore (KEEP-473)", () => {
  beforeEach(() => {
    mockSign.mockReset();
    mockGetOrgWallet.mockReset();
  });

  it("returns the signature and the signer when Turnkey succeeds", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);
    mockSign.mockResolvedValue(`0x${"ab".repeat(65)}`);

    const result = await signTypedDataCore({
      typedData: VALID_TYPED_DATA,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.signature).toMatch(SIGNATURE_HEX_RE);
      expect(result.signer).toBe(WALLET.walletAddress);
    }
    expect(mockSign).toHaveBeenCalledWith(
      WALLET.turnkeySubOrgId,
      WALLET.walletAddress,
      VALID_TYPED_DATA
    );
  });

  it("rejects payloads missing domain/types/primaryType/message", async () => {
    for (const td of [
      null,
      {},
      { domain: {}, types: {}, primaryType: 1, message: {} },
      { domain: {}, types: {}, primaryType: "", message: {} },
      { domain: {}, types: {}, primaryType: "X" },
    ]) {
      const r = await signTypedDataCore({ typedData: td as any });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.code).toBe("VALIDATION");
      }
    }
  });

  it("rejects payloads larger than 32KiB", async () => {
    const huge = {
      ...VALID_TYPED_DATA,
      message: { blob: "x".repeat(33 * 1024) },
    };
    const result = await signTypedDataCore({
      typedData: huge,
      _context: { organizationId: "org-1" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
  });

  it("returns NO_WALLET when the org has no Turnkey sub-org", async () => {
    mockGetOrgWallet.mockResolvedValue({ ...WALLET, turnkeySubOrgId: null });

    const result = await signTypedDataCore({
      typedData: VALID_TYPED_DATA,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("NO_WALLET");
    }
  });

  it("translates PolicyBlockedError to POLICY_BLOCKED", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);
    mockSign.mockRejectedValue(new PolicyBlockedError("blocked by policy"));

    const result = await signTypedDataCore({
      typedData: VALID_TYPED_DATA,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("POLICY_BLOCKED");
    }
  });

  it("translates TurnkeyUpstreamError to UPSTREAM", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);
    mockSign.mockRejectedValue(new TurnkeyUpstreamError("502 from Turnkey"));

    const result = await signTypedDataCore({
      typedData: VALID_TYPED_DATA,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("UPSTREAM");
    }
  });

  // KEEP-473 regression: the json-editor UI field emits typedData as a JSON
  // string. Core must parse it before validation. Same shape-mismatch class
  // as KEEP-571 (UI vs validator emit-shape).
  it("accepts typedData as a JSON string from the json-editor UI", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);
    mockSign.mockResolvedValue(`0x${"ab".repeat(65)}`);

    const result = await signTypedDataCore({
      typedData: JSON.stringify(VALID_TYPED_DATA),
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.signature).toMatch(SIGNATURE_HEX_RE);
    }
    // Turnkey must receive the parsed object, never the raw string.
    expect(mockSign).toHaveBeenCalledWith(
      WALLET.turnkeySubOrgId,
      WALLET.walletAddress,
      VALID_TYPED_DATA
    );
  });

  it("returns VALIDATION when typedData is an invalid JSON string", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const result = await signTypedDataCore({
      typedData: "{not valid json",
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toMatch(JSON_ERROR_RE);
    }
    // The signer must NEVER be invoked when the input fails to parse.
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("routes a parsed string through validateTypedData (missing primaryType is rejected)", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const malformed = {
      domain: VALID_TYPED_DATA.domain,
      types: VALID_TYPED_DATA.types,
      message: VALID_TYPED_DATA.message,
      // primaryType intentionally omitted
    };

    const result = await signTypedDataCore({
      typedData: JSON.stringify(malformed),
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toMatch(PRIMARY_TYPE_ERROR_RE);
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  // A-06: a malicious marketplace template can embed a hardcoded
  // fund-moving EIP-712 authorization; deploy + run would otherwise sign it
  // with the victim's creator EOA and drain their tokens. The web3 step
  // must refuse these primaryTypes BEFORE touching the Turnkey signer.
  it("rejects an EIP-2612 Permit typedData (fund-moving denylist)", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const permit = {
      ...VALID_TYPED_DATA,
      primaryType: "Permit",
      message: {
        owner: "0x0000000000000000000000000000000000000001",
        spender: "0x0000000000000000000000000000000000000002",
        value: "1000000000",
        nonce: 0,
        deadline: "9999999999",
      },
    };

    const result = await signTypedDataCore({
      typedData: permit,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("rejects an EIP-3009 TransferWithAuthorization typedData", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const transferAuth = {
      ...VALID_TYPED_DATA,
      primaryType: "TransferWithAuthorization",
    };

    const result = await signTypedDataCore({
      typedData: transferAuth,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("rejects a custom primaryType containing 'permit' via the substring backstop", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const sneaky = { ...VALID_TYPED_DATA, primaryType: "MyPermitThing" };

    const result = await signTypedDataCore({
      typedData: sneaky,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("rejects a typedData whose domain.chainId is unsupported", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const unsupportedChain = {
      ...VALID_TYPED_DATA,
      domain: { ...VALID_TYPED_DATA.domain, chainId: 999_999 },
    };

    const result = await signTypedDataCore({
      typedData: unsupportedChain,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("rejects an unsupported domain.chainId supplied as a hex string", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const unsupportedHex = {
      ...VALID_TYPED_DATA,
      domain: { ...VALID_TYPED_DATA.domain, chainId: "0xf423f" },
    };

    const result = await signTypedDataCore({
      typedData: unsupportedHex,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("signs a benign primaryType (Mail) on a supported chain", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);
    mockSign.mockResolvedValue(`0x${"ab".repeat(65)}`);

    const mail = {
      domain: { name: "Ether Mail", version: "1", chainId: 1 },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Mail: [{ name: "contents", type: "string" }],
      },
      primaryType: "Mail",
      message: { contents: "hello" },
    };

    const result = await signTypedDataCore({
      typedData: mail,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.signature).toMatch(SIGNATURE_HEX_RE);
    }
    expect(mockSign).toHaveBeenCalledWith(
      WALLET.turnkeySubOrgId,
      WALLET.walletAddress,
      mail
    );
  });

  it("signs a benign typedData that omits domain.chainId entirely", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);
    mockSign.mockResolvedValue(`0x${"ab".repeat(65)}`);

    const noChainId = {
      domain: { name: "Order Book", version: "1" },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Order: [{ name: "id", type: "uint256" }],
      },
      primaryType: "Order",
      message: { id: 7 },
    };

    const result = await signTypedDataCore({
      typedData: noChainId,
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.signature).toMatch(SIGNATURE_HEX_RE);
    }
    expect(mockSign).toHaveBeenCalledWith(
      WALLET.turnkeySubOrgId,
      WALLET.walletAddress,
      noChainId
    );
  });

  it("rejects a Gnosis Safe SafeTx typedData", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const result = await signTypedDataCore({
      typedData: { ...VALID_TYPED_DATA, primaryType: "SafeTx" },
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("rejects a Seaport OrderComponents typedData", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const result = await signTypedDataCore({
      typedData: { ...VALID_TYPED_DATA, primaryType: "OrderComponents" },
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("rejects a denylisted primaryType supplied as a JSON string", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const result = await signTypedDataCore({
      typedData: JSON.stringify({ ...VALID_TYPED_DATA, primaryType: "Permit" }),
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("rejects a junk string chainId that parseInt would leniently truncate", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const result = await signTypedDataCore({
      typedData: {
        ...VALID_TYPED_DATA,
        domain: { ...VALID_TYPED_DATA.domain, chainId: "8453garbage" },
      },
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("signs when a supported chainId is given as a decimal string", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);
    mockSign.mockResolvedValue(`0x${"ab".repeat(65)}`);

    const result = await signTypedDataCore({
      typedData: {
        ...VALID_TYPED_DATA,
        domain: { ...VALID_TYPED_DATA.domain, chainId: "8453" },
      },
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.signature).toMatch(SIGNATURE_HEX_RE);
    }
    expect(mockSign).toHaveBeenCalled();
  });

  it("strips control characters from the rejection error message", async () => {
    mockGetOrgWallet.mockResolvedValue(WALLET);

    const result = await signTypedDataCore({
      typedData: { ...VALID_TYPED_DATA, primaryType: "Permit\nINJECTED LOG" },
      _context: { organizationId: "org-1" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("VALIDATION");
      expect(result.error).not.toContain("\n");
      expect(result.error).toContain("PermitINJECTED LOG");
    }
    expect(mockSign).not.toHaveBeenCalled();
  });
});
