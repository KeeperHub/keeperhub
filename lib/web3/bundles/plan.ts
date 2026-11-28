import { ethers } from "ethers";

/** Why a target block gets no bundle. */
type SkipReason =
  | "simulation-failed"
  | "target-passed"
  | "max-fee-below-projected-base-fee";

export type SkippedTarget = { block: number; reason: SkipReason };

/** One block the bundle is sent for, with the tip its transaction pays. */
export type PlannedTarget = { block: number; tip: bigint };

const HUNDRED = BigInt(100);
// EIP-1559 lets the base fee rise at most 1/8 per block.
const BASE_FEE_GROWTH_NUM = BigInt(9);
const BASE_FEE_GROWTH_DEN = BigInt(8);
const ELASTICITY = BigInt(2);
const CHANGE_DENOMINATOR = BigInt(8);

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

/**
 * The tip for the k-th target (1 = the first target): the first tip raised by
 * `increasePercent` per block, compounded and rounded up, held to the tip limit and the fee cap.
 */
function tipForTarget(
  firstTip: bigint,
  maxFee: bigint,
  increasePercent: number,
  k: number,
  tipLimit: bigint | undefined
): bigint {
  const tip = plannedTip(firstTip, increasePercent, k, tipLimit);
  return tip < maxFee ? tip : maxFee;
}

function raisedTip(
  firstTip: bigint,
  increasePercent: number,
  k: number
): bigint {
  const steps = BigInt(k - 1);
  const factor = BigInt(100 + increasePercent);
  return ceilDiv(firstTip * factor ** steps, HUNDRED ** steps);
}

// A raised tip stops at the chain's tip limit, never below the first tip.
function plannedTip(
  firstTip: bigint,
  increasePercent: number,
  k: number,
  tipLimit: bigint | undefined
): bigint {
  const tip = raisedTip(firstTip, increasePercent, k);
  if (tipLimit === undefined) {
    return tip;
  }
  const limit = tipLimit > firstTip ? tipLimit : firstTip;
  return tip < limit ? tip : limit;
}

/**
 * The fee cap the planned tips need: room for the base fee (the estimate's, or
 * the last target's projected base fee if higher) plus the highest tip planned.
 * The caller holds it to Max Fee or MAX_FEE_GWEI.
 */
export function maxFeeForTips(options: {
  estimatedMaxFee: bigint;
  firstTip: bigint;
  increasePercent: number;
  latest: number;
  blocks: readonly number[];
  tipLimit?: bigint;
  // The latest block; its base fee bounds the targets' (planTips skips by the same bound).
  parent?: ParentBlock | null;
  // The block that gets the plain first tip; default latest + 1.
  firstTarget?: number;
}): bigint {
  const { estimatedMaxFee, firstTip } = options;
  const firstTarget = options.firstTarget ?? options.latest + 1;
  const lastBlock = Math.max(firstTarget, ...options.blocks);
  // The base fee is projected from latest; the tip rises from the first target.
  const lastK = lastBlock - options.latest;
  const lastTipIndex = Math.max(1, lastBlock - firstTarget + 1);
  // The estimate's Max Fee counts the tip once (base-fee room + tip).
  const headroom =
    estimatedMaxFee > firstTip ? estimatedMaxFee - firstTip : BigInt(0);
  const projected = options.parent
    ? projectedBaseFee(nextBaseFee(options.parent), lastK - 1)
    : BigInt(0);
  return (
    (projected > headroom ? projected : headroom) +
    plannedTip(
      firstTip,
      options.increasePercent,
      lastTipIndex,
      options.tipLimit
    )
  );
}

/** The highest base fee `blocksAhead` blocks after one with `baseFee`. */
function projectedBaseFee(baseFee: bigint, blocksAhead: number): bigint {
  const steps = BigInt(blocksAhead);
  return ceilDiv(
    baseFee * BASE_FEE_GROWTH_NUM ** steps,
    BASE_FEE_GROWTH_DEN ** steps
  );
}

/** The header fields the next block's base fee follows from. */
type ParentBlock = {
  baseFee: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
};

/** The exact EIP-1559 base fee of the block after `parent`. */
function nextBaseFee(parent: ParentBlock): bigint {
  const target = parent.gasLimit / ELASTICITY;
  if (target === BigInt(0) || parent.gasUsed === target) {
    return parent.baseFee;
  }
  if (parent.gasUsed > target) {
    const delta =
      (parent.baseFee * (parent.gasUsed - target)) /
      target /
      CHANGE_DENOMINATOR;
    return parent.baseFee + (delta > BigInt(1) ? delta : BigInt(1));
  }
  return (
    parent.baseFee -
    (parent.baseFee * (target - parent.gasUsed)) / target / CHANGE_DENOMINATOR
  );
}

/**
 * Tips for the targets that passed simulation, raised per block from the first
 * target. Block latest + 1's base fee is exact; later ones are the most it can
 * reach. A target whose base fee could exceed Max Fee is skipped.
 */
export function planTips(options: {
  latest: number;
  parent: ParentBlock | null;
  firstTip: bigint;
  maxFee: bigint;
  increasePercent: number;
  blocks: readonly number[];
  // The chain's tip limit; later tips stop there (the first tip is kept).
  tipLimit?: bigint;
  // The block that gets the plain first tip; default latest + 1.
  firstTarget?: number;
}): {
  targets: PlannedTarget[];
  skipped: SkippedTarget[];
  // The lowest base fee a fee-skipped target may reach, for the refusal text.
  lowestSkippedBaseFee?: bigint;
} {
  const targets: PlannedTarget[] = [];
  const skipped: SkippedTarget[] = [];
  let lowestSkippedBaseFee: bigint | undefined;
  const next = options.parent && nextBaseFee(options.parent);
  const firstTarget = options.firstTarget ?? options.latest + 1;
  for (const block of options.blocks) {
    const k = block - options.latest;
    const tipIndex = Math.max(1, block - firstTarget + 1);
    const baseFee = next === null ? undefined : projectedBaseFee(next, k - 1);
    if (baseFee !== undefined && options.maxFee < baseFee) {
      skipped.push({ block, reason: "max-fee-below-projected-base-fee" });
      if (
        lowestSkippedBaseFee === undefined ||
        baseFee < lowestSkippedBaseFee
      ) {
        lowestSkippedBaseFee = baseFee;
      }
      continue;
    }
    targets.push({
      block,
      tip: tipForTarget(
        options.firstTip,
        options.maxFee,
        options.increasePercent,
        tipIndex,
        options.tipLimit
      ),
    });
  }
  return {
    targets,
    skipped,
    ...(lowestSkippedBaseFee !== undefined && { lowestSkippedBaseFee }),
  };
}

/** A tip as decimal gwei, for outputs ("1.44", "2"). */
export function toGwei(wei: bigint): string {
  const text = ethers.formatUnits(wei, "gwei");
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** A block as the first-allowed-block math reads it. */
export type BlockStamp = { number: number; timestamp: number };

/**
 * The first block number that cannot have a timestamp before `notBefore`: every
 * block is at least `gapSeconds` after its parent, so block N's time is at least
 * base.timestamp + gapSeconds x (N - base.number). Never before base + 1.
 */
export function firstAllowedBlock(
  notBefore: number,
  base: BlockStamp,
  gapSeconds: number
): number {
  const ahead = Math.ceil((notBefore - base.timestamp) / gapSeconds);
  return base.number + Math.max(1, ahead);
}

/** What a step with Not before does at a block: wait, or send for `targets`. */
export type SendAheadPlan =
  | { kind: "waiting"; firstAllowedBlock: number }
  | { kind: "send"; firstAllowedBlock: number; targets: number[] };

/**
 * U is counted from the latest block's parent, so a reorg of the head alone
 * cannot move it early. Sends when U is at most latest + 1 + `sendAheadBlocks`;
 * targets start at the later of U and latest + 1.
 */
export function planSendAhead(options: {
  notBefore: number;
  latest: number;
  parent: BlockStamp;
  gapSeconds: number;
  sendAheadBlocks: number;
  blocks: number;
}): SendAheadPlan {
  const allowed = firstAllowedBlock(
    options.notBefore,
    options.parent,
    options.gapSeconds
  );
  if (allowed > options.latest + 1 + options.sendAheadBlocks) {
    return { kind: "waiting", firstAllowedBlock: allowed };
  }
  const first = Math.max(allowed, options.latest + 1);
  return {
    kind: "send",
    firstAllowedBlock: allowed,
    targets: Array.from({ length: options.blocks }, (_, i) => first + i),
  };
}
