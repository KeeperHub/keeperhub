import { defineAbiProtocol } from "@/lib/protocol-registry";
import { type ProtocolTestData, wallet } from "@/lib/test-data/types";
import cbethAbi from "./abis/coinbase-cbeth.json";

// cbETH is Coinbase Wrapped Staked ETH: a non-rebasing ERC20 whose value
// against ETH accrues through an on-chain exchange rate.
//
// Read-only. The token is a FiatToken-style proxy whose implementation does
// carry mint(address,uint256) and burn(uint256), but minting is minter-gated
// (configureMinter / isMinter / minterAllowance) so an integrator cannot call
// it, and burn destroys tokens without redeeming ETH. Neither is a useful
// workflow action, so the surface here is the reads: the exchange rate (to
// value a position or gate on drift), a balance, and the total supply.
// protocols/pyth.ts and protocols/robinhood.ts are the read-only precedents.
//
// Verified on 2026-09-10 by reading the mainnet token over a public RPC: name
// "Coinbase Wrapped Staked ETH", symbol cbETH, 18 decimals, exchangeRate()
// 1139167190088840180 (about 1.1391 ETH per cbETH), total supply about
// 393,750 cbETH. Per specs/protocol-coverage-methodology.md:303-304.
//
// Mainnet only. The Base cbETH is an OP-stack bridged representation rather
// than a second deployment: its l1Token() returns this mainnet address and
// exchangeRate() reverts there. balanceOf and totalSupply do work on Base, so
// adding it later means a second contract key rather than a second address on
// this one, because defineAbiProtocol derives one action set per contract.

const CBETH_DOCS =
  "https://help.coinbase.com/en/coinbase/trading-and-funding/staking-rewards/cbeth";

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0",
      requiredTokens: [],
      approvals: [],
    },
    actions: {
      "exchange-rate": {},
      "balance-of": { account: wallet() },
      "total-supply": {},
    },
    // Chain invariants: the exchange rate only ratchets up from 1e18 and cbETH
    // supply is six figures; both being zero means the read decoded garbage. No
    // expectation on balance-of, which is address- and history-dependent.
    expectations: {
      "exchange-rate": [{ field: "rate", nonZero: true }],
      "total-supply": [{ field: "totalSupply", nonZero: true }],
    },
  },
};

export default defineAbiProtocol({
  name: "Coinbase cbETH",
  slug: "coinbase-cbeth",
  description:
    "Coinbase Wrapped Staked ETH (cbETH), a non-rebasing liquid staking token. Read the on-chain exchange rate, a balance, and the total supply to value or monitor a cbETH position.",
  website: "https://www.coinbase.com/cbeth",
  icon: "/protocols/coinbase-cbeth.png",

  testData: TEST_DATA,

  contracts: {
    cbeth: {
      label: "cbETH Token",
      abi: JSON.stringify(cbethAbi),
      addresses: {
        "1": "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
      },
      overrides: {
        exchangeRate: {
          slug: "exchange-rate",
          label: "Get cbETH Exchange Rate",
          description:
            "Read the current ETH value of one cbETH. Only ratchets up as staking rewards accrue; useful to value a position or gate a workflow on the rate.",
          docUrl: CBETH_DOCS,
          outputs: {
            rate: {
              label: "Exchange Rate (wei of ETH per cbETH)",
              decimals: 18,
            },
          },
        },
        balanceOf: {
          slug: "balance-of",
          label: "Get cbETH Balance",
          description: "Check the cbETH balance of an address.",
          docUrl: CBETH_DOCS,
          inputs: {
            account: {
              label: "Wallet Address",
              helpTip: "Address whose cbETH balance will be read.",
              docUrl: CBETH_DOCS,
            },
          },
          outputs: {
            balance: {
              label: "cbETH Balance (wei)",
              decimals: 18,
            },
          },
        },
        totalSupply: {
          slug: "total-supply",
          label: "Get cbETH Total Supply",
          description: "Get the total supply of cbETH in circulation.",
          docUrl: CBETH_DOCS,
          outputs: {
            totalSupply: {
              label: "Total cbETH Supply (wei)",
              decimals: 18,
            },
          },
        },
      },
    },
  },
});
