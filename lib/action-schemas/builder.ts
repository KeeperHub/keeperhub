import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chains, explorerConfigs } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { synthesizeOutputSchema } from "@/lib/mcp/output-schema";
import {
  SYSTEM_ACTIONS,
  TEMPLATE_SYNTAX,
  TRIGGERS,
} from "@/lib/mcp/workflow-schema-constants";
import {
  BUILTIN_NODE_ID,
  BUILTIN_NODE_LABEL,
} from "@/lib/workflow/editor/builtin-variables";
import {
  type ActionConfigFieldBase,
  computeActionId,
  flattenConfigFields,
  getAllIntegrations,
  type IntegrationPlugin,
  type PluginAction,
} from "@/plugins/registry";

/**
 * Shared payload builder for plugin action schemas. Used by both the
 * internal MCP schemas route (/api/mcp/schemas) and the public REST
 * /api/action-schemas endpoint so the two never drift.
 */

type ChainInfo = {
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  isTestnet: boolean;
  // Support maturity: "stable" | "experimental" | "deprecated". Agents
  // should avoid experimental/deprecated chains for production writes.
  status: string;
  explorerUrl: string | null;
};

export type ActionSchema = {
  actionType: string;
  label: string;
  description: string;
  category: string;
  integration: string;
  requiresCredentials: boolean;
  requiredFields: Record<string, string>;
  optionalFields: Record<string, string>;
  outputFields: Record<string, string>;
  outputSchema?: Record<string, unknown>;
};

export type BuildActionSchemasOptions = {
  /**
   * Filter by plugin type / category (e.g. "web3", "discord", "system",
   * "triggers"). Pass undefined to return everything.
   */
  category?: string;
  /**
   * Pass false to skip the chains DB lookup. Default true.
   */
  includeChains?: boolean;
  /**
   * Restrict the returned `actions` map to a single actionType key
   * (e.g. "web3.read-contract"). System actions are still considered if
   * the type matches. Other top-level fields are returned unchanged.
   */
  type?: string;
};

function mapFieldType(field: ActionConfigFieldBase): string {
  switch (field.type) {
    case "number":
      return "number";
    case "chain-select":
      return "string (chain ID)";
    case "token-select":
      return 'string (JSON) - Token selection config. Use: {"mode":"custom","customToken":{"address":"0x...","symbol":"USDC"}} for a known token address';
    case "abi-function-select":
      return "string (function name from ABI)";
    case "abi-function-args":
      return "string (JSON array of function arguments)";
    case "abi-with-auto-fetch":
      return "string (JSON ABI - auto-fetched for verified contracts)";
    case "abi-event-select":
      return "string (event name from ABI)";
    case "select":
      return `string (${field.options?.map((o) => `"${o.value}"`).join(" | ") || "select"})`;
    case "fail-on-error-switch":
      return "boolean";
    case "template-input":
    case "template-textarea":
      return "string (supports {{@nodeId:Label.field}} templates)";
    default:
      return "string";
  }
}

export function transformPluginAction(
  plugin: IntegrationPlugin,
  action: PluginAction
): ActionSchema {
  const actionType = computeActionId(plugin.type, action.slug);
  const flatFields = flattenConfigFields(action.configFields);

  const requiredFields: Record<string, string> = {};
  const optionalFields: Record<string, string> = {};

  for (const field of flatFields) {
    const fieldDesc = `${mapFieldType(field)}${field.placeholder ? ` - ${field.placeholder}` : ""}`;
    if (field.required) {
      requiredFields[field.key] = fieldDesc;
    } else {
      optionalFields[field.key] = fieldDesc;
    }
  }

  const outputFields: Record<string, string> = {};
  if (action.outputFields) {
    for (const output of action.outputFields) {
      outputFields[output.field] = output.description;
    }
  }

  const outputSchema = synthesizeOutputSchema(action);

  return {
    actionType,
    label: action.label,
    description: action.description,
    category: action.category,
    integration: plugin.type,
    requiresCredentials:
      action.requiresCredentials ?? plugin.requiresCredentials ?? false,
    requiredFields,
    optionalFields,
    outputFields,
    ...(outputSchema ? { outputSchema } : {}),
  };
}

function pluginHasAbiAutoFetch(plugin: IntegrationPlugin): boolean {
  for (const action of plugin.actions) {
    const flatFields = flattenConfigFields(action.configFields);
    if (flatFields.some((field) => field.type === "abi-with-auto-fetch")) {
      return true;
    }
  }
  return false;
}

function derivePlatformCapabilities(plugins: IntegrationPlugin[]) {
  const web3Plugin = plugins.find((p) => p.type === "web3");
  const hasAbiAutoFetch = web3Plugin
    ? pluginHasAbiAutoFetch(web3Plugin)
    : false;

  return {
    wallet: web3Plugin
      ? {
          provider: "Turnkey",
          features: ["secure-enclave", "non-custodial", "hosted"],
          description:
            "Turnkey wallet backed by hardware secure enclaves; KeeperHub signs transactions on the user's behalf via the Turnkey API",
        }
      : null,
    proxyContracts: hasAbiAutoFetch
      ? {
          supported: true,
          autoDetectImplementation: true,
          supportedPatterns: ["EIP-1967", "EIP-1822", "Diamond (EIP-2535)"],
          description:
            "Proxy contracts are automatically detected and implementation ABIs fetched",
        }
      : { supported: false },
    abiHandling: hasAbiAutoFetch
      ? {
          autoFetchVerified: true,
          manualAbiSupported: true,
          description:
            "ABIs auto-fetched from block explorers for verified contracts. Manual ABI input available for unverified contracts.",
        }
      : null,
  };
}

async function fetchEnabledChains(endpointLabel: string): Promise<ChainInfo[]> {
  try {
    const results = await db
      .select({ chain: chains, explorer: explorerConfigs })
      .from(chains)
      .leftJoin(explorerConfigs, eq(chains.chainId, explorerConfigs.chainId))
      .where(eq(chains.isEnabled, true));

    return results.map(({ chain, explorer }) => ({
      chainId: chain.chainId,
      name: chain.name,
      symbol: chain.symbol,
      chainType: chain.chainType,
      isTestnet: chain.isTestnet ?? false,
      status: chain.status,
      explorerUrl: explorer?.explorerUrl ?? null,
    }));
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[ActionSchemas] Failed to fetch chains",
      error,
      { endpoint: endpointLabel, operation: "get" }
    );
    return [];
  }
}

export async function buildActionSchemasResponse(
  opts: BuildActionSchemasOptions & { endpointLabel: string }
): Promise<Record<string, unknown>> {
  const categoryFilter = opts.category?.toLowerCase();
  const includeChains = opts.includeChains !== false;
  const typeFilter = opts.type;

  const allPlugins = getAllIntegrations();

  const pluginActions: Record<string, ActionSchema> = {};
  for (const plugin of allPlugins) {
    if (categoryFilter && plugin.type !== categoryFilter) {
      continue;
    }
    for (const action of plugin.actions) {
      const transformed = transformPluginAction(plugin, action);
      pluginActions[transformed.actionType] = transformed;
    }
  }

  const systemActions =
    !categoryFilter || categoryFilter === "system" ? SYSTEM_ACTIONS : {};
  const triggers =
    !categoryFilter || categoryFilter === "triggers" ? TRIGGERS : {};

  const chainList: ChainInfo[] = includeChains
    ? await fetchEnabledChains(opts.endpointLabel)
    : [];

  const platformCapabilities = derivePlatformCapabilities(allPlugins);

  let actions: Record<string, unknown> = {
    ...pluginActions,
    ...systemActions,
  };
  if (typeFilter) {
    const matched = actions[typeFilter];
    actions = matched === undefined ? {} : { [typeFilter]: matched };
  }

  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    actions,
    triggers,
    chains: chainList,
    platform: platformCapabilities,
    templateSyntax: TEMPLATE_SYNTAX,
    builtinVariables: {
      description: `Built-in variables evaluated at runtime. Reference using {{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.fieldName}} syntax.`,
      nodeId: BUILTIN_NODE_ID,
      nodeLabel: BUILTIN_NODE_LABEL,
      variables: {
        unixTimestamp: {
          type: "number",
          description:
            "Current Unix timestamp in seconds (Solidity-compatible, matches block.timestamp)",
          example: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestamp}}`,
        },
        unixTimestampMs: {
          type: "number",
          description:
            "Current Unix timestamp in milliseconds (JavaScript Date.now())",
          example: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestampMs}}`,
        },
        isoTimestamp: {
          type: "string",
          description: "Current time as ISO 8601 UTC string",
          example: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.isoTimestamp}}`,
        },
      },
    },
    workflowStructure: {
      nodeStructure: {
        id: "string - Unique node identifier",
        type: '"trigger" | "action"',
        position:
          "{ x: number, y: number } - Optional, auto-laid out if omitted",
        data: {
          label: "string - Human-readable node name",
          description: "string - Optional description",
          type: '"trigger" | "action"',
          config: "object - Action/trigger specific configuration",
          status: '"idle" | "running" | "success" | "error"',
        },
      },
      edgeStructure: {
        id: "string - Unique edge identifier",
        source: "string - Source node ID",
        target: "string - Target node ID",
        sourceHandle:
          "string (optional) - For Condition node edges: 'true' or 'false'. For For Each node edges: 'loop' or 'done'. Omit for all other node types.",
        note: "Do NOT use targetHandle. sourceHandle is only needed for Condition and For Each node edges.",
      },
    },
    projects: {
      description:
        "Workflows can be organized into projects. Use projectId when creating or updating workflows to assign them to a project.",
      endpoints: {
        list: "GET /api/projects - List all projects for the org (includes workflowCount)",
        create:
          "POST /api/projects - Create project with { name, description?, color? }",
        update:
          "PATCH /api/projects/:id - Update project name/description/color",
        delete:
          "DELETE /api/projects/:id - Delete project (workflows become uncategorized)",
      },
      workflowFields: {
        projectId:
          "string | null - Optional project ID to assign the workflow to. Pass null to unassign.",
      },
    },
    tags: {
      description:
        "Workflows can be labeled with a single tag per workflow. Tags are organization-scoped and have a name and color. Use tagId when creating or updating workflows to assign a tag.",
      endpoints: {
        list: "GET /api/tags - List all tags for the org (includes workflowCount)",
        create:
          "POST /api/tags - Create tag with { name, color } (color is required, e.g. '#4A90D9')",
        update: "PATCH /api/tags/:id - Update tag name/color",
        delete:
          "DELETE /api/tags/:id - Delete tag (workflows lose their tag assignment)",
      },
      workflowFields: {
        tagId:
          "string | null - Optional tag ID to assign to the workflow. Pass null to unassign. Each workflow can have at most one tag.",
      },
    },
    tips: [
      "actionType must match exactly (e.g., 'web3/check-balance', not 'Get Wallet Balance')",
      "Use {{@nodeId:Label.field}} syntax to reference outputs from previous nodes",
      "chainId is the canonical field for the target chain (e.g., 1 for Ethereum mainnet, 11155111 for Sepolia, 8453 for Base). Accepts a number or stringified number. The legacy `network` field is still accepted as a deprecated alias and also resolves common chain names (mainnet/ethereum, sepolia, base, base-sepolia, etc.).",
      "Edges need id, source, and target. For Condition nodes, also set sourceHandle to 'true' or 'false' to control which branch executes.",
      "For verified contracts, ABI is auto-fetched. For unverified contracts, provide ABI manually.",
      "Condition nodes have dual output handles ('true' and 'false'). Set sourceHandle on edges to route execution. For if/else, connect different nodes to each handle of a single Condition node.",
      "integrationId is required for actions that need credentials (discord, sendgrid, database)",
      "web3 read actions (check-balance, read-contract) don't require wallet integration",
      "web3 write actions (transfer-funds, write-contract) require wallet integration",
      "web3/query-transactions queries historical transactions by function call using block explorer APIs. Use it when the contract does not emit events for the operations you need to monitor. Provide functionArgs as a JSON array where empty strings are wildcards.",
      'tokenConfig must be a JSON string with format: {"mode":"custom","customToken":{"address":"0x...","symbol":"USDC"}}. Do NOT use a flat {address, symbol, decimals} object',
      "Use projectId to organize related workflows into a project (e.g., all Sky ESM workflows in one project)",
      "Use tagId to label a workflow with a single tag (e.g., 'production', 'monitoring'). Each workflow supports one tag. Fetch available tags from GET /api/tags first.",
      `Use {{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestamp}} for current time comparisons in conditions (e.g., checking if a contract timestamp has passed)`,
      "All trigger types expose a 'triggeredAt' output field (ISO timestamp). Reference it with {{@triggerId:TriggerLabel.data.triggeredAt}} to include when the workflow fired.",
      "Database Query: use inline {{@nodeId:Label.field}} template refs directly in the SQL string. Do NOT use parameterized $1/$2 placeholders with a separate dbParams array. The UI does not support that format.",
      "Condition conditionConfig: every group and rule MUST have a unique 'id' field (use nanoid or UUID). Operators must be exact symbols: '===' not 'equals', '<' not 'less_than', '>' not 'greater_than'. Rule fields are 'leftOperand' and 'rightOperand', NOT 'field' and 'value'.",
    ],
  };
}

export function findActionSchemaByType(
  actionType: string
): ActionSchema | null {
  const allPlugins = getAllIntegrations();
  for (const plugin of allPlugins) {
    for (const action of plugin.actions) {
      const transformed = transformPluginAction(plugin, action);
      if (transformed.actionType === actionType) {
        return transformed;
      }
    }
  }
  return null;
}
