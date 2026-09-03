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
import type { ActionConfigField, OutputField } from "@/plugins/registry";

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

export function evmPrivateNetworkField(): ActionConfigField {
  return {
    chainTypeFilter: "evm",
    key: "network",
    label: "Network",
    placeholder: "Select network",
    required: true,
    showPrivateVariants: true,
    type: "chain-select",
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

export function contractAddressField(): ActionConfigField {
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
export function readFailOnErrorField(): ActionConfigField {
  return {
    defaultValue: "true",
    helpTip:
      "When off, a failed read passes a soft error to the next node instead of failing the run, so one bad item in a For Each loop does not abort it. This covers the call itself and the ABI, function and arguments you send. Only problems that leave the step with nowhere to call - an invalid address, an unknown network, or unresolved RPC config - still fail the run, matching HTTP Request, which softens every response but refuses to soften an unusable URL.",
    key: "failOnError",
    label: "Fail workflow on error",
    type: "fail-on-error-switch",
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
  executedCallSponsoredOutput,
  executedCallRevertedOutput,
  querySuccessOutput,
  queryErrorOutput,
  fromWalletOutput,
};
