import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";
import fraxEtherV2Abi from "./abis/frax-ether-v2.json";

// Frax Ether V2 launched Q2-Q3 2024 as part of the Frax V3 reorganization.
// The minter contract was redesigned: V1's `submit()` was renamed to
// `mintFrxEth()`, so V1 and V2 are NOT ABI-compatible. The frxETH and
// sfrxETH token addresses are unchanged from V1; only the minter and the
// redemption queue are V2-specific.
//
// This first cut exposes the V2 minter only. Mainnet-only because staking
// happens on the beacon chain; L2 frxETH variants are LayerZero-bridged
// and not mintable. Redemption is a queue (FraxEtherRedemptionQueueV2)
// rather than instant unwrap; that surface is deferred to a follow-up.

const FRAX_ETHER_DOCS =
  "https://docs.frax.finance/frax-ether/frxeth-and-sfrxeth";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      "mint-paused": {},
      // Minting is unconditional while mintFrxEthPaused() is false: ETH in,
      // frxETH out 1:1, no caps or queues. ethValue is the builder's
      // virtual msg.value key for payable actions.
      mint: { ethValue: "0.01" },
      "mint-and-give": { ethValue: "0.01", recipient: wallet() },
      "mint-and-stake": { ethValue: "0.01", recipient: wallet() },
    },
    // mintFrxEthPaused() returned false on mainnet as of 2026-07-02. A
    // flip to true is an emergency pause -- the mint actions this plugin
    // markets would be failing for users, so surfacing it as a red suite
    // is signal, not flake.
    expectations: {
      "mint-paused": [{ equals: "false" }],
    },
  },
};

export default defineAbiProtocol({
  name: "Frax Ether V2",
  slug: "frax-ether-v2",
  description:
    "Liquid staking on Ethereum mainnet. Deposit ETH to mint frxETH (1:1 receipt) or sfrxETH (yield-bearing ERC4626 vault) in one transaction.",
  website: "https://frax.finance/products/frax-ether",
  icon: "/protocols/frax-ether.png",

  testData: TEST_DATA,

  contracts: {
    minter: {
      label: "Frax Ether Minter V2",
      abi: JSON.stringify(fraxEtherV2Abi),
      addresses: {
        "1": "0x7Bc6bad540453360F744666D625fec0ee1320cA3",
      },
      overrides: {
        mintFrxEth: {
          slug: "mint",
          label: "Mint frxETH",
          description:
            "Deposit native ETH and mint frxETH 1:1 to the sending address. Send ETH value with the transaction; the contract returns the same amount of frxETH.",
          docUrl: FRAX_ETHER_DOCS,
        },
        mintFrxEthAndGive: {
          slug: "mint-and-give",
          label: "Mint frxETH to Recipient",
          description:
            "Deposit native ETH and mint frxETH 1:1 to a different recipient address. Send ETH value with the transaction; the contract sends the minted frxETH to the recipient.",
          docUrl: FRAX_ETHER_DOCS,
          inputs: {
            _recipient: {
              name: "recipient",
              label: "Recipient Address",
              helpTip:
                "Address that will receive the minted frxETH. The sender of the transaction pays the ETH and gas; only frxETH goes to this address.",
              docUrl: FRAX_ETHER_DOCS,
            },
          },
        },
        submitAndDeposit: {
          slug: "mint-and-stake",
          label: "Mint and Stake into sfrxETH",
          description:
            "Mint frxETH and immediately deposit it into the sfrxETH ERC4626 vault in one transaction. Returns the amount of sfrxETH shares received by the recipient.",
          docUrl: FRAX_ETHER_DOCS,
          inputs: {
            _recipient: {
              name: "recipient",
              label: "Recipient Address",
              helpTip:
                "Address that will receive the minted sfrxETH shares. The sender pays the ETH and gas; only sfrxETH shares go to this address.",
              docUrl: FRAX_ETHER_DOCS,
            },
          },
          outputs: {
            _shares: {
              name: "shares",
              label: "sfrxETH Shares Received (wei)",
              decimals: 18,
            },
          },
        },
        mintFrxEthPaused: {
          slug: "mint-paused",
          label: "Check Mint Pause Status",
          description:
            "Read whether minting is currently paused on the Frax Ether Minter V2. Useful as a gate in workflows to skip mint actions when the contract is paused.",
          docUrl: FRAX_ETHER_DOCS,
          outputs: {
            result: {
              name: "paused",
              label: "Mint Paused",
            },
          },
        },
      },
    },
  },
});
