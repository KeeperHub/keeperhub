/**
 * Programmatic workflow builders for KEEP-458 protocol-coverage.
 *
 * Pure functions consumed by the seeder (deploy-time) and the test runner
 * (CI / local). Replaces the JSON fixture tree: workflows are constructed on
 * demand from each protocol's co-located `testData` plus the registry.
 *
 * Trigger variation is a property of the consumer:
 *   - Seeder iterates all 5 trigger types per action so the dashboard surfaces
 *     each variant as its own runnable workflow row.
 *   - Test runner uses Manual only (the webhook-fired execution path ignores
 *     the trigger node's config, so trigger variants give no test signal).
 */

import { parseUnits } from "ethers";
import {
  getProtocol,
  getRegisteredProtocols,
  type ProtocolAction,
  type ProtocolDefinition,
} from "@/lib/protocol-registry";
import { TOKEN_REGISTRY, type TokenSymbol } from "./chain-test-data";
import {
  type ActionInputBindings,
  type InputBinding,
  isAmountBinding,
  isContractBinding,
  isNativeBinding,
  isWalletBinding,
  type ProtocolChainTestData,
  type SetupSpec,
  type WorkflowEdgeJson,
  type WorkflowNodeJson,
} from "./types";

export const TRIGGER_TYPES = [
  "Manual",
  "Schedule",
  "Webhook",
  "Event",
  "Block",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

const TRANSFER_EVENT_ABI = JSON.stringify([
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
]);

export type BuiltWorkflow = {
  name: string;
  description: string;
  nodes: WorkflowNodeJson[];
  edges: WorkflowEdgeJson[];
  _phase: "setup" | "read" | "write";
  _chainId: string;
  _protocol: string;
  _trigger: TriggerType;
  _executable: boolean;
};

// --- Resolver ----------------------------------------------------------------

function tokenEntryOrThrow(chainId: string, symbol: TokenSymbol) {
  const entry = TOKEN_REGISTRY[chainId]?.[symbol];
  if (!entry) {
    throw new Error(
      `TOKEN_REGISTRY missing ${symbol} on chain ${chainId}. Extend lib/test-data/chain-test-data.ts.`
    );
  }
  return entry;
}

function contractAddressOrThrow(
  protocol: ProtocolDefinition,
  key: string,
  chainId: string
): string {
  const contractDef = protocol.contracts[key];
  if (!contractDef) {
    throw new Error(`Protocol ${protocol.slug} has no contract "${key}".`);
  }
  const address = contractDef.addresses[chainId];
  if (!address) {
    throw new Error(
      `Protocol ${protocol.slug}.${key} not deployed on chain ${chainId}.`
    );
  }
  return address;
}

/** Resolve a binding to a config value. Token-symbol strings on address-typed
 *  inputs are looked up in TOKEN_REGISTRY; plain strings pass through.
 *  `walletAddress` is the persistent test user's signing wallet for this
 *  environment (looked up from `organization_wallets` by the caller).
 *
 *  Exported for unit coverage in tests/unit/build-workflow.test.ts. */
export function resolveBinding(
  binding: InputBinding,
  inputType: string | undefined,
  protocol: ProtocolDefinition,
  chainId: string,
  walletAddress: string
): string {
  if (isWalletBinding(binding)) {
    // Symmetric with the string-token-symbol path below: wallet() only
    // makes sense on a scalar `address` input. Honouring it on any other
    // type would silently encode a 0x-prefixed string into a uint/bytes/
    // bool slot, which the engine would later reject with a far less
    // actionable error than this one.
    if (inputType !== "address") {
      throw new Error(
        `wallet() binding on a non-address input (type: "${inputType ?? "unknown"}"). ` +
          "wallet() only resolves on scalar `address` inputs. Use a literal value, " +
          "amount(symbol, human), or native(human) when the input is non-address."
      );
    }
    return walletAddress;
  }
  if (isAmountBinding(binding)) {
    const tok = tokenEntryOrThrow(chainId, binding._amount.symbol);
    return parseUnits(binding._amount.human, tok.decimals).toString();
  }
  if (isContractBinding(binding)) {
    return contractAddressOrThrow(protocol, binding._contract.key, chainId);
  }
  if (isNativeBinding(binding)) {
    return parseUnits(binding._native.human, 18).toString();
  }
  if (typeof binding === "string") {
    // Only resolve TOKEN_REGISTRY symbols on scalar `address` inputs.
    // `address[]` / `address[N]` need explicit array handling (none of the
    // Phase 1 protocols expose array inputs) and a string binding against an
    // array slot is almost certainly a user error -- let it pass through
    // unchanged so the engine surfaces the type mismatch downstream.
    if (inputType === "address") {
      if (binding.startsWith("0x")) {
        return binding;
      }
      const symbol = binding as TokenSymbol;
      if (TOKEN_REGISTRY[chainId]?.[symbol]) {
        return tokenEntryOrThrow(chainId, symbol).address;
      }
      return binding;
    }
    return binding;
  }
  throw new Error(`Unhandled binding shape: ${JSON.stringify(binding)}`);
}

type DefaultContext = {
  protocolSlug: string;
  actionSlug: string;
  inputName: string;
};

function defaultForSolidityType(type: string, context: DefaultContext): string {
  if (type === "address" || type.startsWith("address")) {
    throw new Error(
      `address-typed input "${context.inputName}" on "${context.protocolSlug}/${context.actionSlug}" ` +
        "has no binding and no protocol-level default. Add it to TEST_DATA " +
        '(use wallet(), a token symbol like "DAI", contract("<key>"), or ' +
        "a literal 0x address), or give the action's input a `default` " +
        "in protocols/<slug>.ts."
    );
  }
  if (type === "bool") {
    return "false";
  }
  if (type === "string") {
    return "test";
  }
  if (type.startsWith("bytes")) {
    return "0x";
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return "1";
  }
  return "";
}

// --- Trigger nodes -----------------------------------------------------------

// Explicit priority for chains where WETH is missing. Object.values()[0] would
// rely on the TOKEN_REGISTRY literal's key order (V8 string-key insertion order)
// and shift silently if someone reshuffles the registry. Listing the fallbacks
// here makes the choice survive that.
const EVENT_TRIGGER_TOKEN_PRIORITY: TokenSymbol[] = [
  "WETH",
  "USDC",
  "USDT",
  "DAI",
  "USDS",
  "LINK",
  "FUSDC",
  "FUSDCX",
];

function pickEventContractAddress(chainId: string): string {
  const registryForChain = TOKEN_REGISTRY[chainId];
  if (!registryForChain) {
    throw new Error(
      `Event trigger contractAddress: chain ${chainId} has no entry in TOKEN_REGISTRY`
    );
  }
  for (const symbol of EVENT_TRIGGER_TOKEN_PRIORITY) {
    const address = registryForChain[symbol]?.address;
    if (address) {
      return address;
    }
  }
  throw new Error(
    `Event trigger contractAddress: chain ${chainId} has no token in TOKEN_REGISTRY matching ${EVENT_TRIGGER_TOKEN_PRIORITY.join(", ")}`
  );
}

function buildTriggerConfig(
  trigger: TriggerType,
  chainId: string
): Record<string, unknown> {
  switch (trigger) {
    case "Manual":
      return { triggerType: "Manual" };
    case "Schedule":
      return { triggerType: "Schedule", cron: "0 0 * * *", timezone: "UTC" };
    case "Webhook":
      return { triggerType: "Webhook" };
    case "Event":
      return {
        triggerType: "Event",
        network: chainId,
        contractAddress: pickEventContractAddress(chainId),
        abi: TRANSFER_EVENT_ABI,
        eventName: "Transfer",
      };
    case "Block":
      return {
        triggerType: "Block",
        network: chainId,
        blockInterval: "1",
      };
    default:
      throw new Error(`Unhandled trigger: ${String(trigger)}`);
  }
}

function buildTriggerNode(
  trigger: TriggerType,
  chainId: string,
  id = "trigger-1"
): WorkflowNodeJson {
  return {
    id,
    type: "trigger",
    position: { x: 100, y: 200 },
    data: {
      label: `${trigger} Trigger`,
      type: "trigger",
      config: buildTriggerConfig(trigger, chainId),
      status: "idle",
    },
  };
}

// --- Action nodes ------------------------------------------------------------

function buildProtocolMeta(action: ProtocolAction, slug: string): string {
  return JSON.stringify({
    protocolSlug: slug,
    contractKey: action.contract,
    functionName: action.function,
    actionType: action.type,
  });
}

function buildProtocolActionNode(
  protocol: ProtocolDefinition,
  action: ProtocolAction,
  chainId: string,
  bindings: ActionInputBindings,
  nodeId: string,
  xPos: number,
  walletAddress: string
): WorkflowNodeJson {
  const config: Record<string, unknown> = {
    actionType: `${protocol.slug}/${action.slug}`,
    network: chainId,
    _protocolMeta: buildProtocolMeta(action, protocol.slug),
  };

  // `contractAddress` and `ethValue` are reserved virtual keys. Catch
  // any real action input with those names before they collide with the
  // builder's own virtual handling below.
  for (const input of action.inputs) {
    if (input.name === "contractAddress") {
      throw new Error(
        `${protocol.slug}/${action.slug} declares an input named "contractAddress", ` +
          "which the protocol-coverage builder reserves as a virtual hint for " +
          "userSpecifiedAddress contracts. Rename the input in protocols/" +
          `${protocol.slug}.ts.`
      );
    }
    if (input.name === "ethValue") {
      throw new Error(
        `${protocol.slug}/${action.slug} declares an input named "ethValue", ` +
          "which the protocol-coverage builder reserves for the payable msg.value " +
          "field. Rename the input in protocols/" +
          `${protocol.slug}.ts.`
      );
    }
  }

  // Optional virtual `contractAddress` for actions whose contract is
  // userSpecifiedAddress (Superfluid SuperTokens, etc.).
  if (bindings.contractAddress !== undefined) {
    config.contractAddress = resolveBinding(
      bindings.contractAddress,
      "address",
      protocol,
      chainId,
      walletAddress
    );
  }

  // Optional virtual `ethValue` for payable actions. The execution engine
  // expects an ETH string (e.g. "0.01"), not wei. Provide a plain string
  // binding in TEST_DATA actions: `{ ethValue: "0.01" }`.
  if (bindings.ethValue !== undefined) {
    const ev = bindings.ethValue;
    if (typeof ev !== "string") {
      throw new Error(
        `${protocol.slug}/${action.slug}: ethValue binding must be a plain ETH ` +
          `string (e.g. "0.01"), got ${JSON.stringify(ev)}.`
      );
    }
    config.ethValue = ev;
  }

  for (const input of action.inputs) {
    const bound = bindings[input.name];
    if (bound !== undefined) {
      config[input.name] = resolveBinding(
        bound,
        input.type,
        protocol,
        chainId,
        walletAddress
      );
      continue;
    }
    if (input.default !== undefined) {
      config[input.name] = input.default;
      continue;
    }
    config[input.name] = defaultForSolidityType(input.type, {
      protocolSlug: protocol.slug,
      actionSlug: action.slug,
      inputName: input.name,
    });
  }

  return {
    id: nodeId,
    type: "action",
    position: { x: xPos, y: 200 },
    data: {
      label: action.label,
      description: action.description,
      type: "action",
      config,
      status: "idle",
    },
  };
}

function buildApproveTokenNode(
  approval: SetupSpec["approvals"][number],
  protocol: ProtocolDefinition,
  chainId: string,
  nodeId: string,
  xPos: number,
  walletAddress: string
): WorkflowNodeJson {
  const tokenEntry = tokenEntryOrThrow(chainId, approval.token);
  const spenderAddress = resolveBinding(
    approval.spender,
    "address",
    protocol,
    chainId,
    walletAddress
  );
  const tokenConfig = JSON.stringify({
    mode: "custom",
    customToken: { address: tokenEntry.address, symbol: tokenEntry.symbol },
  });
  return {
    id: nodeId,
    type: "action",
    position: { x: xPos, y: 200 },
    data: {
      label: `Approve ${tokenEntry.symbol}`,
      description: `Approve ${spenderAddress} to spend ${approval.human} ${tokenEntry.symbol}`,
      type: "action",
      config: {
        actionType: "web3/approve-token",
        network: chainId,
        tokenConfig,
        spenderAddress,
        amount: approval.human,
      },
      status: "idle",
    },
  };
}

// --- Public builders ---------------------------------------------------------

function chainName(chainId: string): string {
  if (chainId === "11155111") {
    return "Sepolia";
  }
  if (chainId === "1") {
    return "Mainnet";
  }
  return `chain ${chainId}`;
}

function getProtocolOrThrow(slug: string): ProtocolDefinition {
  const p = getProtocol(slug);
  if (!p) {
    throw new Error(`Protocol ${slug} not registered.`);
  }
  return p;
}

function getChainData(
  protocol: ProtocolDefinition,
  chainId: string
): ProtocolChainTestData | undefined {
  return protocol.testData?.[chainId];
}

export type BuildSetupOptions = {
  protocolSlug: string;
  chainId: string;
  walletAddress: string;
};

export function buildSetupWorkflow({
  protocolSlug,
  chainId,
  walletAddress,
}: BuildSetupOptions): BuiltWorkflow {
  const protocol = getProtocolOrThrow(protocolSlug);
  const chainData = getChainData(protocol, chainId);
  if (!chainData) {
    throw new Error(`No testData for ${protocolSlug} on chain ${chainId}.`);
  }
  const spec = chainData.setup;

  const nodes: WorkflowNodeJson[] = [buildTriggerNode("Manual", chainId)];
  const edges: WorkflowEdgeJson[] = [];
  let prevId = "trigger-1";
  let x = 350;
  let counter = 1;

  for (const approval of spec.approvals) {
    const id = `approve-${counter}`;
    counter += 1;
    nodes.push(
      buildApproveTokenNode(approval, protocol, chainId, id, x, walletAddress)
    );
    edges.push({ id: `e-${prevId}-${id}`, source: prevId, target: id });
    prevId = id;
    x += 250;
  }

  for (const step of spec.protocolSteps ?? []) {
    const stepProtocol = getProtocolOrThrow(step.protocol);
    const stepAction = stepProtocol.actions.find((a) => a.slug === step.action);
    if (!stepAction) {
      throw new Error(
        `Setup step references unknown action ${step.protocol}/${step.action}`
      );
    }
    const id = `step-${counter}`;
    counter += 1;
    nodes.push(
      buildProtocolActionNode(
        stepProtocol,
        stepAction,
        chainId,
        step.inputs,
        id,
        x,
        walletAddress
      )
    );
    edges.push({ id: `e-${prevId}-${id}`, source: prevId, target: id });
    prevId = id;
    x += 250;
  }

  return {
    name: `${protocol.name} setup (${chainName(chainId)})`,
    description: `Setup workflow for ${protocol.slug} on ${chainName(chainId)}. Approves ${spec.approvals.length} token(s); runs ${spec.protocolSteps?.length ?? 0} protocol prep step(s). The TS preflight ensures the wallet has min ${spec.minNativeHuman} native gas and the listed ERC20 balances before this workflow runs.`,
    nodes,
    edges,
    _phase: "setup",
    _chainId: chainId,
    _protocol: protocol.slug,
    _trigger: "Manual",
    _executable: chainData.enabled !== false,
  };
}

export type BuildActionOptions = {
  protocolSlug: string;
  actionSlug: string;
  chainId: string;
  trigger: TriggerType;
  walletAddress: string;
};

export function buildActionWorkflow({
  protocolSlug,
  actionSlug,
  chainId,
  trigger,
  walletAddress,
}: BuildActionOptions): BuiltWorkflow {
  const protocol = getProtocolOrThrow(protocolSlug);
  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    throw new Error(`${protocolSlug} has no action "${actionSlug}".`);
  }
  const chainData = getChainData(protocol, chainId);
  const bindings = chainData?.actions[actionSlug] ?? {};

  const triggerNode = buildTriggerNode(trigger, chainId);
  const actionNode = buildProtocolActionNode(
    protocol,
    action,
    chainId,
    bindings,
    "step-1",
    450,
    walletAddress
  );

  return {
    name: `${trigger} -> ${protocol.name}: ${action.label} (${chainName(chainId)})`,
    description: `Protocol-coverage ${action.type} workflow for ${protocol.slug}/${action.slug} on ${chainName(chainId)} with a ${trigger} trigger. Built from co-located testData at consumer call time.`,
    nodes: [triggerNode, actionNode],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
    _phase: action.type,
    _chainId: chainId,
    _protocol: protocol.slug,
    _trigger: trigger,
    // When chainData is absent the builder has no testData to vet inputs
    // against (any required address-typed input falls through to
    // defaultForSolidityType and throws), so the workflow is not executable.
    // The previous `chainData?.enabled !== false` returned true for missing
    // chainData because `undefined !== false` -- callers acted on that as
    // if the workflow were vetted.
    _executable: chainData !== undefined && chainData.enabled !== false,
  };
}

export type BuiltCoverage = {
  setup: BuiltWorkflow;
  reads: BuiltWorkflow[];
  writes: BuiltWorkflow[];
};

/**
 * Build the full coverage for one (protocol, chain): setup workflow + every
 * read action + every write action, expanded across all 5 trigger types.
 *
 * Callers (seeder, test runner) filter further:
 *   - Seeder takes every entry (each becomes a row in the workflows table).
 *   - Test runner takes only the Manual variants for execution.
 */
export type BuildCoverageOptions = {
  protocolSlug: string;
  chainId: string;
  walletAddress: string;
};

export function buildAllForProtocol({
  protocolSlug,
  chainId,
  walletAddress,
}: BuildCoverageOptions): BuiltCoverage {
  const protocol = getProtocolOrThrow(protocolSlug);
  const setup = buildSetupWorkflow({ protocolSlug, chainId, walletAddress });
  const reads: BuiltWorkflow[] = [];
  const writes: BuiltWorkflow[] = [];
  for (const action of protocol.actions) {
    for (const trigger of TRIGGER_TYPES) {
      const wf = buildActionWorkflow({
        protocolSlug,
        actionSlug: action.slug,
        chainId,
        trigger,
        walletAddress,
      });
      if (action.type === "read") {
        reads.push(wf);
      } else {
        writes.push(wf);
      }
    }
  }
  return { setup, reads, writes };
}

/**
 * Return a copy of `built` with its trigger node's config rewritten to a
 * Webhook trigger. The production webhook endpoint at
 * app/api/workflows/[id]/webhook/route.ts:244 requires
 * `triggerNode.data.config.triggerType === "Webhook"`, so the test runner
 * must rewrite the trigger before inserting an otherwise-Manual fixture into
 * the workflows table for webhook-fired execution. Action nodes are untouched.
 */
export function toWebhookTriggered(built: BuiltWorkflow): BuiltWorkflow {
  const rewrittenNodes = built.nodes.map((node): WorkflowNodeJson => {
    if (node.type !== "trigger" || node.data.type !== "trigger") {
      return node;
    }
    return {
      ...node,
      data: {
        ...node.data,
        label: "Webhook Trigger",
        config: { triggerType: "Webhook" },
      },
    };
  });
  return { ...built, nodes: rewrittenNodes, _trigger: "Webhook" };
}

/** Enumerate every (protocol, chain) tuple that has testData. */
export function listCoverageTargets(): Array<{
  protocolSlug: string;
  chainId: string;
}> {
  const targets: Array<{ protocolSlug: string; chainId: string }> = [];
  for (const protocol of getRegisteredProtocols()) {
    if (!protocol.testData) {
      continue;
    }
    for (const chainId of Object.keys(protocol.testData)) {
      targets.push({ protocolSlug: protocol.slug, chainId });
    }
  }
  return targets;
}
