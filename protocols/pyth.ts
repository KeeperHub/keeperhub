import type { AbiFunctionOverride } from "@/lib/protocol-registry";
import { defineAbiProtocol } from "@/lib/protocol-registry";
import type { ProtocolTestData } from "@/lib/test-data/types";

// Verified EVM Pyth deployment addresses across chains (eth_getCode verified)
const PYTH_ADDRESSES: Record<string, string> = {
  "1": "0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
  "8453": "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
  "42161": "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
  "10": "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
  "137": "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
  "56": "0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594",
  "43114": "0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
  "11155111": "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21",
};

// Canonical Pyth price feed IDs verified from Pyth catalogue
const ETH_USD_FEED =
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      "get-price-unsafe": { id: ETH_USD_FEED },
      "get-ema-price-unsafe": { id: ETH_USD_FEED },
    },
    expectations: {
      "get-price-unsafe": [{ field: "price", nonZero: true }],
      "get-ema-price-unsafe": [{ field: "price", nonZero: true }],
    },
    skipped: {
      "get-price":
        "Pyth getPrice reverts StalePrice() unless a fresh price update payload was submitted in the same block",
      "get-price-no-older-than":
        "Pyth getPriceNoOlderThan reverts StalePrice() unless a fresh price update payload was submitted",
      "get-ema-price":
        "Pyth getEmaPrice reverts StalePrice() unless a fresh price update payload was submitted",
      "get-ema-price-no-older-than":
        "Pyth getEmaPriceNoOlderThan reverts StalePrice() unless a fresh price update payload was submitted",
      "custom-get-price":
        "Custom oracle userSpecifiedAddress contract is tested via build-workflow test runner",
      "custom-get-price-unsafe":
        "Custom oracle userSpecifiedAddress contract is tested via build-workflow test runner",
      "custom-get-price-no-older-than":
        "Custom oracle userSpecifiedAddress contract is tested via build-workflow test runner",
      "custom-get-ema-price":
        "Custom oracle userSpecifiedAddress contract is tested via build-workflow test runner",
      "custom-get-ema-price-unsafe":
        "Custom oracle userSpecifiedAddress contract is tested via build-workflow test runner",
      "custom-get-ema-price-no-older-than":
        "Custom oracle userSpecifiedAddress contract is tested via build-workflow test runner",
    },
  },
};

const PYTH_ABI = JSON.stringify([
  {
    type: "function",
    name: "getPriceUnsafe",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "price", type: "int64" },
      { name: "conf", type: "uint64" },
      { name: "expo", type: "int32" },
      { name: "publishTime", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "price", type: "int64" },
      { name: "conf", type: "uint64" },
      { name: "expo", type: "int32" },
      { name: "publishTime", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "getPriceNoOlderThan",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "age", type: "uint256" },
    ],
    outputs: [
      { name: "price", type: "int64" },
      { name: "conf", type: "uint64" },
      { name: "expo", type: "int32" },
      { name: "publishTime", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "getEmaPriceUnsafe",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "price", type: "int64" },
      { name: "conf", type: "uint64" },
      { name: "expo", type: "int32" },
      { name: "publishTime", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "getEmaPrice",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "price", type: "int64" },
      { name: "conf", type: "uint64" },
      { name: "expo", type: "int32" },
      { name: "publishTime", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "getEmaPriceNoOlderThan",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "age", type: "uint256" },
    ],
    outputs: [
      { name: "price", type: "int64" },
      { name: "conf", type: "uint64" },
      { name: "expo", type: "int32" },
      { name: "publishTime", type: "uint64" },
    ],
  },
]);

const OUTPUT_OVERRIDES = {
  price: { name: "price", label: "Price (int64 raw integer)" },
  conf: { name: "conf", label: "Confidence Interval (uint64)" },
  expo: { name: "expo", label: "Exponent (int32)" },
  publishTime: { name: "publishTime", label: "Publish Time (Unix timestamp)" },
};

const ORACLE_OVERRIDES: Record<string, AbiFunctionOverride> = {
  getPriceUnsafe: {
    slug: "get-price-unsafe",
    label: "Get Price (Unsafe)",
    description:
      "Read the latest on-chain price tuple from the Pyth contract without age-stale revert.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getPrice: {
    slug: "get-price",
    label: "Get Price",
    description:
      "Read the current price tuple for a Pyth price feed. Reverts with StalePrice() if not recently updated.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getPriceNoOlderThan: {
    slug: "get-price-no-older-than",
    label: "Get Price No Older Than",
    description:
      "Read the current price tuple for a Pyth price feed, reverting if older than specified max age.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getEmaPriceUnsafe: {
    slug: "get-ema-price-unsafe",
    label: "Get EMA Price (Unsafe)",
    description:
      "Read the latest on-chain EMA price tuple from Pyth contract without age-stale revert.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getEmaPrice: {
    slug: "get-ema-price",
    label: "Get EMA Price",
    description:
      "Read the current exponential moving average (EMA) price tuple from the on-chain Pyth contract.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getEmaPriceNoOlderThan: {
    slug: "get-ema-price-no-older-than",
    label: "Get EMA Price No Older Than",
    description:
      "Read the current EMA price tuple from the Pyth contract, reverting if older than max age.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
};

const CUSTOM_ORACLE_OVERRIDES: Record<string, AbiFunctionOverride> = {
  getPriceUnsafe: {
    slug: "custom-get-price-unsafe",
    label: "Get Price Unsafe (Custom Oracle)",
    description:
      "Read latest price tuple from a custom Pyth oracle address without age-stale revert.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getPrice: {
    slug: "custom-get-price",
    label: "Get Price (Custom Oracle)",
    description:
      "Read current price tuple from a custom Pyth oracle contract address.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getPriceNoOlderThan: {
    slug: "custom-get-price-no-older-than",
    label: "Get Price No Older Than (Custom Oracle)",
    description:
      "Read price tuple from a custom Pyth oracle address with max age assertion.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getEmaPriceUnsafe: {
    slug: "custom-get-ema-price-unsafe",
    label: "Get EMA Price Unsafe (Custom Oracle)",
    description:
      "Read latest EMA price tuple from a custom Pyth oracle address without age-stale revert.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getEmaPrice: {
    slug: "custom-get-ema-price",
    label: "Get EMA Price (Custom Oracle)",
    description:
      "Read EMA price tuple from a custom Pyth oracle contract address.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
  getEmaPriceNoOlderThan: {
    slug: "custom-get-ema-price-no-older-than",
    label: "Get EMA Price No Older Than (Custom Oracle)",
    description:
      "Read EMA price tuple from a custom Pyth oracle address with max age assertion.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: OUTPUT_OVERRIDES,
  },
};

export default defineAbiProtocol({
  name: "Pyth Network",
  slug: "pyth",
  description:
    "Pyth Network: cross-chain decentralized on-chain price oracle feeds",
  website: "https://pyth.network",
  icon: "/protocols/pyth.png",

  testData: TEST_DATA,

  contracts: {
    oracle: {
      label: "Pyth Oracle Contract",
      abi: PYTH_ABI,
      addresses: PYTH_ADDRESSES,
      overrides: ORACLE_OVERRIDES,
    },
    customOracle: {
      label: "Custom Pyth Oracle",
      abi: PYTH_ABI,
      userSpecifiedAddress: true,
      addresses: PYTH_ADDRESSES,
      overrides: CUSTOM_ORACLE_OVERRIDES,
    },
  },
});
