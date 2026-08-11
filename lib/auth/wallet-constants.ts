// Synthetic email domain assigned to wallet-only (SIWE) accounts. Wallet
// users have no real inbox, so Better Auth's SIWE plugin mints
// `<address>@<domain>`. The suffix is the marker the proxy and the
// auth hooks use to recognize a wallet account without a dedicated column.
export const WALLET_EMAIL_DOMAIN = "wallet.keeperhub.com";

export function isWalletEmail(email: string | null | undefined): boolean {
  return (
    typeof email === "string" &&
    email.toLowerCase().endsWith(`@${WALLET_EMAIL_DOMAIN.toLowerCase()}`)
  );
}
