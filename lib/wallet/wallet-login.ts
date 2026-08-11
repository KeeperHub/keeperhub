"use client";

import { toHex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { authClient } from "@/lib/auth-client";
import type { Eip1193Provider } from "@/lib/wallet/connect-types";

export type WalletLoginResult =
  | { ok: true }
  | { ok: false; error: string; rejected?: boolean };

function isUserRejection(error: unknown): boolean {
  // EIP-1193 user-rejected-request code.
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === 4001
  );
}

/**
 * Full SIWE login against an injected wallet:
 * request accounts -> fetch a server nonce -> build + sign an EIP-4361
 * message -> verify server-side (which mints the session cookie).
 *
 * The signature is the auth factor; on success Better Auth's /siwe/verify
 * has already set the session cookie, so callers just need to refresh the
 * session and (for new accounts) prompt the rename modal.
 */
export async function loginWithWallet(
  provider: Eip1193Provider
): Promise<WalletLoginResult> {
  try {
    const accounts = await provider.request<string[]>({
      method: "eth_requestAccounts",
    });
    const address = accounts?.[0];
    if (!address) {
      return { ok: false, error: "No wallet account was authorized." };
    }

    const chainIdHex = await provider.request<string>({
      method: "eth_chainId",
    });
    const chainId = Number.parseInt(chainIdHex, 16) || 1;

    const nonceResult = await authClient.siwe.nonce({
      walletAddress: address,
      chainId,
    });
    const nonce = nonceResult.data?.nonce;
    if (!nonce) {
      return { ok: false, error: "Could not start the wallet sign-in." };
    }

    const message = createSiweMessage({
      address: address as `0x${string}`,
      chainId,
      domain: window.location.host,
      nonce,
      statement: "Sign in to KeeperHub with your wallet.",
      uri: window.location.origin,
      version: "1",
    });

    const signature = await provider.request<string>({
      method: "personal_sign",
      params: [toHex(message), address],
    });

    const verifyResult = await authClient.siwe.verify({
      message,
      signature,
      walletAddress: address,
      chainId,
    });
    if (verifyResult.error || !verifyResult.data?.success) {
      return {
        ok: false,
        error:
          verifyResult.error?.message ??
          "Wallet signature could not be verified.",
      };
    }

    return { ok: true };
  } catch (error) {
    if (isUserRejection(error)) {
      return {
        ok: false,
        error: "Signature request was rejected.",
        rejected: true,
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Wallet sign-in failed.",
    };
  }
}
