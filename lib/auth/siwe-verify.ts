import { isAddressEqual, recoverMessageAddress } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";

// Shape of the argument Better Auth's SIWE plugin passes to `verifyMessage`.
// The plugin does not re-export this type, so it is mirrored here.
type SIWEVerifyMessageArgs = {
  message: string;
  signature: string;
  address: string;
  chainId: number;
  cacao?: {
    p: { domain: string; nonce: string };
  };
};

/**
 * Verifies a SIWE (EIP-4361) message + EIP-191 personal_sign signature for an
 * EOA wallet. Fully offline: it parses the message, validates the structural
 * fields (domain + the server-issued nonce, expiry / not-before windows), then
 * recovers the signer from the signature and checks it matches the claimed
 * address. EIP-1271 (smart-contract wallets) is out of scope here; injected
 * browser wallets sign with an EOA key.
 *
 * The Better Auth SIWE plugin only checks that a nonce exists in storage; it
 * does not bind that nonce to the signed message. Binding it here (via
 * `cacao.p.nonce`/`domain`) is what makes the signature non-replayable.
 *
 * For standard EIP-1193 browser wallets (MetaMask, Brave, etc.) the `cacao`
 * envelope is absent. We fall back to the server's own origin as the expected
 * domain so cross-domain phishing signatures (signed for evil.com using a
 * KeeperHub-issued nonce) are rejected even without WalletConnect 2.0.
 */
function getExpectedDomain(): string | undefined {
  const raw =
    process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  try {
    return new URL(raw).host || undefined;
  } catch {
    return undefined;
  }
}

export async function verifySiweSignature(
  args: SIWEVerifyMessageArgs
): Promise<boolean> {
  const { message, signature, address, cacao } = args;

  const fields = parseSiweMessage(message);
  if (!fields.address) {
    return false;
  }

  const expectedDomain = cacao?.p.domain ?? getExpectedDomain();
  if (!expectedDomain) {
    return false;
  }

  const structurallyValid = validateSiweMessage({
    address: address as `0x${string}`,
    domain: expectedDomain,
    message: fields,
    // For WalletConnect the nonce comes from the cacao envelope; for standard
    // EIP-1193 wallets (MetaMask, Rabby, Brave) there is no cacao, so fall
    // back to the nonce embedded in the signed SIWE message itself. Without
    // this fallback, validateSiweMessage receives nonce=undefined and skips
    // the nonce field check entirely, leaving signed messages replayable.
    nonce: cacao?.p.nonce ?? fields.nonce,
  });
  if (!structurallyValid) {
    return false;
  }

  try {
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    return isAddressEqual(recovered, address as `0x${string}`);
  } catch {
    return false;
  }
}
