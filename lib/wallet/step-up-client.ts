"use client";

import { toHex } from "viem";
import { truncateAddress } from "@/lib/address-utils";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient } from "@/lib/auth-client";
import type {
  DiscoveredWallet,
  Eip1193Provider,
} from "@/lib/wallet/connect-types";

/**
 * Client helpers for wallet step-up. When a step-up-gated endpoint returns
 * `signature_required` with a `challenge`, the wallet signs that exact message
 * and the request is retried with the signature.
 *
 * The signature MUST come from the account the user signed in with, which the
 * server verifies against. Reading `window.ethereum` is wrong: with more than
 * one wallet installed (e.g. Brave + MetaMask) it resolves to whichever hijacked
 * the global, and `accounts[0]` is that wallet's active account, not the login
 * wallet. So we discover every injected wallet via EIP-6963 (the same mechanism
 * the sign-in flow uses) and sign with the provider that actually holds the
 * login account, failing with a clear instruction if none does.
 */

export type StepUpExtra = {
  signature?: string;
  code?: string;
  emailOtp?: string;
};

/** Collect injected providers announced over EIP-6963, plus window.ethereum. */
async function discoverProviders(): Promise<Eip1193Provider[]> {
  const byProvider = new Set<Eip1193Provider>();
  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent<DiscoveredWallet>).detail;
    if (detail?.provider) {
      byProvider.add(detail.provider);
    }
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);

  const injected = (window as unknown as { ethereum?: Eip1193Provider })
    .ethereum;
  if (injected) {
    byProvider.add(injected);
  }
  return [...byProvider];
}

/** The wallet address the user authenticated with (SIWE email local-part). */
async function getLoginWalletAddress(): Promise<string | null> {
  try {
    const session = await authClient.getSession();
    const email = session?.data?.user?.email;
    if (email && isWalletEmail(email)) {
      return email.split("@")[0] ?? null;
    }
  } catch {
    // No session or fetch failed; fall back to the active account below.
  }
  return null;
}

async function accountsOf(
  provider: Eip1193Provider,
  method: "eth_accounts" | "eth_requestAccounts"
): Promise<string[]> {
  try {
    return (await provider.request<string[]>({ method })) ?? [];
  } catch {
    return [];
  }
}

/** Sign a step-up challenge with the login wallet (EIP-191 personal_sign). */
export async function signStepUpChallenge(challenge: string): Promise<string> {
  const providers = await discoverProviders();
  if (providers.length === 0) {
    throw new Error("No wallet detected in this browser.");
  }
  const expected = await getLoginWalletAddress();
  const message = toHex(challenge);

  // No known login address (e.g. parse failure): preserve the old behavior and
  // sign with the first provider's active account.
  if (!expected) {
    for (const provider of providers) {
      const [account] = await accountsOf(provider, "eth_requestAccounts");
      if (account) {
        return await provider.request<string>({
          method: "personal_sign",
          params: [message, account],
        });
      }
    }
    throw new Error("No wallet account was authorized.");
  }

  const matches = (account: string): boolean =>
    account.toLowerCase() === expected.toLowerCase();

  // Prefer a provider that already has the login account connected (no prompt).
  for (const provider of providers) {
    const account = (await accountsOf(provider, "eth_accounts")).find(matches);
    if (account) {
      return await provider.request<string>({
        method: "personal_sign",
        params: [message, account],
      });
    }
  }
  // Otherwise prompt each wallet to connect and look again.
  for (const provider of providers) {
    const account = (await accountsOf(provider, "eth_requestAccounts")).find(
      matches
    );
    if (account) {
      return await provider.request<string>({
        method: "personal_sign",
        params: [message, account],
      });
    }
  }

  throw new Error(
    `Switch your wallet to ${truncateAddress(expected)}, the account you signed in with, then try again.`
  );
}

type StepUpBody = { code?: string; challenge?: string };

/**
 * Runs a step-up-gated request. `send` performs the fetch with the given
 * extra fields. On a `signature_required` response the wallet signs the
 * returned challenge and the request is retried once. Returns the final
 * Response (the caller handles non-signature errors and success).
 */
export async function runWalletStepUp(
  send: (extra: StepUpExtra) => Promise<Response>
): Promise<Response> {
  const first = await send({});
  if (first.ok) {
    return first;
  }
  const data = (await first
    .clone()
    .json()
    .catch(() => ({}))) as StepUpBody;
  if (
    first.status === 401 &&
    data.code === "signature_required" &&
    data.challenge
  ) {
    const signature = await signStepUpChallenge(data.challenge);
    return await send({ signature });
  }
  return first;
}
