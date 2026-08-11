import { randomBytes } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt } from "drizzle-orm";
import { isAddressEqual, recoverMessageAddress } from "viem";
import { db } from "@/lib/db";
import { verifications } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { generateId } from "@/lib/utils/id";

/**
 * Sign-to-join challenge for wallet (SIWE) org invitations.
 *
 * Minted when the invitation is created and stored encrypted in `verifications`
 * (same primitives as lib/mfa/wallet-step-up.ts). When the invited wallet user
 * accepts, they sign this exact message; the server recovers the signer and
 * confirms it matches the invited address. The nonce is single-use and scoped
 * to the invitation id, so a signature for one invite can't be replayed.
 */

const TTL_DAYS = 7;

function identifier(invitationId: string): string {
  return `orginvite:${invitationId}`;
}

function buildMessage(invitationId: string, nonce: string): string {
  return `KeeperHub organization invite\n\nInvitation: ${invitationId}\nNonce: ${nonce}`;
}

function serverSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
  return secret;
}

/** Create (or replace) the challenge nonce for an invitation. Called at invite
 *  creation time. TTL matches the invitation expiry. */
export async function mintInviteChallenge(
  invitationId: string
): Promise<string> {
  const nonce = randomBytes(16).toString("hex");
  const encrypted = await symmetricEncrypt({
    key: serverSecret(),
    data: nonce,
  });
  const id = identifier(invitationId);
  await db.transaction(async (tx) => {
    await tx.delete(verifications).where(eq(verifications.identifier, id));
    await tx.insert(verifications).values({
      id: generateId(),
      identifier: id,
      value: encrypted,
      expiresAt: new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  return buildMessage(invitationId, nonce);
}

async function readNonce(invitationId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifier(invitationId)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!row) {
    return null;
  }
  try {
    return await symmetricDecrypt({ key: serverSecret(), data: row.value });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[InviteChallenge] Failed to decrypt nonce",
      err,
      { invitationId }
    );
    return null;
  }
}

/** The message the invited wallet must sign. Mints a fresh nonce if none is
 *  stored (covers expiry or a re-sent invite). */
export async function getInviteChallengeMessage(
  invitationId: string
): Promise<string> {
  const nonce = await readNonce(invitationId);
  if (nonce) {
    return buildMessage(invitationId, nonce);
  }
  return mintInviteChallenge(invitationId);
}

/** Verify a signature against the invited address. Single-use: the nonce is
 *  deleted on success so the same signature can't be replayed. */
export async function verifyInviteChallenge(
  invitationId: string,
  invitedAddress: string,
  signature: string
): Promise<boolean> {
  const nonce = await readNonce(invitationId);
  if (!nonce) {
    return false;
  }
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({
      message: buildMessage(invitationId, nonce),
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
  if (!isAddressEqual(recovered, invitedAddress as `0x${string}`)) {
    return false;
  }
  // Use .returning() so we know whether the DELETE actually removed a row.
  // Under concurrent POST requests both could pass the signature check; the
  // first to delete wins and the second gets an empty array, returning false
  // and preventing a duplicate member insert.
  const deleted = await db
    .delete(verifications)
    .where(eq(verifications.identifier, identifier(invitationId)))
    .returning({ id: verifications.id });
  return deleted.length > 0;
}
