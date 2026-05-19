import { isNotNull, relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IntegrationType } from "../types/integration";
import { generateId } from "../utils/id";

// These enums are created by @workflow/world-postgres migrations in the public
// schema and referenced by workflow.workflow_runs / workflow.workflow_steps.
// Declaring them here prevents drizzle-kit from trying to drop them.
export const workflowRunStatus = pgEnum("status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const workflowStepStatus = pgEnum("step_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

// Better Auth tables
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  // Anonymous user tracking
  isAnonymous: boolean("is_anonymous").default(false),
  deactivatedAt: timestamp("deactivated_at"),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("idx_sessions_user_id").on(table.userId)]
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("idx_accounts_user_id").on(table.userId)]
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// Organization tables
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("idx_member_user_id").on(table.userId),
    index("idx_member_organization_id").on(table.organizationId),
  ]
);

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").default("pending").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const addressBookEntry = pgTable(
  "address_book_entry",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    address: text("address").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("idx_address_book_org").on(table.organizationId)]
);

export const projects = pgTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_projects_org").on(table.organizationId)]
);

export const tags = pgTable(
  "tags",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name").notNull(),
    color: text("color").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_tags_org").on(table.organizationId)]
);
// Workflow visibility type
export type WorkflowVisibility = "private" | "public";

// Workflows table with user association
export const workflows = pgTable(
  "workflows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    isAnonymous: boolean("is_anonymous").default(false).notNull(),
    featured: boolean("featured").default(false).notNull(),
    featuredOrder: integer("featured_order").default(0),
    featuredProtocol: text("featured_protocol"),
    featuredProtocolOrder: integer("featured_protocol_order").default(0),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    tagId: text("tag_id").references(() => tags.id, {
      onDelete: "set null",
    }),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    nodes: jsonb("nodes").notNull().$type<any[]>(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    edges: jsonb("edges").notNull().$type<any[]>(),
    visibility: text("visibility")
      .notNull()
      .default("private")
      .$type<WorkflowVisibility>(),
    enabled: boolean("enabled").default(false).notNull(), // keeperhub custom field //
    sourceWorkflowId: text("source_workflow_id"), // tracks which public template was duplicated
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    // KEEP-458: last time the row was written by scripts/seed/seed-protocol-workflows.
    // Null for user-created rows. Lets the seeder detect post-seed user edits
    // (updatedAt > seededAt + epsilon) without overloading createdAt/updatedAt.
    seededAt: timestamp("seeded_at"),
    // v1.7: Workflow listing columns (INFRA-01)
    isListed: boolean("is_listed").default(false).notNull(),
    listedSlug: text("listed_slug"),
    listedAt: timestamp("listed_at"),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
    outputMapping: jsonb("output_mapping").$type<Record<string, unknown>>(),
    priceUsdcPerCall: numeric("price_usdc_per_call"),
    // v1.7: MCP meta-tools columns (MCP-01, MCP-03)
    workflowType: text("workflow_type")
      .$type<"read" | "write">()
      .default("read")
      .notNull(),
    category: text("category"),
    chain: text("chain"),
    // v1.11: per-workflow MCP server versioning (incremented on listing schema changes)
    listingVersion: integer("listing_version").notNull().default(1),
    // KEEP-440: soft-delete. Set instead of hard-deleting the row so the listed
    // slug stays bound to this row and cannot be re-claimed by another workflow.
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    // INFRA-02: globally unique listed slug so external callers can invoke by slug alone
    uniqueIndex("idx_workflows_listed_slug")
      .on(table.listedSlug)
      .where(isNotNull(table.listedSlug)),
    index("idx_workflows_user_id").on(table.userId),
    index("idx_workflows_tag_id").on(table.tagId),
    index("idx_workflows_project_id").on(table.projectId),
  ]
);

// Integrations table for storing user credentials
export const integrations = pgTable(
  "integrations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    type: text("type").notNull().$type<IntegrationType>(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - encrypted credentials stored as JSON
    config: jsonb("config").notNull().$type<any>(),
    // Whether this integration was created via OAuth (managed by app) vs manual entry
    isManaged: boolean("is_managed").default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // At most one web3 integration row per org. Today the only web3 row is
    // the cosmetic KeeperHub-wallet entry; the broader rule is enforced
    // here so any future web3 write hits the same guard. Closes the race
    // in ensureWalletIntegration where two concurrent /api/integrations
    // GETs could both pass the existence check and both insert.
    uniqueIndex("idx_integrations_org_web3")
      .on(table.organizationId)
      .where(
        sql`${table.type} = 'web3' AND ${table.organizationId} IS NOT NULL`
      ),
    index("idx_integrations_user_id").on(table.userId),
  ]
);

// Workflow executions table to track workflow runs
export type TransactionHashEntry = {
  hash: string;
  nodeId: string;
  nodeName: string;
  chainId?: number;
  network?: string;
  iterationIndex?: number;
};

export const workflowExecutions = pgTable(
  "workflow_executions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    status: text("status")
      .notNull()
      .$type<"pending" | "running" | "success" | "error" | "cancelled">(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    input: jsonb("input").$type<Record<string, any>>(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    output: jsonb("output").$type<any>(),
    error: text("error"),
    errorCategory: text("error_category").$type<
      | "validation"
      | "configuration"
      | "external_service"
      | "network_rpc"
      | "transaction"
      | "database"
      | "auth"
      | "infrastructure"
      | "workflow_engine"
      | "unknown"
    >(),
    errorType: text("error_type").$type<"user" | "system">(),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    duration: numeric("duration"), // Duration in milliseconds
    // Progress tracking
    totalSteps: text("total_steps"),
    completedSteps: text("completed_steps").default("0"),
    currentNodeId: text("current_node_id"),
    currentNodeName: text("current_node_name"),
    lastSuccessfulNodeId: text("last_successful_node_id"),
    lastSuccessfulNodeName: text("last_successful_node_name"),
    executionTrace: jsonb("execution_trace").$type<string[]>(),
    runId: text("run_id"),
    transactionHashes: jsonb("transaction_hashes")
      .$type<TransactionHashEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Whether this execution counts toward the owner organisation's monthly
     * execution quota and overage billing.
     *
     * Defaults to TRUE on every insert. The marketplace call route is the
     * only path that ever flips a row to FALSE, and only after recordPayment
     * succeeds and the recorded price is at or above
     * FREE_MARKETPLACE_BILLING_THRESHOLD_USDC. Owner-initiated runs (manual
     * Run, scheduled, block, event, webhook) and direct API calls always
     * stay TRUE.
     *
     * See drizzle/0070_workflow_executions_billable.sql,
     * lib/billing/marketplace-billing.ts, and
     * app/api/mcp/workflows/[slug]/call/route.ts.
     */
    billable: boolean("billable").notNull().default(true),
  },
  (table) => [
    index("idx_workflow_executions_status").on(table.status),
    index("idx_workflow_executions_user_id").on(table.userId),
  ]
);

// Workflow execution logs to track individual node executions
export const workflowExecutionLogs = pgTable(
  "workflow_execution_logs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
  executionId: text("execution_id")
    .notNull()
    .references(() => workflowExecutions.id),
  nodeId: text("node_id").notNull(),
  nodeName: text("node_name").notNull(),
  nodeType: text("node_type").notNull(),
  status: text("status")
    .notNull()
    .$type<"pending" | "running" | "success" | "error" | "cancelled">(),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
  input: jsonb("input").$type<any>(),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
  output: jsonb("output").$type<any>(),
  // output_raw is the executor's authoritative source-of-truth for cross-process resume.
  // `output` receives redactSensitiveData() for observability/UI display; `output_raw`
  // stores the unredacted payload so downstream template rendering receives real values
  // rather than "[REDACTED]" strings when a pod resumes across a process boundary.
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
  outputRaw: jsonb("output_raw").$type<any>(),
  error: text("error"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  duration: numeric("duration"), // Duration in milliseconds
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  iterationIndex: integer("iteration_index"), // 0-based loop iteration (null for non-loop nodes)
  forEachNodeId: text("for_each_node_id"), // parent For Each node ID (null for non-loop nodes)
  },
  (table) => [index("idx_exec_logs_started_at").on(table.startedAt)]
);

export {
  type AgenticWalletCredit,
  agenticWalletCredits,
  type NewAgenticWalletCredit,
} from "./schema-agentic-wallet-credits";
export {
  type AgenticWallet,
  type AgenticWalletDailySpend,
  type AgenticWalletHmacSecret,
  type AgenticWalletRateLimit,
  agenticWalletDailySpend,
  agenticWalletHmacSecrets,
  agenticWalletRateLimits,
  agenticWallets,
  approvalRiskLevel,
  approvalStatus,
  type NewAgenticWallet,
  type NewAgenticWalletDailySpend,
  type NewAgenticWalletHmacSecret,
  type NewAgenticWalletRateLimit,
  type NewWalletApprovalRequest,
  type WalletApprovalRequest,
  walletApprovalRequests,
} from "./schema-agentic-wallets";
// KeeperHub: Para Wallets, Organization API Keys, and Organization Tokens (imported from KeeperHub schema extensions)
// Note: Using relative path instead of @/ alias for drizzle-kit compatibility
export {
  type BillingEvent,
  billingEvents,
  type DirectExecution,
  directExecutions,
  type ExecutionDebt,
  executionDebt,
  type GasCreditAllocation,
  gasCreditAllocations,
  gasCreditUsage,
  gasSponsorshipDelegations,
  keyExportCodes,
  type NewBillingEvent,
  type NewDirectExecution,
  type NewExecutionDebt,
  type NewGasCreditAllocation,
  type NewOrganizationApiKey,
  type NewOrganizationSpendCap,
  type NewOrganizationSubscription,
  type NewOrganizationToken,
  type NewOrganizationWallet,
  type NewParaWallet,
  type NewPublicTag,
  type NewSupportedToken,
  type NewWorkflowPublicTag,
  type OrganizationApiKey,
  type OrganizationSpendCap,
  type OrganizationSubscription,
  type OrganizationToken,
  type OrganizationWallet,
  type OverageBillingRecord,
  organizationApiKeys,
  organizationSpendCaps,
  organizationSubscriptions,
  organizationTokens,
  organizationWallets,
  overageBillingRecords,
  type ParaWallet,
  type PendingTransaction,
  type PublicTag,
  paraWallets,
  pendingTransactions,
  publicTags,
  type SupportedToken,
  supportedTokens,
  type WalletLock,
  type WorkflowPublicTag,
  walletLocks,
  workflowPublicTags,
  workflowRatings,
} from "./schema-extensions";
export { feedback, feedbackStatus } from "./schema-feedback";
export {
  type McpOauthAuthCode,
  type McpOauthClient,
  type McpOauthRefreshToken,
  mcpOauthAuthCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
  type NewMcpOauthAuthCode,
  type NewMcpOauthClient,
  type NewMcpOauthRefreshToken,
} from "./schema-oauth";
export {
  type NewWorkflowPayment,
  type WorkflowPayment,
  workflowPayments,
} from "./schema-payments";

// Better Auth: Device Authorization table (for CLI device flow)
export const deviceCode = pgTable("device_code", {
  id: text("id").primaryKey(),
  deviceCode: text("device_code").notNull(),
  userCode: text("user_code").notNull(),
  userId: text("user_id").references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  status: text("status").notNull(),
  lastPolledAt: timestamp("last_polled_at"),
  pollingInterval: integer("polling_interval"),
  clientId: text("client_id"),
  scope: text("scope"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// API Keys table for webhook authentication
export const apiKeys = pgTable("api_keys", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name"), // Optional label for the API key
  keyHash: text("key_hash").notNull(), // Store hashed version of the key
  keyPrefix: text("key_prefix").notNull(), // Store first few chars for display (e.g., "wf_abc...")
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
});

// Beta Access Requests - stores emails requesting beta access
export const betaAccessRequests = pgTable("beta_access_requests", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Workflow Schedules table for scheduled trigger configuration
export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id")
      .notNull()
      .unique()
      .references(() => workflows.id, { onDelete: "cascade" }),
    cronExpression: text("cron_expression").notNull(),
    // KEEP-575: true-interval scheduling. When intervalSeconds is set, the
    // dispatcher fires on anchorAt + k * intervalSeconds instead of parsing
    // cronExpression. This expresses "every 55 minutes" accurately, which
    // a 5-field cron cannot when the period doesn't divide 60. In that mode
    // cronExpression holds a fixed non-match sentinel (see
    // INTERVAL_MODE_CRON_PLACEHOLDER) and `timezone` is unused by the
    // dispatcher -- interval math is in raw milliseconds. The column is
    // still populated for display purposes and stays meaningful for cron
    // mode.
    intervalSeconds: integer("interval_seconds"),
    anchorAt: timestamp("anchor_at", { withTimezone: true }),
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status").$type<"success" | "error" | null>(),
    lastError: text("last_error"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    runCount: text("run_count").default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_workflow_schedules_enabled").on(table.enabled),
    uniqueIndex("idx_workflow_schedules_workflow").on(table.workflowId),
  ]
);

// Supported blockchain networks with default RPC endpoints
export const chains = pgTable(
  "chains",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    chainId: integer("chain_id").notNull().unique(), // e.g., 1, 11155111, 8453
    name: text("name").notNull(), // e.g., "Ethereum Mainnet"
    symbol: text("symbol").notNull(), // e.g., "ETH"
    chainType: text("chain_type").notNull().default("evm"), // "evm" | "solana"
    defaultPrimaryRpc: text("default_primary_rpc").notNull(),
    defaultFallbackRpc: text("default_fallback_rpc"),
    defaultPrimaryWss: text("default_primary_wss"), // WebSocket URL
    defaultFallbackWss: text("default_fallback_wss"),
    // KEEP-137: Private mempool routing (Flashbots Protect). When enabled,
    // write transactions for this chain can be routed through defaultPrivateRpcUrl
    // instead of the public mempool.
    usePrivateMempoolRpc: boolean("use_private_mempool_rpc").default(false),
    defaultPrivateRpcUrl: text("default_private_rpc_url"),
    isTestnet: boolean("is_testnet").default(false),
    isEnabled: boolean("is_enabled").default(true), // Can disable chains
    // KEEP-1240: Chain-specific gas configuration
    gasConfig: jsonb("gas_config").default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_chains_chain_id").on(table.chainId)]
);

// Explorer configuration for each chain (KEEP-1154)
export const explorerConfigs = pgTable(
  "explorer_configs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    chainId: integer("chain_id")
      .notNull()
      .unique()
      .references(() => chains.chainId, { onDelete: "cascade" }),
    chainType: text("chain_type").notNull().default("evm"), // "evm" | "solana" - mirrors chains.chainType
    explorerUrl: text("explorer_url"), // e.g., "https://etherscan.io"
    explorerApiType: text("explorer_api_type"), // "etherscan" | "blockscout" | "solscan"
    explorerApiUrl: text("explorer_api_url"), // Base URL for API calls (ABI, balance, etc.)
    explorerTxPath: text("explorer_tx_path").default("/tx/{hash}"),
    explorerAddressPath: text("explorer_address_path").default(
      "/address/{address}"
    ),
    explorerContractPath: text("explorer_contract_path"), // e.g., "/address/{address}#code"
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_explorer_configs_chain_id").on(table.chainId)]
);

// User-specific RPC endpoint overrides
export const userRpcPreferences = pgTable(
  "user_rpc_preferences",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(), // References chains.chainId
    primaryRpcUrl: text("primary_rpc_url").notNull(),
    fallbackRpcUrl: text("fallback_rpc_url"),
    primaryWssUrl: text("primary_wss_url"), // WebSocket URL override
    fallbackWssUrl: text("fallback_wss_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_user_rpc_user_chain").on(table.userId, table.chainId),
    index("idx_user_rpc_user_id").on(table.userId),
  ]
);

// Relations
export const workflowExecutionsRelations = relations(
  workflowExecutions,
  ({ one }) => ({
    workflow: one(workflows, {
      fields: [workflowExecutions.workflowId],
      references: [workflows.id],
    }),
  })
);

export const workflowSchedulesRelations = relations(
  workflowSchedules,
  ({ one }) => ({
    workflow: one(workflows, {
      fields: [workflowSchedules.workflowId],
      references: [workflows.id],
    }),
  })
);

// Organization relations
export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
  addressBookEntries: many(addressBookEntry),
  projects: many(projects),
  tags: many(tags),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(users, {
    fields: [member.userId],
    references: [users.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  inviter: one(users, {
    fields: [invitation.inviterId],
    references: [users.id],
  }),
}));

export const addressBookEntryRelations = relations(
  addressBookEntry,
  ({ one }) => ({
    organization: one(organization, {
      fields: [addressBookEntry.organizationId],
      references: [organization.id],
    }),
    creator: one(users, {
      fields: [addressBookEntry.createdBy],
      references: [users.id],
    }),
  })
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organization, {
    fields: [projects.organizationId],
    references: [organization.id],
  }),
  creator: one(users, {
    fields: [projects.userId],
    references: [users.id],
  }),
  workflows: many(workflows),
}));

export const workflowsRelations = relations(workflows, ({ one }) => ({
  project: one(projects, {
    fields: [workflows.projectId],
    references: [projects.id],
  }),
}));

export const tagsRelations = relations(tags, ({ one }) => ({
  organization: one(organization, {
    fields: [tags.organizationId],
    references: [organization.id],
  }),
  creator: one(users, {
    fields: [tags.userId],
    references: [users.id],
  }),
}));
export const chainsRelations = relations(chains, ({ one, many }) => ({
  explorerConfig: one(explorerConfigs, {
    fields: [chains.chainId],
    references: [explorerConfigs.chainId],
  }),
  userRpcPreferences: many(userRpcPreferences),
}));

export const explorerConfigsRelations = relations(
  explorerConfigs,
  ({ one }) => ({
    chain: one(chains, {
      fields: [explorerConfigs.chainId],
      references: [chains.chainId],
    }),
  })
);

export const userRpcPreferencesRelations = relations(
  userRpcPreferences,
  ({ one }) => ({
    user: one(users, {
      fields: [userRpcPreferences.userId],
      references: [users.id],
    }),
  })
);

// v1.7: ERC-8004 agent registration storage (REG-04)
export const agentRegistrations = pgTable("agent_registrations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  agentId: text("agent_id").notNull(),
  txHash: text("tx_hash").notNull(),
  registeredAt: timestamp("registered_at").notNull().defaultNow(),
  chainId: integer("chain_id").notNull().default(1),
  registryAddress: text("registry_address").notNull(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
// INFRA-03: Field projection type for public-facing listed workflow queries.
// Excludes nodes, edges, and userId -- these must never reach external agents.
// Uses Omit (not Pick) so new columns added to workflows are included automatically.
// Public-facing projection for the listed-workflow catalog. Uses Pick (not Omit)
// so adding a new column to `workflows` does NOT auto-leak it to the public API.
// Must stay in sync with LISTED_WORKFLOW_COLUMNS in app/api/mcp/workflows/route.ts.
export type ListedWorkflowView = Pick<
  Workflow,
  | "id"
  | "name"
  | "description"
  | "listedSlug"
  | "listedAt"
  | "inputSchema"
  | "outputMapping"
  | "priceUsdcPerCall"
  | "organizationId"
  | "createdAt"
  | "updatedAt"
  | "isListed"
  | "workflowType"
  | "category"
  | "chain"
  | "listingVersion"
>;
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;
export type NewWorkflowExecutionLog = typeof workflowExecutionLogs.$inferInsert;
// ParaWallet types are exported from ./schema-extensions
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type BetaAccessRequest = typeof betaAccessRequests.$inferSelect;
export type NewBetaAccessRequest = typeof betaAccessRequests.$inferInsert;
export type WorkflowSchedule = typeof workflowSchedules.$inferSelect;
export type NewWorkflowSchedule = typeof workflowSchedules.$inferInsert;
export type Organization = typeof organization.$inferSelect;
export type NewOrganization = typeof organization.$inferInsert;
export type Member = typeof member.$inferSelect;
export type NewMember = typeof member.$inferInsert;
export type Invitation = typeof invitation.$inferSelect;
export type NewInvitation = typeof invitation.$inferInsert;
export type AddressBookEntry = typeof addressBookEntry.$inferSelect;
export type NewAddressBookEntry = typeof addressBookEntry.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type Chain = typeof chains.$inferSelect;
export type NewChain = typeof chains.$inferInsert;
export type ExplorerConfig = typeof explorerConfigs.$inferSelect;
export type NewExplorerConfig = typeof explorerConfigs.$inferInsert;
export type UserRpcPreference = typeof userRpcPreferences.$inferSelect;
export type NewUserRpcPreference = typeof userRpcPreferences.$inferInsert;
export type AgentRegistration = typeof agentRegistrations.$inferSelect;
