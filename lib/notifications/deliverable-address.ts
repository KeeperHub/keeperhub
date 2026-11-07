import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { isAnonymousUser } from "@/lib/is-anonymous";

/**
 * The address a member can actually be reached at, or null.
 *
 * Not every account has a real inbox. Wallet (SIWE) accounts are minted with a
 * synthetic `<address>@wallet.keeperhub.com` login, and anonymous accounts get
 * a placeholder; mailing either is guaranteed to bounce and, on a shared
 * domain, hurts the sending reputation the rest of our mail depends on.
 *
 * So an address only qualifies if the user supplied it and proved they hold it:
 * a wallet user's enrolled step-up email, which is written only after an
 * emailed code is confirmed, or a verified login email.
 */
export function deliverableAddress(row: {
  email: string | null;
  emailVerified: boolean | null;
  stepUpEmail: string | null;
  name: string | null;
}): string | null {
  if (isWalletEmail(row.email)) {
    return row.stepUpEmail;
  }
  if (isAnonymousUser({ name: row.name, email: row.email })) {
    return null;
  }
  return row.emailVerified ? row.email : null;
}
