import { isAddress } from "viem";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { isDisposableEmailDomain } from "@/lib/auth-disposable-emails";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalized comparison key for an invite value (trimmed, lowercased). */
export function inviteKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A valid invite target: either a checksum-strict wallet address, or a
 * well-formed email that is not disposable/blacklisted or a synthetic wallet
 * address (matching the signup email rules).
 */
export function isValidInvite(value: string): boolean {
  const v = value.trim();
  if (!v) {
    return false;
  }
  if (v.startsWith("0x")) {
    return isAddress(v);
  }
  return EMAIL_RE.test(v) && !(isWalletEmail(v) || isDisposableEmailDomain(v));
}

/**
 * Whether an invite value refers to the signed-in user (who is already in the
 * org). Matches their email (email/social) or, for wallet accounts, the address
 * in their synthetic email.
 */
export function isSelfInvite(
  value: string,
  selfEmail?: string,
  selfAddress?: string
): boolean {
  const v = inviteKey(value);
  if (!v) {
    return false;
  }
  return v === selfEmail || (Boolean(selfAddress) && v === selfAddress);
}

/** The set of normalized keys that appear in more than one non-empty value. */
export function findDuplicateKeys(values: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = inviteKey(value);
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const dups = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) {
      dups.add(key);
    }
  }
  return dups;
}
