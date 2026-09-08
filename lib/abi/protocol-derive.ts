/**
 * ABI-Driven Protocol Action Derivation
 *
 * Parses a reduced ABI (the subset of functions to expose) and generates
 * ProtocolAction[] with slugs, labels, types, inputs, and outputs inferred
 * from Solidity types. Overrides provide the editorial layer on top.
 */

import type {
  AbiEntry,
  AbiEventEntry,
  AbiFunctionEntry,
  AbiParam,
} from "@/lib/abi/types";
import type {
  ProtocolAction,
  ProtocolActionInput,
  ProtocolActionInputComponent,
  ProtocolActionOutput,
  ProtocolEvent,
  ProtocolEventInput,
} from "@/lib/protocol-registry";

// -- Override types ----------------------------------------------------------

export type AbiInputOverride = {
  name?: string;
  label?: string;
  helpTip?: string;
  docUrl?: string;
  default?: string;
  hidden?: boolean;
  required?: boolean;
  advanced?: boolean;
  decimals?: boolean | number;
  fieldType?: string;
};

export type AbiOutputOverride = {
  name?: string;
  label?: string;
  decimals?: number;
};

/**
 * Override applied to an ABI function. Override keys for `inputs` and
 * `outputs` are the raw ABI param names (or `arg<index>` / `result` /
 * `result<index>` defaults if the ABI declares the param unnamed) - NOT
 * post-rename display names. Renaming via override.inputs.<rawName>.name
 * changes the resulting input.name (form field key) but does not change
 * the lookup key for further overrides.
 */
export type AbiFunctionOverride = {
  slug?: string;
  label?: string;
  description?: string;
  docUrl?: string;
  inputs?: Record<string, AbiInputOverride>;
  outputs?: Record<string, AbiOutputOverride>;
  /** Default value for the gas-limit-multiplier field. Mode + value
   *  match parseGasLimitConfig in lib/web3/gas-defaults.ts. Only meaningful
   *  on write actions; ignored on reads. */
  gasLimit?: { mode: "maxGasLimit" | "multiplier"; value: string };
};

/**
 * Override applied to an ABI event. The lookup key in
 * AbiDrivenContract.events is the raw event name from the ABI (e.g.
 * "TokensMinted"), not the kebab-case slug.
 */
export type AbiEventOverride = {
  slug?: string;
  label?: string;
  description?: string;
};

// -- Helpers -----------------------------------------------------------------

const UPPERCASE_BOUNDARY = /([a-z0-9])([A-Z])/g;
const CONSECUTIVE_UPPERCASE = /([A-Z]+)([A-Z][a-z])/g;

export function camelToKebab(s: string): string {
  return s
    .replace(UPPERCASE_BOUNDARY, "$1-$2")
    .replace(CONSECUTIVE_UPPERCASE, "$1-$2")
    .toLowerCase();
}

export function camelToTitle(s: string): string {
  const spaced = s
    .replace(UPPERCASE_BOUNDARY, "$1 $2")
    .replace(CONSECUTIVE_UPPERCASE, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isReadOnly(stateMutability: string): boolean {
  return stateMutability === "view" || stateMutability === "pure";
}

function defaultInputName(index: number): string {
  return `arg${index}`;
}

function defaultOutputName(index: number, total: number): string {
  return total === 1 ? "result" : `result${index}`;
}

// -- Derivation --------------------------------------------------------------

function toInputComponents(
  params: AbiParam[] | undefined
): ProtocolActionInputComponent[] | undefined {
  if (!params || params.length === 0) {
    return undefined;
  }
  return params.map((p) => ({
    name: p.name,
    type: p.type,
    ...(p.components ? { components: toInputComponents(p.components) } : {}),
  }));
}

function isFlattenableTuple(param: AbiParam): boolean {
  return (
    param.type === "tuple" &&
    param.components !== undefined &&
    param.components.length > 0
  );
}

function deriveInput(
  param: AbiParam,
  index: number,
  override: AbiInputOverride | undefined
): ProtocolActionInput | null {
  if (override?.hidden) {
    return null;
  }

  const rawName = param.name || defaultInputName(index);
  const name = override?.name ?? rawName;
  const label = override?.label ?? camelToTitle(rawName);

  const input: ProtocolActionInput = {
    name,
    type: override?.fieldType ?? param.type,
    label,
  };

  if (override?.default !== undefined) {
    input.default = override.default;
  }
  if (override?.required !== undefined) {
    input.required = override.required;
  }
  if (override?.advanced) {
    input.advanced = true;
  }
  if (override?.docUrl !== undefined) {
    input.docUrl = override.docUrl;
  }
  if (override?.helpTip !== undefined) {
    input.helpTip = override.helpTip;
  }
  if (override?.decimals !== undefined) {
    input.decimals = override.decimals;
  }

  const components = toInputComponents(param.components);
  if (components) {
    input.components = components;
  }

  return input;
}

function deriveTupleInputs(
  param: AbiParam,
  overrides: Record<string, AbiInputOverride> | undefined
): ProtocolActionInput[] {
  const inputs: ProtocolActionInput[] = [];
  const components = param.components ?? [];
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    const compOverride = overrides?.[comp.name || defaultInputName(i)];
    const derived = deriveInput(comp, i, compOverride);
    if (derived) {
      inputs.push(derived);
    }
  }
  return inputs;
}

function deriveOutput(
  param: AbiParam,
  index: number,
  total: number,
  override: AbiOutputOverride | undefined
): ProtocolActionOutput {
  const rawName = param.name || defaultOutputName(index, total);
  const name = override?.name ?? rawName;
  const label = override?.label ?? camelToTitle(rawName);

  const output: ProtocolActionOutput = {
    name,
    type: param.type,
    label,
  };

  if (override?.decimals !== undefined) {
    output.decimals = override.decimals;
  }

  return output;
}

function deriveAction(
  contractKey: string,
  fn: AbiFunctionEntry,
  override: AbiFunctionOverride | undefined
): ProtocolAction {
  const slug = override?.slug ?? camelToKebab(fn.name);
  const label = override?.label ?? camelToTitle(fn.name);
  const description =
    override?.description ?? `Call ${fn.name} on the contract`;
  const docUrl = override?.docUrl;
  const actionType = isReadOnly(fn.stateMutability) ? "read" : "write";
  const payable = fn.stateMutability === "payable";

  const inputs: ProtocolActionInput[] = [];
  for (let i = 0; i < fn.inputs.length; i++) {
    const param = fn.inputs[i];
    const paramKey = param.name || defaultInputName(i);

    if (isFlattenableTuple(param)) {
      const tupleInputs = deriveTupleInputs(param, override?.inputs);
      for (const inp of tupleInputs) {
        inputs.push(inp);
      }
    } else {
      const inputOverride = override?.inputs?.[paramKey];
      const derived = deriveInput(param, i, inputOverride);
      if (derived) {
        inputs.push(derived);
      }
    }
  }

  const outputs: ProtocolActionOutput[] = [];
  if (fn.outputs.length > 0) {
    for (let i = 0; i < fn.outputs.length; i++) {
      const param = fn.outputs[i];
      const paramKey = param.name || defaultOutputName(i, fn.outputs.length);
      const outputOverride = override?.outputs?.[paramKey];
      outputs.push(deriveOutput(param, i, fn.outputs.length, outputOverride));
    }
  }

  const action: ProtocolAction = {
    slug,
    label,
    description,
    type: actionType,
    contract: contractKey,
    function: fn.name,
    inputs,
  };

  if (docUrl !== undefined) {
    action.docUrl = docUrl;
  }

  if (override?.gasLimit !== undefined) {
    action.gasLimitDefault = JSON.stringify(override.gasLimit);
  }

  if (outputs.length > 0) {
    action.outputs = outputs;
  }

  if (payable) {
    action.payable = true;
  }

  return action;
}

// -- Public API --------------------------------------------------------------

export type AbiDrivenContract = {
  label: string;
  abi: string;
  addresses: Record<string, string>;
  userSpecifiedAddress?: boolean;
  overrides?: Record<string, AbiFunctionOverride>;
  events?: Record<string, AbiEventOverride>;
};

export type AbiDrivenProtocolInput = {
  name: string;
  slug: string;
  description: string;
  website?: string;
  icon?: string;
  testData?: import("../test-data/types").ProtocolTestData;
  contracts: Record<string, AbiDrivenContract>;
};

export function deriveActionsFromAbi(
  contractKey: string,
  contract: AbiDrivenContract
): ProtocolAction[] {
  const parsed: AbiEntry[] = JSON.parse(contract.abi);
  const functions = parsed.filter(
    (entry): entry is AbiFunctionEntry => entry.type === "function"
  );

  const actions: ProtocolAction[] = [];
  for (const fn of functions) {
    const override = contract.overrides?.[fn.name];
    actions.push(deriveAction(contractKey, fn, override));
  }

  return actions;
}

function deriveEvent(
  contractKey: string,
  evt: AbiEventEntry,
  override: AbiEventOverride | undefined
): ProtocolEvent {
  if (evt.anonymous === true) {
    throw new Error(
      `Anonymous event "${evt.name}" on contract "${contractKey}" cannot be derived: anonymous events have no topic-0 selector and cannot be matched by name downstream.`
    );
  }

  const slug = override?.slug ?? camelToKebab(evt.name);
  const label = override?.label ?? camelToTitle(evt.name);
  const description =
    override?.description ??
    `Fires when ${evt.name} is emitted by the contract`;

  const inputs: ProtocolEventInput[] = evt.inputs.map((p, i) => ({
    name: p.name || defaultInputName(i),
    type: p.type,
    indexed: p.indexed === true,
  }));

  return {
    slug,
    label,
    description,
    eventName: evt.name,
    contract: contractKey,
    inputs,
  };
}

export function deriveEventsFromAbi(
  contractKey: string,
  contract: AbiDrivenContract
): ProtocolEvent[] {
  const parsed: AbiEntry[] = JSON.parse(contract.abi);
  const eventEntries = parsed.filter(
    (entry): entry is AbiEventEntry => entry.type === "event"
  );

  const events: ProtocolEvent[] = [];
  for (const evt of eventEntries) {
    const override = contract.events?.[evt.name];
    events.push(deriveEvent(contractKey, evt, override));
  }

  return events;
}
