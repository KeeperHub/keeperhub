import "@/protocols";

import {
  getProtocol,
  type ProtocolAction,
  type ProtocolActionOutput,
  type ProtocolContract,
  type ProtocolDefinition,
} from "@/lib/protocol-registry";

export type AbiFunctionFragment = {
  type: "function";
  name: string;
  stateMutability?: "pure" | "view" | "nonpayable" | "payable";
  inputs: AbiParameter[];
  outputs: AbiParameter[];
};

export type AbiParameter = {
  name?: string;
  type: string;
  components?: AbiParameter[];
  internalType?: string;
};

export type AbiSource = "abi-fragment" | "synthesised-from-action-metadata";

export type ProtocolActionContext = {
  actionId: string;
  protocolSlug: string;
  actionSlug: string;
  protocol: ProtocolDefinition;
  contract: ProtocolContract;
  contractKey: string;
  action: ProtocolAction;
  abiFragment: AbiFunctionFragment;
  abiSource: AbiSource;
};

function parseAbi(abiJson: string | undefined): unknown[] | null {
  if (!abiJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(abiJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findFunctionFragment(
  abi: unknown[],
  functionName: string
): AbiFunctionFragment | null {
  for (const item of abi) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "function" &&
      (item as { name?: unknown }).name === functionName
    ) {
      return item as AbiFunctionFragment;
    }
  }
  return null;
}

// Both ProtocolActionInput and ProtocolActionInputComponent share this
// minimal shape; ProtocolActionInput just carries extra UI metadata.
// One walker handles both via structural typing.
type AbiShapedInput = {
  name: string;
  type: string;
  components?: AbiShapedInput[];
};

function inputToAbiParameter(input: AbiShapedInput): AbiParameter {
  const result: AbiParameter = {
    name: input.name,
    type: input.type,
  };
  if (input.components && input.components.length > 0) {
    result.components = input.components.map(inputToAbiParameter);
  }
  return result;
}

function outputToAbiParameter(output: ProtocolActionOutput): AbiParameter {
  return { name: output.name, type: output.type };
}

function deriveStateMutability(
  action: ProtocolAction
): AbiFunctionFragment["stateMutability"] {
  if (action.type === "read") {
    return "view";
  }
  if (action.payable) {
    return "payable";
  }
  return "nonpayable";
}

function synthesiseFragmentFromAction(
  action: ProtocolAction
): AbiFunctionFragment {
  const stateMutability = deriveStateMutability(action);

  return {
    type: "function",
    name: action.function,
    stateMutability,
    inputs: action.inputs.map(inputToAbiParameter),
    outputs: action.outputs ? action.outputs.map(outputToAbiParameter) : [],
  };
}

function resolveAbiFragment(
  contract: ProtocolContract,
  action: ProtocolAction
): { fragment: AbiFunctionFragment; source: AbiSource } | null {
  const abi = parseAbi(contract.abi);
  if (abi) {
    const fragment = findFunctionFragment(abi, action.function);
    if (fragment) {
      return { fragment, source: "abi-fragment" };
    }
    // ABI is present but the function is missing -- treat as data error
    return null;
  }
  // Proxy contract or otherwise ABI-less: synthesise from action metadata.
  // Action.inputs/outputs already encode the function shape (per
  // protocols/aave-v3.ts and similar hand-defined protocols).
  return {
    fragment: synthesiseFragmentFromAction(action),
    source: "synthesised-from-action-metadata",
  };
}

export function getProtocolActionContext(
  actionId: string
): ProtocolActionContext | null {
  const slashIndex = actionId.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  const protocolSlug = actionId.slice(0, slashIndex);
  const actionSlug = actionId.slice(slashIndex + 1);

  const protocol = getProtocol(protocolSlug);
  if (!protocol) {
    return null;
  }

  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    return null;
  }

  const contract = protocol.contracts[action.contract];
  if (!contract) {
    return null;
  }

  const resolved = resolveAbiFragment(contract, action);
  if (!resolved) {
    return null;
  }

  return {
    actionId,
    protocolSlug,
    actionSlug,
    protocol,
    contract,
    contractKey: action.contract,
    action,
    abiFragment: resolved.fragment,
    abiSource: resolved.source,
  };
}
