// What the editor's bundle box says about its tips; safe in the browser.
import { MAX_FEE_GWEI } from "@/lib/web3/gas-defaults";

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** A plain decimal number, not a template or empty text. */
function plainNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return typeof value === "string" && DECIMAL_RE.test(value.trim())
    ? Number(value.trim())
    : undefined;
}

function gwei(value: number): string {
  return String(Number(value.toFixed(2)));
}

function listed(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// Display only: the step computes tips in wei, rounded up, so the last digit can differ.
export function bundleTipsText(input: {
  blocks: number;
  increasePercent: number;
  priorityFeeGwei: unknown;
  maxFeeGwei: unknown;
  // The network's tip limit; undefined while the network is not known.
  tipLimitGwei?: number;
  // With Not before set, the first tip goes to the first allowed block.
  fromFirstAllowed?: boolean;
}): string {
  const counted = input.fromFirstAllowed
    ? ", counted from the first allowed block"
    : "";
  const first = plainNumber(input.priorityFeeGwei);
  const cap = plainNumber(input.maxFeeGwei);
  const limit = input.tipLimitGwei;
  // A Priority Fee above the limit is kept, so later tips do not rise from it.
  const limitRule =
    limit !== undefined && first !== undefined && first > limit
      ? `Later tips stay at your Priority Fee, which is above the network's tip limit (${gwei(limit)} gwei on this network).`
      : `Later tips stop at the network's tip limit${limit === undefined ? "" : ` (${gwei(limit)} gwei on this network)`}.`;
  const capNote =
    cap === undefined
      ? ""
      : ` A tip is paid only up to what the ${gwei(cap)} gwei Max Fee leaves above the base fee.`;
  const ceiling =
    cap === undefined
      ? `${MAX_FEE_GWEI.toLocaleString("en-US")} gwei`
      : "Max Fee";
  // The raise is named for rising tips; a flat tip raises the cap only past a base-fee spike.
  const rules =
    input.increasePercent === 0
      ? capNote
      : ` ${limitRule} The step raises its fee cap to pay them, up to ${ceiling}, and the wallet must hold Gas Limit x that cap.${capNote}`;
  if (first === undefined || first <= 0) {
    if (input.increasePercent === 0) {
      return `Every block gets the same tip: Priority Fee in Advanced, or the network's default.${rules}`;
    }
    const growth = (1 + input.increasePercent / 100) ** (input.blocks - 1);
    const last =
      input.blocks > 1
        ? `, so the last block's tip is up to ${gwei(growth)}x the first`
        : "";
    return `Each later block's tip is ${input.increasePercent}% higher than the one before, starting from Priority Fee in Advanced (or the network's default)${counted}${last}.${rules}`;
  }
  // As the step plans them: later tips stop at the tip limit (never below the first), then the cap.
  const tipCeiling =
    limit === undefined ? Number.POSITIVE_INFINITY : Math.max(limit, first);
  const tips: string[] = [];
  for (let k = 0; k < input.blocks; k += 1) {
    const tip = Math.min(
      first * (1 + input.increasePercent / 100) ** k,
      tipCeiling
    );
    tips.push(gwei(Math.min(tip, cap ?? MAX_FEE_GWEI)));
  }
  return `Tips: ${listed(tips)} gwei, from Priority Fee in Advanced${counted}.${rules}`;
}
