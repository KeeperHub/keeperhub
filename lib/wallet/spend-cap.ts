export const EVM_DECIMALS = 18;
export const SOLANA_DECIMALS = 9;

const TRAILING_ZEROS = /\.?0+$/;

export type SpendCapResponse = {
  dailyCapWei: string | null;
  dailyUsedWei: string;
  dailySolanaCapLamports: string | null;
  dailySolanaUsedLamports: string;
  // What enforcement actually compares against: the org's own cap when it set
  // one, the platform default otherwise. A null configured cap means the org
  // set nothing, never that spending is uncapped.
  effectiveDailyCapWei: string;
  effectiveDailySolanaCapLamports: string;
  usingDefaultDailyCap: boolean;
  usingDefaultDailySolanaCap: boolean;
};

export type SpendCap = {
  id: "evm" | "solana";
  label: string;
  symbol: string;
  decimals: number;
  /** The org's own cap, or null when it set none. */
  cap: string | null;
  /** The figure enforcement uses. Null only while the response is missing. */
  effectiveCap: string | null;
  /** True when `effectiveCap` is the platform default rather than the org's. */
  usingDefault: boolean;
  used: string;
};

/** Shared by the limits section and the toolbar digest so one fetch serves both. */
export function spendCapCacheKey(organizationId: string | null): string | null {
  return organizationId ? `spend-caps:${organizationId}` : null;
}

export async function fetchSpendCap(): Promise<SpendCapResponse | null> {
  const res = await fetch("/api/analytics/spend-cap");
  return res.ok ? ((await res.json()) as SpendCapResponse) : null;
}

export function toSpendCaps(data: SpendCapResponse | null): SpendCap[] {
  return [
    {
      cap: data?.dailyCapWei ?? null,
      decimals: EVM_DECIMALS,
      effectiveCap: data?.effectiveDailyCapWei ?? null,
      id: "evm",
      label: "EVM networks",
      symbol: "ETH",
      usingDefault: data?.usingDefaultDailyCap ?? false,
      used: data?.dailyUsedWei ?? "0",
    },
    {
      cap: data?.dailySolanaCapLamports ?? null,
      decimals: SOLANA_DECIMALS,
      effectiveCap: data?.effectiveDailySolanaCapLamports ?? null,
      id: "solana",
      label: "Solana",
      symbol: "SOL",
      usingDefault: data?.usingDefaultDailySolanaCap ?? false,
      used: data?.dailySolanaUsedLamports ?? "0",
    },
  ];
}

/** Base units to a short decimal string, e.g. wei to "0.024". */
export function formatCapAmount(base: string, decimals: number): string {
  try {
    const value = BigInt(base);
    const unit = BigInt(10) ** BigInt(decimals);
    const whole = value / unit;
    const frac = (value % unit).toString().padStart(decimals, "0").slice(0, 6);
    return `${whole}.${frac}`.replace(TRAILING_ZEROS, "") || "0";
  } catch {
    return "0";
  }
}
