import type { AbiFunctionOverride } from "@/lib/protocol-registry";
import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  type ActionInputBindings,
  contract,
  type OutputExpectation,
  type ProtocolTestData,
  wallet,
} from "@/lib/test-data/types";
import ccipBnmAbi from "./abis/ccip-bnm.json";
import ccipErc20Abi from "./abis/ccip-erc20.json";
import ccipRouterAbi from "./abis/ccip-router.json";

// The generic feed contract is userSpecifiedAddress; bind the canonical
// mainnet ETH/USD aggregator proxy (verified 2026-07-03 via eth_call).
const MAINNET_ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
// L2 ETH/USD aggregator proxies for the custom-feed read bindings; match
// the ethUsd contract addresses below (decimals 8, latestRoundData live,
// verified via eth_call against public Base/Arbitrum nodes 2026-07-09).
const BASE_ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const ARBITRUM_ETH_USD_FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";

// CCIP actions are skipped on the L2 read sweeps: the fee/send actions need
// a fully-formed EVM2AnyMessage struct and the token-surface reads need a
// provisioned bridge/fee token position, neither of which the read-only
// multi-chain sweep sets up.
const CCIP_L2_SKIPS: Record<string, string> = {
  "ccip-check-bridge-balance":
    "CCIP token surface not provisioned for the multi-chain read sweep",
  "ccip-check-bridge-allowance":
    "CCIP token surface not provisioned for the multi-chain read sweep",
  "ccip-check-fee-balance":
    "CCIP token surface not provisioned for the multi-chain read sweep",
  "ccip-check-fee-allowance":
    "CCIP token surface not provisioned for the multi-chain read sweep",
  "ccip-get-fee":
    "requires CCIP message struct with destination chain and encoded data",
  "ccip-send":
    "requires CCIP message struct, bridge token balance, and fee token balance",
  "ccip-bnm-drip":
    "CCIP-BnM test token is testnet only (Sepolia, Base Sepolia)",
  "ccip-approve-bridge-token": "write action requiring bridge token balance",
  "ccip-approve-fee-token": "write action requiring fee token balance",
  "get-round-data": "requires a valid historical round ID",
};

// L2 action bindings, identical to the mainnet set except the custom-feed
// reads bind the chain's own ETH/USD proxy. CCIP + historical-round actions
// carry the same bindings as mainnet but self-skip via CCIP_L2_SKIPS; the
// price-feed reads run.
function l2FeedActions(feed: string): Record<string, ActionInputBindings> {
  return {
    "eth-usd-latest-round-data": {},
    "eth-usd-decimals": {},
    "btc-usd-latest-round-data": {},
    "btc-usd-decimals": {},
    "link-usd-latest-round-data": {},
    "link-usd-decimals": {},
    "usdc-usd-latest-round-data": {},
    "usdc-usd-decimals": {},
    "dai-usd-latest-round-data": {},
    "dai-usd-decimals": {},
    "usdt-usd-latest-round-data": {},
    "usdt-usd-decimals": {},
    "link-eth-latest-round-data": {},
    "link-eth-decimals": {},
    "btc-eth-latest-round-data": {},
    "btc-eth-decimals": {},
    "latest-round-data": { contractAddress: feed },
    "latest-answer": { contractAddress: feed },
    decimals: { contractAddress: feed },
    description: { contractAddress: feed },
    version: { contractAddress: feed },
    "ccip-check-bridge-balance": { account: wallet() },
    "ccip-check-bridge-allowance": {
      owner: wallet(),
      spender: contract("ccipRouter"),
    },
    "ccip-check-fee-balance": { account: wallet() },
    "ccip-check-fee-allowance": {
      owner: wallet(),
      spender: contract("ccipRouter"),
    },
    "get-round-data": {},
    "ccip-get-fee": { receiver: wallet(), feeToken: wallet() },
    "ccip-send": { receiver: wallet(), feeToken: wallet() },
    "ccip-bnm-drip": { to: wallet() },
    "ccip-approve-bridge-token": { spender: contract("ccipRouter") },
    "ccip-approve-fee-token": { spender: contract("ccipRouter") },
  };
}

// Price-feed read oracles, parallel to l2FeedActions. Every feed's
// latest-round-data must decode a live, nonzero answer (the field is the
// named `answer` output of the AggregatorV3 tuple); the custom ETH/USD proxy
// adds latest-answer (nonzero), description (nonempty), and version (nonzero),
// whose outputs are unnamed so those assertions carry no field. decimals is
// deliberately not asserted: a feed's decimal count is a static config that
// varies per chain and feed (Base BTC/USD and USDC/USD report 18, not 8), so
// pinning it adds fragility for little signal - the nonzero answer is the real
// proof the feed decoded. btcEth/description are optional because some L2s
// lack those surfaces (see the per-chain skips).
function feedExpectations(opts: {
  btcEth: boolean;
  description: boolean;
}): Record<string, OutputExpectation[]> {
  const answer: OutputExpectation[] = [{ field: "answer", nonZero: true }];
  const e: Record<string, OutputExpectation[]> = {
    "eth-usd-latest-round-data": answer,
    "btc-usd-latest-round-data": answer,
    "link-usd-latest-round-data": answer,
    "usdc-usd-latest-round-data": answer,
    "dai-usd-latest-round-data": answer,
    "usdt-usd-latest-round-data": answer,
    "link-eth-latest-round-data": answer,
    "latest-round-data": answer,
    "latest-answer": [{ nonZero: true }],
    version: [{ nonZero: true }],
  };
  if (opts.btcEth) {
    e["btc-eth-latest-round-data"] = answer;
  }
  if (opts.description) {
    e.description = [{ notEmpty: true }];
  }
  return e;
}

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    expectations: feedExpectations({ btcEth: true, description: true }),
    actions: {
      "eth-usd-latest-round-data": {},
      "eth-usd-decimals": {},
      "btc-usd-latest-round-data": {},
      "btc-usd-decimals": {},
      "link-usd-latest-round-data": {},
      "link-usd-decimals": {},
      "usdc-usd-latest-round-data": {},
      "usdc-usd-decimals": {},
      "dai-usd-latest-round-data": {},
      "dai-usd-decimals": {},
      "usdt-usd-latest-round-data": {},
      "usdt-usd-decimals": {},
      "link-eth-latest-round-data": {},
      "link-eth-decimals": {},
      "btc-eth-latest-round-data": {},
      "btc-eth-decimals": {},
      "latest-round-data": { contractAddress: MAINNET_ETH_USD_FEED },
      "latest-answer": { contractAddress: MAINNET_ETH_USD_FEED },
      decimals: { contractAddress: MAINNET_ETH_USD_FEED },
      description: { contractAddress: MAINNET_ETH_USD_FEED },
      version: { contractAddress: MAINNET_ETH_USD_FEED },
      "ccip-check-bridge-balance": { account: wallet() },
      "ccip-check-bridge-allowance": {
        owner: wallet(),
        spender: contract("ccipRouter"),
      },
      "ccip-check-fee-balance": { account: wallet() },
      "ccip-check-fee-allowance": {
        owner: wallet(),
        spender: contract("ccipRouter"),
      },
      "get-round-data": {},
      "ccip-get-fee": { receiver: wallet(), feeToken: wallet() },
      "ccip-send": { receiver: wallet(), feeToken: wallet() },
      "ccip-bnm-drip": { to: wallet() },
      "ccip-approve-bridge-token": { spender: contract("ccipRouter") },
      "ccip-approve-fee-token": { spender: contract("ccipRouter") },
    },
    skipped: {
      "ccip-check-bridge-balance":
        "CCIP-BnM test token surface is testnet-only; no code at the bound address on mainnet",
      "ccip-check-bridge-allowance":
        "CCIP-BnM test token surface is testnet-only; no code at the bound address on mainnet",
      "ccip-check-fee-balance":
        "CCIP-BnM test token surface is testnet-only; no code at the bound address on mainnet",
      "ccip-check-fee-allowance":
        "CCIP-BnM test token surface is testnet-only; no code at the bound address on mainnet",
      "get-round-data": "requires a valid historical round ID",
      "ccip-get-fee":
        "requires CCIP message struct with destination chain and encoded data",
      "ccip-send":
        "requires CCIP message struct, bridge token balance, and fee token balance",
      "ccip-bnm-drip":
        "CCIP-BnM test token is testnet only (Sepolia, Base Sepolia)",
      "ccip-approve-bridge-token":
        "write action requiring bridge token balance",
      "ccip-approve-fee-token": "write action requiring fee token balance",
    },
  },
  // Base: Chainlink price-feed reads. Every named feed except BTC/ETH is
  // deployed on Base; CCIP + historical-round actions self-skip (see
  // CCIP_L2_SKIPS). Runs on an anvil Base fork in Tier 1 (gated on
  // PROTOCOL_SIM_RPC_8453).
  "8453": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    expectations: feedExpectations({ btcEth: false, description: true }),
    actions: l2FeedActions(BASE_ETH_USD_FEED),
    skipped: {
      "btc-eth-latest-round-data": "no Chainlink BTC/ETH feed deployed on Base",
      "btc-eth-decimals": "no Chainlink BTC/ETH feed deployed on Base",
      ...CCIP_L2_SKIPS,
    },
  },
  // Arbitrum One: same price-feed read sweep as Base, plus the BTC/ETH feed
  // (deployed on Arbitrum). Runs on an anvil Arbitrum fork in Tier 1 (gated
  // on PROTOCOL_SIM_RPC_42161).
  "42161": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    expectations: feedExpectations({ btcEth: true, description: false }),
    actions: l2FeedActions(ARBITRUM_ETH_USD_FEED),
    skipped: {
      // description() reverts on the anvil Arbitrum fork (the proxy's
      // dynamic-string read cold-fetches state the public upstream will
      // not serve at the pinned block; it works live and the fixed-size
      // reads on the same proxy pass). Not core price-feed coverage.
      description:
        "Arbitrum ETH/USD proxy description() reverts under fork cold-fetch",
      ...CCIP_L2_SKIPS,
    },
  },
};

// Minimal AggregatorV3Interface ABI used for named feed contracts.
// Inline because Arbitrum and Optimism lack Etherscan-compatible explorer configs.
const MINIMAL_FEED_ABI = JSON.stringify([
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
]);

// Full AggregatorV3Interface ABI used for the custom feed contract.
const AGGREGATOR_V3_ABI = JSON.stringify([
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "latestAnswer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "description",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

// EVMExtraArgsV1 with gasLimit=0 - for EOA token transfers where no
// ccipReceive callback runs on the destination. Setting gasLimit explicitly
// to 0 avoids CCIP charging a fee for the default 200k gas.
const EXTRA_ARGS_V1_GAS_LIMIT_ZERO =
  "0x97a657c90000000000000000000000000000000000000000000000000000000000000000";

// Shared CCIP message overrides for the flattened EVM2AnyMessage tuple.
// Used by both getFee and ccipSend since they share the same message struct.
// Exported so tests can import and validate docUrls directly.
export const CCIP_DOCS = "https://docs.chain.link/ccip";

export const CCIP_MESSAGE_INPUT_OVERRIDES = {
  destinationChainSelector: {
    label: "Destination Chain Selector",
    helpTip:
      "CCIP chain selector for the target network. This is not the same as chain ID - each CCIP lane has a unique selector.",
    docUrl: CCIP_DOCS,
  },
  receiver: {
    label: "Receiver Address",
    fieldType: "address" as const,
    helpTip:
      "The destination address that will receive the tokens and/or data. Enter a standard EVM address - it is automatically abi-encoded for the CCIP message.",
    docUrl: CCIP_DOCS,
  },
  data: {
    label: "Data Payload",
    default: "0x",
    advanced: true,
    helpTip:
      "Arbitrary bytes payload sent alongside tokens. Use 0x (empty) for token-only transfers. Only needed when sending instructions to a contract that implements ccipReceive on the destination chain.",
    docUrl: CCIP_DOCS,
  },
  tokenAmounts: {
    label: "Token Amounts",
    helpTip:
      "Tokens to bridge. Each entry specifies a token contract address and amount in the token's smallest unit (wei). Leave empty for data-only messages.",
    docUrl: CCIP_DOCS,
  },
  feeToken: {
    label: "Fee Token Address",
    helpTip:
      "Token used to pay CCIP fees. Use the LINK token address to pay in LINK, or 0x0000000000000000000000000000000000000000 to pay in native gas (sent as msg.value).",
    docUrl: CCIP_DOCS,
  },
  extraArgs: {
    label: "Extra Args",
    default: EXTRA_ARGS_V1_GAS_LIMIT_ZERO,
    advanced: true,
    helpTip:
      "Encoded execution options for the destination chain. Default sets gasLimit=0, which is correct for EOA token transfers. Increase gasLimit when the receiver is a contract that runs logic in ccipReceive.",
    docUrl: CCIP_DOCS,
  },
} as const;

// CCIP Router addresses (mainnet + testnet)
const CCIP_ROUTER_ADDRESSES: Record<string, string> = {
  "1": "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D",
  "8453": "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD",
  "42161": "0x141fa059441E0ca23ce184B6A78bafD2A517DdE8",
  "56": "0x34B03Cb9086d7D758AC55af71584F81A598759FE",
  "137": "0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe",
  "43114": "0xF4c7E640EdA248ef95972845a62bdC74237805dB",
  "11155111": "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
  "84532": "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
  "97": "0xE1053aE1857476f36A3C62580FF9b016E8EE8F6f",
  "80002": "0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2",
  "421614": "0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165",
  "43113": "0xF694E193200268f9a4868e4Aa017A0118C9a8177",
};

// ERC-20 reference addresses for CCIP token interactions.
// Runtime address comes from user input (userSpecifiedAddress: true).
const CCIP_ERC20_ADDRESSES: Record<string, string> = {
  "1": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "8453": "0x4200000000000000000000000000000000000006",
  "42161": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  "56": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  "137": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  "43114": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  "11155111": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
  "84532": "0x88A2d74F47a237a62e7A51cdDa67270CE381555e",
  "97": "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
  "80002": "0x0000000000000000000000000000000000001010",
  "421614": "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
  "43113": "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
};

// Per-feed overrides: unique slugs per contract to avoid collisions when named
// feed contracts share the same ABI (auto-derived slug would be "latest-round-data"
// and "decimals" for all, causing duplicate-slug errors in defineAbiProtocol).
function feedOverrides(
  feedSlug: string,
  feedLabel: string
): Record<string, AbiFunctionOverride> {
  return {
    latestRoundData: {
      slug: `${feedSlug}-latest-round-data`,
      label: `Get ${feedLabel} Latest Round Data`,
      description: `Get the latest price, round ID, and timestamps from the Chainlink ${feedLabel} feed`,
      outputs: {
        roundId: { label: "Round ID" },
        answer: { label: "Price Answer" },
        startedAt: { label: "Round Started At (Unix)" },
        updatedAt: { label: "Last Updated At (Unix)" },
        answeredInRound: { label: "Answered In Round" },
      },
    },
    decimals: {
      slug: `${feedSlug}-decimals`,
      label: `Get ${feedLabel} Decimals`,
      description: `Get the number of decimals used by the Chainlink ${feedLabel} feed`,
      outputs: {
        result: { name: "decimals", label: "Decimals" },
      },
    },
  };
}

export default defineAbiProtocol({
  name: "Chainlink",
  slug: "chainlink",
  description:
    "Chainlink oracle price feeds and CCIP cross-chain messaging - read prices via AggregatorV3Interface, bridge tokens and data via CCIP Router",
  website: "https://chain.link",
  icon: "/protocols/chainlink.png",

  testData: TEST_DATA,

  contracts: {
    // -- CCIP contracts --------------------------------------------------------

    ccipRouter: {
      label: "CCIP Router",
      abi: JSON.stringify(ccipRouterAbi),
      addresses: CCIP_ROUTER_ADDRESSES,
      overrides: {
        getFee: {
          slug: "ccip-get-fee",
          label: "CCIP Get Fee",
          description:
            "Quote the LINK (or native) fee for a CCIP cross-chain message before sending",
          inputs: { ...CCIP_MESSAGE_INPUT_OVERRIDES },
          outputs: {
            fee: { label: "Fee Amount (wei)" },
          },
        },
        ccipSend: {
          slug: "ccip-send",
          label: "CCIP Send",
          description:
            "Send a cross-chain message (token transfer and/or arbitrary data) via Chainlink CCIP",
          inputs: { ...CCIP_MESSAGE_INPUT_OVERRIDES },
          outputs: {
            messageId: { label: "CCIP Message ID" },
          },
        },
      },
    },

    ccipBnM: {
      label: "CCIP-BnM Test Token",
      userSpecifiedAddress: true,
      abi: JSON.stringify(ccipBnmAbi),
      addresses: {
        "11155111": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
        "84532": "0x88A2d74F47a237a62e7A51cdDa67270CE381555e",
      },
      overrides: {
        drip: {
          slug: "ccip-bnm-drip",
          label: "CCIP-BnM Drip (Testnet)",
          description:
            "Mint 1 CCIP-BnM test token to an address. Testnet only - this token is used for exercising CCIP bridging on Sepolia/Base Sepolia.",
          inputs: {
            to: {
              label: "Recipient Address",
              helpTip:
                "Address to receive the minted CCIP-BnM test tokens. Typically your own wallet for testing.",
              docUrl: CCIP_DOCS,
            },
          },
        },
      },
    },

    ccipBridgeToken: {
      label: "Bridge Token (ERC-20 for CCIP)",
      userSpecifiedAddress: true,
      abi: JSON.stringify(ccipErc20Abi),
      addresses: CCIP_ERC20_ADDRESSES,
      overrides: {
        approve: {
          slug: "ccip-approve-bridge-token",
          label: "CCIP Approve Bridge Token",
          description:
            "Approve the CCIP Router to spend the token you are bridging. Required before ccipSend.",
          inputs: {
            spender: {
              label: "Spender (CCIP Router)",
              helpTip:
                "The CCIP Router address for your source chain. Must match the router used in the ccipSend step.",
              docUrl: CCIP_DOCS,
            },
            amount: {
              label: "Amount (wei)",
              helpTip:
                "Amount to approve in the token's smallest unit. Must be >= the amount you intend to bridge.",
              docUrl: CCIP_DOCS,
            },
          },
        },
        balanceOf: {
          slug: "ccip-check-bridge-balance",
          label: "CCIP Check Bridge Token Balance",
          description:
            "Check the balance of the token being bridged. Use before ccipSend to catch insufficient bridge token balances early.",
          inputs: {
            account: {
              label: "Account Address",
              helpTip:
                "The address whose bridge token balance to check. Typically the wallet that will call ccipSend.",
              docUrl: CCIP_DOCS,
            },
          },
          outputs: {
            result: { name: "balance", label: "Token Balance (wei)" },
          },
        },
        allowance: {
          slug: "ccip-check-bridge-allowance",
          label: "CCIP Check Bridge Token Allowance",
          description:
            "Check how much of the bridge token the CCIP Router is approved to spend. Use to verify the approve-bridge-token step succeeded.",
          inputs: {
            owner: {
              label: "Token Owner",
              helpTip:
                "The address that granted the approval. Typically your wallet address.",
              docUrl: CCIP_DOCS,
            },
            spender: {
              label: "Spender (CCIP Router)",
              helpTip:
                "The CCIP Router address to check allowance for. Must match the router on your source chain.",
              docUrl: CCIP_DOCS,
            },
          },
          outputs: {
            result: { name: "allowance", label: "Approved Amount (wei)" },
          },
        },
      },
    },

    ccipFeeToken: {
      label: "Fee Token (ERC-20 for CCIP)",
      userSpecifiedAddress: true,
      abi: JSON.stringify(ccipErc20Abi),
      addresses: CCIP_ERC20_ADDRESSES,
      overrides: {
        approve: {
          slug: "ccip-approve-fee-token",
          label: "CCIP Approve Fee Token",
          description:
            "Approve the CCIP Router to spend LINK (or another fee token) for bridge fees. Required before ccipSend when paying fees in ERC-20.",
          inputs: {
            spender: {
              label: "Spender (CCIP Router)",
              helpTip:
                "The CCIP Router address for your source chain. Must match the router used in the ccipSend step.",
              docUrl: CCIP_DOCS,
            },
            amount: {
              label: "Amount (wei)",
              helpTip:
                "Fee ceiling to approve in the fee token's smallest unit. Set higher than the expected fee to avoid reverts (e.g. 1 LINK = 1000000000000000000). Unused allowance is not spent.",
              docUrl: CCIP_DOCS,
            },
          },
        },
        balanceOf: {
          slug: "ccip-check-fee-balance",
          label: "CCIP Check Fee Token Balance",
          description:
            "Check the balance of the fee token (LINK or native wrapper). Use before ccipSend to catch insufficient fee token balances early.",
          inputs: {
            account: {
              label: "Account Address",
              helpTip:
                "The address whose fee token balance to check. Typically the wallet that will call ccipSend.",
              docUrl: CCIP_DOCS,
            },
          },
          outputs: {
            result: { name: "balance", label: "Token Balance (wei)" },
          },
        },
        allowance: {
          slug: "ccip-check-fee-allowance",
          label: "CCIP Check Fee Token Allowance",
          description:
            "Check how much of the fee token (LINK) the CCIP Router is approved to spend. Use to verify the approve-fee-token step succeeded.",
          inputs: {
            owner: {
              label: "Token Owner",
              helpTip:
                "The address that granted the approval. Typically your wallet address.",
              docUrl: CCIP_DOCS,
            },
            spender: {
              label: "Spender (CCIP Router)",
              helpTip:
                "The CCIP Router address to check allowance for. Must match the router on your source chain.",
              docUrl: CCIP_DOCS,
            },
          },
          outputs: {
            result: { name: "allowance", label: "Approved Amount (wei)" },
          },
        },
      },
    },

    // -- Price feed contracts --------------------------------------------------
    // Named feeds expose only latestRoundData + decimals (minimal ABI to avoid
    // duplicate slug collisions when multiple contracts share the same ABI).
    // Per-feed slug overrides give each contract its own unique action slugs.

    ethUsd: {
      label: "ETH/USD Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
        "8453": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
        "42161": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
        "10": "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
        "11155111": "0x694AA1769357215DE4FAC081bf1f309aDC325306",
      },
      overrides: feedOverrides("eth-usd", "ETH/USD"),
    },
    btcUsd: {
      label: "BTC/USD Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
        "8453": "0x03Df23A32C83cA8cD9B1aAC0aF1c72924af7502b",
        "42161": "0x06047dD6f43552831BB51319917DC0C99c29A44c",
        "10": "0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593",
        "11155111": "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43",
      },
      overrides: feedOverrides("btc-usd", "BTC/USD"),
    },
    linkUsd: {
      label: "LINK/USD Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c",
        "8453": "0x17CAb8FE31E32f08326e5E27412894e49B0f9D65",
        "42161": "0x3EAbF62EB761BD86c71d07AdBb1A9183FeC24064",
        "10": "0xCc232dcFAAE6354cE191Bd574108c1aD03f86450",
      },
      overrides: feedOverrides("link-usd", "LINK/USD"),
    },
    usdcUsd: {
      label: "USDC/USD Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
        "8453": "0x1401Fd60F9ba4F718a2fE6149aadf3d1F0dB1b0A",
        "42161": "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3",
        "10": "0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3",
      },
      overrides: feedOverrides("usdc-usd", "USDC/USD"),
    },
    daiUsd: {
      label: "DAI/USD Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
        "8453": "0x591e79239a7d679378eC8c847e5038150364C78F",
        "42161": "0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB",
        "10": "0x8dBa75e83DA73cc766A7e5a0ee71F656BAb470d6",
      },
      overrides: feedOverrides("dai-usd", "DAI/USD"),
    },
    usdtUsd: {
      label: "USDT/USD Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
        "8453": "0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9",
        "42161": "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7",
        "10": "0xECef79E109e997bCA29c1c0897ec9d7b03647F5E",
      },
      overrides: feedOverrides("usdt-usd", "USDT/USD"),
    },
    linkEth: {
      label: "LINK/ETH Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0xDC530D9457755926550b59e8ECcdaE7624181557",
        "8453": "0xc5E65227fe3385B88468F9A01600017cDC9F3A12",
        "42161": "0xb7c8Fb1dB45007F98A68Da0588e1AA524C317f27",
        "10": "0x464A1515ADc20de946f8d0DEB99cead8CEAE310d",
      },
      overrides: feedOverrides("link-eth", "LINK/ETH"),
    },
    btcEth: {
      label: "BTC/ETH Price Feed",
      abi: MINIMAL_FEED_ABI,
      addresses: {
        "1": "0xdeb288F737066589598e9214E782fa5A8eD689e8",
        "42161": "0xc5a90A6d7e4Af242dA238FFe279e9f2BA0c64B2e",
      },
      overrides: feedOverrides("btc-eth", "BTC/ETH"),
    },

    // Custom feed exposes the full 6-function AggregatorV3Interface. The user
    // supplies any AggregatorV3-compatible address via the address config field.
    customFeed: {
      label: "Custom Price Feed (AggregatorV3Interface)",
      userSpecifiedAddress: true,
      abi: AGGREGATOR_V3_ABI,
      addresses: {
        "1": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
        "8453": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
        "42161": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
        "10": "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
        "11155111": "0x694AA1769357215DE4FAC081bf1f309aDC325306",
      },
      overrides: {
        latestRoundData: {
          label: "Get Latest Round Data (Custom Feed)",
          description:
            "Get the latest price, round ID, and timestamps from any Chainlink price feed",
          outputs: {
            roundId: { label: "Round ID" },
            answer: { label: "Price Answer" },
            startedAt: { label: "Round Started At (Unix)" },
            updatedAt: { label: "Last Updated At (Unix)" },
            answeredInRound: { label: "Answered In Round" },
          },
        },
        getRoundData: {
          slug: "get-round-data",
          label: "Get Round Data (Custom Feed)",
          description:
            "Get the price and timestamps for a specific historical round from any Chainlink price feed",
          inputs: {
            _roundId: { label: "Round ID" },
          },
          outputs: {
            roundId: { label: "Round ID" },
            answer: { label: "Price Answer" },
            startedAt: { label: "Round Started At (Unix)" },
            updatedAt: { label: "Last Updated At (Unix)" },
            answeredInRound: { label: "Answered In Round" },
          },
        },
        latestAnswer: {
          slug: "latest-answer",
          label: "Get Latest Answer (Custom Feed)",
          description:
            "Get the latest price answer from any Chainlink price feed (raw integer, divide by 10^decimals for human-readable value)",
          outputs: {
            result: { name: "answer", label: "Latest Price Answer" },
          },
        },
        decimals: {
          label: "Get Decimals (Custom Feed)",
          description:
            "Get the number of decimals used by a Chainlink price feed (typically 8 for USD pairs, 18 for ETH pairs)",
          outputs: {
            result: { name: "decimals", label: "Decimals" },
          },
        },
        description: {
          label: "Get Description (Custom Feed)",
          description:
            "Get the human-readable description of any Chainlink price feed (e.g. ETH / USD)",
          outputs: {
            result: { name: "description", label: "Feed Description" },
          },
        },
        version: {
          label: "Get Version (Custom Feed)",
          description:
            "Get the version number of any Chainlink price feed aggregator contract",
          outputs: {
            result: { name: "version", label: "Aggregator Version" },
          },
        },
      },
    },
  },
});
