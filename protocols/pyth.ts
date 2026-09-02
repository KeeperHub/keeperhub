import type { AbiFunctionOverride } from "@/lib/protocol-registry";
import { defineAbiProtocol } from "@/lib/protocol-registry";
import type { ProtocolTestData } from "@/lib/test-data/types";

// Standard Pyth EVM contract address across mainnet chains
const MAINNET_PYTH_ADDRESS = "0x4305FB66699C3B2702D4d05CF36551390A4c69C6";

// Canonical Pyth price feed IDs verified from catalogue
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
      "get-price": { id: ETH_USD_FEED },
      "get-price-no-older-than": { id: ETH_USD_FEED, age: "60" },
      "get-ema-price": { id: ETH_USD_FEED },
      "get-ema-price-no-older-than": { id: ETH_USD_FEED, age: "60" },
    },
    expectations: {
      "get-price": [{ field: "price", nonZero: true }],
      "get-ema-price": [{ field: "price", nonZero: true }],
    },
  },
};

const PYTH_ABI = JSON.stringify([
  {
    type: "function",
    name: "getPrice",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "price",
        type: "tuple",
        components: [
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint64" },
        ],
      },
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
      {
        name: "price",
        type: "tuple",
        components: [
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getEmaPrice",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "price",
        type: "tuple",
        components: [
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint64" },
        ],
      },
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
      {
        name: "price",
        type: "tuple",
        components: [
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint64" },
        ],
      },
    ],
  },
]);

const ORACLE_OVERRIDES: Record<string, AbiFunctionOverride> = {
  getPrice: {
    slug: "get-price",
    label: "Get Price",
    description:
      "Read the current price tuple for a Pyth price feed from the on-chain Pyth contract.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
  },
  getPriceNoOlderThan: {
    slug: "get-price-no-older-than",
    label: "Get Price No Older Than",
    description:
      "Read the current price tuple for a Pyth price feed from the on-chain Pyth contract, reverting if older than specified age.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
  },
  getEmaPrice: {
    slug: "get-ema-price",
    label: "Get EMA Price",
    description:
      "Read the current exponential moving average (EMA) price tuple from the on-chain Pyth contract.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
  },
  getEmaPriceNoOlderThan: {
    slug: "get-ema-price-no-older-than",
    label: "Get EMA Price No Older Than",
    description:
      "Read the current EMA price tuple from the on-chain Pyth contract, reverting if older than specified max age.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
  },
};

const CUSTOM_ORACLE_OVERRIDES: Record<string, AbiFunctionOverride> = {
  getPrice: {
    slug: "custom-get-price",
    label: "Get Price (Custom Oracle)",
    description:
      "Read current price tuple from a custom Pyth oracle contract address.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
  },
  getPriceNoOlderThan: {
    slug: "custom-get-price-no-older-than",
    label: "Get Price No Older Than (Custom Oracle)",
    description:
      "Read price tuple from a custom Pyth oracle contract address with max age assertion.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
  },
  getEmaPrice: {
    slug: "custom-get-ema-price",
    label: "Get EMA Price (Custom Oracle)",
    description:
      "Read EMA price tuple from a custom Pyth oracle contract address.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
  },
  getEmaPriceNoOlderThan: {
    slug: "custom-get-ema-price-no-older-than",
    label: "Get EMA Price No Older Than (Custom Oracle)",
    description:
      "Read EMA price tuple from a custom Pyth oracle contract address with max age assertion.",
    inputs: {
      id: { label: "Price Feed ID (bytes32 hex)" },
      age: { label: "Max Age (seconds)" },
    },
    outputs: {
      price: { name: "price", label: "Price (int64 raw)" },
      conf: { name: "conf", label: "Confidence Interval (uint64)" },
      expo: { name: "expo", label: "Exponent (int32)" },
      publishTime: {
        name: "publishTime",
        label: "Publish Time (Unix timestamp)",
      },
    },
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
      addresses: {
        "1": MAINNET_PYTH_ADDRESS,
        "8453": "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
        "42161": "0xff1a0f4744e8582DF1aE519577d3E054501020E0",
        "10": "0xff1a0f4744e8582DF1aE519577d3E054501020E0",
        "137": "0xff1a0f4744e8582DF1aE519577d3E054501020E0",
        "56": "0x4D7fDFB1B2BE541e487779930777B96eB70b8098",
        "43114": MAINNET_PYTH_ADDRESS,
        "11155111": "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21",
      },
      overrides: ORACLE_OVERRIDES,
    },
    customOracle: {
      label: "Custom Pyth Oracle",
      abi: PYTH_ABI,
      userSpecifiedAddress: true,
      addresses: {
        "1": MAINNET_PYTH_ADDRESS,
        "11155111": "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21",
      },
      overrides: CUSTOM_ORACLE_OVERRIDES,
    },
  },
});
