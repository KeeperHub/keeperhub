/**
 * Shared calldata encoding for protocol registry actions.
 *
 * Resolves an action's testData bindings through buildActionWorkflow
 * (the same builder the e2e coverage suites use), applies encode
 * transforms, then runs the identical reshapeArgsForAbi and
 * coerceArgsForAbi pipeline the runtime protocol steps use, producing
 * the exact transaction the platform would send. Consumed by the Tier 0
 * golden-calldata tests, the Tier 1 fork simulation harness, and the
 * integration-test calldata builder
 * (tests/integration/_shared/build-calldata.ts) so all layers share one
 * encoding source of truth.
 */

import { Interface, parseEther } from "ethers";
import {
  coerceArgsForAbi,
  type FunctionAbiEntry,
  reshapeArgsForAbi,
} from "@/lib/abi/struct-args";
import { applyEncodeTransformsNamed } from "@/lib/protocol-encode-transforms";
import {
  getProtocol,
  type ProtocolAction,
  type ProtocolContract,
  type ProtocolDefinition,
  resolveContractAddress,
} from "@/lib/protocol-registry";
import {
  buildActionWorkflow,
  buildSetupWorkflow,
} from "@/lib/test-data/build-workflow";
import type { SetupOutputs } from "@/lib/test-data/types";
import type { AbiOutputParam } from "@/plugins/web3/steps/structure-abi-result";

function requireProtocol(slug: string): ProtocolDefinition {
  const def = getProtocol(slug);
  if (!def) {
    throw new Error(`protocol ${slug} not registered`);
  }
  return def;
}

export type EncodedAction = {
  to: string;
  data: string;
  /** msg.value in wei when the testData binds the virtual ethValue key. */
  value: bigint;
  iface: Interface;
  /** ABI output params from the resolved fragment JSON, retained so read
   *  simulations can structure decoded results without re-deriving them. */
  abiOutputs: AbiOutputParam[];
  /** The live ethers fragment; use for decodeFunctionResult (string
   *  re-resolution mangles tuple signatures). */
  ethersFragment: unknown;
};

/** Interfaces are immutable and ABI parsing is the hot cost of a sweep
 *  (every action of a contract re-parsed its full ABI); cache keyed on
 *  the contract object itself, not a slug/contract-name string, so a
 *  synthetic definition reusing the same slug and contract key with a
 *  different ABI can never be served a stale Interface. Registry
 *  contract objects are stable, so memoization still holds. */
const ifaceCache = new WeakMap<ProtocolContract, Interface>();

export function ifaceFor(
  protocol: ProtocolDefinition,
  action: ProtocolAction
): Interface {
  const contract = protocol.contracts[action.contract];
  if (!contract?.abi) {
    throw new Error(
      `${protocol.slug}: action ${action.slug} references missing contract or ABI "${action.contract}"`
    );
  }
  const cached = ifaceCache.get(contract);
  if (cached) {
    return cached;
  }
  const iface = new Interface(JSON.parse(contract.abi));
  ifaceCache.set(contract, iface);
  return iface;
}

/** The fragment JSON carries the outputs alongside the inputs
 *  FunctionAbiEntry declares; retaining them here saves consumers from
 *  re-parsing the fragment to structure decoded read results. */
type ParsedFragment = FunctionAbiEntry & { outputs?: AbiOutputParam[] };

/** Resolve the exact fragment for an action. Bare-name lookup throws on
 *  overload ambiguity, and registry actions flatten single-tuple params
 *  (deriveTupleInputs), so fragment arity can differ from the action's
 *  input count: prefer an exact-arity match, else a fragment whose
 *  flattened tuple arity matches. */
export function fragmentFor(
  iface: Interface,
  action: ProtocolAction
): { ethersFragment: unknown; abi: ParsedFragment } {
  const byName = iface.fragments.filter(
    (f) =>
      f.type === "function" && (f as { name?: string }).name === action.function
  );
  const parsed = byName.map(
    (f) => JSON.parse(f.format("json")) as ParsedFragment
  );
  const flatArity = (f: FunctionAbiEntry): number =>
    (f.inputs ?? []).reduce(
      (n, i) =>
        n + (i.type === "tuple" && i.components ? i.components.length : 1),
      0
    );
  let idx = parsed.findIndex(
    (f) => (f.inputs ?? []).length === action.inputs.length
  );
  if (idx < 0) {
    const flattened = parsed
      .map((f, i) => [f, i] as const)
      .filter(([f]) => flatArity(f) === action.inputs.length);
    if (flattened.length !== 1) {
      throw new Error(
        `${action.slug}: no unambiguous ABI fragment for ${action.function} with ${action.inputs.length} flattened args (candidates: ${parsed.length})`
      );
    }
    idx = flattened[0][1];
  }
  return { ethersFragment: byName[idx], abi: parsed[idx] };
}

export function encodeBoundAction(
  protocol: ProtocolDefinition,
  action: ProtocolAction,
  chainId: string,
  walletAddress: string,
  setupOutputs?: SetupOutputs
): EncodedAction {
  const built = buildActionWorkflow({
    protocolSlug: protocol.slug,
    actionSlug: action.slug,
    chainId,
    trigger: "Manual",
    walletAddress,
    setupOutputs,
  });
  const actionNode = built.nodes.find((n) => n.id !== "trigger-1");
  const config = (actionNode?.data.config ?? {}) as Record<string, unknown>;
  return encodeFromConfig(protocol, action, chainId, config);
}

/**
 * Encode setup-phase protocol steps for a (protocol, chain). Setup steps
 * carry their own inputs (a supply of 100 vs the fixture's 10; six
 * chronicle kisses against six oracles), so they are encoded from the
 * setup workflow's node configs, not the action fixture bindings.
 */
export function encodeSetupSteps(
  protocolSlug: string,
  chainId: string,
  walletAddress: string
): Pick<EncodedAction, "to" | "data" | "value">[] {
  const built = buildSetupWorkflow({ protocolSlug, chainId, walletAddress });
  const steps: Pick<EncodedAction, "to" | "data" | "value">[] = [];
  for (const node of built.nodes) {
    const config = (node.data.config ?? {}) as Record<string, unknown>;
    const actionType = config.actionType as string | undefined;
    if (!(node.id.startsWith("step-") && actionType)) {
      continue;
    }
    const meta = JSON.parse(String(config._protocolMeta ?? "{}")) as {
      protocolSlug?: string;
    };
    const stepSlug = meta.protocolSlug ?? actionType.split("/")[0];
    const stepActionSlug = actionType.slice(actionType.indexOf("/") + 1);
    const stepProtocol = requireProtocol(stepSlug);
    const stepAction = stepProtocol.actions.find(
      (a) => a.slug === stepActionSlug
    );
    if (!stepAction) {
      throw new Error(`setup step action ${actionType} not in registry`);
    }
    const { to, data, value } = encodeFromConfig(
      stepProtocol,
      stepAction,
      chainId,
      config
    );
    steps.push({ to, data, value });
  }
  return steps;
}

export function encodeFromConfig(
  protocol: ProtocolDefinition,
  action: ProtocolAction,
  chainId: string,
  config: Record<string, unknown>
): EncodedAction {
  const named = action.inputs.map((inp) => {
    const raw = config[inp.name];
    let value: string;
    if (raw === undefined || raw === "") {
      value = inp.default ?? "";
    } else if (typeof raw === "object") {
      value = JSON.stringify(raw);
    } else {
      value = String(raw);
    }
    return { name: inp.name, value };
  });
  const transformed = applyEncodeTransformsNamed(
    protocol.slug,
    action.slug,
    named
  );
  const iface = ifaceFor(protocol, action);
  const { ethersFragment, abi } = fragmentFor(iface, action);
  // Same pipeline the runtime steps run: flattened string args are
  // reshaped against tuple params, then coerced per ABI type.
  let args: unknown[] = transformed.map((t) => t.value);
  args = reshapeArgsForAbi(args, abi);
  args = coerceArgsForAbi(args, abi);
  const data = iface.encodeFunctionData(ethersFragment as never, args);
  const contract = protocol.contracts[action.contract];
  const to =
    resolveContractAddress(
      contract,
      chainId,
      (config.contractAddress as string | undefined) ?? undefined
    ) ?? "";
  const ethValue = config.ethValue as string | undefined;
  return {
    to,
    data,
    value: ethValue ? parseEther(ethValue) : BigInt(0),
    iface,
    abiOutputs: abi.outputs ?? [],
    ethersFragment,
  };
}
