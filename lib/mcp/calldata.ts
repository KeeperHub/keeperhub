import { ethers } from "ethers";

export type CalldataResult =
  | { success: true; to: string; data: string; value: string }
  | { success: false; error: string };

type WriteNodeConfig = {
  contractAddress: string;
  abi: string;
  abiFunction: string;
  functionArgs?: string;
  ethValue?: string;
};

type WriteNode = {
  config: WriteNodeConfig;
};

// Defined at module level to satisfy Biome useTopLevelRegex rule
const TRIGGER_TEMPLATE_RE = /\{\{@trigger:Trigger\.(\w+)\}\}/g;
const UNRESOLVED_TEMPLATE_RE = /\{\{@[^}]+\}\}/;

export function isWriteActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    actionType.includes("write-contract") ||
    actionType.includes("protocol-write")
  );
}

/**
 * Returns the FIRST write-action node in the workflow, or undefined if none.
 *
 * Note: workflows containing multiple write-action nodes are not composed --
 * only the first one is used to generate calldata. This matches the current
 * "one transaction per call" model. If multi-write composition is needed in
 * the future, this function and its callers must change together.
 *
 * Node shape (post-sanitize, see lib/workflow/editor/sanitize-nodes.ts:233-238):
 *   { id, type:"action", data: { type:"action", config: { actionType, ... } } }
 * actionType lives at data.config.actionType -- the older top-level
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
    const config = node.data.config as WriteNodeConfig & {
      actionType?: unknown;
    };
    const candidateActionType =
      config.actionType ??
      ("actionType" in node.data ? node.data.actionType : undefined);
    if (isWriteActionType(candidateActionType)) {
      return { config };
    }
  }
  return undefined;
}

/**
 * Returns the workflowType that should be persisted given current node content.
 *
 * A workflow containing a callable write node (write-contract / protocol-write)
 * is unconditionally "write" - this auto-flips a "read" and overrides a
 * conflicting requested "read". When no callable write node is present, the
 * requested type (or the current type when no explicit request is made) is
 * preserved unchanged.
 *
 * Detection is intentionally narrow and matches the calldata generator so a
 * "write"-typed workflow can always be served by call_workflow. Value
 * transfers and token approvals mutate chain state but are not calldata-
 * generatable, so they do not qualify here - labelling them "write" would
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

export function generateCalldataForWorkflow(
  nodes: unknown[],
  triggerInputs: Record<string, unknown>
): CalldataResult {
  const writeNode = findFirstWriteActionNode(nodes);
  if (!writeNode) {
    return { success: false, error: "No write action node found in workflow" };
  }

  const { contractAddress, abi, abiFunction, functionArgs, ethValue } =
    writeNode.config;

  let parsedAbi: unknown[];
  try {
    parsedAbi = JSON.parse(abi) as unknown[];
  } catch {
    return { success: false, error: "Invalid ABI JSON in workflow node" };
  }

  let resolvedArgs: unknown[] = [];
  if (functionArgs) {
    let rawArgs: unknown[];
    try {
      rawArgs = JSON.parse(functionArgs) as unknown[];
    } catch {
      return {
        success: false,
        error: "Invalid functionArgs JSON in workflow node",
      };
    }

    resolvedArgs = rawArgs.map((arg) => {
      if (typeof arg === "string") {
        return resolveTriggerTemplates(arg, triggerInputs);
      }
      return arg;
    });

    for (const arg of resolvedArgs) {
      if (typeof arg === "string" && UNRESOLVED_TEMPLATE_RE.test(arg)) {
        return {
          success: false,
          error: `Unresolvable template reference: ${arg}`,
        };
      }
    }
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
      ethValue && ethValue.length > 0
        ? ethers.parseEther(ethValue).toString()
        : "0";
  } catch (err) {
    return {
      success: false,
      error: `Invalid ethValue "${ethValue}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { success: true, to: contractAddress, data, value };
}
