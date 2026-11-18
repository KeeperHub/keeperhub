import { truncateAddress } from "@/lib/address-utils";
import { EVM_ADDRESS_RE } from "@/lib/web3/address";

/** The stand-ins used when a person has no usable name. */
export const ROLE_NAMES: ReadonlySet<string> = new Set([
  "An owner",
  "An admin",
  "A member",
]);

/** A sign-in account as shown: a wallet address shortened, an email as is. */
export function accountLabel(account: string): string {
  return EVM_ADDRESS_RE.test(account) ? truncateAddress(account) : account;
}

/** "Dana (dana@x.com)", the account alone for a role stand-in, or the name alone. */
export function actorLabel(
  by: string | null,
  account: string | null
): string | null {
  const shown = account ? accountLabel(account) : null;
  if (!by || ROLE_NAMES.has(by)) {
    return shown ?? by;
  }
  return shown && shown !== by ? `${by} (${shown})` : by;
}
