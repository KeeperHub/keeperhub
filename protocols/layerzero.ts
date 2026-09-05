import type { AbiInputOverride } from "@/lib/abi/protocol-derive";
import { defineAbiProtocol } from "@/lib/protocol-registry";
import { contract, type ProtocolTestData, wallet } from "@/lib/test-data/types";
import layerzeroEndpointV2Abi from "./abis/layerzero-endpoint-v2.json";
import layerzeroErc20Abi from "./abis/layerzero-erc20.json";
import layerzeroOftAbi from "./abis/layerzero-oft.json";

// LayerZero V2 OFT (Omnichain Fungible Token) read surface and the
// EndpointV2 configuration reads a workflow needs before it trusts a lane.
//
// This first cut is read-only plus the ERC-20 approve an OFT Adapter
// needs. The two payable send actions depend on the protocol write step
// being able to convert a wei-denominated quote into the ether-denominated
// ETH Value field, which is a separate change; they are added once that
// lands.
//
// Endpoint IDs (EIDs) are LayerZero's own chain identifiers and are not
// EVM chain IDs. They are passed as call arguments, so they are plain
// user-typed fields with the table below in the help text, the same way
// the CCIP actions treat the destination chain selector.

export const LAYERZERO_OFT_DOCS =
  "https://docs.layerzero.network/v2/developers/evm/oft/quickstart";
export const LAYERZERO_PROTOCOL_DOCS =
  "https://docs.layerzero.network/v2/developers/evm/protocol-contracts-overview";
export const LAYERZERO_CONFIG_DOCS =
  "https://docs.layerzero.network/v2/developers/evm/configuration/dvn-executor-config";
export const LAYERZERO_DEPLOYMENTS_DOCS =
  "https://docs.layerzero.network/v2/deployments/deployed-contracts";

// Endpoint IDs per EVM chain ID. Source: LayerZero metadata API
// (metadata.layerzero-api.com/v1/metadata), 2026-09-05.
export const LAYERZERO_EIDS: Record<string, number> = {
  "1": 30_101,
  "8453": 30_184,
  "42161": 30_110,
  "10": 30_111,
  "137": 30_109,
  "11155111": 40_161,
  "84532": 40_245,
};

// Type 3 options: executor lzReceive gas of 200,000 and no native drop.
// OFTs that set enforced options merge or ignore this; OFTs without
// enforced options reject an empty options blob at the message library,
// so a working floor is the safe default.
export const DEFAULT_EXTRA_OPTIONS =
  "0x00030100110100000000000000000000000000030d40";

const EID_TABLE =
  "Ethereum 30101, Base 30184, Arbitrum One 30110, Optimism 30111, Polygon 30109, Ethereum Sepolia 40161, Base Sepolia 40245.";

// EndpointV2 per chain. Same address on every mainnet listed; testnets
// share a different one. Source: LayerZero metadata API, 2026-09-05.
const ENDPOINT_V2_ADDRESSES: Record<string, string> = {
  "1": "0x1a44076050125825900e736c501f859c50fE728c",
  "8453": "0x1a44076050125825900e736c501f859c50fE728c",
  "42161": "0x1a44076050125825900e736c501f859c50fE728c",
  "10": "0x1a44076050125825900e736c501f859c50fE728c",
  "137": "0x1a44076050125825900e736c501f859c50fE728c",
  "11155111": "0x6EDCE65403992e310A62460808c4b910D972f10f",
  "84532": "0x6EDCE65403992e310A62460808c4b910D972f10f",
};

// Reference OFT deployments. The runtime address always comes from the
// user (userSpecifiedAddress); this map is the chain allowlist and the
// binding the test suites use. No chain was dropped.
//
// Chains 1, 10, 137, 8453 and 42161 are the USDT0 family. Chain 1 is the
// OFT Adapter over USDT: approvalRequired() is true, so a send needs an
// ERC-20 approval first. The four L2 entries are native mint-and-burn
// OFTs (approvalRequired() false), and on each of them token() returns
// the separate USDT0 token contract listed in the map below, not the OFT
// itself.
//
// The two testnet entries are a third-party USDT+ test-token pair wired
// to each other via peers(). There the OFT is the token, so token()
// returns the OFT's own address, which is why the same address appears in
// both maps for those chains.
//
// Each entry answered approvalRequired(), token() and sharedDecimals()
// over eth_call on 2026-09-05.
const OFT_REFERENCE_ADDRESSES: Record<string, string> = {
  "1": "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee",
  "10": "0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD",
  "137": "0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13",
  "8453": "0xeab8fA7AB28F05D7600558b873d5C7F805412304",
  "42161": "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92",
  "11155111": "0xe20534a32f9162488a90026F268a74fBE28d272D",
  "84532": "0xdE287B4a0918102511b027d53688c169fb308762",
};

// token() of each reference OFT above.
const OFT_TOKEN_REFERENCE_ADDRESSES: Record<string, string> = {
  "1": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  "10": "0x01bFF41798a0BcF287b996046Ca68b395DbC1071",
  "137": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  "8453": "0x102d758f688a4C1C5a80b116bD945d4455460282",
  "42161": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  "11155111": "0xe20534a32f9162488a90026F268a74fBE28d272D",
  "84532": "0xdE287B4a0918102511b027d53688c169fb308762",
};

// Shared overrides for the flattened SendParam tuple used by both quotes.
const SEND_PARAM_INPUT_OVERRIDES: Record<string, AbiInputOverride> = {
  dstEid: {
    label: "Destination Endpoint ID",
    helpTip: `LayerZero endpoint ID of the destination chain. This is not the EVM chain ID. ${EID_TABLE}`,
    docUrl: LAYERZERO_DEPLOYMENTS_DOCS,
  },
  to: {
    label: "Recipient Address",
    fieldType: "address",
    helpTip:
      "Destination address that receives the tokens. Enter a standard EVM address; it is padded to the bytes32 the OFT expects.",
    docUrl: LAYERZERO_OFT_DOCS,
  },
  amountLD: {
    label: "Amount (token smallest unit)",
    helpTip:
      "Amount to send in the token's smallest unit (local decimals). The OFT removes dust below its shared decimals; see the quote-oft receipt for the exact amount received.",
    docUrl: LAYERZERO_OFT_DOCS,
  },
  minAmountLD: {
    label: "Minimum Amount (token smallest unit)",
    helpTip:
      "Slippage floor in the token's smallest unit. The send reverts if the amount after dust removal and fees is below this.",
    docUrl: LAYERZERO_OFT_DOCS,
  },
  extraOptions: {
    label: "Extra Options",
    default: DEFAULT_EXTRA_OPTIONS,
    advanced: true,
    helpTip:
      "Encoded executor options for the destination. Default is a Type 3 blob with 200,000 gas for lzReceive, which is enough for a plain token receive. OFTs with enforced options may override it. Raise the gas when the receiver runs logic.",
    docUrl: LAYERZERO_OFT_DOCS,
  },
  composeMsg: {
    label: "Compose Message",
    default: "0x",
    advanced: true,
    helpTip:
      "Optional bytes delivered to a composer contract on the destination. Use 0x for a plain transfer.",
    docUrl: LAYERZERO_OFT_DOCS,
  },
  oftCmd: {
    label: "OFT Command",
    default: "0x",
    advanced: true,
    helpTip:
      "Implementation-specific command bytes. Unused by the standard OFT; use 0x.",
    docUrl: LAYERZERO_OFT_DOCS,
  },
};

const PAY_IN_LZ_TOKEN_OVERRIDE: AbiInputOverride = {
  label: "Pay In LZ Token",
  default: "false",
  advanced: true,
  helpTip:
    "false quotes the fee in the chain's native gas token, which is what the send pays as msg.value. true quotes in ZRO; only OFTs that enable ZRO payment accept it.",
  docUrl: LAYERZERO_OFT_DOCS,
};

const TEST_DATA: ProtocolTestData = {
  "1": {
    setup: {
      minNativeHuman: "0.01",
      requiredTokens: [],
      approvals: [],
    },
    // Every oft/oftToken action binds contractAddress explicitly: for a
    // userSpecifiedAddress contract the builder ignores the fallback map,
    // and the Tier 0 golden test treats a runnable action with no target
    // as a defect.
    actions: {
      "oft-quote-send": {
        contractAddress: OFT_REFERENCE_ADDRESSES["1"],
        dstEid: "30110",
        to: wallet(),
        amountLD: "1000000",
        minAmountLD: "1000000",
        extraOptions: DEFAULT_EXTRA_OPTIONS,
        composeMsg: "0x",
        oftCmd: "0x",
        payInLzToken: "false",
      },
      "oft-quote-oft": {
        contractAddress: OFT_REFERENCE_ADDRESSES["1"],
        dstEid: "30110",
        to: wallet(),
        amountLD: "1000000",
        minAmountLD: "1000000",
        extraOptions: DEFAULT_EXTRA_OPTIONS,
        composeMsg: "0x",
        oftCmd: "0x",
      },
      "oft-approval-required": {
        contractAddress: OFT_REFERENCE_ADDRESSES["1"],
      },
      "oft-shared-decimals": {
        contractAddress: OFT_REFERENCE_ADDRESSES["1"],
      },
      "oft-token": { contractAddress: OFT_REFERENCE_ADDRESSES["1"] },
      "oft-peer": {
        contractAddress: OFT_REFERENCE_ADDRESSES["1"],
        eid: "30110",
      },
      "oft-approve": {
        contractAddress: OFT_TOKEN_REFERENCE_ADDRESSES["1"],
        spender: contract("oft"),
        amount: "1000000",
      },
      "oft-check-balance": {
        contractAddress: OFT_TOKEN_REFERENCE_ADDRESSES["1"],
        account: wallet(),
      },
      "oft-check-allowance": {
        contractAddress: OFT_TOKEN_REFERENCE_ADDRESSES["1"],
        owner: wallet(),
        spender: contract("oft"),
      },
      "endpoint-get-send-library": {
        sender: contract("oft"),
        dstEid: "30110",
      },
      "endpoint-get-config": {
        oapp: contract("oft"),
        // SendUln302 on Ethereum; equals defaultSendLibrary(30110) and
        // getSendLibrary(USDT0, 30110), verified 2026-09-05.
        lib: "0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1",
        eid: "30110",
        configType: "2",
      },
      "endpoint-is-supported-eid": { eid: "30110" },
    },
    // Long-lived invariants of the USDT0 adapter and the Ethereum endpoint,
    // all observed over eth_call on 2026-09-05 at block 25907823. Hex
    // strings are checked numerically by the oracle, so nonZero holds for
    // addresses and bytes32.
    expectations: {
      "oft-approval-required": [{ equals: "true" }],
      "oft-shared-decimals": [{ equals: "6" }],
      "oft-token": [{ equals: OFT_TOKEN_REFERENCE_ADDRESSES["1"] }],
      "oft-peer": [{ nonZero: true }],
      "oft-quote-send": [{ field: "fee.nativeFee", nonZero: true }],
      "oft-quote-oft": [
        { field: "oftReceipt.amountReceivedLD", nonZero: true },
      ],
      "endpoint-get-send-library": [{ nonZero: true }],
      "endpoint-get-config": [{ notEmpty: true }],
      "endpoint-is-supported-eid": [{ equals: "true" }],
    },
    skipped: {
      "oft-approve":
        "write requiring a USDT balance the read-only sweep does not provision",
    },
  },
};

export default defineAbiProtocol({
  name: "LayerZero",
  slug: "layerzero",
  description:
    "LayerZero V2 omnichain tokens (OFT) and endpoint configuration. Quote crosschain transfer fees, inspect an OFT's peers and approval needs, and read the send library and DVN configuration a lane will use before you trust it.",
  website: "https://layerzero.network",

  testData: TEST_DATA,

  contracts: {
    oft: {
      label: "OFT / OFT Adapter",
      userSpecifiedAddress: true,
      abi: JSON.stringify(layerzeroOftAbi),
      addresses: OFT_REFERENCE_ADDRESSES,
      overrides: {
        // The runtime result key is `fee`, matching the ABI output name.
        // Canonical Solidity calls this return value `msgFee`; do not
        // "correct" it here. The expectation path (fee.nativeFee) and the
        // workflow templates read the key this override produces.
        quoteSend: {
          slug: "oft-quote-send",
          label: "OFT Quote Send",
          description:
            "Quote the LayerZero messaging fee for sending an OFT to another chain. The nativeFee output is denominated in wei of the source chain's gas token.",
          docUrl: LAYERZERO_OFT_DOCS,
          inputs: {
            ...SEND_PARAM_INPUT_OVERRIDES,
            payInLzToken: PAY_IN_LZ_TOKEN_OVERRIDE,
          },
          outputs: {
            fee: { label: "Messaging Fee (nativeFee, lzTokenFee in wei)" },
          },
        },
        quoteOFT: {
          slug: "oft-quote-oft",
          label: "OFT Quote Transfer",
          description:
            "Preview an OFT transfer: the transfer limits, the fee breakdown, and the exact amounts debited and received after dust removal.",
          docUrl: LAYERZERO_OFT_DOCS,
          inputs: { ...SEND_PARAM_INPUT_OVERRIDES },
          outputs: {
            oftLimit: { label: "Transfer Limits (minAmountLD, maxAmountLD)" },
            oftFeeDetails: { label: "Fee Details" },
            oftReceipt: {
              label: "Receipt Preview (amountSentLD, amountReceivedLD)",
            },
          },
        },
        approvalRequired: {
          slug: "oft-approval-required",
          label: "OFT Approval Required",
          description:
            "Whether this OFT needs an ERC-20 approval before sending. true means it is an OFT Adapter that pulls the underlying token; false means it mints and burns its own supply.",
          docUrl: LAYERZERO_OFT_DOCS,
          outputs: {
            result: { name: "approvalRequired", label: "Approval Required" },
          },
        },
        sharedDecimals: {
          slug: "oft-shared-decimals",
          label: "OFT Shared Decimals",
          description:
            "The decimal precision shared across every chain this OFT lives on. Amounts below this precision are removed as dust before sending.",
          docUrl: LAYERZERO_OFT_DOCS,
          outputs: {
            result: { name: "sharedDecimals", label: "Shared Decimals" },
          },
        },
        token: {
          slug: "oft-token",
          label: "OFT Underlying Token",
          description:
            "The ERC-20 this OFT moves. For an OFT Adapter it is the wrapped token to approve; for a native OFT it is the OFT itself.",
          docUrl: LAYERZERO_OFT_DOCS,
          outputs: {
            result: { name: "token", label: "Token Address" },
          },
        },
        peers: {
          slug: "oft-peer",
          label: "OFT Peer",
          description:
            "The OFT address registered on a destination chain, as bytes32. All zeros means the lane is not wired and a send to it will revert.",
          docUrl: LAYERZERO_OFT_DOCS,
          inputs: {
            eid: {
              label: "Destination Endpoint ID",
              helpTip: `LayerZero endpoint ID of the destination chain, not the EVM chain ID. ${EID_TABLE}`,
              docUrl: LAYERZERO_DEPLOYMENTS_DOCS,
            },
          },
          outputs: {
            result: { name: "peer", label: "Peer (bytes32)" },
          },
        },
      },
    },

    oftToken: {
      label: "OFT Underlying Token (ERC-20)",
      userSpecifiedAddress: true,
      abi: JSON.stringify(layerzeroErc20Abi),
      addresses: OFT_TOKEN_REFERENCE_ADDRESSES,
      overrides: {
        approve: {
          slug: "oft-approve",
          label: "OFT Approve",
          description:
            "Approve an OFT Adapter to pull the underlying token. Needed only when OFT Approval Required returns true.",
          docUrl: LAYERZERO_OFT_DOCS,
          inputs: {
            spender: {
              label: "Spender (OFT Adapter)",
              helpTip:
                "The OFT Adapter address that will call transferFrom on this token during send.",
              docUrl: LAYERZERO_OFT_DOCS,
            },
            amount: {
              label: "Amount (token smallest unit)",
              helpTip:
                "Allowance in the token's smallest unit. Must cover the amount you intend to send.",
              docUrl: LAYERZERO_OFT_DOCS,
            },
          },
        },
        balanceOf: {
          slug: "oft-check-balance",
          label: "OFT Check Token Balance",
          description:
            "Balance of the underlying token for an address. Use before a send to catch an empty wallet early.",
          docUrl: LAYERZERO_OFT_DOCS,
          inputs: {
            account: {
              label: "Account Address",
              helpTip: "The address whose token balance to read.",
              docUrl: LAYERZERO_OFT_DOCS,
            },
          },
          outputs: {
            result: { name: "balance", label: "Token Balance (smallest unit)" },
          },
        },
        allowance: {
          slug: "oft-check-allowance",
          label: "OFT Check Allowance",
          description:
            "How much of the underlying token an OFT Adapter may pull from an owner. Use to confirm the approve step took effect.",
          docUrl: LAYERZERO_OFT_DOCS,
          inputs: {
            owner: {
              label: "Token Owner",
              helpTip: "The address that granted the approval.",
              docUrl: LAYERZERO_OFT_DOCS,
            },
            spender: {
              label: "Spender (OFT Adapter)",
              helpTip: "The OFT Adapter address.",
              docUrl: LAYERZERO_OFT_DOCS,
            },
          },
          outputs: {
            result: { name: "allowance", label: "Allowance (smallest unit)" },
          },
        },
      },
    },

    endpointV2: {
      label: "LayerZero EndpointV2",
      abi: JSON.stringify(layerzeroEndpointV2Abi),
      addresses: ENDPOINT_V2_ADDRESSES,
      overrides: {
        getSendLibrary: {
          slug: "endpoint-get-send-library",
          label: "Endpoint Get Send Library",
          description:
            "The message library an OFT will send through for a destination. Resolves to the LayerZero default when the OFT has not chosen one.",
          docUrl: LAYERZERO_PROTOCOL_DOCS,
          inputs: {
            sender: {
              label: "OFT Address",
              helpTip: "The OFT (or any OApp) whose send library to look up.",
              docUrl: LAYERZERO_PROTOCOL_DOCS,
            },
            dstEid: {
              label: "Destination Endpoint ID",
              helpTip: `LayerZero endpoint ID of the destination chain, not the EVM chain ID. ${EID_TABLE}`,
              docUrl: LAYERZERO_DEPLOYMENTS_DOCS,
            },
          },
          outputs: {
            result: { name: "sendLibrary", label: "Send Library Address" },
          },
        },
        getConfig: {
          slug: "endpoint-get-config",
          label: "Endpoint Get Config",
          description:
            "The ABI-encoded configuration an OFT uses on a library for a destination: the DVN set and confirmations (config type 2) or the executor (config type 1). Compare the bytes against a stored baseline to detect a security configuration change before sending.",
          docUrl: LAYERZERO_CONFIG_DOCS,
          inputs: {
            oapp: {
              label: "OFT Address",
              helpTip: "The OFT (or any OApp) whose configuration to read.",
              docUrl: LAYERZERO_CONFIG_DOCS,
            },
            lib: {
              label: "Message Library Address",
              helpTip:
                "The send or receive library to read the configuration from. Use the Endpoint Get Send Library output for the send side.",
              docUrl: LAYERZERO_CONFIG_DOCS,
            },
            eid: {
              label: "Remote Endpoint ID",
              helpTip: `LayerZero endpoint ID of the remote chain, not the EVM chain ID. ${EID_TABLE}`,
              docUrl: LAYERZERO_DEPLOYMENTS_DOCS,
            },
            configType: {
              label: "Config Type",
              default: "2",
              helpTip:
                "1 returns the executor config (maxMessageSize, executor). 2 returns the ULN config (confirmations, required and optional DVNs).",
              docUrl: LAYERZERO_CONFIG_DOCS,
            },
          },
          outputs: {
            result: { name: "config", label: "Config (ABI-encoded bytes)" },
          },
        },
        isSupportedEid: {
          slug: "endpoint-is-supported-eid",
          label: "Endpoint Is Supported EID",
          description:
            "Whether this endpoint has a default send library for the destination, meaning messages can be routed there at all.",
          docUrl: LAYERZERO_PROTOCOL_DOCS,
          inputs: {
            eid: {
              label: "Destination Endpoint ID",
              helpTip: `LayerZero endpoint ID of the destination chain, not the EVM chain ID. ${EID_TABLE}`,
              docUrl: LAYERZERO_DEPLOYMENTS_DOCS,
            },
          },
          outputs: {
            result: { name: "supported", label: "Supported" },
          },
        },
      },
    },
  },
});
