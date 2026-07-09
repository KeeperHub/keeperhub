import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PolicyBlockedError,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign";
import { TurnkeySolanaSigner } from "@/lib/agentic-wallet/solana-turnkey-signer";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";

vi.mock("@/lib/turnkey/agentic-wallet", () => ({
  getTurnkeyClientForOrg: vi.fn(),
}));

describe("TurnkeySolanaSigner", () => {
  const mockSubOrgId = "mock-sub-org-id";
  const mockSolanaAddress = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  let mockApiClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = {
      signTransaction: vi.fn(),
    };
    vi.mocked(getTurnkeyClientForOrg).mockReturnValue({
      apiClient: () => mockApiClient,
    } as any);
  });

  it("getPublicKey returns correct PublicKey instance", async () => {
    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    const pubkey = await signer.getPublicKey();
    expect(pubkey.toBase58()).toBe(mockSolanaAddress);
  });

  it("signTransaction successfully signs when status is completed", async () => {
    const mockUnsignedBytes = new Uint8Array([1, 2, 3]);
    const mockSignedBase64 = Buffer.from(new Uint8Array([4, 5, 6])).toString(
      "base64"
    );

    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_COMPLETED",
        result: {
          signTransactionResult: {
            signedTransaction: mockSignedBase64,
          },
        },
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    const result = await signer.signTransaction(mockUnsignedBytes);

    expect(result).toEqual(new Uint8Array([4, 5, 6]));
    expect(mockApiClient.signTransaction).toHaveBeenCalledWith({
      signWith: mockSolanaAddress,
      type: "TRANSACTION_TYPE_SOLANA",
      unsignedTransaction: Buffer.from(mockUnsignedBytes).toString("base64"),
    });
  });

  it("throws PolicyBlockedError when status is consensus needed", async () => {
    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    await expect(
      signer.signTransaction(new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(PolicyBlockedError);
  });

  it("throws TurnkeyUpstreamError when status is not completed", async () => {
    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_PENDING",
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    await expect(
      signer.signTransaction(new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(TurnkeyUpstreamError);
  });

  it("throws TurnkeyUpstreamError when signedTransaction is missing", async () => {
    mockApiClient.signTransaction.mockResolvedValue({
      activity: {
        status: "ACTIVITY_STATUS_COMPLETED",
        result: {
          signTransactionResult: {},
        },
      },
    });

    const signer = new TurnkeySolanaSigner(mockSubOrgId, mockSolanaAddress);
    await expect(
      signer.signTransaction(new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(TurnkeyUpstreamError);
  });
});
