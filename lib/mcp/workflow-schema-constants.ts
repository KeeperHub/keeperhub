// Constants extracted from app/api/mcp/schemas/route.ts so consumers
// (validate_workflow, schemas route, future MCP tooling) share one
// canonical definition. NO behavior change in this extraction.
//
// To add a new system action: add an entry to SYSTEM_ACTIONS and
// implement the step in lib/steps/. To add a new trigger: add an entry
// to TRIGGERS and implement the UI in
// components/workflow/config/trigger-config.tsx.

import {
  BUILTIN_NODE_ID,
  BUILTIN_NODE_LABEL,
} from "@/lib/workflow/editor/builtin-variables";

// =============================================================================
// SYSTEM ACTIONS (inline - these rarely change)
// To add a new system action: add entry here and implement in lib/steps/
// =============================================================================
export const SYSTEM_ACTIONS = {
  Condition: {
    actionType: "Condition",
    label: "Condition",
    description:
      "Conditional branch with dual output paths (true/false). Connect downstream nodes to the 'true' or 'false' source handles to create if/else logic in a single Condition node.",
    category: "System",
    requiredFields: {
      condition:
        'string - JavaScript expression using {{@nodeId:Label.field}} syntax. Supported operators: == (soft equals), === (equals), != (soft not equals), !== (not equals), >, >=, <, <=, contains, startsWith, endsWith, matchesRegex, isEmpty, isNotEmpty, exists (not null and not undefined), doesNotExist (null or undefined), isNull (=== null), isNotNull (!== null), isUndefined (=== undefined), isNotUndefined (!== undefined). Use == for cross-type comparisons (e.g., string "0" vs number 0). Example: "{{@check-balance:Check Balance.balance}} == 0"',
    },
    optionalFields: {
      conditionConfig:
        'object - Visual condition builder config. Structure: { group: { id: "nanoid", logic: "AND" | "OR", rules: [{ id: "nanoid", leftOperand: "{{@nodeId:Label.field}}", operator: "===" | "==" | "!==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "startsWith" | "endsWith" | "isEmpty" | "isNotEmpty" | "exists" | "doesNotExist" | "isNull" | "isNotNull" | "isUndefined" | "isNotUndefined" | "matchesRegex", rightOperand: "value" }] } }. Every group and rule MUST have a unique id. Operator must be the exact symbol (e.g. "===" not "equals", "<" not "less_than"). When provided, the condition expression is auto-generated from this visual config.',
    },
    outputFields: {
      result: "boolean - Whether the condition evaluated to true",
    },
    sourceHandles: ["true", "false"],
    behavior:
      "BRANCH - has two output handles ('true' and 'false'). Edges from sourceHandle 'true' execute when condition is true; edges from sourceHandle 'false' execute when condition is false. For new workflows, always set sourceHandle on edges from Condition nodes.",
  },
  "HTTP Request": {
    actionType: "HTTP Request",
    label: "HTTP Request",
    description: "Make HTTP requests to external APIs",
    category: "System",
    requiredFields: {
      endpoint: "string - Full URL to call",
      httpMethod: "string - GET, POST, PUT, DELETE, or PATCH",
    },
    optionalFields: {
      httpHeaders: "string - JSON object of headers",
      httpBody: "string - JSON request body (ignored for GET)",
      timeout: "number - Request timeout in seconds (default 5, min 1, max 30)",
      failOnError:
        "boolean - Default true. When false, a non-2xx response or timeout does not fail the step; instead the next node receives { status, data: null, error }. Use for aggregator workflows where one source being down should not fail the whole run.",
    },
    outputFields: {
      status: "number - HTTP status code (null on timeout or connection error)",
      data: "object - Response body (parsed JSON), or null on a soft failure",
      error:
        "string - Present only on a soft failure (failOnError=false): the failure reason",
    },
  },
  "Database Query": {
    actionType: "Database Query",
    label: "Database Query",
    description: "Execute SQL queries against connected database",
    category: "System",
    requiredFields: {
      integrationId: "string - ID of the database integration",
      dbQuery:
        "string - SQL query with inline template references for dynamic values. Use {{@nodeId:Label.field}} directly in the SQL string. Example: \"INSERT INTO logs (vault, price) VALUES ('{{@compute:Compare.bestVault}}', '{{@compute:Compare.bestPrice}}')\" or \"SELECT * FROM positions WHERE address = '{{@trigger-1:Trigger.address}}'\"",
    },
    optionalFields: {
      dbSchema: "string - JSON schema for result typing",
      connectTimeout:
        "number - Connection timeout in seconds (default 30, min 1, max 60). Raise for serverless databases that scale to zero and need time to wake on a cold start.",
      retries:
        "number - Connection retries (default 1, min 0, max 3). Retries only pre-query connection failures (e.g. a cold-start connect timeout); never re-runs a query that already started, so writes are not duplicated.",
    },
    outputFields: {
      rows: "array - Query result rows",
      rowCount: "number - Number of rows returned",
    },
  },
  "For Each": {
    actionType: "For Each",
    label: "For Each",
    description:
      "Loop over an array - executes connected body nodes once per element. Optionally pair with a downstream Collect node to aggregate results. Without Collect, the loop runs as fire-and-forget (side effects only).",
    category: "System",
    requiredFields: {
      arraySource:
        'string - Template reference to an array, e.g., "{{@db-query-1:Database Query.rows}}" or "{{@http-1:HTTP Request.data.items}}"',
    },
    optionalFields: {
      maxIterations:
        "number - Safety limit on iterations (default: processes entire array)",
      mapExpression:
        'string - Dot-path to extract from each element, e.g., "address" or "data.name". When set, the iteration output is transformed before being collected.',
      concurrency:
        '"sequential" | "parallel" | "custom" - Execution mode for iterations (default: "sequential"). "parallel" runs all at once, "custom" uses concurrencyLimit.',
      concurrencyLimit:
        'number - Max concurrent iterations when concurrency is "custom" (min: 2)',
    },
    outputFields: {
      currentItem:
        "unknown - Current array element (available inside loop body only via {{@forEachNodeId:For Each.currentItem}})",
      index:
        "number - Current zero-based iteration index (available inside loop body only)",
      totalItems:
        "number - Total number of items being iterated (available inside loop body only)",
    },
    behavior:
      "LOOP - executes all downstream nodes once per array element. Optionally end with a Collect node to aggregate results. Without Collect, all downstream nodes run as fire-and-forget.",
  },
  Collect: {
    actionType: "Collect",
    label: "Collect",
    description:
      "Gathers results from a preceding For Each loop into an array. Place downstream of a For Each node to mark the end of the loop body and enable result aggregation.",
    category: "System",
    requiredFields: {},
    optionalFields: {},
    outputFields: {
      results:
        "array - Array of outputs from each iteration (one entry per element)",
      count: "number - Number of iterations completed",
    },
  },
} as const;

// =============================================================================
// TRIGGERS (inline - these rarely change)
// To add a new trigger: add entry here and implement in trigger-config.tsx
// =============================================================================
export const TRIGGERS = {
  Manual: {
    triggerType: "Manual",
    label: "Manual",
    description: "Manually triggered workflow via UI or API",
    requiredFields: {},
    optionalFields: {},
    outputFields: {
      triggeredAt:
        "string - ISO timestamp when the workflow was triggered (available on all trigger types)",
    },
  },
  Schedule: {
    triggerType: "Schedule",
    label: "Schedule",
    description: "Time-based scheduled trigger using cron expressions",
    requiredFields: {
      scheduleCron:
        'string - Cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am)',
    },
    optionalFields: {
      scheduleTimezone: 'string - Timezone (e.g., "America/New_York", "UTC")',
    },
    outputFields: {
      triggeredAt:
        "string - ISO timestamp when the schedule fired (available on all trigger types)",
    },
  },
  Webhook: {
    triggerType: "Webhook",
    label: "Webhook",
    description:
      "HTTP webhook trigger - workflow executes when webhook URL receives a request",
    requiredFields: {},
    optionalFields: {
      webhookSchema: "string - JSON schema for expected payload validation",
      webhookMockRequest: "string - Sample JSON payload for testing",
    },
    outputFields: {
      body: "object - Webhook request body",
      headers: "object - Webhook request headers",
      method: "string - HTTP method (GET, POST, etc.)",
      query: "object - Query parameters",
      triggeredAt:
        "string - ISO timestamp when the webhook was received (available on all trigger types)",
    },
  },
  Event: {
    triggerType: "Event",
    label: "Blockchain Event",
    description:
      "Blockchain event trigger - listens for smart contract events on-chain",
    requiredFields: {
      network:
        'string - Chain ID to listen on (e.g., "1" for Ethereum, "11155111" for Sepolia)',
      contractAddress: "string - Contract address to watch for events",
      contractABI:
        "string - Contract ABI JSON (auto-fetched if contract is verified)",
      eventName:
        'string - Event name to listen for (e.g., "Transfer", "Approval")',
    },
    optionalFields: {},
    outputFields: {
      eventName: "string - Name of the event that was emitted",
      args: "object - Event arguments (decoded parameters from ABI)",
      blockNumber: "number - Block number where event was emitted",
      transactionHash: "string - Transaction hash that emitted the event",
      address: "string - Contract address that emitted the event",
      logIndex: "number - Index of the log in the block",
      triggeredAt:
        "string - ISO timestamp when the event was detected (available on all trigger types)",
    },
  },
  Block: {
    triggerType: "Block",
    label: "Block",
    description:
      "Blockchain block trigger - fires workflow at block intervals on a chain",
    requiredFields: {
      network: 'string - Chain ID (e.g., "1" for Ethereum, "8453" for Base)',
      blockInterval:
        'string - Fire every N blocks (e.g., "1" for every block, "10" for every 10th)',
    },
    optionalFields: {},
    outputFields: {
      // EVM chains
      blockNumber: "number - EVM: the block number",
      blockHash: "string - EVM: hash of the block",
      blockTimestamp: "number - EVM: Unix timestamp of the block",
      parentHash: "string - EVM: hash of the parent block",
      // Solana chains (fields emitted by the solana-tracker block payload;
      // keep in sync with buildBlockPayload in
      // keeperhub-events/solana-tracker/src/payload/block-payload.ts)
      chainType: 'string - Solana: "solana"; absent on EVM block triggers',
      slot: "number - Solana: the slot the block was produced in",
      blockHeight:
        "number - Solana: the block height (null for skipped/empty slots)",
      blockhash:
        "string - Solana: the block hash (note: lower-case, distinct from EVM blockHash)",
      blockTime: "number - Solana: Unix timestamp of the block (may be null)",
      parentSlot: "number - Solana: the parent slot",
      triggeredAt:
        "string - ISO timestamp when the block was detected (available on all trigger types)",
    },
  },
  Transfer: {
    triggerType: "Transfer",
    label: "Transfer",
    description:
      "Fires when a TIP-20 TransferWithMemo payment lands on a watched Tempo address, with an optional memo filter for invoice matching",
    requiredFields: {
      network: 'string - Tempo chain ID ("4217" mainnet, "42431" Moderato)',
      contractAddress:
        "string - TIP-20 stablecoin token contract to watch for payments",
      recipientAddress:
        "string - The deposit address to match against the transfer recipient",
    },
    optionalFields: {
      memo: "string - Only fire when the transfer memo matches. A 0x + 64-hex value matches exactly; a shorter string matches as a prefix",
    },
    outputFields: {
      "args.from": "string - Sender address of the payment",
      "args.to": "string - Recipient address (the watched deposit address)",
      "args.value": "string - Amount transferred, in the token's smallest unit",
      "args.memo": "string - The bytes32 memo attached to the transfer",
      "args.memoText":
        "string - The memo decoded to text (e.g. INV-1042), or empty for a non-text memo",
      transactionHash: "string - Hash of the payment transaction",
      blockNumber: "number - Block height the payment landed in",
      address: "string - The TIP-20 token contract that emitted the event",
      triggeredAt:
        "string - ISO timestamp when the payment was detected (available on all trigger types)",
    },
  },
} as const;

// =============================================================================
// TEMPLATE SYNTAX DOCUMENTATION (inline - core system behavior)
// Update if template engine syntax changes in lib/steps/step-handler.ts
// =============================================================================
export const TEMPLATE_SYNTAX = {
  pattern: "{{@nodeId:Label.field}}",
  description:
    "Reference output from a previous node in the workflow. The @ symbol indicates a node reference.",
  examples: [
    {
      template: "{{@check-balance:Check Balance.balance}}",
      description:
        "Reference the 'balance' output from a node labeled 'Check Balance'",
    },
    {
      template: "{{@trigger-1:Trigger.amount}}",
      description:
        "Reference field 'amount' from a webhook (or manual) trigger. Trigger inputs are spread at the TOP LEVEL of the trigger output - there is no 'body' or 'data' wrapper - and the reference uses the trigger node's actual id (e.g. trigger-1), not a bare 'trigger' alias",
    },
    {
      template: "{{@http-1:Fetch Price.data.price}}",
      description: "Reference 'price' from HTTP request response data",
    },
    {
      template: "{{@read-1:Read Contract.result.liquidityIndex}}",
      description:
        "Named-field access into a tuple/struct read-contract output. Tuple components surface as named keys (configuration, liquidityIndex, etc.); positional indexing like result[1] does NOT work on tuple outputs and a bare step2[1] is never valid",
    },
    {
      template: "{{@read-1:Read Contract.result.holders[0]}}",
      description:
        "Bracket indexing is only valid for ARRAY fields, inside the field path - here `holders` is an address[] output and [0] picks the first element",
    },
    {
      template: `{{@${BUILTIN_NODE_ID}:${BUILTIN_NODE_LABEL}.unixTimestamp}}`,
      description:
        "Current Unix timestamp in seconds (built-in, evaluated at execution time)",
    },
  ],
  notes: [
    "nodeId is the unique identifier of the node (visible in node settings)",
    "Label is the human-readable name shown on the node",
    "Nested fields use dot notation (e.g., data.nested.value)",
    "Trigger inputs (webhook JSON body / event fields) are placed at the TOP LEVEL of the trigger output - reference them as {{@<triggerNodeId>:Trigger.<field>}} (e.g. {{@trigger-1:Trigger.amount}}), NOT {{@trigger:Trigger.body.<field>}}; the bare 'trigger' alias resolves only in calldata/event-trigger contexts, so use the trigger node's real id",
    "Tuple/struct outputs surface their components as NAMED fields - use result.<componentName> (e.g. result.liquidityIndex), NOT positional result[1]",
    "Bracket indexing [n] is only for ARRAY fields, applied inside the field path (e.g. result.items[0]); numeric indices only",
    "Condition expressions use this same reference and path grammar - never a bare step2[1] (this fails validation with an actionable error)",
    "Templates are resolved at runtime before each step executes",
  ],
};

// Helper types Phase 48 + future phases can consume.
export type TriggerKey = keyof typeof TRIGGERS;
export type SystemActionKey = keyof typeof SYSTEM_ACTIONS;
