"use client";

import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient, useSession } from "@/lib/auth-client";
import {
  useInvalidateWalletInfo,
  useWalletInfo,
} from "@/lib/wallet/use-wallet-info";

type ProvisionEvent =
  | { type: "provisioning" }
  | { type: "ready"; walletAddress: string; created: boolean }
  | { type: "error"; message: string };

/**
 * Orgs whose provisioning stream has already been opened this page-session.
 * Module-level so the multiple mounted consumers (the global trigger plus the
 * workflow toolbar) never open the stream twice for the same org.
 */
const attemptedOrgIds = new Set<string>();

/** Shared so the toolbar badge reflects provisioning regardless of which mounted hook opened the stream. */
const provisioningAtom = atom(false);

function parseEvent(frame: string): ProvisionEvent | null {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) {
    return null;
  }
  try {
    return JSON.parse(dataLine.slice(5).trim()) as ProvisionEvent;
  } catch {
    return null;
  }
}

async function runProvisionStream(onReady: () => void): Promise<void> {
  const response = await fetch("/api/user/wallet/provision");
  if (!(response.ok && response.body)) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
      stream: !done,
    });

    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const event = parseEvent(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      if (event?.type === "ready") {
        onReady();
      }
      separator = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Pure gate for whether to open the provisioning stream: a verified, org-scoped
 * user whose org has no wallet yet and that we have not already attempted this
 * page-session. Extracted so it can be unit-tested without rendering the hook.
 */
function shouldOpenProvisionStream(params: {
  isAuthed: boolean;
  activeOrgId: string | null;
  isLoading: boolean;
  hasWallet: boolean;
  attempted: boolean;
}): boolean {
  const { isAuthed, activeOrgId, isLoading, hasWallet, attempted } = params;
  if (!(isAuthed && activeOrgId)) {
    return false;
  }
  // Wait for the wallet-status fetch to resolve before deciding.
  if (isLoading || hasWallet) {
    return false;
  }
  return !attempted;
}

/**
 * Drives signup-time wallet provisioning from the client: when a verified user
 * has an active org but no wallet yet, opens the streamed provisioning endpoint
 * once, awaits the Turnkey call, and refreshes wallet info when it is ready.
 * Self-gating and idempotent - safe to mount in global chrome. On failure it
 * stays silent; the next-login backstop (session.create.after) is the fallback.
 */
export function useWalletProvisioning(): { isProvisioning: boolean } {
  const { data: session } = useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const { hasWallet, isLoading } = useWalletInfo();
  const invalidate = useInvalidateWalletInfo();
  const isProvisioning = useAtomValue(provisioningAtom);
  const setProvisioning = useSetAtom(provisioningAtom);

  const email = session?.user?.email;
  // Wallet (SIWE) accounts never verify their synthetic email; they authenticate
  // by signature. Without the wallet-aware clause this hook never ran for them,
  // so after signup the client never refetched wallet info once the backstop
  // provisioned the Turnkey wallet -- the toolbar stayed on "Create wallet"
  // until a manual page reload.
  const isAuthed =
    !!session?.user?.id &&
    !!email &&
    !email.startsWith("temp-") &&
    (session?.user?.emailVerified === true || isWalletEmail(email));
  const activeOrgId = activeOrg?.id ?? null;

  useEffect(() => {
    if (!activeOrgId) {
      return;
    }
    const open = shouldOpenProvisionStream({
      isAuthed,
      activeOrgId,
      isLoading,
      hasWallet,
      attempted: attemptedOrgIds.has(activeOrgId),
    });
    if (!open) {
      return;
    }

    attemptedOrgIds.add(activeOrgId);
    setProvisioning(true);
    runProvisionStream(invalidate)
      .catch(() => {
        // Network/stream failure: fall back silently to the login backstop.
      })
      .finally(() => {
        setProvisioning(false);
      });
  }, [
    isAuthed,
    activeOrgId,
    isLoading,
    hasWallet,
    invalidate,
    setProvisioning,
  ]);

  return { isProvisioning };
}

export {
  parseEvent as __parseEventForTesting,
  runProvisionStream as __runProvisionStreamForTesting,
  shouldOpenProvisionStream as __shouldOpenProvisionStreamForTesting,
};
