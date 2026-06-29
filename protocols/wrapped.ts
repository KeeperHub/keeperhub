import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";
import wethAbi from "./abis/weth.json";

const WRAPPED_DOCS = "https://ethereum.org/en/wrapped-eth/";

// Mainnet fork smoke test: wrap deposits 0.01 ETH, unwrap burns half.
// No ERC20 prefunding needed (WETH is acquired by wrapping native).
// Setup is a no-op: the TS preflight provisions native gas via anvil_setBalance.
export const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.1",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      // deposit() is payable with no calldata inputs; ethValue sets msg.value.
      wrap: { ethValue: "0.01" },
      // withdraw(wad uint256): burn 0.005 WETH and receive 0.005 ETH.
      unwrap: { wad: "5000000000000000" },
      // balanceOf: input is renamed to "account" via override, so binding key is "account".
      "balance-of": { account: wallet() },
    },
  },
};

export default defineAbiProtocol({
  name: "Wrapped",
  slug: "wrapped",
  description:
    "Wrap a chain's native token into its wrapped ERC-20 form and unwrap back to the native token",
  website: "https://weth.io",
  icon: "/protocols/weth.png",
  testData: TEST_DATA,

  contracts: {
    weth: {
      label: "Wrapped Native Contract",
      abi: JSON.stringify(wethAbi),
      addresses: {
        "1": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "8453": "0x4200000000000000000000000000000000000006",
        "42161": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        "11155111": "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
        "84532": "0x4200000000000000000000000000000000000006",
        "421614": "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
        "56": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        "97": "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
        "137": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        "43114": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
        "43113": "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
      },
      overrides: {
        deposit: {
          slug: "wrap",
          label: "Wrap Native Token",
          description:
            "Wrap the chain's native token into its wrapped ERC-20 form. Send native token value with the transaction; the contract mints an equal amount (1:1) of the wrapped token to the sender.",
        },
        withdraw: {
          slug: "unwrap",
          label: "Unwrap Wrapped Token",
          description:
            "Unwrap the wrapped token back to the chain's native token. The contract burns the specified amount of wrapped token and sends an equal amount of native token to the sender.",
          inputs: {
            wad: {
              label: "Amount (wei)",
              helpTip:
                "Amount of wrapped token to burn, in wei. An equal amount of native token will be sent back to your address.",
              docUrl: WRAPPED_DOCS,
            },
          },
        },
        balanceOf: {
          slug: "balance-of",
          label: "Check Wrapped Token Balance",
          description:
            "Read the wrapped token balance of an address on the selected chain",
          inputs: {
            arg0: {
              name: "account",
              label: "Wallet Address",
              helpTip:
                "Address whose wrapped-token balance will be read from the contract.",
              docUrl: WRAPPED_DOCS,
            },
          },
          outputs: {
            result: {
              name: "balance",
              label: "Wrapped Token Balance (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
