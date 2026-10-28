import {
  toChecksumAddress,
  truncateChecksummedAddress,
} from "@/lib/address-utils";
import { walletAddressFromEmail } from "@/lib/auth/wallet-constants";

/**
 * How an account is identified wherever it is listed or shown. A wallet
 * account carries a synthetic `<address>@wallet...` email rather than a
 * mailbox, so it is shown as the wallet it signs in with. `full` is the
 * untruncated form, for a tooltip and for search.
 */
export function loginIdentifier(email: string): {
  shown: string;
  full: string;
} {
  const address = walletAddressFromEmail(email);
  if (!address) {
    return { shown: email, full: email };
  }
  const checksummed = toChecksumAddress(address);
  return { shown: truncateChecksummedAddress(checksummed), full: checksummed };
}
