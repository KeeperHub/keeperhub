import { ethers } from "ethers";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import {
  BATCH_WRITE_CONTRACT_ACTION_TYPE,
  isWriteActionType,
} from "@/lib/mcp/action-type";
import { buildCallsWithMeta } from "@/plugins/web3/steps/batch-write-contract-core";

export type CalldataResult =
  | { success: true; to: string; data: string; value: string }
  | { success: false; error: string };

type WriteNode = {
  actionType: string | undefined;
  config: Record<string, unknown>;
};

// Defined at module level to satisfy Biome useTopLevelRegex rule
const TRIGGER_TEMPLATE_RE = /\{\{@trigger:Trigger\.(\w+)\}\}/g;
const UNRESOLVED_TEMPLATE_RE = /\{\{@[^}]+\}\}/;

/**
 * Returns the FIRST write-action node in the workflow, or undefined if none.
 *
 * Note: workflows containing multiple write-action nodes are not composed,
 * only the first one is used to generate calldata. This matches the current
 * "one transaction per call" model. If multi-write composition is needed in
 * the future, this function and its callers must change together.
 *
 * Node shape (post-sanitize, see lib/workflow/editor/sanitize-nodes.ts:233-238):
 *   { id, type:"action", data: { type:"action", config: { actionType, ... } } }
 * actionType lives at data.config.actionType, the older top-level
 * data.actionType path is also accepted as a fallback for any legacy fixtures
 * or in-memory shapes that pre-date the sanitizer normalization.
 */
export function findFirstWriteActionNode(
  nodes: unknown[]
): WriteNode | undefined {
  for (const node of nodes) {
    if (
      node === null ||
      typeof node !== "object" ||
      !("data" in node) ||
      node.data === null ||
      typeof node.data !== "object" ||
      !("config" in node.data) ||
      node.data.config === null ||
      typeof node.data.config !== "object"
    ) {
      continue;
    }
    const config = node.data.config as Record<string, unknown>;
    const candidateActionType =
      config.actionType ??
      ("actionType" in node.data ? node.data.actionType : undefined);
    if (isWriteActionType(candidateActionType)) {
      return {
        actionType:
          typeof candidateActionType === "string"
            ? candidateActionType
            : undefined,
        config,
      };
    }
  }
  return undefined;
}

/**
 * Returns the workflowType that should be persisted given current node content.
 *
 * A workflow containing a callable write node (write-contract, protocol-write,
 * or batch-write-contract) is unconditionally "write", this auto-flips a
 * "read" and overrides a conflicting requested "read". When no callable write
 * node is present, the requested type (or the current type when no explicit
 * request is made) is preserved unchanged.
 *
 * Detection is intentionally narrow and matches the calldata generator so a
 * "write"-typed workflow can always be served by call_workflow. Value
 * transfers and token approvals mutate chain state but are not calldata-
 * generatable, so they do not qualify here, labelling them "write" would
 * make the call route fail at runtime with "No write action node found in
 * workflow".
 */
export function deriveWorkflowType(
  nodes: unknown[],
  requestedType: "read" | "write"
): "read" | "write" {
  if (findFirstWriteActionNode(nodes) !== undefined) {
    return "write";
  }
  return requestedType;
}

export function resolveTriggerTemplates(
  value: string,
  triggerInputs: Record<string, unknown>
): string {
  return value.replace(TRIGGER_TEMPLATE_RE, (_match, fieldName: string) => {
    const resolved = triggerInputs[fieldName];
    return resolved === undefined ? _match : String(resolved);
  });
}

/**
 * Resolve {{@trigger:Trigger.field}} references in every string arg against
 * triggerInputs, and fail if any arg still has an unresolved {{@...}}
 * reference afterward (e.g. a template pointing at an upstream node, which
 * this one-shot route has no execution context to resolve). Shared by the
 * single-write and batch-write-contract paths so the substitution/validation
 * rule cannot drift between them.
 */
function resolveArgsTemplates(
  args: unknown[],
  triggerInputs: Record<string, unknown>
): { args: unknown[]; error?: string } {
  const resolved = args.map((arg) =>
    typeof arg === "string" ? resolveTriggerTemplates(arg, triggerInputs) : arg
  );
  for (const arg of resolved) {
    if (typeof arg === "string" && UNRESOLVED_TEMPLATE_RE.test(arg)) {
      return {
        args: resolved,
        error: `Unresolvable template reference: ${arg}`,
      };
    }
  }
  return { args: resolved };
}

function generateSingleWriteCalldata(
  config: Record<string, unknown>,
  triggerInputs: Record<string, unknown>
): CalldataResult {
  const contractAddress = config.contractAddress;
  const abi = config.abi;
  const abiFunction = config.abiFunction;
  const functionArgs = config.functionArgs;
  const ethValue = config.ethValue;

  // A write node with a missing, templated, or malformed contractAddress
  // used to serialize to a 200 whose `to` key was simply absent. A priced
  // write listing charges for this artifact with no refund path, so reject
  // an unusable address before any money can move.
  if (
    typeof contractAddress !== "string" ||
    !ethers.isAddress(contractAddress)
  ) {
    return {
      success: false,
      error: `Invalid or missing contract address in workflow node: ${String(contractAddress)}`,
    };
  }

  if (typeof abi !== "string" || typeof abiFunction !== "string") {
    return {
      success: false,
      error: "Missing abi or abiFunction in workflow node",
    };
  }

  let parsedAbi: unknown[];
  try {
    parsedAbi = JSON.parse(abi) as unknown[];
  } catch {
    return { success: false, error: "Invalid ABI JSON in workflow node" };
  }

  let resolvedArgs: unknown[] = [];
  if (typeof functionArgs === "string" && functionArgs) {
    let rawArgs: unknown[];
    try {
      rawArgs = JSON.parse(functionArgs) as unknown[];
    } catch {
      return {
        success: false,
        error: "Invalid functionArgs JSON in workflow node",
      };
    }

    const resolved = resolveArgsTemplates(rawArgs, triggerInputs);
    if (resolved.error) {
      return { success: false, error: resolved.error };
    }
    resolvedArgs = resolved.args;
  }

  // ethers.Interface and encodeFunctionData throw on malformed ABI or wrong
  // arg types. Wrap so the caller (the call route) gets a structured error
  // and returns a 400 instead of letting the throw bubble up to a generic 500.
  let data: string;
  try {
    const iface = new ethers.Interface(parsedAbi as ethers.InterfaceAbi);
    data = iface.encodeFunctionData(abiFunction, resolvedArgs);
  } catch (err) {
    return {
      success: false,
      error: `Failed to encode function call: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ethers.parseEther throws on non-numeric input ("abc", "1.5e18", etc).
  let value: string;
  try {
    value =
      typeof ethValue === "string" && ethValue.length > 0
        ? ethers.parseEther(ethValue).toString()
        : "0";
  } catch (err) {
    return {
      success: false,
      error: `Invalid ethValue "${String(ethValue)}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { success: true, to: contractAddress, data, value };
}

/**
 * Resolve trigger-template args on every call entry before handing the batch
 * to buildCallsWithMeta, which has no template awareness of its own (normal
 * workflow execution resolves templates upstream in the executor; this
 * one-shot route has no executor, so it does the same narrow trigger-input
 * substitution the single-write path does).
 */
function resolveBatchCallTemplates(
  entry: unknown,
  triggerInputs: Record<string, unknown>
): { entry: unknown; error?: string } {
  if (entry === null || typeof entry !== "object" || !("args" in entry)) {
    return { entry };
  }
  const { args } = entry as { args: unknown };
  if (!Array.isArray(args)) {
    return { entry };
  }
  const resolved = resolveArgsTemplates(args, triggerInputs);
  if (resolved.error) {
    return { entry, error: resolved.error };
  }
  return {
    entry: { ...(entry as Record<string, unknown>), args: resolved.args },
  };
}

/**
 * Encodes a batch-write-contract node as a single aggregate3(Call3[]) call
 * against Multicall3, the same encoding batchWriteContractCore broadcasts.
 * Reuses its buildCallsWithMeta so the two never drift on per-call
 * validation, encoding, or allowFailure semantics. The result is exactly the
 * same shape a single write-contract node produces, one to/data/value
 * triple, just targeting Multicall3 instead of the caller's own contract.
 */
function generateBatchCalldata(
  config: Record<string, unknown>,
  triggerInputs: Record<string, unknown>
): CalldataResult {
  const rawCalls = config.calls;
  if (typeof rawCalls !== "string" && !Array.isArray(rawCalls)) {
    return { success: false, error: "Missing calls in workflow node" };
  }

  let entries: unknown[];
  if (typeof rawCalls === "string") {
    try {
      const parsed: unknown = JSON.parse(rawCalls);
      if (!Array.isArray(parsed)) {
        return { success: false, error: "Calls must be a JSON array" };
      }
      entries = parsed;
    } catch (err) {
      return {
        success: false,
        error: `Invalid Calls JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    entries = rawCalls;
  }

  const resolvedEntries: unknown[] = [];
  for (const entry of entries) {
    const resolved = resolveBatchCallTemplates(entry, triggerInputs);
    if (resolved.error) {
      return { success: false, error: resolved.error };
    }
    resolvedEntries.push(resolved.entry);
  }

  const isolateCallFailures = config.isolateCallFailures;
  const { calls: callsWithMeta, error } = buildCallsWithMeta({
    calls: resolvedEntries,
    isolateCallFailures:
      typeof isolateCallFailures === "string" ||
      typeof isolateCallFailures === "boolean"
        ? isolateCallFailures
        : undefined,
  });
  if (error) {
    return { success: false, error };
  }

  const call3Array = callsWithMeta.map(
    ({ target, allowFailure, callData }) => ({
      target,
      allowFailure,
      callData,
    })
  );

  let data: string;
  try {
    const iface = new ethers.Interface(MULTICALL3_ABI);
    data = iface.encodeFunctionData("aggregate3", [call3Array]);
  } catch (err) {
    return {
      success: false,
      error: `Failed to encode batch call: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { success: true, to: MULTICALL3_ADDRESS, data, value: "0" };
}

export function generateCalldataForWorkflow(
  nodes: unknown[],
  triggerInputs: Record<string, unknown>
): CalldataResult {
  const writeNode = findFirstWriteActionNode(nodes);
  if (!writeNode) {
    return { success: false, error: "No write action node found in workflow" };
  }

  if (writeNode.actionType === BATCH_WRITE_CONTRACT_ACTION_TYPE) {
    return generateBatchCalldata(writeNode.config, triggerInputs);
  }

  return generateSingleWriteCalldata(writeNode.config, triggerInputs);
}
