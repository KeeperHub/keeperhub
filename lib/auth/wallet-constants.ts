// Synthetic email domain assigned to wallet-only (SIWE) accounts. Wallet
// users have no real inbox, so Better Auth's SIWE plugin mints
// `<address>@<domain>`. The suffix is the marker the proxy and the
// auth hooks use to recognize a wallet account without a dedicated column.
//
// Deliberately not configurable, though it does put a keeperhub.com suffix in
// every deployment's user rows. This module is imported by client components
// (manage-orgs-modal, api-keys-overlay, broadcast-overlay) as well as by server
// routes, so a non-NEXT_PUBLIC_ read would resolve to the configured value on
// the server and to the default in the browser. isWalletEmail matches on the
// suffix, so the two sides would disagree about which accounts are wallet
// accounts. The address is synthetic and never receives mail; see
// DEPENDENCIES.md.
export const WALLET_EMAIL_DOMAIN = "wallet.keeperhub.com";

export function isWalletEmail(email: string | null | undefined): boolean {
  return (
    typeof email === "string" &&
    email.toLowerCase().endsWith(`@${WALLET_EMAIL_DOMAIN.toLowerCase()}`)
  );
}
