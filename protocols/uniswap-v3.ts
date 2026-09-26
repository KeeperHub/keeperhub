import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  amount,
  native,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";
import factoryAbi from "./abis/uniswap-factory.json";
import positionManagerAbi from "./abis/uniswap-position-manager.json";
import quoterAbi from "./abis/uniswap-quoter.json";
import swapRouterAbi from "./abis/uniswap-swap-router.json";

const POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const DEAD = "0x000000000000000000000000000000000000dEaD";
// Two fully-cleared V3 positions (liquidity 0, tokensOwed 0), verified burnable
// on the mainnet fork 2026-07-13. Setup impersonates each current owner and
// transfers the NFT to the test wallet: #50000 drives approve + transfer-away,
// #100000 is burned. They rot only if someone burns them upstream (refresh
// with another empty position then).
const EMPTY_POS_APPROVE = "50000";
const EMPTY_POS_APPROVE_OWNER = "0x0ac48977074E7355E09809C80e4f411D446d063c";
const EMPTY_POS_BURN = "100000";
const EMPTY_POS_BURN_OWNER = "0xa8eBe1eeD676d5BfEB7F7B5933625281489aF8A3";
// A live, in-range USDC/WETH 0.05% position for the liquidity writes, kept
// separate from #1 so the get-position read expectation never moves. Verified
// at mainnet block 25981008: ticks [190140, 205200] around a pool tick of
// 198094, an EOA owner, fees accrued on both tokens, and a 1e13 liquidity
// decrease returning both tokens. Setup transfers it to the test wallet like
// the empty positions above; it rots only if its owner withdraws the liquidity
// upstream (refresh with another in-range position then).
const LIQUID_POS = "180205";
const LIQUID_POS_OWNER = "0x6d64492e2b90f25F8Db3033942560377E166AB99";
// Far enough ahead (2100-01-01) that a fork's clock never passes it.
const FAR_DEADLINE = "4102444800";
// uint128 max: the value Uniswap's own interface passes to collect everything.
const UINT128_MAX = "340282366920938463463374607431768211455";
const ERC721_TRANSFER_FROM_ABI = JSON.stringify([
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
]);

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      // USDC from the mainnet whale + a fabricated SwapRouter02 approval fund
      // both swaps (USDC -> WETH). USDC and WETH approvals to the position
      // manager fund increase-liquidity on LIQUID_POS.
      requiredTokens: [
        { symbol: "USDC", human: "2000" },
        { symbol: "WETH", human: "0.1" },
      ],
      approvals: [],
      fabricatedApprovals: [
        {
          token: "USDC",
          spender: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
          human: "2000",
        },
        { token: "USDC", spender: POSITION_MANAGER, human: "100" },
        { token: "WETH", spender: POSITION_MANAGER, human: "0.05" },
      ],
      // Provision the owned position NFTs the position writes need by
      // impersonating their current holders and transferring them in.
      forkImpersonatedCalls: [
        {
          impersonate: EMPTY_POS_APPROVE_OWNER,
          contract: POSITION_MANAGER,
          abi: ERC721_TRANSFER_FROM_ABI,
          functionName: "transferFrom",
          args: [EMPTY_POS_APPROVE_OWNER, wallet(), EMPTY_POS_APPROVE],
        },
        {
          impersonate: EMPTY_POS_BURN_OWNER,
          contract: POSITION_MANAGER,
          abi: ERC721_TRANSFER_FROM_ABI,
          functionName: "transferFrom",
          args: [EMPTY_POS_BURN_OWNER, wallet(), EMPTY_POS_BURN],
        },
        {
          impersonate: LIQUID_POS_OWNER,
          contract: POSITION_MANAGER,
          abi: ERC721_TRANSFER_FROM_ABI,
          functionName: "transferFrom",
          args: [LIQUID_POS_OWNER, wallet(), LIQUID_POS],
        },
      ],
    },
    actions: {
      "get-pool": { tokenA: "WETH", tokenB: "USDC", fee: "3000" },
      "balance-of": { owner: wallet() },
      "quote-exact-input": {
        tokenIn: "WETH",
        tokenOut: "USDC",
        amountIn: native("1"),
        fee: "3000",
        sqrtPriceLimitX96: "0",
      },
      "quote-exact-output": {
        tokenIn: "USDC",
        tokenOut: "WETH",
        amount: native("1"),
        fee: "3000",
        sqrtPriceLimitX96: "0",
      },
      "get-position": { tokenId: "1" },
      "owner-of": { tokenId: "1" },
      "approve-position": { to: DEAD, tokenId: EMPTY_POS_APPROVE },
      "transfer-position": {
        from: wallet(),
        to: DEAD,
        tokenId: EMPTY_POS_APPROVE,
      },
      "burn-position": { tokenId: EMPTY_POS_BURN },
      "decrease-liquidity": {
        tokenId: LIQUID_POS,
        liquidity: "10000000000000",
        amount0Min: "0",
        amount1Min: "0",
        deadline: FAR_DEADLINE,
      },
      "collect-fees": {
        tokenId: LIQUID_POS,
        recipient: wallet(),
        amount0Max: UINT128_MAX,
        amount1Max: UINT128_MAX,
      },
      "increase-liquidity": {
        tokenId: LIQUID_POS,
        amount0Desired: amount("USDC", "100"),
        amount1Desired: amount("WETH", "0.05"),
        amount0Min: "0",
        amount1Min: "0",
        deadline: FAR_DEADLINE,
      },
      "swap-exact-input": {
        tokenIn: "USDC",
        tokenOut: "WETH",
        fee: "3000",
        recipient: wallet(),
        amountIn: amount("USDC", "100"),
        amountOutMinimum: "0",
        sqrtPriceLimitX96: "0",
      },
      "swap-exact-output": {
        tokenIn: "USDC",
        tokenOut: "WETH",
        fee: "3000",
        recipient: wallet(),
        amountOut: native("0.01"),
        amountInMaximum: amount("USDC", "1000"),
        sqrtPriceLimitX96: "0",
      },
    },
    skipped: {},
    // The read-only position reads bind Uniswap V3 position #1 - the genesis
    // NonfungiblePositionManager mint (UNI/WETH 0.3%, live since 2021),
    // verified on the mainnet fork 2026-07-13. get-position returns the
    // position struct (named outputs) with nonzero liquidity; owner-of returns
    // its owner. The position writes need the test wallet to own a position,
    // which the harness cannot mint (no mint action), so setup transfers the
    // positions in: the empty ones for approve/transfer/burn, LIQUID_POS for
    // decrease-liquidity, collect-fees and increase-liquidity.
    expectations: {
      "get-position": [{ field: "liquidity", nonZero: true }],
      "owner-of": [{ notEmpty: true }],
    },
  },
};

const UNISWAP_DOCS =
  "https://developers.uniswap.org/docs/protocols/v3/overview";

const FEE_TIER_TIP =
  "Pool fee tier in hundredths of a basis point. Common values: 100 (0.01% - stablecoin pairs), 500 (0.05% - correlated pairs), 3000 (0.3% - most pairs), 10000 (1% - exotic pairs).";

const SQRT_PRICE_LIMIT_TIP =
  "Square-root price limit encoded as a Q64.96 fixed-point number. Constrains how far the pool price can move during the swap. Set to 0 for no limit (most common). Non-zero values act as a slippage guard at the pool level.";

const TOKEN_IN_TIP =
  "ERC20 contract address of the token you are spending. To swap native ETH directly, set this to the chain's WETH address and provide the swap amount via the 'ETH Value' field below - SwapRouter02 will wrap msg.value internally and no token approval is needed. For ERC20 input, the SwapRouter02 must have an approval for at least the input amount before this action runs.";

const POSITION_TOKEN_ID_TIP =
  "The NFT token ID representing a Uniswap V3 liquidity position. Each position minted via the NonfungiblePositionManager receives a unique uint256 ID. Find it from the Mint event or via the balanceOf + tokenOfOwnerByIndex pattern.";

const COLLECT_MAX_TIP =
  "Upper bound on how much of this token to withdraw, in its smallest unit. The default (2^128 - 1) collects everything the position is owed. Get Position Details' Tokens Owed fields only update when a position is touched, so they leave out fees earned since - do not use them to decide whether there is anything to collect.";

const DECREASE_LIQUIDITY_TIP =
  "How much of the position's liquidity to remove, in liquidity units - read the current total from Get Position Details' Liquidity output. The removed tokens are credited to the position, not sent anywhere: follow this step with Collect Fees to withdraw them. Removing all liquidity and collecting is what makes a position burnable.";

const MIN_AMOUNT_TIP =
  "Slippage guard: the transaction reverts if less than this amount of the token would be removed or added. Set to 0 only for testing - in production, derive it from a recent price so the step cannot be filled at a manipulated rate.";

const COLLECT_RECIPIENT_TIP =
  "Where the collected tokens go - normally the wallet that owns the position. It must not be the zero address: Uniswap reads that as the position manager itself, and anyone can then sweep the tokens out of it. The action refuses the zero address for that reason.";

const DEADLINE_TIP =
  "Absolute unix timestamp (seconds) after which the transaction reverts - not a duration. It exists to bound how long a signed transaction stays fillable: a deadline far in the future removes the only protection against one sitting pending and being mined later at a moved price. There is no relative-time helper yet, so a literal timestamp in a scheduled workflow eventually passes and every later run reverts with 'Transaction too old'. Prefer a short deadline that you refresh, and treat those reverts as the cost of the protection, rather than a distant timestamp that disables it.";

const INCREASE_AMOUNT_TIP =
  "The most of this token to add, in its smallest unit. The pool takes both tokens in the position's current price ratio, so usually only one of the two amounts is used in full. The position manager needs an allowance for both tokens before this step runs - use Approve Token. Use WETH, not native ETH.";

// increaseLiquidity is the only position function without isAuthorizedForToken
// (Uniswap v3-periphery NonfungiblePositionManager: decreaseLiquidity, collect
// and burn all carry it). A wrong id therefore does not revert here - it funds
// a stranger's position and reports success. The step reads the owner first
// where it can, but that read fails open (see lib/protocol-input-guards-
// onchain.ts), so the tip must not promise a check the user can rely on.
const INCREASE_TOKEN_ID_TIP =
  "The NFT token ID of the position to add liquidity to. Unlike the other position actions, Uniswap performs no ownership check on this one: a wrong ID deposits your tokens into someone else's position, succeeds, and cannot be undone. This action reads the position's owner first and refuses an ID your wallet does not own, but that read is skipped when the owner cannot be fetched, so verify the ID yourself against Get Position Details rather than relying on either the check or a revert.";

// Two deliberate divergences from upstream mutability in this file.
//
// QuoterV2: upstream the quote functions are `nonpayable` (they use a revert-
// as-return idiom: pool.swap is invoked inside try/catch and the simulated
// amounts are decoded from the revert data), but every client invokes them
// via eth_call. Marking them `view` here classifies the action as a read
// step (no credentials, no gas, no transaction). Solidity's mutability model
// cannot express "off-chain simulation"; this is the cleanest place to bridge
// that gap until AbiFunctionOverride supports a stateMutability override.
//
// NonfungiblePositionManager burn / collect / decreaseLiquidity /
// increaseLiquidity: upstream they are `payable` only so they can be batched
// inside `multicall` alongside a WETH wrap or `refundETH`. Called directly, as
// these actions do, any ETH sent stays in the position manager, and its public
// `refundETH()` pays the whole balance to whoever calls it next. A `payable`
// ABI would show an ETH Value field whose every non-zero use hands that ETH to
// a stranger, so all four are declared `nonpayable` here. Mutability does not
// enter the selector or the encoding; the calldata is identical. `burn` was
// payable before this change and carried the same hazard.

export default defineAbiProtocol({
  name: "Uniswap V3",
  slug: "uniswap",
  description:
    "Uniswap V3 - pool discovery, liquidity positions, swaps, and quotes",
  website: "https://uniswap.org",
  icon: "/protocols/uniswap.png",

  testData: TEST_DATA,

  contracts: {
    factory: {
      label: "Uniswap V3 Factory",
      abi: JSON.stringify(factoryAbi),
      addresses: {
        "1": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "8453": "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        "42161": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "10": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "11155111": "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
      },
      overrides: {
        getPool: {
          slug: "get-pool",
          label: "Get Pool Address",
          description:
            "Find the Uniswap V3 pool address for a token pair and fee tier",
          inputs: {
            tokenA: { label: "Token A Address" },
            tokenB: { label: "Token B Address" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            pool: { label: "Pool Address" },
          },
        },
      },
    },
    positionManager: {
      label: "NonfungiblePositionManager",
      abi: JSON.stringify(positionManagerAbi),
      addresses: {
        "1": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
        "8453": "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
        "42161": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
        "10": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
        "11155111": "0x1238536071E1c677A632429e3655c799b22cDA52",
      },
      overrides: {
        positions: {
          slug: "get-position",
          label: "Get Position Details",
          description:
            "Get full details of a liquidity position by NFT token ID",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            nonce: { label: "Nonce" },
            operator: { label: "Operator Address" },
            token0: { label: "Token 0 Address" },
            token1: { label: "Token 1 Address" },
            fee: { label: "Fee Tier" },
            tickLower: { label: "Lower Tick" },
            tickUpper: { label: "Upper Tick" },
            liquidity: { label: "Liquidity" },
            feeGrowthInside0LastX128: { label: "Fee Growth Inside 0 (X128)" },
            feeGrowthInside1LastX128: { label: "Fee Growth Inside 1 (X128)" },
            tokensOwed0: { label: "Tokens Owed 0" },
            tokensOwed1: { label: "Tokens Owed 1" },
          },
        },
        balanceOf: {
          slug: "balance-of",
          label: "Get Position Count",
          description: "Check how many LP position NFTs an address owns",
          inputs: {
            owner: { label: "Wallet Address" },
          },
          outputs: {
            result: { name: "balance", label: "Position Count" },
          },
        },
        ownerOf: {
          slug: "owner-of",
          label: "Get Position Owner",
          description: "Get the owner address of a liquidity position NFT",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            result: { name: "owner", label: "Owner Address" },
          },
        },
        approve: {
          slug: "approve-position",
          label: "Approve Position Transfer",
          description:
            "Approve an address to manage a specific liquidity position NFT",
          inputs: {
            to: { label: "Approved Address" },
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
        },
        transferFrom: {
          slug: "transfer-position",
          label: "Transfer Position NFT",
          description: "Transfer a liquidity position NFT to another address",
          inputs: {
            from: { label: "From Address" },
            to: { label: "To Address" },
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
        },
        burn: {
          slug: "burn-position",
          label: "Burn Empty Position",
          description:
            "Burn an empty liquidity position NFT (position must have zero liquidity and zero owed tokens)",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
        },
        collect: {
          slug: "collect-fees",
          label: "Collect Fees",
          description:
            "Withdraw a position's earned fees, plus any tokens a Decrease Liquidity step credited to it, to a recipient",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
            recipient: {
              label: "Recipient Address",
              helpTip: COLLECT_RECIPIENT_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount0Max: {
              label: "Max Token 0 Amount (wei)",
              default: UINT128_MAX,
              helpTip: COLLECT_MAX_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount1Max: {
              label: "Max Token 1 Amount (wei)",
              default: UINT128_MAX,
              helpTip: COLLECT_MAX_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amount0: { label: "Token 0 Collected (wei)" },
            amount1: { label: "Token 1 Collected (wei)" },
          },
        },
        decreaseLiquidity: {
          slug: "decrease-liquidity",
          label: "Decrease Liquidity",
          description:
            "Remove liquidity from a position. The tokens stay credited to the position until a Collect Fees step withdraws them",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: POSITION_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
            liquidity: {
              label: "Liquidity to Remove",
              helpTip: DECREASE_LIQUIDITY_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount0Min: {
              label: "Minimum Token 0 Out (wei)",
              helpTip: MIN_AMOUNT_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount1Min: {
              label: "Minimum Token 1 Out (wei)",
              helpTip: MIN_AMOUNT_TIP,
              docUrl: UNISWAP_DOCS,
            },
            deadline: {
              label: "Deadline (unix timestamp)",
              helpTip: DEADLINE_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amount0: { label: "Token 0 Credited (wei)" },
            amount1: { label: "Token 1 Credited (wei)" },
          },
        },
        increaseLiquidity: {
          slug: "increase-liquidity",
          label: "Increase Liquidity",
          description:
            "Add liquidity to an existing position, for example to compound collected fees back in",
          inputs: {
            tokenId: {
              label: "Position Token ID",
              helpTip: INCREASE_TOKEN_ID_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount0Desired: {
              label: "Token 0 Amount to Add (wei)",
              helpTip: INCREASE_AMOUNT_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount1Desired: {
              label: "Token 1 Amount to Add (wei)",
              helpTip: INCREASE_AMOUNT_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount0Min: {
              label: "Minimum Token 0 Added (wei)",
              helpTip: MIN_AMOUNT_TIP,
              docUrl: UNISWAP_DOCS,
            },
            amount1Min: {
              label: "Minimum Token 1 Added (wei)",
              helpTip: MIN_AMOUNT_TIP,
              docUrl: UNISWAP_DOCS,
            },
            deadline: {
              label: "Deadline (unix timestamp)",
              helpTip: DEADLINE_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            liquidity: { label: "Liquidity Added" },
            amount0: { label: "Token 0 Added (wei)" },
            amount1: { label: "Token 1 Added (wei)" },
          },
        },
      },
    },
    swapRouter: {
      label: "SwapRouter02",
      abi: JSON.stringify(swapRouterAbi),
      addresses: {
        "1": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        "8453": "0x2626664c2603336E57B271c5C0b26F421741e481",
        "42161": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        "10": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        "11155111": "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
      },
      overrides: {
        exactInputSingle: {
          slug: "swap-exact-input",
          label: "Swap Exact Input",
          description:
            "Swap an exact amount of input tokens for as many output tokens as possible (single-hop)",
          inputs: {
            tokenIn: {
              label: "Input Token Address",
              helpTip: TOKEN_IN_TIP,
              docUrl: UNISWAP_DOCS,
            },
            tokenOut: { label: "Output Token Address" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            recipient: { label: "Recipient Address" },
            amountIn: { label: "Amount In (wei)" },
            amountOutMinimum: {
              label: "Minimum Output Amount (wei)",
              helpTip:
                "Minimum tokens to receive after the swap. The transaction reverts if the output would be less. Set to 0 only for testing - in production, calculate from a quote minus your slippage tolerance to avoid sandwich attacks.",
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountOut: { label: "Amount Out (wei)" },
          },
        },
        exactOutputSingle: {
          slug: "swap-exact-output",
          label: "Swap Exact Output",
          description:
            "Swap as few input tokens as possible for an exact amount of output tokens (single-hop)",
          inputs: {
            tokenIn: {
              label: "Input Token Address",
              helpTip: TOKEN_IN_TIP,
              docUrl: UNISWAP_DOCS,
            },
            tokenOut: { label: "Output Token Address" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            recipient: { label: "Recipient Address" },
            amountOut: { label: "Desired Output Amount (wei)" },
            amountInMaximum: {
              label: "Maximum Input Amount (wei)",
              helpTip:
                "Maximum tokens you are willing to spend. The transaction reverts if the required input exceeds this. Calculate from a quote plus your slippage tolerance.",
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountIn: { label: "Amount In (wei)" },
          },
        },
      },
    },
    quoter: {
      label: "QuoterV2",
      abi: JSON.stringify(quoterAbi),
      addresses: {
        "1": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        "8453": "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        "42161": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        "10": "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        "11155111": "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
      },
      overrides: {
        quoteExactInputSingle: {
          slug: "quote-exact-input",
          label: "Quote Exact Input",
          description:
            "Get the expected output amount for a single-hop exact-input swap",
          inputs: {
            tokenIn: { label: "Input Token Address" },
            tokenOut: { label: "Output Token Address" },
            amountIn: { label: "Amount In (wei)" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountOut: { label: "Amount Out (wei)" },
            sqrtPriceX96After: { label: "Price After Swap" },
            initializedTicksCrossed: { label: "Ticks Crossed" },
            gasEstimate: { label: "Gas Estimate" },
          },
        },
        quoteExactOutputSingle: {
          slug: "quote-exact-output",
          label: "Quote Exact Output",
          description:
            "Get the required input amount for a single-hop exact-output swap",
          inputs: {
            tokenIn: { label: "Input Token Address" },
            tokenOut: { label: "Output Token Address" },
            amount: { label: "Desired Output Amount (wei)" },
            fee: {
              label: "Fee Tier (100, 500, 3000, or 10000)",
              helpTip: FEE_TIER_TIP,
              docUrl: UNISWAP_DOCS,
            },
            sqrtPriceLimitX96: {
              label: "Price Limit (0 for none)",
              default: "0",
              helpTip: SQRT_PRICE_LIMIT_TIP,
              docUrl: UNISWAP_DOCS,
            },
          },
          outputs: {
            amountIn: { label: "Amount In (wei)" },
            sqrtPriceX96After: { label: "Price After Swap" },
            initializedTicksCrossed: { label: "Ticks Crossed" },
            gasEstimate: { label: "Gas Estimate" },
          },
        },
      },
    },
  },
});
