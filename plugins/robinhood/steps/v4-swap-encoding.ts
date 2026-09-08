import { ethers } from "ethers";

/**
 * Calldata encoding for a single-hop exact-input swap through the Universal
 * Router on Robinhood Chain.
 *
 * Every constant and every struct field below was read from the verified source
 * of the deployed router at 0x8876789976decbfcbbbe364623c63652db8c0904, not
 * from the Uniswap SDK or the public v4 documentation. That distinction is
 * load-bearing: this deployment's `ExactInputSingleParams` carries a
 * `minHopPriceX36` field that upstream v4-periphery does not have, sitting
 * between `amountOutMinimum` and `hookData`. Encoding against the canonical
 * struct produces calldata whose `hookData` offset is wrong, which the router
 * would decode as garbage rather than reject cleanly.
 *
 * Pure by design. No provider, no signer, no network. The riskiest part of a
 * fund-moving action is the part that is easiest to test in isolation, so it is
 * isolated.
 */

/** UniversalRouter Commands.V4_SWAP. */
const COMMAND_V4_SWAP = 0x10;

/** v4-periphery Actions, as deployed. */
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);

/** v4 pool identity. `currency0` must sort below `currency1`. */
export type PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

export type EncodeSwapArgs = {
  poolKey: PoolKey;
  /** The token being spent. Must be one of the pool's two currencies. */
  inputCurrency: string;
  amountIn: bigint;
  /** The floor the caller will accept. Enforced twice on-chain; see below. */
  minAmountOut: bigint;
  hookData?: string;
};

export type EncodedSwap = {
  commands: string;
  inputs: string[];
  /** Derived, not supplied: which direction the pool is being traded in. */
  zeroForOne: boolean;
  outputCurrency: string;
};

const coder = ethers.AbiCoder.defaultAbiCoder();

const EXACT_IN_SINGLE_TUPLE =
  "tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)";

function assertAddress(value: string, label: string): string {
  if (!ethers.isAddress(value)) {
    throw new Error(`${label} is not an address: ${value}`);
  }
  return ethers.getAddress(value);
}

/**
 * Build the `execute(bytes commands, bytes[] inputs, uint256 deadline)`
 * arguments for one exact-input swap.
 *
 * The action sequence is swap, then settle what is owed, then take what is
 * credited:
 *
 *   SWAP_EXACT_IN_SINGLE  performs the swap and reverts below amountOutMinimum
 *   SETTLE_ALL(in,  max)  pays the debt, reverting if it exceeds amountIn
 *   TAKE_ALL(out,   min)  collects the credit, reverting below minAmountOut
 *
 * The minimum is therefore enforced twice, by two different checks in the
 * router. That redundancy is deliberate and kept: this is the only thing
 * standing between a caller and a 95%-fee pool, of which this chain has many.
 */
export function encodeExactInSingleSwap(args: EncodeSwapArgs): EncodedSwap {
  const currency0 = assertAddress(args.poolKey.currency0, "currency0");
  const currency1 = assertAddress(args.poolKey.currency1, "currency1");
  const hooks = assertAddress(args.poolKey.hooks, "hooks");
  const inputCurrency = assertAddress(args.inputCurrency, "inputCurrency");

  // v4 identifies a pool by the hash of its key, and a key with unsorted
  // currencies hashes to a pool that does not exist. Rejecting here turns a
  // confusing on-chain revert into a clear message.
  if (BigInt(currency0) >= BigInt(currency1)) {
    throw new Error(
      "PoolKey currencies must be sorted: currency0 must be numerically below currency1"
    );
  }

  // Derived rather than trusted. A caller who passes the direction themselves
  // can invert it and sell what they meant to buy.
  let zeroForOne: boolean;
  if (inputCurrency === currency0) {
    zeroForOne = true;
  } else if (inputCurrency === currency1) {
    zeroForOne = false;
  } else {
    throw new Error(
      `inputCurrency ${inputCurrency} is not part of this pool (${currency0}, ${currency1})`
    );
  }
  const outputCurrency = zeroForOne ? currency1 : currency0;

  if (args.amountIn <= BigInt(0)) {
    throw new Error("amountIn must be positive");
  }
  if (args.minAmountOut <= BigInt(0)) {
    throw new Error(
      "minAmountOut must be positive: an unbounded swap on this chain can be filled at a 95 percent fee"
    );
  }
  if (args.amountIn > MAX_UINT128 || args.minAmountOut > MAX_UINT128) {
    throw new Error("amountIn and minAmountOut must fit in uint128");
  }

  const actions = ethers.concat([
    new Uint8Array([ACTION_SWAP_EXACT_IN_SINGLE]),
    new Uint8Array([ACTION_SETTLE_ALL]),
    new Uint8Array([ACTION_TAKE_ALL]),
  ]);

  const swapParams = coder.encode(
    [EXACT_IN_SINGLE_TUPLE],
    [
      [
        [currency0, currency1, args.poolKey.fee, args.poolKey.tickSpacing, hooks],
        zeroForOne,
        args.amountIn,
        args.minAmountOut,
        // Zero disables the per-hop price floor. This is a single hop and
        // amountOutMinimum already bounds the result.
        BigInt(0),
        args.hookData ?? "0x",
      ],
    ]
  );

  const settleParams = coder.encode(
    ["address", "uint256"],
    [inputCurrency, args.amountIn]
  );
  const takeParams = coder.encode(
    ["address", "uint256"],
    [outputCurrency, args.minAmountOut]
  );

  const v4Input = coder.encode(
    ["bytes", "bytes[]"],
    [actions, [swapParams, settleParams, takeParams]]
  );

  return {
    commands: ethers.hexlify(new Uint8Array([COMMAND_V4_SWAP])),
    inputs: [v4Input],
    zeroForOne,
    outputCurrency,
  };
}

export const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
] as const;
