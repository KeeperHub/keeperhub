import "server-only";

import { SIGNER_MODE, type SignerMode } from "@/lib/safe/signer-resolver";
import {
  isGasSponsorshipEnabled,
  resolveSponsorGas,
} from "@/lib/web3/sponsorship-feature-flag";
import { isSponsorshipSupported } from "@/lib/web3/turnkey-sponsorship-config";

type SponsorshipEligibility = {
  chainId: number;
  signerMode: SignerMode;
  sponsorGas?: boolean;
  usePrivateMempool?: boolean;
};

/**
 * Whether a write step should try the gas-sponsored route before signing
 * directly. Every step that has a sponsored path asks here, so two actions
 * sending the same kind of transaction cannot disagree about when to take it.
 *
 * Each clause rules the route out for its own reason:
 *  - the deployment-wide flag is off;
 *  - Turnkey's Gas Station does not cover the chain (EVM only, and not every
 *    EVM chain - see SPONSORSHIP_CHAINS);
 *  - the node's author turned the Sponsor gas toggle off;
 *  - KEEP-137: the node routes through a private mempool (e.g. Flashbots
 *    Protect), which Turnkey's own broadcast infrastructure would bypass;
 *  - the send goes through a Safe, where a sponsored call built as a direct
 *    send from the org's EOA would change msg.sender away from the Safe.
 *
 * A false answer is never an error: the caller signs and pays directly, which
 * is also what happens when this returns true and sponsorship then declines
 * (no credits left, client creation failed).
 */
export function shouldTrySponsorship({
  chainId,
  signerMode,
  sponsorGas,
  usePrivateMempool,
}: SponsorshipEligibility): boolean {
  return (
    isGasSponsorshipEnabled() &&
    isSponsorshipSupported(chainId) &&
    resolveSponsorGas(sponsorGas) &&
    !usePrivateMempool &&
    signerMode.kind === SIGNER_MODE.EOA
  );
}
