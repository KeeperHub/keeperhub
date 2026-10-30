import { truncateAddress } from "@/lib/address-utils";
import { isWalletEmail } from "@/lib/auth/wallet-constants";

/** A wallet account's login is a synthetic address; show the wallet instead. */
export function memberLabel(m: {
  email: string | null;
  name: string | null;
  userId: string;
}): string {
  if (m.email && isWalletEmail(m.email)) {
    return truncateAddress(m.email.split("@")[0] ?? "");
  }
  return m.email ?? m.name ?? m.userId;
}
