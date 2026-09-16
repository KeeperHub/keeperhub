import type { AbiInputOverride } from "@/lib/abi/protocol-derive";
import { defineAbiProtocol } from "@/lib/protocol-registry";
import { contract, type ProtocolTestData, wallet } from "@/lib/test-data/types";
import layerzeroEndpointV2Abi from "./abis/layerzero-endpoint-v2.json";
import layerzeroEndpointV2ViewAbi from "./abis/layerzero-endpoint-v2-view.json";
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

// Endpoint IDs per EVM chain ID, covering every EVM chain KeeperHub
// supports. Source: LayerZero metadata API
// (metadata.layerzero-api.com/v1/metadata), 2026-09-16, with every entry
// then confirmed against the chain itself by calling eid() on that chain's
// EndpointV2. The integration suite repeats that check for all of them: it
// asks each chain's view which endpoint it serves and that endpoint which
// chain it is on, so a corrected or mistyped ID here fails CI rather than
// being compared against itself in a unit test.
//
// Chosen by hand, one chain at a time, because the metadata cannot be
// filtered on nativeChainId alone: chain 1 is both Ethereum and Aptos, and
// chain 11155111 carries three rows of which only sepolia-testnet is the
// lane in use. Reading eid() from the deployment is what settles those.
// Plasma Testnet is the case that proves the point: it has three metadata
// rows (40409, 40411, 40417) sharing one endpoint address, and the endpoint
// reports 40417.
export const LAYERZERO_EIDS: Record<string, number> = {
  "1": 30_101,
  "8453": 30_184,
  "42161": 30_110,
  "10": 30_111,
  "137": 30_109,
  "56": 30_102,
  "43114": 30_106,
  "9745": 30_383,
  "16661": 30_388,
  "4217": 30_410,
  "4663": 30_416,
  "11155111": 40_161,
  "84532": 40_245,
  "421614": 40_231,
  "11155420": 40_232,
  "80002": 40_267,
  "97": 40_102,
  "43113": 40_106,
  "9746": 40_417,
  "16602": 40_428,
  "42431": 40_444,
  "46630": 40_451,
};

// Type 3 options: executor lzReceive gas of 200,000 and no native drop.
// OFTs without enforced options reject an empty options blob at the
// message library, so a working floor is the safe default.
//
// On an OFT that does set enforced options, these are COMBINED with them
// rather than overriding or being ignored: the executor sums the
// lzReceive gas across both. An OFT enforcing 100,000 gas therefore
// budgets 300,000 with this default, and quoteSend returns a
// correspondingly larger nativeFee.
export const DEFAULT_EXTRA_OPTIONS =
  "0x00030100110100000000000000000000000000030d40";

// Chain names for the endpoint ID table below, in the order it reads them:
// mainnets first, then testnets.
//
// An ordered list rather than a map keyed by chain ID, because object keys that
// look like integers enumerate in ascending numeric order however they are
// written. Keying this off the chain ID would interleave the testnets with the
// mainnets and put Base Sepolia ahead of Ethereum Sepolia, so the order has to
// be stated rather than inherited.
const EID_CHAIN_NAMES: readonly (readonly [string, string])[] = [
  ["1", "Ethereum"],
  ["8453", "Base"],
  ["42161", "Arbitrum One"],
  ["10", "Optimism"],
  ["137", "Polygon"],
  ["56", "BNB Chain"],
  ["43114", "Avalanche"],
  ["9745", "Plasma"],
  ["16661", "0G"],
  ["4217", "Tempo"],
  ["4663", "Robinhood Chain"],
  ["11155111", "Ethereum Sepolia"],
  ["84532", "Base Sepolia"],
  ["421614", "Arbitrum Sepolia"],
  ["11155420", "Optimism Sepolia"],
  ["80002", "Polygon Amoy"],
  ["97", "BNB Chain Testnet"],
  ["43113", "Avalanche Fuji"],
  ["9746", "Plasma Testnet"],
  ["16602", "0G Galileo"],
  ["42431", "Tempo Testnet"],
  ["46630", "Robinhood Chain Testnet"],
];

// Built from LAYERZERO_EIDS rather than typed out beside it, so a corrected
// endpoint ID or a newly supported chain cannot leave a stale figure in the
// help text. The list above supplies order and names only: every chain in the
// map is listed either way, one with no name entry appearing by its chain ID
// after the named ones.
function formatEidTable(): string {
  const rank = (chainId: string): number => {
    const index = EID_CHAIN_NAMES.findIndex(([id]) => id === chainId);
    return index === -1 ? EID_CHAIN_NAMES.length : index;
  };
  const nameOf = (chainId: string): string =>
    EID_CHAIN_NAMES.find(([id]) => id === chainId)?.[1] ?? chainId;

  return `${Object.entries(LAYERZERO_EIDS)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([chainId, eid]) => `${nameOf(chainId)} ${eid}`)
    .join(", ")}.`;
}

const EID_TABLE = formatEidTable();

// EndpointV2 per chain. Same address on every mainnet listed; testnets
// share a different one. Source: LayerZero metadata API, 2026-09-05.
//
// Deliberately still the five mainnets and two testnets the OFT reference
// map covers, while the view map below covers every chain KeeperHub runs.
// The endpoint's own actions bind a reference OFT deployment per chain; the
// view's does not, so widening this map is a separate change from widening
// the read that needs no such deployment.
const ENDPOINT_V2_ADDRESSES: Record<string, string> = {
  "1": "0x1a44076050125825900e736c501f859c50fE728c",
  "8453": "0x1a44076050125825900e736c501f859c50fE728c",
  "42161": "0x1a44076050125825900e736c501f859c50fE728c",
  "10": "0x1a44076050125825900e736c501f859c50fE728c",
  "137": "0x1a44076050125825900e736c501f859c50fE728c",
  "11155111": "0x6EDCE65403992e310A62460808c4b910D972f10f",
  "84532": "0x6EDCE65403992e310A62460808c4b910D972f10f",
};

// EndpointV2View per chain: LayerZero's read-only view over the endpoint's
// inbound state, whose executable() is what LayerZero's own executor polls
// before delivering. Unlike EndpointV2 the address differs on almost every
// chain, so none of it is derivable.
//
// Source: LayerZero metadata API `endpointV2View`, 2026-09-16. Every entry
// was called on its own chain that day: each holds the same 2304 bytes of
// code and answers executable() with 0 for an unused nonce, so a wrong-chain
// or wrong-shaped address cannot pass silently.
//
// Executed (3) is returned both when the receiver's lzReceive ran and when
// the OApp cleared the payload with clear() without running it: the endpoint
// deletes the payload hash either way, so the two leave the same state. It
// says nothing about lzCompose, which runs as a separate call afterwards.
const ENDPOINT_V2_VIEW_ADDRESSES: Record<string, string> = {
  "1": "0x8FAFC84cAeA1Cef8475cb5CB344658D160c9CE0b",
  "8453": "0x5e2A88c385B86f00eb8F4d9f861649a6feB93F24",
  "42161": "0x5440E2097C41F8e0a8551521d569c71de70fDe23",
  "10": "0xECEE8B581960634aF89f467AE624Ff468a9Db14B",
  "137": "0x1Bef2d7C5c60fD826Cc1b1f29cA357Af2d0Ae2c6",
  "56": "0x40B36b785A6872b40Cd6957Ce211E515E1be1081",
  "43114": "0x5cDc927876031B4Ef910735225c425A7Fc8efed9",
  "9745": "0xAaB5A48CFC03Efa9cC34A2C1aAcCCB84b4b770e4",
  "16661": "0x4514FC667a944752ee8A29F544c1B20b1A315f25",
  "4217": "0x6903A4a6F09f8837886928b9494C0635Cf3091ED",
  "4663": "0xAaB5A48CFC03Efa9cC34A2C1aAcCCB84b4b770e4",
  "11155111": "0x982Ca8b3532236C5e77Ff215791dD454e07E21F7",
  "84532": "0xF49d162484290EAeAd7bb8C2c7E3a6f8f52e32d6",
  "421614": "0x91282bEf7b549732c6acE92778167E952F864A5e",
  "11155420": "0x1e5432719b432738aDeb8F8C5bb6d118e09E768d",
  "80002": "0xcF1B0F4106B0324F96fEfcC31bA9498caa80701C",
  "97": "0x9a8E38C2394A4ec94421750b96a67A5CeF75EbfE",
  "43113": "0x31fFd858c7826817F830C3dF2bb2A74126d51126",
  "9746": "0x6Ac7bdc07A0583A362F1497252872AE6c0A5F5B8",
  "16602": "0x6Ac7bdc07A0583A362F1497252872AE6c0A5F5B8",
  "42431": "0x9BDD19d8cF1cAB4972802bCA09f72d8c8325dBfB",
  "46630": "0x6Ac7bdc07A0583A362F1497252872AE6c0A5F5B8",
};

// Reference OFT deployments. The runtime address always comes from the
// user (userSpecifiedAddress); this map is the chain allowlist and the
// binding the test suites use. No chain was dropped.
//
// Chains 1, 10, 137, 8453 and 42161 are the USDT0 family. Chain 1 is the
// OFT Adapter over USDT: approvalRequired() is true, so a send needs an
// ERC-20 approval first. The four L2 entries are Mint and Burn OFT
// Adapters (approvalRequired() false), and on each of them token()
// returns the chain's USDT0 deployment listed in the map below, not the
// OFT itself. On 137 and 42161 that is the legacy bridged-USDT address,
// rebranded in place: eth_call name() on 2026-09-08 returns "USDT0" on
// 137 and "USD₮0" on 42161, alongside "USD₮0" on 10 and
// "Stargate USD₮0 (Bridged)" on 8453. The 137 and 42161 reads are the
// counter-intuitive ones, so they were taken from several unaffiliated
// providers rather than one: drpc, 1rpc, Tenderly, publicnode and
// Arbitrum's own endpoint agree, with no dissent.
//
// Two rules follow, both learned the expensive way on this line. Read
// name() rather than inferring from an address's history: these two are
// the addresses everyone remembers as bridged USDT. And read it with
// eth_call rather than an indexed token-metadata API, which serves its
// own cache and can still return the pre-migration name long after the
// contract has been rebranded.
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
      "Slippage floor in the token's smallest unit. Both the quote and the send revert with SlippageExceeded when the amount after dust removal and fees falls below this, so leave headroom instead of matching the amount exactly.",
    docUrl: LAYERZERO_OFT_DOCS,
  },
  extraOptions: {
    label: "Extra Options",
    default: DEFAULT_EXTRA_OPTIONS,
    advanced: true,
    helpTip:
      "Encoded executor options for the destination. The default is a Type 3 blob with 200,000 gas for lzReceive, which is enough for a plain token receive; raise it when the receiver runs logic. An OFT that sets enforced options combines these with them rather than overriding or ignoring them, so the executor sums the lzReceive gas and this default adds to the fee the quote returns.",
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
        minAmountLD: "990000",
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
        minAmountLD: "990000",
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
      // A real USDT0 transfer from Arbitrum into the chain-1 adapter:
      // Arbitrum tx 0xd3f268dff7fc88568424cc39f6f3757709bd68079c5b1f3f67b716c95dd721c3
      // emitted PacketSent with nonce 28910 from the Arbitrum USDT0 adapter.
      // Ethereum's EndpointV2View returned Executed for it on 2026-09-15, and
      // an executed message never leaves that state, so the fixture holds on
      // any fork taken after that day.
      "endpoint-view-executable": {
        srcEid: "30110",
        sender: OFT_REFERENCE_ADDRESSES["42161"],
        nonce: "28910",
        receiver: OFT_REFERENCE_ADDRESSES["1"],
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
      // 3 is Executed; see the fixture above.
      "endpoint-view-executable": [{ equals: "3" }],
    },
    // oft-approve runs. An earlier revision skipped it as "a write
    // requiring a USDT balance"; that reason was wrong twice over. ERC-20
    // approve records an allowance and never reads the caller's balance,
    // and the chain-1 sweep is not read-only anyway - wrapped.ts writes on
    // the same mainnet fork and sky.ts provisions tokens through
    // requiredTokens. Leaving it skipped left the protocol's only write
    // with no end-to-end coverage.
    //
    // The real constraint is USDT-specific and worth knowing before this
    // fixture is edited: USDT's approve reverts when it would move a
    // non-zero allowance straight to another non-zero value
    // (`require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))`).
    // So the fixture depends on the allowance being zero when it runs, and
    // on it running once per fork.
    //
    // Zero at the start, per actor. Tier 1 does not sign at all: it sends
    // from SIM_WALLET through anvil impersonation, and that account's live
    // mainnet allowance to the adapter is 0 (eth_call, 2026-09-08). Tier 2
    // signs with the persistent Turnkey test wallet, whose address lives
    // in the CI database rather than this repo, so its live allowance is
    // asserted by the fixture rather than checked here: if that wallet
    // ever approves USDT to this adapter on real mainnet, every fresh fork
    // inherits the allowance and this write starts reverting.
    //
    // Once per fork. planPhaseFixtures maps one case per action
    // (lib/test-data/plan.ts), run-fixture.ts fires the webhook once per
    // case and never re-fires, and the five trigger variants give no test
    // signal on the webhook path so they are not enumerated (see that
    // file's header). vitest.config.mts sets no `retry` and the shard
    // command passes none. A GitHub job re-run starts a new anvil, so it
    // re-forks rather than replaying against used state; the nightly fork
    // cache holds anvil's upstream fetches, not local mutations.
    //
    // The runner re-fire case is the one worth spelling out, because
    // `maxRetries = 0` reads like it only governs failures. The executor
    // re-delivers a step when its completion event is lost, and
    // @workflow/core's step handler counts `step_started` events and
    // checks `step.attempt > maxRetries + 1` *before* running the step
    // body. That package is not a direct dependency, which is why no
    // version for it appears in package.json: it arrives under
    // `workflow` 4.8.5 (package.json:158) and is pinned as
    // `@workflow/core@4.8.5` in pnpm-lock.yaml, so the citation is
    // checkable from the repo - dist/runtime/step-handler.js:264 in
    // that version, verified 2026-09-09. A re-fire arrives
    // as attempt 2, trips that guard at 2 > 1, and is failed by event
    // without calling protocolWriteStep again. So a second approve cannot
    // be broadcast from one execution.
    //
    // The oracle asserts nonZero rather than equals for a different
    // reason: writeExpectations must stay history-safe on a long-lived
    // fork.
    writeExpectations: {
      "oft-approve": [
        { read: "oft-check-allowance", expect: { nonZero: true } },
      ],
    },
  },
};

export default defineAbiProtocol({
  name: "LayerZero",
  slug: "layerzero",
  description:
    "LayerZero V2 omnichain tokens (OFT) and endpoint configuration. Quote crosschain transfer fees, inspect an OFT's peers and approval needs, and read the send library and DVN configuration a lane will use before you trust it.",
  website: "https://layerzero.network",
  icon: "/protocols/layerzero.png",

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
            fee: {
              label:
                "Messaging Fee (nativeFee, lzTokenFee, each in its token's smallest unit)",
            },
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
            "Decide the approval step from this value alone. true means this OFT pulls the underlying token via transferFrom before sending, so run OFT Approve first; false means it does not. Do not infer it from whether the underlying token differs from the OFT: a Mint and Burn OFT Adapter is a separate contract holding mint and burn rights over an existing token, so it reports false while still having a distinct token address.",
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
            "Do not infer approval from this address; use OFT Approval Required for that. This is the ERC-20 the OFT moves: its own address when the OFT is itself the token, and a separate contract for every adapter style, both the one that locks and unlocks the token and the one that mints and burns a separate token it has rights over. So a differing address does not tell you an approval is needed.",
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

    // The ERC-20 ABI declares approve with no outputs, rather than the bool
    // the general ERC-20 shape returns. USDT returns no data at all, and
    // chain 1's reference token is USDT, so the declaration has to cover
    // both shapes.
    //
    // The mismatch is not inert, which is what a bool declaration would
    // assume. On the EOA path, EvmChainAdapter.executeContractCall runs a
    // preflight `staticCall` before broadcasting (lib/web3/chain-adapter/
    // evm.ts), and ethers decodes that call's return data against the
    // declared outputs. Against USDT it decodes "0x" as a bool and throws
    // BAD_DATA, so the approve fails before it is sent, with "Contract
    // returned no data, but the ABI you supplied declares 1 output (bool)".
    // It is a decode error reported as a contract failure.
    //
    // Only that path decodes. Safe, Safe-role and Turnkey-sponsored sends
    // encode the call and estimate gas without a staticCall
    // (lib/safe/execute-as-safe.ts, lib/web3/sponsored-transaction-manager.ts),
    // so a bool declaration survives them. Stating this precisely matters:
    // the same node, ABI and token fails for an EOA connection and succeeds
    // for a Safe one, so a repro that omits the signer mode proves nothing.
    //
    // An empty `outputs` decodes both shapes: ethers reads nothing and
    // ignores the 32 bytes a conforming token returns. Nothing downstream
    // loses information, because a write step surfaces no return value
    // either way - writeContractCore returns `result: undefined`.
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
            "Whether this endpoint supports the destination endpoint ID. It returns true only when both the default send library and the default receive library are set, meaning messages can be routed there at all.",
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

    endpointV2View: {
      label: "LayerZero EndpointV2View",
      abi: JSON.stringify(layerzeroEndpointV2ViewAbi),
      addresses: ENDPOINT_V2_VIEW_ADDRESSES,
      overrides: {
        executable: {
          slug: "endpoint-view-executable",
          label: "Endpoint Message Executable",
          description:
            "Where an inbound message stands on this (the destination) chain: 0 not yet verified, 1 verified but waiting on an earlier nonce, 2 ready to execute, 3 executed. 3 is also returned when the receiving app cleared the message without executing it, and it does not cover lzCompose.",
          docUrl: LAYERZERO_PROTOCOL_DOCS,
          inputs: {
            srcEid: {
              label: "Source Endpoint ID",
              // Solana's endpoint IDs are named here and nowhere else in the
              // file. The source may be non-EVM -- that is what the bytes32
              // sender is for -- and a user polling a Solana send has no
              // other way to learn the ID. A wrong one returns 0 forever,
              // which reads as "not delivered yet" rather than "wrong lane".
              // It says nothing about destinations: the action's network
              // picker is EVM-only, and Solana has no view contract.
              helpTip: `LayerZero endpoint ID of the chain the message was sent from, not the EVM chain ID. ${EID_TABLE} A non-EVM source works too, with its sender given as bytes32: Solana 30168, Solana Devnet 40168.`,
              docUrl: LAYERZERO_DEPLOYMENTS_DOCS,
            },
            sender: {
              label: "Sender (OApp on the source chain)",
              helpTip:
                "The OApp that sent the message on the source chain, for example the source OFT. An EVM address is padded to the bytes32 the endpoint expects; a bytes32 value is passed as-is.",
              docUrl: LAYERZERO_PROTOCOL_DOCS,
            },
            nonce: {
              label: "Message Nonce",
              helpTip:
                "The nonce of the message on its sender, receiver and source endpoint path, as carried in the source chain's PacketSent event.",
              docUrl: LAYERZERO_PROTOCOL_DOCS,
            },
            receiver: {
              label: "Receiver (OApp on this chain)",
              helpTip: "The OApp the message is addressed to on this chain.",
              docUrl: LAYERZERO_PROTOCOL_DOCS,
            },
          },
          outputs: {
            result: {
              name: "state",
              label:
                "Execution State (0 not executable, 1 verified but not executable, 2 executable, 3 executed)",
            },
          },
        },
      },
    },
  },
});
