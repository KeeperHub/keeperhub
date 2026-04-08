import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withToolLogging } from "./logging";
import { isToolAllowed } from "./oauth-scopes";

const SCOPE_DENIED_RESULT = {
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: "Forbidden",
        message: "This tool is not allowed by the current OAuth scope.",
      }),
    },
  ],
} as const;

// biome-ignore lint/suspicious/noExplicitAny: SDK ToolCallback uses complex generic overloads that cannot be expressed without any
type AnyToolHandler = (...args: any[]) => unknown;

function withScopeCheck<H extends AnyToolHandler>(
  toolName: string,
  scope: string | undefined,
  handler: H
): H {
  if (scope === undefined) {
    return handler;
  }
  const wrapped = (
    ...args: Parameters<H>
  ): ReturnType<H> | typeof SCOPE_DENIED_RESULT => {
    if (!isToolAllowed(toolName, scope)) {
      return SCOPE_DENIED_RESULT;
    }
    return handler(...args) as ReturnType<H>;
  };
  return wrapped as unknown as H;
}

type ApiResponse = Record<string, unknown>;

async function callApi(
  baseUrl: string,
  authHeader: string,
  path: string,
  method: string,
  body?: unknown
): Promise<ApiResponse> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as ApiResponse;
  }

  return { result: await response.text() };
}

export function registerTools(
  server: McpServer,
  baseUrl: string,
  authHeader: string,
  scope?: string
): void {
  // =========================================================================
  // Workflow CRUD
  // =========================================================================

  server.tool(
    "list_workflows",
    "List all workflows for the authenticated organization. Optionally filter by projectId or tagId.",
    {
      projectId: z
        .string()
        .optional()
        .describe("Optional project ID to filter workflows"),
      tagId: z
        .string()
        .optional()
        .describe("Optional tag ID to filter workflows"),
    },
    { title: "List Workflows", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("list_workflows", scope, async (args) =>
      withToolLogging("list_workflows", undefined, async () => {
        const params = new URLSearchParams();
        if (args.projectId) {
          params.set("projectId", args.projectId);
        }
        if (args.tagId) {
          params.set("tagId", args.tagId);
        }
        const query = params.toString();
        const path = `/api/workflows${query ? `?${query}` : ""}`;
        const data = await callApi(baseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_workflow",
    "Get a single workflow by ID, including its nodes, edges, and configuration.",
    {
      workflowId: z.string().describe("The workflow ID"),
    },
    { title: "Get Workflow", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_workflow", scope, async (args) =>
      withToolLogging("get_workflow", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.workflowId}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "create_workflow",
    "Create a new workflow with nodes and edges. Nodes define the trigger and actions; edges define the execution flow.",
    {
      name: z.string().describe("Workflow name"),
      description: z
        .string()
        .optional()
        .describe("Optional workflow description"),
      nodes: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Workflow nodes (trigger + action nodes)"),
      edges: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Workflow edges connecting nodes"),
      projectId: z
        .string()
        .optional()
        .describe("Optional project ID to assign the workflow to"),
      tagId: z
        .string()
        .optional()
        .describe("Optional tag ID to label the workflow"),
    },
    { title: "Create Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("create_workflow", scope, async (args) =>
      withToolLogging("create_workflow", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/workflows/create",
          "POST",
          {
            name: args.name,
            description: args.description,
            nodes: args.nodes,
            edges: args.edges,
            projectId: args.projectId,
            tagId: args.tagId,
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "update_workflow",
    "Update an existing workflow's name, description, nodes, edges, or project/tag assignment.",
    {
      workflowId: z.string().describe("The workflow ID to update"),
      name: z.string().optional().describe("New workflow name"),
      description: z.string().optional().describe("New workflow description"),
      nodes: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Updated workflow nodes"),
      edges: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Updated workflow edges"),
      projectId: z
        .string()
        .nullable()
        .optional()
        .describe("Project ID to assign (null to unassign)"),
      tagId: z
        .string()
        .nullable()
        .optional()
        .describe("Tag ID to assign (null to unassign)"),
    },
    { title: "Update Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("update_workflow", scope, async (args) =>
      withToolLogging("update_workflow", undefined, async () => {
        const { workflowId, ...body } = args;
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${workflowId}`,
          "PATCH",
          body
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "delete_workflow",
    "Delete a workflow by ID. This action is irreversible.",
    {
      workflowId: z.string().describe("The workflow ID to delete"),
    },
    { title: "Delete Workflow", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("delete_workflow", scope, async (args) =>
      withToolLogging("delete_workflow", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.workflowId}`,
          "DELETE"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Execution
  // =========================================================================

  server.tool(
    "execute_workflow",
    "Trigger a manual execution of a workflow. Returns the execution ID for status polling.",
    {
      workflowId: z.string().describe("The workflow ID to execute"),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional input data to pass to the workflow trigger"),
    },
    { title: "Execute Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("execute_workflow", scope, async (args) =>
      withToolLogging("execute_workflow", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflow/${args.workflowId}/execute`,
          "POST",
          { input: args.input ?? {} }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_execution_status",
    "Get the current status of a workflow execution by execution ID.",
    {
      executionId: z
        .string()
        .describe("The execution ID returned by execute_workflow"),
    },
    {
      title: "Get Execution Status",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("get_execution_status", scope, async (args) =>
      withToolLogging("get_execution_status", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/executions/${args.executionId}/status`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_execution_logs",
    "Get detailed step-by-step logs for a workflow execution.",
    {
      executionId: z.string().describe("The execution ID to fetch logs for"),
    },
    { title: "Get Execution Logs", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_execution_logs", scope, async (args) =>
      withToolLogging("get_execution_logs", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/executions/${args.executionId}/logs`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // AI Workflow Generation
  // =========================================================================

  server.tool(
    "ai_generate_workflow",
    "Generate a complete workflow from a natural language description using AI. Returns a workflow definition ready to be created.",
    {
      prompt: z
        .string()
        .describe(
          "Natural language description of the workflow to generate, e.g. 'Monitor USDC transfers over $10k and send a Discord alert'"
        ),
      context: z
        .string()
        .optional()
        .describe("Additional context or constraints for the AI generator"),
    },
    {
      title: "AI Generate Workflow",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("ai_generate_workflow", scope, async (args) =>
      withToolLogging("ai_generate_workflow", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/ai/generate",
          "POST",
          { prompt: args.prompt, context: args.context }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Discovery
  // =========================================================================

  server.tool(
    "list_action_schemas",
    "List all available action schemas, triggers, and supported chains. Use this to discover what actions and integrations are available for workflow creation.",
    {
      category: z
        .string()
        .optional()
        .describe(
          "Filter by category (e.g., 'web3', 'discord', 'system', 'triggers')"
        ),
      includeChains: z
        .boolean()
        .optional()
        .describe(
          "Whether to include supported blockchain networks (default: true)"
        ),
    },
    {
      title: "List Action Schemas",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("list_action_schemas", scope, async (args) =>
      withToolLogging("list_action_schemas", undefined, async () => {
        const params = new URLSearchParams();
        if (args.category) {
          params.set("category", args.category);
        }
        if (args.includeChains === false) {
          params.set("includeChains", "false");
        }
        const query = params.toString();
        const path = `/api/mcp/schemas${query ? `?${query}` : ""}`;
        const data = await callApi(baseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "search_plugins",
    "List available action schemas filtered by category (e.g., 'web3', 'discord', 'system').",
    {
      category: z
        .string()
        .describe(
          "Category to filter by (e.g., 'web3', 'discord', 'sendgrid', 'system', 'triggers')"
        ),
    },
    { title: "Search Plugins", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("search_plugins", scope, async (args) =>
      withToolLogging("search_plugins", undefined, async () => {
        const params = new URLSearchParams({ category: args.category });
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/mcp/schemas?${params.toString()}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_plugin",
    "Get schema details for a specific plugin or integration type.",
    {
      pluginType: z
        .string()
        .describe(
          "Plugin type identifier (e.g., 'web3', 'discord', 'sendgrid')"
        ),
    },
    { title: "Get Plugin", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_plugin", scope, async (args) =>
      withToolLogging("get_plugin", undefined, async () => {
        const params = new URLSearchParams({ category: args.pluginType });
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/mcp/schemas?${params.toString()}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "list_integrations",
    "List all configured integrations (credentials) for the organization. These are required for actions like Discord notifications or Sendgrid emails.",
    {},
    { title: "List Integrations", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("list_integrations", scope, async (_args) =>
      withToolLogging("list_integrations", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/integrations",
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_wallet_integration",
    "Get details for a specific wallet integration. Required for web3 write actions like fund transfers and contract writes.",
    {
      integrationId: z.string().describe("The integration (wallet) ID"),
    },
    {
      title: "Get Wallet Integration",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("get_wallet_integration", scope, async (args) =>
      withToolLogging("get_wallet_integration", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/integrations/${args.integrationId}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Templates
  // =========================================================================

  server.tool(
    "search_templates",
    "Search for pre-built workflow templates that can be deployed and customized.",
    {
      query: z
        .string()
        .optional()
        .describe("Search query to find relevant templates"),
      category: z.string().optional().describe("Filter templates by category"),
    },
    { title: "Search Templates", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("search_templates", scope, async (args) =>
      withToolLogging("search_templates", undefined, async () => {
        const params = new URLSearchParams();
        if (args.query) {
          params.set("q", args.query);
        }
        if (args.category) {
          params.set("category", args.category);
        }
        const query = params.toString();
        const path = `/api/workflows/public${query ? `?${query}` : ""}`;
        const data = await callApi(baseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_template",
    "Get details of a specific workflow template by ID.",
    {
      templateId: z.string().describe("The template workflow ID"),
    },
    { title: "Get Template", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_template", scope, async (args) =>
      withToolLogging("get_template", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.templateId}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "deploy_template",
    "Clone a public template workflow into the organization as a new workflow.",
    {
      templateId: z.string().describe("The template workflow ID to clone"),
      name: z
        .string()
        .optional()
        .describe("Optional name for the cloned workflow"),
    },
    { title: "Deploy Template", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("deploy_template", scope, async (args) =>
      withToolLogging("deploy_template", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/workflows/${args.templateId}/duplicate`,
          "POST",
          { name: args.name }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Meta
  // =========================================================================

  server.tool(
    "tools_documentation",
    "Get documentation on how to use the KeeperHub MCP tools, including examples and best practices for workflow creation.",
    {},
    {
      title: "Tools Documentation",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("tools_documentation", scope, (_args) =>
      withToolLogging("tools_documentation", undefined, () => {
        const text = [
          "KeeperHub MCP Tools Documentation",
          "",
          "WORKFLOW CREATION",
          "1. Call list_action_schemas to discover available actions and triggers",
          "2. Call ai_generate_workflow with a natural language prompt to generate a workflow",
          "3. Call create_workflow with the generated definition to persist it",
          "4. Call execute_workflow to run it manually",
          "5. Call get_execution_status to poll for completion",
          "",
          "WORKFLOW MANAGEMENT",
          "- list_workflows: List all org workflows (filter by projectId or tagId)",
          "- get_workflow: Fetch a single workflow by ID",
          "- update_workflow: Modify name, nodes, edges, project, or tag",
          "- delete_workflow: Permanently delete a workflow",
          "",
          "INTEGRATIONS",
          "- list_integrations: See all configured credentials (Discord, Sendgrid, wallets)",
          "- get_wallet_integration: Get a specific wallet credential (needed for web3 writes)",
          "",
          "TEMPLATES",
          "- search_templates: Browse public workflow templates",
          "- get_template: Inspect a template's structure",
          "- deploy_template: Clone a template into your org",
          "",
          "TEMPLATE SYNTAX",
          "Reference outputs from previous nodes using: {{@nodeId:Label.field}}",
          "Example: {{@check-balance:Check Balance.balance}}",
          "",
          "CHAIN IDs",
          "- Ethereum Mainnet: 1",
          "- Base: 8453",
          "- Sepolia Testnet: 11155111",
          "- Use list_action_schemas (with includeChains: true) for the full list",
        ].join("\n");

        return {
          content: [{ type: "text", text }],
        };
      })
    )
  );

  // ===========================================================================
  // Direct Web3 Execution
  // ===========================================================================

  server.tool(
    "execute_transfer",
    "Transfer native tokens (ETH, MATIC) or ERC20 tokens from your wallet to a recipient address. Requires a wallet integration.",
    {
      network: z
        .string()
        .describe("Chain ID (e.g., '1' for Ethereum, '8453' for Base)"),
      recipient_address: z
        .string()
        .describe("Recipient wallet address (0x...)"),
      amount: z
        .string()
        .describe("Amount to transfer in human-readable units (e.g., '0.1')"),
      token_address: z
        .string()
        .optional()
        .describe(
          "ERC20 token contract address. Omit for native token transfers."
        ),
    },
    { title: "Transfer Funds", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("execute_transfer", scope, async (args) =>
      withToolLogging("execute_transfer", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/execute/transfer",
          "POST",
          {
            network: args.network,
            recipientAddress: args.recipient_address,
            amount: args.amount,
            tokenAddress: args.token_address,
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "execute_contract_call",
    "Call a smart contract function. For view/pure functions, returns the result directly. For state-changing functions, submits a transaction and returns the execution ID. Requires a wallet integration for write calls.",
    {
      contract_address: z.string().describe("Contract address (0x...)"),
      network: z.string().describe("Chain ID (e.g., '1' for Ethereum)"),
      function_name: z
        .string()
        .describe("Solidity function name (e.g., 'balanceOf', 'transfer')"),
      function_args: z
        .string()
        .optional()
        .describe(
          'JSON array of function arguments (e.g., \'["0x...", "1000"]\')'
        ),
      abi: z
        .string()
        .optional()
        .describe(
          "Contract ABI as JSON string. Auto-fetched for verified contracts if omitted."
        ),
      value: z
        .string()
        .optional()
        .describe(
          "ETH value to send with the call in wei (for payable functions)"
        ),
      gas_limit_multiplier: z
        .string()
        .optional()
        .describe("Gas limit multiplier (e.g., '1.5' for 50% buffer)"),
    },
    { title: "Contract Call", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("execute_contract_call", scope, async (args) =>
      withToolLogging("execute_contract_call", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/execute/contract-call",
          "POST",
          {
            contractAddress: args.contract_address,
            network: args.network,
            functionName: args.function_name,
            functionArgs: args.function_args,
            abi: args.abi,
            value: args.value,
            gasLimitMultiplier: args.gas_limit_multiplier,
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "execute_check_and_execute",
    "Read a contract value, evaluate a condition, and execute an action if the condition is met. Useful for conditional on-chain operations (e.g., 'if balance > 1000, then transfer'). Requires a wallet integration.",
    {
      contract_address: z
        .string()
        .describe("Contract address to read the check value from (0x...)"),
      network: z.string().describe("Chain ID (e.g., '1' for Ethereum)"),
      function_name: z
        .string()
        .describe("Function to call for the check (e.g., 'balanceOf')"),
      function_args: z
        .string()
        .optional()
        .describe("JSON array of function arguments for the check"),
      abi: z
        .string()
        .optional()
        .describe("ABI for the check contract (auto-fetched if omitted)"),
      condition: z.object({
        operator: z
          .enum(["eq", "neq", "gt", "lt", "gte", "lte"])
          .describe("Comparison operator"),
        value: z.string().describe("Target value to compare against"),
      }),
      action: z.object({
        contract_address: z
          .string()
          .describe("Contract to call if condition met (0x...)"),
        function_name: z
          .string()
          .describe("Function to execute if condition met"),
        function_args: z
          .string()
          .optional()
          .describe("JSON array of function arguments for the action"),
        abi: z.string().optional().describe("ABI for the action contract"),
        gas_limit_multiplier: z
          .string()
          .optional()
          .describe("Gas limit multiplier for the action"),
      }),
    },
    { title: "Check and Execute", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("execute_check_and_execute", scope, async (args) =>
      withToolLogging("execute_check_and_execute", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          "/api/execute/check-and-execute",
          "POST",
          {
            contractAddress: args.contract_address,
            network: args.network,
            functionName: args.function_name,
            functionArgs: args.function_args,
            abi: args.abi,
            condition: args.condition,
            action: {
              contractAddress: args.action.contract_address,
              functionName: args.action.function_name,
              functionArgs: args.action.function_args,
              abi: args.action.abi,
              gasLimitMultiplier: args.action.gas_limit_multiplier,
            },
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_direct_execution_status",
    "Get the status of a direct execution (transfer or contract call). Returns transaction hash, status, and result when complete.",
    {
      execution_id: z
        .string()
        .describe(
          "The execution ID returned by execute_transfer, execute_contract_call, or execute_check_and_execute"
        ),
    },
    {
      title: "Get Direct Execution Status",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("get_direct_execution_status", scope, async (args) =>
      withToolLogging("get_direct_execution_status", undefined, async () => {
        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/execute/${args.execution_id}/status`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );
}

// =============================================================================
// Protocol meta-tools (replaces individual per-action tool registration)
// =============================================================================

export function registerMetaTools(
  server: McpServer,
  baseUrl: string,
  authHeader: string,
  scope?: string
): void {
  // Meta-tool 1: Search and discover available protocol actions
  server.tool(
    "search_protocol_actions",
    "Search for available protocol actions across all supported DeFi protocols (Aave, Morpho, Chronicle, Chainlink, Uniswap, Compound, Lido, etc.). Call this first to discover what actions are available and what parameters they require, then use execute_protocol_action to run them.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Keyword search across action names and descriptions (e.g., 'ETH balance', 'borrow', 'swap')"
        ),
      protocol: z
        .string()
        .optional()
        .describe(
          "Filter by protocol name (e.g., 'chronicle', 'aave', 'morpho', 'uniswap', 'compound', 'lido', 'chainlink')"
        ),
    },
    {
      title: "Search Protocol Actions",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("search_protocol_actions", scope, async (args) =>
      withToolLogging("search_protocol_actions", undefined, async () => {
        const params = new URLSearchParams();
        if (args.protocol) {
          params.set("category", args.protocol);
        }
        params.set("includeChains", "false");
        const path = `/api/mcp/schemas${params.toString() ? `?${params.toString()}` : ""}`;
        const data = (await callApi(
          baseUrl,
          authHeader,
          path,
          "GET"
        )) as Record<string, unknown>;

        const actions = (data.actions ?? {}) as Record<
          string,
          {
            actionType?: string;
            label?: string;
            description?: string;
            requiredFields?: Record<string, string>;
            optionalFields?: Record<string, string>;
            requiresCredentials?: boolean;
          }
        >;

        let results = Object.values(actions);

        // Client-side keyword filtering
        if (args.query) {
          const q = args.query.toLowerCase();
          results = results.filter(
            (a) =>
              a.label?.toLowerCase().includes(q) ||
              a.description?.toLowerCase().includes(q) ||
              a.actionType?.toLowerCase().includes(q)
          );
        }

        // Return compact results
        const compact = results.map((a) => ({
          actionType: a.actionType,
          label: a.label,
          description: a.description,
          requiredFields: a.requiredFields,
          optionalFields: a.optionalFields,
          requiresCredentials: a.requiresCredentials,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { count: compact.length, actions: compact },
                null,
                2
              ),
            },
          ],
        };
      })
    )
  );

  // Meta-tool 2: Execute any protocol action by actionType
  server.tool(
    "execute_protocol_action",
    "Execute a DeFi protocol action directly. Use search_protocol_actions first to discover available actions and their required parameters. The actionType follows the format 'protocol/action-slug' (e.g., 'chronicle/eth-usd-read', 'aave/supply', 'morpho/get-position'). Pass all required parameters in the params object.",
    {
      actionType: z
        .string()
        .describe(
          "The action identifier in 'protocol/action-slug' format (e.g., 'chronicle/eth-usd-read', 'aave/get-user-account-data')"
        ),
      params: z
        .record(z.string(), z.unknown())
        .describe(
          "Action parameters as key-value pairs (e.g., {network: '1', address: '0x...'}). Use search_protocol_actions to discover required params."
        ),
    },
    {
      title: "Execute Protocol Action",
      readOnlyHint: false,
      destructiveHint: false,
    },
    withScopeCheck("execute_protocol_action", scope, async (args) =>
      withToolLogging("execute_protocol_action", undefined, async () => {
        const parts = args.actionType.split("/");
        if (parts.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Invalid actionType format",
                  message:
                    "actionType must be in 'protocol/action-slug' format (e.g., 'chronicle/eth-usd-read')",
                }),
              },
            ],
            isError: true,
          };
        }

        const integration = parts[0];
        const slug = parts.slice(1).join("/");

        const data = await callApi(
          baseUrl,
          authHeader,
          `/api/execute/${integration}/${slug}`,
          "POST",
          args.params as Record<string, unknown>
        );

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );
}
