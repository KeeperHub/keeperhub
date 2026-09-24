import {
  divideCeil,
  divideScaled,
  formatScaled,
  parseDecimal,
  pow10,
  rescale,
  type Decimal,
} from "./decimal-core";

const ZERO = BigInt(0);
const SECONDS_PER_DAY = BigInt(86_400);

export const RUNWAY_DECIMAL_PLACES = 6;

export const RATE_PERIOD_SECONDS = {
  second: BigInt(1),
  minute: BigInt(60),
  hour: BigInt(3_600),
  day: SECONDS_PER_DAY,
  week: BigInt(604_800),
  month: BigInt(2_592_000),
  year: BigInt(31_536_000),
} as const;

export type RatePeriod = keyof typeof RATE_PERIOD_SECONDS;
export type TreasuryStatus = "safe" | "warning" | "critical";

export type TreasuryRunwayCoreInput = {
  treasuryBalance: string;
  incomingRate: string;
  outgoingRate: string;
  protectedReserve: string;
  minimumRunwayDays: string;
  ratePeriod: string;
};

export type TreasuryRunwaySuccess = {
  success: true;
  reserveAdjustedBalance: string;
  reserveBreached: boolean;
  netBurnRate: string;
  runwayDays: string | null;
  requiredRecoveryAmount: string;
  status: TreasuryStatus;
  ratePeriod: RatePeriod;
};

function parseNonNegative(raw: string, fieldName: string): Decimal {
  const parsed = parseDecimal(raw, fieldName);
  if (parsed.value < ZERO) {
    throw new Error(`${fieldName} must not be negative.`);
  }
  return parsed;
}

function parsePositive(raw: string, fieldName: string): Decimal {
  const parsed = parseDecimal(raw, fieldName);
  if (parsed.value <= ZERO) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }
  return parsed;
}

function resolveRatePeriod(raw: string): RatePeriod {
  if (!Object.hasOwn(RATE_PERIOD_SECONDS, raw)) {
    throw new Error(
      "Rate period must be one of: second, minute, hour, day, week, month, year."
    );
  }
  return raw as RatePeriod;
}

function runwayDaysOf(
  reserveAdjustedBalance: bigint,
  netBurnRate: bigint,
  periodSeconds: bigint
): string {
  if (reserveAdjustedBalance <= ZERO) {
    return "0";
  }

  const scaledDays = divideScaled(
    reserveAdjustedBalance * periodSeconds,
    netBurnRate * SECONDS_PER_DAY,
    RUNWAY_DECIMAL_PLACES
  );

  return formatScaled(scaledDays, RUNWAY_DECIMAL_PLACES);
}

function requiredRecoveryOf(
  reserveAdjustedBalance: bigint,
  netBurnRate: bigint,
  minimumRunwayDays: Decimal,
  periodSeconds: bigint
): bigint {
  const minimumScale = pow10(minimumRunwayDays.decimals);
  const denominator = periodSeconds * minimumScale;
  const numerator =
    netBurnRate * minimumRunwayDays.value * SECONDS_PER_DAY -
    reserveAdjustedBalance * denominator;

  if (numerator <= ZERO) {
    return ZERO;
  }

  return divideCeil(numerator, denominator);
}

function statusOf(
  reserveAdjustedBalance: bigint,
  netBurnRate: bigint,
  requiredRecoveryAmount: bigint
): TreasuryStatus {
  if (netBurnRate <= ZERO || requiredRecoveryAmount === ZERO) {
    return "safe";
  }
  if (reserveAdjustedBalance <= ZERO) {
    return "critical";
  }
  return "warning";
}

export function calculateTreasuryRunway(
  input: TreasuryRunwayCoreInput
): TreasuryRunwaySuccess {
  const treasuryBalance = parseNonNegative(
    input.treasuryBalance,
    "Treasury balance"
  );
  const incomingRate = parseNonNegative(input.incomingRate, "Incoming rate");
  const outgoingRate = parseNonNegative(input.outgoingRate, "Outgoing rate");
  const protectedReserve = parseNonNegative(
    input.protectedReserve,
    "Protected reserve"
  );
  const minimumRunwayDays = parsePositive(
    input.minimumRunwayDays,
    "Minimum runway days"
  );
  const ratePeriod = resolveRatePeriod(input.ratePeriod);
  const periodSeconds = RATE_PERIOD_SECONDS[ratePeriod];

  const amountDecimals = Math.max(
    treasuryBalance.decimals,
    incomingRate.decimals,
    outgoingRate.decimals,
    protectedReserve.decimals
  );

  const balance = rescale(treasuryBalance, amountDecimals);
  const inflow = rescale(incomingRate, amountDecimals);
  const outflow = rescale(outgoingRate, amountDecimals);
  const reserve = rescale(protectedReserve, amountDecimals);

  const reserveAdjustedBalance = balance - reserve;
  const netBurnRate = outflow - inflow;
  const reserveBreached = reserveAdjustedBalance < ZERO;

  const runwayDays =
    netBurnRate > ZERO
      ? runwayDaysOf(reserveAdjustedBalance, netBurnRate, periodSeconds)
      : null;

  const requiredRecoveryAmount =
    netBurnRate > ZERO
      ? requiredRecoveryOf(
          reserveAdjustedBalance,
          netBurnRate,
          minimumRunwayDays,
          periodSeconds
        )
      : ZERO;

  return {
    success: true,
    reserveAdjustedBalance: formatScaled(
      reserveAdjustedBalance,
      amountDecimals
    ),
    reserveBreached,
    netBurnRate: formatScaled(netBurnRate, amountDecimals),
    runwayDays,
    requiredRecoveryAmount: formatScaled(
      requiredRecoveryAmount,
      amountDecimals
    ),
    status: statusOf(
      reserveAdjustedBalance,
      netBurnRate,
      requiredRecoveryAmount
    ),
    ratePeriod,
  };
}
