/**
 * Shared field fragments for plugin action registries. Each factory returns a
 * fresh object so no field instance is aliased across actions - registry
 * consumers may treat per-action fields as their own.
 *
 * Only byte-identical repeats live here (three or more occurrences across
 * plugins/web3 and plugins/tempo at extraction time). A field that needs to
 * diverge from a fragment goes back to an inline literal in its action - do
 * not add override parameters here.
 */
import { NOT_LANDED_LATER } from "@/lib/errors/execution-status";
import {
  BUNDLE_SETTING_KEYS,
  BUNDLE_SETTING_LABELS,
  DEFAULT_BUNDLE_BLOCKS,
  DEFAULT_SEND_AHEAD_BLOCKS,
  MAX_BUNDLE_BLOCKS,
  MAX_SELECTED_BUILDERS,
  MAX_SEND_AHEAD_BLOCKS,
  MAX_TIP_INCREASE_PERCENT,
} from "@/lib/web3/bundles/settings";
import {
  MAX_SIMULATE_TIMESTAMP_OFFSET_SEC,
  MIN_SIMULATE_TIMESTAMP_OFFSET_SEC,
} from "@/lib/web3/next-block-limits";
import {
  SEND_MODE_KEY,
  SEND_MODE_OPTIONS,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
  OutputField,
} from "@/plugins/registry";

export function solanaNetworkField(): ActionConfigField {
  return {
    chainTypeFilter: "solana",
    key: "network",
    label: "Network",
    placeholder: "Select network",
    required: true,
    type: "chain-select",
  };
}

export function evmNetworkField(): ActionConfigField {
  return {
    chainTypeFilter: "evm",
    key: "network",
    label: "Network",
    placeholder: "Select network",
    required: true,
    type: "chain-select",
  };
}

/**
 * "Send as", right under Network on every write step that can use a private
 * relay. Listed only when the chain offers more than Normal; see
 * lib/web3/send-mode.ts for how a config is read. `actionType` drops the
 * choices that action cannot send with yet.
 */
export function sendModeField(actionType?: string): ActionConfigFieldBase {
  const noRelay = unsupportedSendMode(actionType, "private-relay");
  const bundle = unsupportedSendMode(actionType, "bundle")
    ? ""
    : ` "bundle" sends it only to the network's block builders for the next 1 to ${MAX_BUNDLE_BLOCKS} blocks (bundleBlocks), never gas-sponsored and never included if it would revert; only on networks with builders, for organizations where bundles are turned on, with your wallet (EOA) connection, and not inside a For Each nested in another For Each.`;
  return {
    editorRenderer: "send-mode",
    helpTip: noRelay
      ? `How the transaction goes out. "transaction" (the default) sends it to the public mempool. "private-relay" is refused at save, and so is usePrivateMempool: true on a network with a private relay. ${noRelay}`
      : `How the transaction goes out. "transaction" (the default) sends it to the public mempool. "private-relay" sends it through the network's private relay (Flashbots Protect on Ethereum), only on networks that have one, and is never gas-sponsored.${bundle} A config with usePrivateMempool: true and no sendMode uses the private relay where the network has one and the public mempool elsewhere, never sponsored.`,
    key: SEND_MODE_KEY,
    label: "Send as",
    networkField: "network",
    options: SEND_MODE_OPTIONS.filter(
      ({ value }) => !unsupportedSendMode(actionType, value)
    ).map(({ value, label, description }) => ({
      description,
      label,
      value,
    })),
    type: "select",
  };
}

const SHOW_FOR_BUNDLE = { field: SEND_MODE_KEY, equals: "bundle" } as const;

/**
 * Write Contract's bundle settings, drawn by Send as in one box under it; see
 * readBundleSettings in lib/web3/bundles/settings.ts for how a step reads them.
 */
export function bundleSettingsFields(): ActionConfigFieldBase[] {
  return [
    {
      editorRenderer: "bundle-setting",
      helpText: "Each block keeps the wallet busy for about 12 seconds more.",
      helpTip: `Bundle only: how many blocks to try, starting with the next one, one signed transaction each. A whole number from 1 to ${MAX_BUNDLE_BLOCKS}; empty means ${DEFAULT_BUNDLE_BLOCKS}. Each block adds about 12 seconds while the wallet waits for the result.`,
      key: BUNDLE_SETTING_KEYS.blocks,
      label: BUNDLE_SETTING_LABELS.blocks,
      max: MAX_BUNDLE_BLOCKS,
      min: 1,
      placeholder: String(DEFAULT_BUNDLE_BLOCKS),
      showWhen: SHOW_FOR_BUNDLE,
      step: 1,
      type: "number",
    },
    {
      editorRenderer: "bundle-setting",
      helpTip: `Bundle only: how much higher the tip is for each later block, compounded, starting from Priority Fee. Later tips stop at the network's tip limit, and the step raises its fee cap to pay them, up to Max Fee (10,000 gwei when empty). A whole number from 0 to ${MAX_TIP_INCREASE_PERCENT}; empty means 0.`,
      key: BUNDLE_SETTING_KEYS.tipIncreasePercent,
      label: BUNDLE_SETTING_LABELS.tipIncreasePercent,
      max: MAX_TIP_INCREASE_PERCENT,
      min: 0,
      placeholder: "0",
      showWhen: SHOW_FOR_BUNDLE,
      step: 1,
      type: "number",
    },
    {
      editorRenderer: "bundle-setting",
      helpText:
        "Includes builders the network adds later. Untick it to pick some, at least one; new builders are then not added.",
      helpTip: `Bundle only: the names of the network's block builders to send to (GET /api/chains lists them as bundleBuilders), up to ${MAX_SELECTED_BUILDERS}. Leave it out, or send [], to send to all of them, including builders added later.`,
      key: BUNDLE_SETTING_KEYS.builders,
      label: BUNDLE_SETTING_LABELS.builders,
      max: MAX_SELECTED_BUILDERS,
      showWhen: SHOW_FOR_BUNDLE,
      type: "multi-select",
    },
    {
      editorRenderer: "bundle-setting",
      helpTip: `Bundle only, optional: the bundle never lands in a block before this time. Unix seconds (such as 1796126400) or an ISO 8601 date with a time zone (such as 2026-12-01T12:00:00Z); a template is read when the run starts (a number, its text, or such a date). A 13-, 16- or 19-digit value is refused (milliseconds, microseconds, nanoseconds), and so is Not before on a network without fixed slots. While the first block that cannot be earlier is more than Send ahead + 1 blocks away, the step sends nothing and the run ends Skipped (Waiting). Empty: sends for the next blocks.`,
      key: BUNDLE_SETTING_KEYS.notBefore,
      label: BUNDLE_SETTING_LABELS.notBefore,
      placeholder: "1796126400",
      showWhen: SHOW_FOR_BUNDLE,
      type: "template-input",
    },
    {
      editorRenderer: "bundle-setting",
      helpTip: `Bundle with Not before only: how many blocks before the first allowed block the step may already send, so the builders hold the bundle when that block starts. A whole number from 0 to ${MAX_SEND_AHEAD_BLOCKS}, no templates; empty means ${DEFAULT_SEND_AHEAD_BLOCKS}. With Target blocks, at most ${MAX_BUNDLE_BLOCKS}.`,
      key: BUNDLE_SETTING_KEYS.sendAheadBlocks,
      label: BUNDLE_SETTING_LABELS.sendAheadBlocks,
      max: MAX_SEND_AHEAD_BLOCKS,
      min: 0,
      placeholder: String(DEFAULT_SEND_AHEAD_BLOCKS),
      showWhen: SHOW_FOR_BUNDLE,
      step: 1,
      type: "number",
    },
  ];
}

export function tokenConfigField(): ActionConfigField {
  return {
    key: "tokenConfig",
    label: "Token",
    networkField: "network",
    required: true,
    type: "token-select",
  };
}

export function amountField(): ActionConfigField {
  return {
    example: "100.50",
    key: "amount",
    label: "Amount",
    placeholder: "100.50 or {{NodeName.amount}}",
    required: true,
    type: "template-input",
  };
}

export function contractAddressField(): ActionConfigFieldBase {
  return {
    example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    key: "contractAddress",
    label: "Contract Address",
    placeholder: "0x... or {{NodeName.contractAddress}}",
    required: true,
    type: "template-input",
  };
}

/**
 * The "Fail workflow on error" toggle shared by the web3 read actions. When
 * off, a failed on-chain read hands the next node a soft error instead of
 * failing the run, so one bad item inside a For Each loop does not abort it.
 * See softenReadFailure in plugins/web3/steps/read-fail-on-error-core.ts for
 * which failures qualify.
 */
export function readFailOnErrorField(helpTip?: string): ActionConfigField {
  return {
    defaultValue: "true",
    helpTip:
      helpTip ??
      "When off, a failed read passes a soft error to the next node instead of failing the run, so one bad item in a For Each loop does not abort it. This covers the call itself and the ABI, function and arguments you send. Only problems that leave the step with nowhere to call - an invalid address, an unknown network, or unresolved RPC config - still fail the run, matching HTTP Request, which softens every response but refuses to soften an unusable URL.",
    key: "failOnError",
    label: "Fail workflow on error",
    type: "fail-on-error-switch",
  };
}

/**
 * The "Sponsor gas" toggle shared by the web3 write actions that have a
 * sponsored route. On (the default) the action tries Turnkey Gas Station
 * first and falls back to direct signing; off skips the sponsored route
 * outright, so the transaction is always signed and paid for by the org's
 * own wallet. See resolveSponsorGas in lib/web3/sponsorship-feature-flag.ts.
 */
export function sponsorGasField(): ActionConfigFieldBase {
  return {
    defaultValue: "true",
    helpTip:
      "When on, the transaction goes through gas sponsorship first and falls back to your own wallet if sponsorship is unavailable on this network or your credits are spent. Turn it off to always pay gas from your own wallet. Sponsorship is never used when Send as is not Normal transaction or the node signs through a Safe, and on Write Contract when Simulate at is set to Next block.",
    key: "sponsorGas",
    label: "Sponsor gas",
    // Hidden on a network the Gas Station does not cover, where the toggle
    // could only ever turn off something that was never available.
    showWhen: { computed: "sponsorshipSupported", networkField: "network" },
    type: "gas-sponsorship-switch",
  };
}

const NOT_BUNDLE = { field: SEND_MODE_KEY, notEquals: "bundle" } as const;

/**
 * "Simulate at" on Read Contract, Write Contract and Batch Write Contract.
 * See parseSimulationSettings in lib/web3/next-block-limits.ts.
 */
export function simulateAtField(): ActionConfigFieldBase {
  return {
    defaultValue: "latest",
    helpTip:
      "Next block checks the call as if the next block had already arrived, so a call that unlocks in the next block is treated as unlocked one block sooner. Needs an RPC that can simulate a future block. On a write, gas sponsorship is off, so the paying wallet needs native gas. See the docs before using it on a write.",
    key: "simulateAt",
    label: "Simulate at",
    options: [
      { label: "Latest block", value: "latest" },
      { label: "Next block", value: "next-block" },
    ],
    // A bundle simulates each of its own target blocks instead.
    showWhen: NOT_BUNDLE,
    type: "select",
  };
}

export function simulateTimestampOffsetField(): ActionConfigFieldBase {
  return {
    helpTip: `Block time in seconds, from ${MIN_SIMULATE_TIMESTAMP_OFFSET_SEC} to ${MAX_SIMULATE_TIMESTAMP_OFFSET_SEC}. Leave empty to use this network's block time. The next block is assumed one block time after the latest one. On Ethereum, Ethereum Sepolia and Ethereum Hoodi it is the earliest 12-second slot the transaction can still land in, and this value only matters above 12. A value above the real block time makes the check pass early.`,
    key: "simulateTimestampOffsetSec",
    label: "Next block timestamp offset (seconds)",
    max: MAX_SIMULATE_TIMESTAMP_OFFSET_SEC,
    min: MIN_SIMULATE_TIMESTAMP_OFFSET_SEC,
    placeholder: "Auto (network block time)",
    // Read as the step reads it, so "Next-Block" saved via the API shows too.
    showWhen: { all: [{ computed: "simulatesNextBlock" }, NOT_BUNDLE] },
    step: 1,
    type: "number",
  };
}

export function simulationOutput(): OutputField {
  return {
    description:
      'The predicted block a Next block check (or, on Read Contract, an At a time check) ran against: { mode ("next-block" or "time"), baseBlock (the latest block used), assumedBlockNumber, assumedTimestamp, timestampOffsetSec (Next block only), rpcMethod }. Absent with Latest block, and when the step failed before or without simulating (a settings or RPC support error).',
    field: "simulation",
  };
}

export function broadcastOutput(): OutputField {
  return {
    description:
      "When and how the transaction was sent: { broadcastAt (ISO time the RPC accepted it), via (primary or fallback RPC), builders? }. builders is present only with Next block on a network with block builders that take single signed transactions (none by default): [{ name, accepted, error? }] per builder that was also sent the transaction, accepted true when it answered with the transaction hash or said it already had it, false when it refused or could not be reached, null when its answer was unclear. When the RPC failed but the transaction was found anyway, only builders is set (no broadcast when no builders were sent it). Absent on a failed step, on gas-sponsored or Safe sends, and on Send as Bundle (see builders).",
    field: "broadcast",
  };
}

export function transactionLinkOutput(): OutputField {
  return {
    description: "Explorer link to view the transaction",
    field: "transactionLink",
  };
}

export function checkErrorOutput(): OutputField {
  return {
    description:
      "Error message if the check failed. Also set when failOnError is off and a failed read was softened into success=true.",
    field: "error",
  };
}

export function transferSuccessOutput(): OutputField {
  return {
    description: "Whether the transfer succeeded",
    field: "success",
  };
}

export function transferErrorOutput(): OutputField {
  return {
    description: "Error message if the transfer failed",
    field: "error",
  };
}

/** Where a write was sent and whether it is in a block, on every EVM write action. */
export function sendRouteOutputFields(): OutputField[] {
  return [
    {
      field: "route",
      description:
        "How KeeperHub routed the send on an EVM network: public (the public mempool, through your RPC or the chain's default RPC), private-relay (accepted by the private relay chosen in Send as), sponsored (gas-sponsored), bundle (Write Contract sent as a bundle to block builders), skipped-in-flight (Write Contract with Send as Bundle sent nothing because this workflow's earlier bundle could still land) or waiting (Write Contract with Send as Bundle sent nothing because its Not before time is still too far ahead, or Max Fee held back the targets ahead). Through a Safe, the route of the transaction your wallet sent to the Safe. Absent when nothing was sent (except skipped-in-flight and waiting), or when only the private relay was tried and it never confirmed taking the transaction; more values may be added.",
    },
    {
      field: "included",
      description:
        "True when the transaction was seen in a block (one confirmation, not final); it may have reverted, so check error too. False when it was sent but is not in a block, and on a skipped-in-flight or waiting bundle step. Absent when route is absent.",
    },
  ];
}

/** Write Contract outputs when Send as is Bundle (sendMode "bundle"). */
export function bundleOutputFields(): OutputField[] {
  return [
    {
      field: "includedBlock",
      description:
        'Bundle only (route "bundle"): the block the transaction was included in. Absent when it was not included.',
    },
    {
      field: "notIncludedReason",
      description: `Bundle only: why the bundle did not land in any of its blocks. not-picked: no builder included it, though the call would still succeed. no-longer-needed: the call would now revert, so no builder could include it. not-checked: KeeperHub could not tell whether it landed (the network could not be read in time, or this step ran again after sending its bundle); it may still land. With it, success is true, included is false, there is no transactionHash, and the run ends Not landed. No gas is paid unless it lands. ${NOT_LANDED_LATER} This step's output is not updated.`,
    },
    {
      field: "targetBlocks",
      description:
        "Bundle only: the block numbers the bundle was sent for, in order.",
    },
    {
      field: "targetTipsGwei",
      description:
        "Bundle only: the maximum priority fee (tip) in gwei of the transaction sent for each target block, in the order of targetBlocks. The tip paid can be lower when the base fee leaves less room under the fee cap.",
    },
    {
      field: "builders",
      description:
        "Bundle only: one entry per block builder, { name, accepted, error? }. accepted is true when the builder took the bundle for any target, false when it refused every one, null when its answer was unclear. error is the builder's answer (shortened, links and long hex removed) or a KeeperHub note when there was no usable answer (no answer in time, unreadable answer, ...).",
    },
    {
      field: "bundleTargetsSkipped",
      description:
        "Bundle only: blocks no transaction was sent for, { block, reason }, where reason is simulation-failed, target-passed or max-fee-below-projected-base-fee. Absent when none were skipped.",
    },
    {
      field: "inFlightUntilBlock",
      description:
        'Bundle only (route "skipped-in-flight"): the block after which the earlier bundle this step waited behind can no longer land.',
    },
    {
      field: "notBefore",
      description:
        "Bundle with Not before only: the Not before time the step used, in unix seconds (a value past 9999999999 counts as 9999999999).",
    },
    {
      field: "firstAllowedBlock",
      description:
        'Bundle with Not before only: the first block number that cannot have a timestamp before Not before. On route "waiting" it was still more than Send ahead + 1 blocks after latestBlock, so nothing was sent; otherwise the targets start at it (or at the next block, if it has passed).',
    },
    {
      field: "latestBlock",
      description:
        "Bundle with Not before only: the latest block KeeperHub read when it decided to wait or planned the targets.",
    },
    {
      field: "sendAheadBlocks",
      description:
        "Bundle with Not before only: the Send ahead setting the step used (how many blocks before firstAllowedBlock it may send).",
    },
  ];
}

export function receiptChainIdOutput(): OutputField {
  return {
    description: "Chain the transaction was broadcast on. Required for on-chain receipt verification: a step that reports a transactionHash without a chainId fails the execution closed.",
    field: "chainId",
  };
}

export function tempoChainIdOutput(): OutputField {
  return {
    description: "The Tempo chain id used",
    field: "chainId",
  };
}

export function balanceCheckSuccessOutput(): OutputField {
  return {
    description:
      "Whether the balance check succeeded. Also true when failOnError is off and a failed read was softened; the balance fields are null and `error` is set.",
    field: "success",
  };
}

export function transferAmountOutput(): OutputField {
  return {
    description: "The amount transferred (human-readable)",
    field: "amount",
  };
}

export function tokenSymbolOutput(): OutputField {
  return {
    description: "The token symbol (e.g., USDC)",
    field: "symbol",
  };
}

export function executedCallContractAddressOutput(): OutputField {
  return {
    description: "Address the executed call actually hit",
    field: "executedCall.contractAddress",
  };
}

export function executedCallArgsOutput(): OutputField {
  return {
    description: "Decoded arguments of the executed call, keyed by name",
    field: "executedCall.args",
  };
}

export function executedCallFromOutput(): OutputField {
  return {
    description:
      "Sender of the trace frame that hit the target: the organization's wallet even when a relayer sent the transaction, the Safe when routed through one, or the delegating proxy when the target is an implementation reached by DELEGATECALL",
    field: "executedCall.from",
  };
}

export function executedCallSponsoredOutput(): OutputField {
  return {
    description: "Whether the transaction was routed through a gas-sponsorship relayer/wrapper",
    field: "executedCall.sponsored",
  };
}

export function executedCallRevertedOutput(): OutputField {
  return {
    description: "Whether the executed call frame reverted",
    field: "executedCall.reverted",
  };
}

export function querySuccessOutput(): OutputField {
  return {
    description: "Whether the query succeeded",
    field: "success",
  };
}

export function queryErrorOutput(): OutputField {
  return {
    description: "Error message if the query failed",
    field: "error",
  };
}

export function fromWalletOutput(): OutputField {
  return {
    description: "The sending wallet address",
    field: "from",
  };
}

/**
 * Name-to-factory map of the output fragments, for tooling that resolves
 * fragment calls found in plugin index sources (see
 * tests/unit/step-transaction-hash-chain-id.test.ts).
 */
export const outputFragmentFactories: Record<string, () => OutputField> = {
  transactionLinkOutput,
  checkErrorOutput,
  transferSuccessOutput,
  transferErrorOutput,
  receiptChainIdOutput,
  tempoChainIdOutput,
  balanceCheckSuccessOutput,
  transferAmountOutput,
  tokenSymbolOutput,
  executedCallContractAddressOutput,
  executedCallArgsOutput,
  executedCallFromOutput,
  executedCallSponsoredOutput,
  executedCallRevertedOutput,
  querySuccessOutput,
  queryErrorOutput,
  fromWalletOutput,
  simulationOutput,
  broadcastOutput,
};
