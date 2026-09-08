import type { AbiFunctionOverride } from "@/lib/protocol-registry";
import { defineAbiProtocol } from "@/lib/protocol-registry";
import {
  contract,
  type ProtocolTestData,
  type SetupSpec,
  wallet,
} from "@/lib/test-data/types";

// Mainnet Scribe feeds are toll-gated with no SelfKisser (mainnet does not
// allow self-kissing), so the fork provisioning impersonates an authed ward
// and kisses the test wallet. Verified 2026-07-07 on a mainnet fork: all
// four feeds share the same authed() wards, kiss(wallet) from this ward
// mines with status 1, tolled(wallet) flips true, and read()/readWithAge()
// then return live values. Chronicle also tolls address(0) on mainnet
// (bare eth_call reads with no `from` succeed), but the simulation tier
// reads with an explicit non-tolled `from`, so the kiss is load-bearing.
const MAINNET_WARD = "0x40C33e796be78148CeC983C2202335A0962d172A";

const KISS_ABI = JSON.stringify([
  {
    type: "function",
    name: "kiss",
    stateMutability: "nonpayable",
    inputs: [{ name: "who", type: "address" }],
    outputs: [],
  },
]);

type ForkCall = NonNullable<SetupSpec["forkImpersonatedCalls"]>[number];

function wardKiss(feedKey: string): ForkCall {
  return {
    impersonate: MAINNET_WARD,
    contract: contract(feedKey),
    abi: KISS_ABI,
    functionName: "kiss",
    args: [wallet()],
  };
}

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
      forkImpersonatedCalls: [
        wardKiss("ethUsd"),
        wardKiss("btcUsd"),
        wardKiss("usdcUsd"),
        wardKiss("usdtUsd"),
      ],
    },
    actions: {
      "eth-usd-read": {},
      "eth-usd-read-with-age": {},
      "btc-usd-read": {},
      "btc-usd-read-with-age": {},
      "usdc-usd-read": {},
      "usdc-usd-read-with-age": {},
      "usdt-usd-read": {},
      "usdt-usd-read-with-age": {},
      // customOracle is userSpecifiedAddress; point the generic reads at
      // the ETH/USD feed the fork provisioning kissed above.
      read: { contractAddress: contract("ethUsd") },
      "try-read": { contractAddress: contract("ethUsd") },
      "read-with-age": { contractAddress: contract("ethUsd") },
      "try-read-with-age": { contractAddress: contract("ethUsd") },
    },
    // Chain invariant: a live price feed never reports zero. Single
    // unnamed ABI output, so the expectation targets the bare result.
    expectations: {
      "eth-usd-read": [{ nonZero: true }],
      "btc-usd-read": [{ nonZero: true }],
      "usdc-usd-read": [{ nonZero: true }],
      "usdt-usd-read": [{ nonZero: true }],
      read: [{ nonZero: true }],
    },
    skipped: {
      "dai-usd-read":
        "no mainnet deployment: Chronicle publishes no DAI/USD feed on Ethereum",
      "dai-usd-read-with-age":
        "no mainnet deployment: Chronicle publishes no DAI/USD feed on Ethereum",
      "link-usd-read":
        "no mainnet deployment: Chronicle publishes no LINK/USD feed on Ethereum",
      "link-usd-read-with-age":
        "no mainnet deployment: Chronicle publishes no LINK/USD feed on Ethereum",
      "self-kiss":
        "SelfKisser is testnet-only; mainnet whitelisting is ward-gated (fork provisioning impersonates a ward)",
    },
  },
};

// Minimal oracle ABI used for named feed contracts (read + readWithAge only).
// tryRead/tryReadWithAge are omitted from named feeds; they are exposed on the
// custom-oracle contract where callers may not be whitelisted.
const FEED_ABI = JSON.stringify([
  {
    type: "function",
    name: "read",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "readWithAge",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
]);

// Full oracle ABI for the custom-address oracle contract.
const ORACLE_ABI = JSON.stringify([
  {
    type: "function",
    name: "read",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "tryRead",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "bool" },
      { name: "", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "readWithAge",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "tryReadWithAge",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "", type: "bool" },
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
]);

const SELF_KISSER_ABI = JSON.stringify([
  {
    type: "function",
    name: "selfKiss",
    stateMutability: "nonpayable",
    inputs: [{ name: "oracle", type: "address" }],
    outputs: [],
  },
]);

// Per-feed overrides: unique slugs per contract to avoid collisions when all
// feed contracts share the same ABI (auto-derived slug would be "read" for all).
function feedOverrides(
  feedSlug: string,
  feedLabel: string
): Record<string, AbiFunctionOverride> {
  return {
    read: {
      slug: `${feedSlug}-read`,
      label: `Read ${feedLabel} Value`,
      description: `Read the current ${feedLabel} price from the Chronicle oracle. Caller must be whitelisted (kissed).`,
      outputs: {
        result: { name: "value", label: "Oracle Value", decimals: 18 },
      },
    },
    readWithAge: {
      slug: `${feedSlug}-read-with-age`,
      label: `Read ${feedLabel} Value with Age`,
      description: `Read the current ${feedLabel} price and its last-updated timestamp from the Chronicle oracle.`,
      outputs: {
        result0: { name: "value", label: "Oracle Value", decimals: 18 },
        result1: { name: "age", label: "Last Updated (Unix timestamp)" },
      },
    },
  };
}

export default defineAbiProtocol({
  name: "Chronicle",
  slug: "chronicle",
  description:
    "Chronicle Protocol: decentralized, verifiable oracle price feeds with Schnorr signature verification",
  website: "https://chroniclelabs.org",
  icon: "/protocols/chronicle.png",

  testData: TEST_DATA,

  contracts: {
    ethUsd: {
      label: "ETH/USD Oracle",
      abi: FEED_ABI,
      addresses: {
        "1": "0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E",
        "11155111": "0xdd6D76262Fd7BdDe428dcfCd94386EbAe0151603",
      },
      overrides: feedOverrides("eth-usd", "ETH/USD"),
    },
    btcUsd: {
      label: "BTC/USD Oracle",
      abi: FEED_ABI,
      addresses: {
        "1": "0x24C392CDbF32Cf911B258981a66d5541d85269ce",
        "11155111": "0x6edF073c4Bd934d3916AA6dDAC4255ccB2b7c0f0",
      },
      overrides: feedOverrides("btc-usd", "BTC/USD"),
    },
    daiUsd: {
      label: "DAI/USD Oracle",
      abi: FEED_ABI,
      addresses: {
        // No mainnet deployment: DAI is a USD-pegged stablecoin (MakerDAO defines the peg),
        // so Chronicle does not publish a DAI/USD price feed on Ethereum mainnet.
        "11155111": "0xaf900d10f197762794C41dac395C5b8112eD13E1",
      },
      overrides: feedOverrides("dai-usd", "DAI/USD"),
    },
    usdcUsd: {
      label: "USDC/USD Oracle",
      abi: FEED_ABI,
      addresses: {
        "1": "0xCe701340261a3dc3541C5f8A6d2bE689381C8fCC",
        "11155111": "0xb34d784dc8E7cD240Fe1F318e282dFdD13C389AC",
      },
      overrides: feedOverrides("usdc-usd", "USDC/USD"),
    },
    usdtUsd: {
      label: "USDT/USD Oracle",
      abi: FEED_ABI,
      addresses: {
        "1": "0x7084a627a22b2de99E18733DC5aAF40993FA405C",
        "11155111": "0x8c852EEC6ae356FeDf5d7b824E254f7d94Ac6824",
      },
      overrides: feedOverrides("usdt-usd", "USDT/USD"),
    },
    linkUsd: {
      label: "LINK/USD Oracle",
      abi: FEED_ABI,
      addresses: {
        "11155111": "0x260c182f0054BF244a8e38d7C475b6d9f67AeAc1",
      },
      overrides: feedOverrides("link-usd", "LINK/USD"),
    },

    // User-provided oracle address -- exposes full 4-function interface
    customOracle: {
      label: "Custom Chronicle Oracle",
      abi: ORACLE_ABI,
      userSpecifiedAddress: true,
      // Reference address (ETH/USD) for chain-availability metadata.
      addresses: {
        "1": "0x46ef0071b1E2fF6B42d36e5A177EA43Ae5917f4E",
        "11155111": "0xdd6D76262Fd7BdDe428dcfCd94386EbAe0151603",
      },
      overrides: {
        read: {
          label: "Read Oracle Value (Custom)",
          description:
            "Read the current price value from any Chronicle oracle. Caller must be whitelisted (kissed).",
          outputs: {
            result: { name: "value", label: "Oracle Value", decimals: 18 },
          },
        },
        tryRead: {
          slug: "try-read",
          label: "Try Read Oracle Value (Custom)",
          description:
            "Attempt to read the current price value from any Chronicle oracle. Returns ok=false instead of reverting if not whitelisted.",
          outputs: {
            result0: { name: "ok", label: "Success" },
            result1: { name: "value", label: "Oracle Value", decimals: 18 },
          },
        },
        readWithAge: {
          slug: "read-with-age",
          label: "Read Oracle Value with Age (Custom)",
          description:
            "Read the current price value and its last-updated timestamp from any Chronicle oracle.",
          outputs: {
            result0: { name: "value", label: "Oracle Value", decimals: 18 },
            result1: { name: "age", label: "Last Updated (Unix timestamp)" },
          },
        },
        tryReadWithAge: {
          slug: "try-read-with-age",
          label: "Try Read Oracle Value with Age (Custom)",
          description:
            "Attempt to read the current price value and last-updated timestamp from any Chronicle oracle. Returns ok=false instead of reverting.",
          outputs: {
            result0: { name: "ok", label: "Success" },
            result1: { name: "value", label: "Oracle Value", decimals: 18 },
            result2: { name: "age", label: "Last Updated (Unix timestamp)" },
          },
        },
      },
    },

    selfKisser: {
      label: "SelfKisser",
      abi: SELF_KISSER_ABI,
      addresses: {
        // Testnets and Gnosis only; mainnet does not allow self-kissing
        "11155111": "0x9eE458DefDc50409DbF153515DA54Ff5B744e533",
        "84532": "0x7D62Def8478c21B82aA7fcbc2E7f8B404Ac6c565",
        "421614": "0x4BAe02bED4b49DE3344878b0B0B2d6A58D47ddC5",
        "100": "0xE24c5cd952193eDA44BE71c19b35a9CB83cd1E24",
      },
      overrides: {
        selfKiss: {
          slug: "self-kiss",
          label: "Whitelist on Oracle (Self)",
          description:
            "Whitelist the caller (msg.sender) on a Chronicle oracle using the SelfKisser contract. Only available on supported testnets.",
          inputs: {
            oracle: { label: "Oracle Contract Address" },
          },
        },
      },
    },
  },
});
