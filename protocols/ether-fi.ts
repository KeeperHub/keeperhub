import { defineAbiProtocol } from "@/lib/protocol-registry";
import { native, type ProtocolTestData, wallet } from "@/lib/test-data/types";
import eethAbi from "./abis/ether-fi-eeth.json";
import liquidityPoolAbi from "./abis/ether-fi-liquidity-pool.json";
import weethAbi from "./abis/ether-fi-weeth.json";

// ether.fi is the largest liquid restaking protocol on Ethereum. Deposit ETH
// into the LiquidityPool to mint eETH, a rebasing receipt that tracks staking
// plus EigenLayer restaking rewards; wrap eETH into weETH, the non-rebasing
// ERC20 used across DeFi and bridged cross-chain.
//
// Three mainnet contracts, verified on 2026-09-10 by reading each over a public
// RPC (name/symbol/decimals and the cross-links below):
//   - weETH.eETH() returns the eETH address, linking the pair on-chain.
//   - weETH.getRate() == LiquidityPool.amountForShare(1e18) ==
//     weETH.getEETHByWeETH(1e18) (~1.1033 ETH per weETH), so the rate the
//     wrapper reports and the pool's share price are the same number.
//
// Minting is mainnet-only: staking settles on the beacon chain. The L2 weETH
// variants are LayerZero-bridged, not mintable here. Unstaking is a withdrawal
// queue (EtherFiWithdrawRequestNFT) rather than an instant unwrap; that surface
// is deferred to a follow-up.

const ETHER_FI_DOCS = "https://etherfi.gitbook.io/etherfi";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.02",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      // Reads: pool accounting and the wrapper's exchange rate. All four are
      // nine-figure or rate-scale values on mainnet; a zero means the read
      // decoded garbage rather than a legitimate empty state.
      //
      // Binding keys are the action's input names, which the overrides below
      // rename from the raw ABI parameters (_share becomes shares, _amount
      // becomes ethAmount, _eETHAmount and _weETHAmount become amount). A key
      // that does not match an input name is silently dropped and the encoder
      // falls back to a type-derived default, so these have to track the
      // renames.
      "get-total-pooled-ether": {},
      "amount-for-share": { shares: native("1") },
      "shares-for-amount": { ethAmount: native("1") },
      "get-rate": {},
      "get-weeth-by-eeth": { amount: native("1") },
      "get-eeth-by-weeth": { amount: native("1") },
      "eeth-balance-of": { account: wallet() },
      "eeth-total-shares": {},
      "weeth-balance-of": { account: wallet() },
      "weeth-total-supply": {},
      // Write: stake ETH for eETH. ethValue is the builder's virtual msg.value
      // for a payable action; the pool mints eETH ~1:1 to the sender.
      stake: { ethValue: "0.02" },
    },
    skipped: {
      // wrap and unwrap need an eETH (resp. weETH) balance and an ERC20
      // approval to the weETH contract. On a fresh fork the wallet holds
      // neither until the stake fixture runs, and wrap additionally needs an
      // approve step the setup block does not model, so these are exercised
      // by the write-expectation oracle on stake rather than as standalone
      // fixtures.
      wrap: "needs an eETH balance and an approval to weETH; covered indirectly by the stake write-expectation",
      unwrap:
        "needs a weETH balance from a prior wrap; not reachable from a clean fork without it",
    },
    // Chain invariants. getTotalPooledEther and eeth-total-shares are the whole
    // protocol's TVL and share count, seven-to-nine figures. getRate only ever
    // ratchets up from 1e18. No expectation on the wallet balances: the stake
    // fixture mints eETH mid-run, so those depend on run history on a
    // long-lived fork.
    expectations: {
      "get-total-pooled-ether": [{ field: "totalPooledEther", nonZero: true }],
      "get-rate": [{ field: "rate", nonZero: true }],
      "amount-for-share": [{ field: "ethAmount", nonZero: true }],
      "eeth-total-shares": [{ field: "totalShares", nonZero: true }],
    },
    // Simulation-tier post-write oracle: staking must actually credit eETH. A
    // mined receipt alone misses the stale-pool failure class where the deposit
    // reverts on the accounting side. nonZero is history-safe on a long-lived
    // fork.
    writeExpectations: {
      stake: [
        {
          read: "eeth-balance-of",
          expect: { field: "balance", nonZero: true },
        },
      ],
    },
  },
};

export default defineAbiProtocol({
  name: "ether.fi",
  slug: "ether-fi",
  description:
    "Liquid restaking on Ethereum. Deposit ETH to mint eETH (rebasing receipt earning staking plus EigenLayer restaking rewards), wrap eETH into weETH (non-rebasing ERC20), and read pool accounting and exchange rates.",
  website: "https://ether.fi",
  icon: "/protocols/ether-fi.png",

  testData: TEST_DATA,

  contracts: {
    liquidityPool: {
      label: "ether.fi Liquidity Pool",
      abi: JSON.stringify(liquidityPoolAbi),
      addresses: {
        "1": "0x308861A430be4cce5502d0A12724771Fc6DaF216",
      },
      overrides: {
        deposit: {
          slug: "stake",
          label: "Stake ETH for eETH",
          description:
            "Deposit native ETH into the ether.fi Liquidity Pool and mint eETH to the sending address. Send ETH value with the transaction; the pool returns eETH tracking the deposit plus staking and restaking rewards.",
          docUrl: ETHER_FI_DOCS,
        },
        getTotalPooledEther: {
          slug: "get-total-pooled-ether",
          label: "Get Total Pooled ETH",
          description:
            "Read the total ETH the ether.fi Liquidity Pool accounts for across all stakers. Useful as a health and TVL signal in a workflow.",
          docUrl: ETHER_FI_DOCS,
          outputs: {
            totalPooledEther: {
              label: "Total Pooled ETH (wei)",
              decimals: 18,
            },
          },
        },
        amountForShare: {
          slug: "amount-for-share",
          label: "Convert eETH Shares to ETH",
          description:
            "Read how much ETH a given number of eETH shares is worth at the current pool exchange rate.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            _share: {
              name: "shares",
              label: "eETH Shares (wei)",
              helpTip:
                "Number of eETH shares to price, in wei. Returns the ETH value at the current pool rate.",
              docUrl: ETHER_FI_DOCS,
              decimals: 18,
            },
          },
          outputs: {
            ethAmount: {
              label: "ETH Value (wei)",
              decimals: 18,
            },
          },
        },
        sharesForAmount: {
          slug: "shares-for-amount",
          label: "Convert ETH to eETH Shares",
          description:
            "Read how many eETH shares a given amount of ETH would mint at the current pool exchange rate.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            _amount: {
              name: "ethAmount",
              label: "ETH Amount (wei)",
              helpTip:
                "Amount of ETH to convert, in wei. Returns the eETH shares that amount represents at the current pool rate.",
              docUrl: ETHER_FI_DOCS,
              decimals: 18,
            },
          },
          outputs: {
            shares: {
              label: "eETH Shares (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
    weeth: {
      label: "weETH Token",
      abi: JSON.stringify(weethAbi),
      addresses: {
        "1": "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
      },
      overrides: {
        wrap: {
          slug: "wrap",
          label: "Wrap eETH into weETH",
          description:
            "Wrap rebasing eETH into non-rebasing weETH. Approve the weETH contract to spend eETH first. Returns the amount of weETH received.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            _eETHAmount: {
              name: "amount",
              label: "eETH Amount (wei)",
              helpTip:
                "Amount of eETH to wrap, in wei. The weETH contract must be approved to spend at least this much eETH.",
              docUrl: ETHER_FI_DOCS,
              decimals: 18,
            },
          },
          outputs: {
            weETHReceived: {
              label: "weETH Received (wei)",
              decimals: 18,
            },
          },
        },
        unwrap: {
          slug: "unwrap",
          label: "Unwrap weETH into eETH",
          description:
            "Unwrap non-rebasing weETH back into rebasing eETH at the current rate. Returns the amount of eETH received.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            _weETHAmount: {
              name: "amount",
              label: "weETH Amount (wei)",
              helpTip:
                "Amount of weETH to unwrap, in wei. Returns eETH at the current exchange rate (see Get weETH Rate).",
              docUrl: ETHER_FI_DOCS,
              decimals: 18,
            },
          },
          outputs: {
            eETHReceived: {
              label: "eETH Received (wei)",
              decimals: 18,
            },
          },
        },
        getRate: {
          slug: "get-rate",
          label: "Get weETH Rate",
          description:
            "Read the current ETH value of one weETH (the wrapper exchange rate). Only ratchets up as staking and restaking rewards accrue.",
          docUrl: ETHER_FI_DOCS,
          outputs: {
            rate: {
              label: "Rate (wei of eETH per weETH)",
              decimals: 18,
            },
          },
        },
        getWeETHByeETH: {
          slug: "get-weeth-by-eeth",
          label: "Convert eETH to weETH",
          description:
            "Read how much weETH a given amount of eETH would wrap into at the current rate.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            _eETHAmount: {
              name: "amount",
              label: "eETH Amount (wei)",
              helpTip: "Amount of eETH to price in weETH, in wei.",
              docUrl: ETHER_FI_DOCS,
              decimals: 18,
            },
          },
          outputs: {
            weETHAmount: {
              label: "weETH Amount (wei)",
              decimals: 18,
            },
          },
        },
        getEETHByWeETH: {
          slug: "get-eeth-by-weeth",
          label: "Convert weETH to eETH",
          description:
            "Read how much eETH a given amount of weETH is worth at the current rate.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            _weETHAmount: {
              name: "amount",
              label: "weETH Amount (wei)",
              helpTip: "Amount of weETH to price in eETH, in wei.",
              docUrl: ETHER_FI_DOCS,
              decimals: 18,
            },
          },
          outputs: {
            eETHAmount: {
              label: "eETH Amount (wei)",
              decimals: 18,
            },
          },
        },
        balanceOf: {
          slug: "weeth-balance-of",
          label: "Get weETH Balance",
          description: "Check the weETH balance of an address.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            account: {
              label: "Wallet Address",
              helpTip: "Address whose weETH balance will be read.",
              docUrl: ETHER_FI_DOCS,
            },
          },
          outputs: {
            balance: {
              label: "weETH Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalSupply: {
          slug: "weeth-total-supply",
          label: "Get weETH Total Supply",
          description: "Get the total supply of weETH in circulation.",
          docUrl: ETHER_FI_DOCS,
          outputs: {
            totalSupply: {
              label: "Total weETH Supply (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
    eeth: {
      label: "eETH Token",
      abi: JSON.stringify(eethAbi),
      addresses: {
        "1": "0x35fA164735182de50811E8e2E824cFb9B6118ac2",
      },
      overrides: {
        balanceOf: {
          slug: "eeth-balance-of",
          label: "Get eETH Balance",
          description:
            "Check the eETH balance of an address. eETH is rebasing, so this value grows as rewards accrue without a transfer.",
          docUrl: ETHER_FI_DOCS,
          inputs: {
            account: {
              label: "Wallet Address",
              helpTip: "Address whose eETH balance will be read.",
              docUrl: ETHER_FI_DOCS,
            },
          },
          outputs: {
            balance: {
              label: "eETH Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalShares: {
          slug: "eeth-total-shares",
          label: "Get eETH Total Shares",
          description:
            "Get the total eETH shares outstanding. Shares are the non-rebasing accounting unit behind eETH balances.",
          docUrl: ETHER_FI_DOCS,
          outputs: {
            totalShares: {
              label: "Total eETH Shares (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
