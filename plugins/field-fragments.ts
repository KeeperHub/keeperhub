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
  return {
    editorRenderer: "send-mode",
    helpTip: noRelay
      ? `How the transaction goes out. "transaction" (the default) sends it to the public mempool. "private-relay" is refused at save, and so is usePrivateMempool: true on a network with a private relay. ${noRelay}`
      : 'How the transaction goes out. "transaction" (the default) sends it to the public mempool. "private-relay" sends it through the network\'s private relay (Flashbots Protect on Ethereum), only on networks that have one, and is never gas-sponsored. A config with usePrivateMempool: true and no sendMode uses the private relay where the network has one and the public mempool elsewhere, never sponsored.',
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
    showWhen: { computed: "simulatesNextBlock" },
    step: 1,
    type: "number",
  };
}

export function simulationOutput(): OutputField {
  return {
    description:
      "The predicted block a Next block check ran against: { mode, baseBlock (the latest block used), assumedBlockNumber, assumedTimestamp, timestampOffsetSec, rpcMethod }. Absent with Latest block, and when the step failed before or without simulating (a settings or RPC support error).",
    field: "simulation",
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
        "How KeeperHub routed the send on an EVM network: public (the public mempool, through your RPC or the chain's default RPC), private-relay (accepted by the private relay chosen in Send as) or sponsored (gas-sponsored). Through a Safe, the route of the transaction your wallet sent to the Safe. Absent when nothing was sent, or when only the private relay was tried and it never confirmed taking the transaction; more values may be added.",
    },
    {
      field: "included",
      description:
        "True when the transaction was seen in a block (one confirmation, not final); it may have reverted, so check error too. False when it was sent but is not in a block. Absent when route is absent.",
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
};
