"use client";

import { signStepUpChallenge } from "@/lib/wallet/step-up-client";

/**
 * Accept a wallet (SIWE) org invitation: fetch the sign-to-join challenge,
 * sign it with the connected wallet, and post the signature. The caller must
 * already be signed in as the invited wallet account; the server verifies both.
 * Resolves on success and throws with a user-facing message otherwise.
 */
export async function acceptWalletInvite(invitationId: string): Promise<void> {
  const base = `/api/organizations/invitations/${invitationId}/wallet-accept`;

  const challengeRes = await fetch(base, { cache: "no-store" });
  if (!challengeRes.ok) {
    const data = (await challengeRes.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error ?? "Couldn't start acceptance.");
  }
  const { message } = (await challengeRes.json()) as { message: string };

  const signature = await signStepUpChallenge(message);

  const acceptRes = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature }),
  });
  if (!acceptRes.ok) {
    const data = (await acceptRes.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error ?? "Couldn't accept the invitation.");
  }
}
