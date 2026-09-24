import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockIsGasSponsorshipEnabled } = vi.hoisted(() => ({
  mockIsGasSponsorshipEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/web3/sponsorship-feature-flag", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/web3/sponsorship-feature-flag")
  >()),
  isGasSponsorshipEnabled: () => mockIsGasSponsorshipEnabled(),
}));

import { SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { shouldTrySponsorship } from "@/lib/web3/sponsorship-eligibility";

const EOA = { kind: SIGNER_MODE.EOA } as Parameters<
  typeof shouldTrySponsorship
>[0]["signerMode"];
const SAFE = { kind: SIGNER_MODE.SAFE } as Parameters<
  typeof shouldTrySponsorship
>[0]["signerMode"];
const SAFE_ROLE = { kind: SIGNER_MODE.SAFE_ROLE } as Parameters<
  typeof shouldTrySponsorship
>[0]["signerMode"];

// Ethereum mainnet and an unsponsored chain (Optimism), per SPONSORSHIP_CHAINS.
const SPONSORED_CHAIN = 1;
const UNSPONSORED_CHAIN = 10;

describe("shouldTrySponsorship", () => {
  beforeEach(() => {
    mockIsGasSponsorshipEnabled.mockReturnValue(true);
  });

  it("takes the sponsored route for a plain EOA send on a covered chain", () => {
    expect(
      shouldTrySponsorship({ chainId: SPONSORED_CHAIN, signerMode: EOA })
    ).toBe(true);
  });

  it("declines when the deployment-wide flag is off", () => {
    mockIsGasSponsorshipEnabled.mockReturnValue(false);
    expect(
      shouldTrySponsorship({ chainId: SPONSORED_CHAIN, signerMode: EOA })
    ).toBe(false);
  });

  it("declines on a chain the Gas Station does not cover", () => {
    // Every core asks this now. Two of them used to omit the check and relied
    // on the sponsored manager returning null, which cost an API round trip
    // per send on, for example, Optimism.
    expect(
      shouldTrySponsorship({ chainId: UNSPONSORED_CHAIN, signerMode: EOA })
    ).toBe(false);
  });

  it("declines when the node turns the Sponsor gas toggle off", () => {
    expect(
      shouldTrySponsorship({
        chainId: SPONSORED_CHAIN,
        signerMode: EOA,
        sponsorGas: false,
      })
    ).toBe(false);
  });

  it('reads the "false" string the editor may persist as off', () => {
    expect(
      shouldTrySponsorship({
        chainId: SPONSORED_CHAIN,
        signerMode: EOA,
        sponsorGas: "false" as unknown as boolean,
      })
    ).toBe(false);
  });

  it("stays on when the toggle is unset or explicitly on", () => {
    expect(
      shouldTrySponsorship({
        chainId: SPONSORED_CHAIN,
        signerMode: EOA,
        sponsorGas: undefined,
      })
    ).toBe(true);
    expect(
      shouldTrySponsorship({
        chainId: SPONSORED_CHAIN,
        signerMode: EOA,
        sponsorGas: true,
      })
    ).toBe(true);
  });

  it("declines a private-mempool route, which Turnkey's broadcast bypasses", () => {
    expect(
      shouldTrySponsorship({
        chainId: SPONSORED_CHAIN,
        signerMode: EOA,
        usePrivateMempool: true,
      })
    ).toBe(false);
  });

  it.each([
    ["safe", SAFE],
    ["safe-role", SAFE_ROLE],
  ])(
    "declines a %s send, which would move msg.sender",
    (_label, signerMode) => {
      expect(
        shouldTrySponsorship({ chainId: SPONSORED_CHAIN, signerMode })
      ).toBe(false);
    }
  );
});
