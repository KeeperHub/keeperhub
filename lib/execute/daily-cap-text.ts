// No imports: callers outside the value ledger read this without its DB deps.

/** How every EVM daily cap refusal starts; the held-bundle detail may follow. */
export const DAILY_CAP_EXCEEDED = "Daily spending cap exceeded";

/**
 * A run error for a caller outside the org: the held-bundle detail names the
 * org's wallets, networks and amounts, so it is cut after the bare refusal.
 */
export function withoutDailyCapDetail(error: string): string {
  const at = error.indexOf(`${DAILY_CAP_EXCEEDED}: `);
  return at === -1 ? error : `${error.slice(0, at)}${DAILY_CAP_EXCEEDED}`;
}
