const FEED_ID = /^(?:0x)?[a-fA-F0-9]{64}$/;
const DECIMAL = /^-?(?:0|[1-9]\d{0,37})(?:\.\d{1,18})?$/;
const INTEGER = /^-?(?:0|[1-9]\d{0,19})$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d{0,19})$/;
const AGE_INTEGER = /^\d+$/;
const HEX_PREFIX = /^0x/;

export type PythTriggerConfig = {
  feedId: string;
  direction: "above" | "below";
  threshold: string;
  rearmThreshold: string;
  maxAgeSeconds: number;
};

export type PythPriceUpdate = {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
};

export type PythCheckpoint = {
  lastPublishTime: number | null;
  armed: boolean;
};

export type PythSignal = {
  source: "pyth-hermes";
  speculative: true;
  sourceUpdateId: string;
  feedId: string;
  price: string;
  confidence: string;
  exponent: number;
  publishTime: number;
  expiresAt: number;
  direction: "above" | "below";
  threshold: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimalParts(value: string): {
  coefficient: bigint;
  exponent: number;
} {
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole + fraction), exponent: -fraction.length };
}

/** Compare base-ten values without rounding either through a JS number. */
function compare(
  coefficient: bigint,
  exponent: number,
  decimal: string
): number {
  const other = decimalParts(decimal);
  const scale = Math.min(exponent, other.exponent);
  const left = coefficient * BigInt(10) ** BigInt(exponent - scale);
  const right =
    other.coefficient * BigInt(10) ** BigInt(other.exponent - scale);
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

export function parsePythTriggerConfig(value: unknown): PythTriggerConfig {
  if (!isRecord(value)) {
    throw new Error("Pyth Price requires a trigger configuration.");
  }
  const { feedId, direction, threshold, rearmThreshold } = value;
  if (typeof feedId !== "string" || !FEED_ID.test(feedId)) {
    throw new Error("Pyth feed ID must contain 64 hexadecimal characters.");
  }
  if (direction !== "above" && direction !== "below") {
    throw new Error("Pyth direction must be above or below.");
  }
  if (typeof threshold !== "string" || !DECIMAL.test(threshold)) {
    throw new Error(
      "Pyth threshold must be a decimal with up to 18 decimal places."
    );
  }
  if (typeof rearmThreshold !== "string" || !DECIMAL.test(rearmThreshold)) {
    throw new Error(
      "Pyth rearm threshold must be a decimal with up to 18 decimal places."
    );
  }
  const rearm = decimalParts(rearmThreshold);
  const order = compare(rearm.coefficient, rearm.exponent, threshold);
  if (
    (direction === "above" && order >= 0) ||
    (direction === "below" && order <= 0)
  ) {
    throw new Error(
      "Rearm threshold must be below an above trigger, or above a below trigger."
    );
  }
  const rawAge = value.maxAgeSeconds ?? 30;
  const maxAgeSeconds =
    typeof rawAge === "string" && AGE_INTEGER.test(rawAge)
      ? Number(rawAge)
      : rawAge;
  if (
    typeof maxAgeSeconds !== "number" ||
    !Number.isInteger(maxAgeSeconds) ||
    maxAgeSeconds < 5 ||
    maxAgeSeconds > 300
  ) {
    throw new Error("Maximum price age must be between 5 and 300 seconds.");
  }
  return {
    feedId: feedId.replace(HEX_PREFIX, "").toLowerCase(),
    direction,
    threshold,
    rearmThreshold,
    maxAgeSeconds,
  };
}

export function parsePythPriceUpdate(value: unknown): PythPriceUpdate {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !FEED_ID.test(value.id) ||
    !isRecord(value.price)
  ) {
    throw new Error("Invalid Pyth price update.");
  }
  const { price, conf, expo, publish_time: publishTime } = value.price;
  if (
    typeof price !== "string" ||
    !INTEGER.test(price) ||
    typeof conf !== "string" ||
    !UNSIGNED_INTEGER.test(conf) ||
    typeof expo !== "number" ||
    !Number.isInteger(expo) ||
    Math.abs(expo) > 38 ||
    typeof publishTime !== "number" ||
    !Number.isSafeInteger(publishTime) ||
    publishTime <= 0
  ) {
    throw new Error("Invalid Pyth price fields.");
  }
  return {
    id: value.id.replace(HEX_PREFIX, "").toLowerCase(),
    price: { price, conf, expo, publish_time: publishTime },
  };
}

export type PythEvaluation = {
  checkpoint: PythCheckpoint;
  outcome:
    | "baseline"
    | "observed"
    | "crossed"
    | "stale"
    | "future"
    | "out_of_order"
    | "wrong_feed";
  signal?: PythSignal;
};

export function evaluatePythPrice(
  config: PythTriggerConfig,
  checkpoint: PythCheckpoint,
  update: PythPriceUpdate,
  nowSeconds: number,
  resetBaseline = false
): PythEvaluation {
  const { price, conf, expo, publish_time: publishTime } = update.price;
  if (update.id !== config.feedId) {
    return { checkpoint, outcome: "wrong_feed" };
  }
  if (publishTime > nowSeconds + 5) {
    return { checkpoint, outcome: "future" };
  }
  if (nowSeconds >= publishTime + config.maxAgeSeconds) {
    return { checkpoint, outcome: "stale" };
  }
  // The first accepted observation for a publish_time wins. Same-second
  // revisions and reconnect replays cannot manufacture another crossing.
  if (
    checkpoint.lastPublishTime !== null &&
    publishTime <= checkpoint.lastPublishTime
  ) {
    return { checkpoint, outcome: "out_of_order" };
  }
  const coefficient = BigInt(price);
  const rearmOrder = compare(coefficient, expo, config.rearmThreshold);
  const isRearmed =
    config.direction === "above" ? rearmOrder <= 0 : rearmOrder >= 0;
  const gap =
    checkpoint.lastPublishTime === null ||
    publishTime - checkpoint.lastPublishTime >= config.maxAgeSeconds;
  if (resetBaseline || gap) {
    const thresholdOrder = compare(coefficient, expo, config.threshold);
    const startsArmed =
      config.direction === "above" ? thresholdOrder < 0 : thresholdOrder > 0;
    return {
      checkpoint: { lastPublishTime: publishTime, armed: startsArmed },
      outcome: "baseline",
    };
  }
  const thresholdOrder = compare(coefficient, expo, config.threshold);
  const crossed =
    checkpoint.armed &&
    (config.direction === "above" ? thresholdOrder >= 0 : thresholdOrder <= 0);
  const next = {
    lastPublishTime: publishTime,
    armed: crossed ? false : checkpoint.armed || isRearmed,
  };
  if (!crossed) {
    return { checkpoint: next, outcome: "observed" };
  }
  return {
    checkpoint: next,
    outcome: "crossed",
    signal: {
      source: "pyth-hermes",
      speculative: true,
      sourceUpdateId: `pyth:${config.feedId}:${publishTime}`,
      feedId: config.feedId,
      price,
      confidence: conf,
      exponent: expo,
      publishTime,
      expiresAt: (publishTime + config.maxAgeSeconds) * 1000,
      direction: config.direction,
      threshold: config.threshold,
    },
  };
}
