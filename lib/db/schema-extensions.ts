/**
 * KeeperHub Database Schema Extensions
 *
 * This file contains database tables specific to KeeperHub functionality.
 * These are extensions to the base workflow-builder schema.
 *
 * Tables defined here:
 * - organizationWallets: Stores wallet information for Web3 operations (aliased as paraWallets)
 * - organizationApiKeys: Stores organization-scoped API keys for MCP server authentication
 * - organizationTokens: Tracks ERC20 tokens per organization/chain for balance display
 * - supportedTokens: System-wide default tokens (stablecoins) available on each chain
 * - directExecutions: Audit log for direct API execution requests (transfer, contract-call, check-and-execute)
 * - organizationSpendCaps: Per-organization daily spending limits for direct execution API
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
// Note: Using relative paths instead of @/ aliases for drizzle-kit compatibility
import { organization, users, workflows } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Organization Wallets table
 *
 * Stores wallet information for Web3 integration. Supports multiple providers
 * (Para MPC, Turnkey secure enclaves). Each organization can have one wallet
 * (enforced by unique constraint on organizationId).
 *
 * Provider-specific columns are nullable since each row only uses one provider's fields.
 * The `provider` column determines which fields are relevant.
 *
 * NOTE: userId tracks who created the wallet, but the wallet belongs to the organization.
 * Only organization admins and owners can create/manage wallets.
 */
export const organizationWallets = pgTable(
  "para_wallets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull().$type<"para" | "turnkey">(),
    email: text("email").notNull(),
    walletAddress: text("wallet_address").notNull(),
    // Para-specific fields
    paraWalletId: text("para_wallet_id"),
    userShare: text("user_share"), // Encrypted MPC keyshare (Para only, pre-claim)
    paraSession: text("para_session"), // Encrypted Para session (post-claim signing)
    // Turnkey-specific fields
    turnkeySubOrgId: text("turnkey_sub_org_id"),
    turnkeyWalletId: text("turnkey_wallet_id"),
    turnkeyPrivateKeyId: text("turnkey_private_key_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("para_wallets_organization_id_unique").on(table.organizationId),
  ]
);

// Backward compatibility alias
export const paraWallets = organizationWallets;

// Type exports
export type OrganizationWallet = typeof organizationWallets.$inferSelect;
export type NewOrganizationWallet = typeof organizationWallets.$inferInsert;
export type ParaWallet = OrganizationWallet;
export type NewParaWallet = NewOrganizationWallet;

/**
 * Key Export Verification Codes table
 *
 * Single-use OTP codes for private key export.
 * Admin must verify via email before viewing a private key.
 * Codes expire after 5 minutes and are deleted after use.
 */
export const keyExportCodes = pgTable("key_export_codes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Organization API Keys table
 *
 * Stores API keys for organization-level authentication.
 * Used by the MCP server to authenticate and access workflows/executions.
 *
 * Security:
 * - Keys are hashed with SHA-256, never stored in plaintext
 * - Only the first 8 chars (prefix) are stored for identification
 * - Keys are scoped to a single organization
 * - Optional expiration and revocation support
 *
 * NOTE: This is separate from the user-scoped apiKeys table in the main schema.
 * Organization keys have broader permissions and are meant for API/MCP access.
 */
export const organizationApiKeys = pgTable("organization_api_keys", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // User-provided label for the key
  keyHash: text("key_hash").notNull().unique(), // SHA-256 hash of the key
  keyPrefix: text("key_prefix").notNull(), // First 8 chars for identification (e.g., "kh_abc12")
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }), // User who created the key
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"), // Track usage for audit
  expiresAt: timestamp("expires_at"), // Optional expiration
  revokedAt: timestamp("revoked_at"), // Soft delete via revocation
});

// Type exports for the Organization API Keys table
export type OrganizationApiKey = typeof organizationApiKeys.$inferSelect;
export type NewOrganizationApiKey = typeof organizationApiKeys.$inferInsert;

/**
 * Organization Tokens table
 *
 * Tracks ERC20 tokens that an organization wants to monitor for their wallet.
 * Each row represents a token on a specific chain that the org is tracking.
 */
export const organizationTokens = pgTable(
  "organization_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(), // ERC20 contract address
    symbol: text("symbol").notNull(), // Cached token symbol
    name: text("name").notNull(), // Cached token name
    decimals: integer("decimals").notNull(), // Cached decimals
    logoUrl: text("logo_url"), // Optional token logo
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_org_tokens_org_chain").on(table.organizationId, table.chainId),
  ]
);

// Type exports for Organization Tokens table
export type OrganizationToken = typeof organizationTokens.$inferSelect;
export type NewOrganizationToken = typeof organizationTokens.$inferInsert;

/**
 * Supported Tokens table
 *
 * System-wide default tokens available on each chain. These are pre-configured
 * tokens (primarily stablecoins) that users can select from in workflow nodes
 * like "Check Token Balance" and "Transfer Token".
 *
 * This is different from organizationTokens which are user-added custom tokens.
 * supportedTokens are read-only system defaults managed via seed scripts.
 */
export const supportedTokens = pgTable(
  "supported_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    chainId: integer("chain_id").notNull(),
    tokenAddress: text("token_address").notNull(), // ERC20 contract address (lowercase)
    symbol: text("symbol").notNull(), // e.g., "USDC", "USDT", "DAI"
    name: text("name").notNull(), // e.g., "USD Coin", "Tether USD"
    decimals: integer("decimals").notNull(),
    logoUrl: text("logo_url"), // Optional token logo URL
    isStablecoin: boolean("is_stablecoin").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0), // Display priority
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Ensure unique token per chain
    unique("supported_tokens_chain_address").on(
      table.chainId,
      table.tokenAddress
    ),
    // Index for querying tokens by chain
    index("idx_supported_tokens_chain").on(table.chainId),
  ]
);

// Type exports for Supported Tokens table
export type SupportedToken = typeof supportedTokens.$inferSelect;
export type NewSupportedToken = typeof supportedTokens.$inferInsert;

/**
 * Wallet Locks table
 *
 * Tracks which execution currently holds the lock for a wallet+chain combination.
 * PostgreSQL advisory locks don't persist lock holder info, so we track it here.
 *
 * Used by NonceManager to:
 * - Prevent concurrent workflows from conflicting on nonce assignment
 * - Detect and recover from stale locks (crash recovery)
 *
 * NOTE: The actual locking is done via pg_advisory_lock(), this table only tracks metadata.
 */
export const walletLocks = pgTable(
  "wallet_locks",
  {
    walletAddress: text("wallet_address").notNull(),
    chainId: integer("chain_id").notNull(),
    lockedBy: text("locked_by"), // execution ID that holds the lock (null = unlocked)
    lockedAt: timestamp("locked_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.walletAddress, table.chainId] })]
);

// Type exports for Wallet Locks table
export type WalletLock = typeof walletLocks.$inferSelect;
export type NewWalletLock = typeof walletLocks.$inferInsert;

/**
 * Pending Transactions table
 *
 * Tracks pending blockchain transactions for validation and recovery.
 * Used by NonceManager to:
 * - Reconcile pending txs with chain state at workflow start
 * - Detect stuck transactions that may need gas bumping
 * - Provide observability into transaction state
 *
 * Status lifecycle: pending -> confirmed | dropped | replaced
 */
export const pendingTransactions = pgTable(
  "pending_transactions",
  {
    walletAddress: text("wallet_address").notNull(),
    chainId: integer("chain_id").notNull(),
    nonce: integer("nonce").notNull(),
    txHash: text("tx_hash").notNull(),
    executionId: text("execution_id").notNull(),
    workflowId: text("workflow_id"),
    gasPrice: text("gas_price"), // for stuck tx analysis
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    status: text("status").default("pending"), // pending, confirmed, dropped, replaced
  },
  (table) => [
    primaryKey({ columns: [table.walletAddress, table.chainId, table.nonce] }),
    index("idx_pending_tx_status").on(
      table.walletAddress,
      table.chainId,
      table.status
    ),
    index("idx_pending_tx_execution").on(table.executionId),
  ]
);

// Type exports for Pending Transactions table
export type PendingTransaction = typeof pendingTransactions.$inferSelect;
export type NewPendingTransaction = typeof pendingTransactions.$inferInsert;

/**
 * Public Tags table
 *
 * Global pool of tags used for Hub discoverability. These are distinct from
 * organization-scoped tags -- public tags are shared across all orgs and
 * used for filtering on the Hub page.
 */
export const publicTags = pgTable("public_tags", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Type exports for Public Tags table
export type PublicTag = typeof publicTags.$inferSelect;
export type NewPublicTag = typeof publicTags.$inferInsert;

/**
 * Workflow Public Tags junction table (many-to-many)
 *
 * Links workflows to public tags for Hub discoverability.
 * Cascade deletes on both sides ensure cleanup when either entity is removed.
 */
export const workflowPublicTags = pgTable(
  "workflow_public_tags",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    publicTagId: text("public_tag_id")
      .notNull()
      .references(() => publicTags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.workflowId, table.publicTagId] }),
    index("idx_workflow_public_tags_workflow").on(table.workflowId),
    index("idx_workflow_public_tags_tag").on(table.publicTagId),
  ]
);

// Type exports for Workflow Public Tags table
export type WorkflowPublicTag = typeof workflowPublicTags.$inferSelect;
export type NewWorkflowPublicTag = typeof workflowPublicTags.$inferInsert;

/**
 * Direct Executions table
 *
 * Audit log for direct API execution requests. Supports both specialized web3 endpoints
 * (transfer, contract-call, check-and-execute) and generic node execution (any action type).
 * Used by spending-cap enforcement (SUM of gasUsedWei per org per day).
 *
 * NOTE: apiKeyId has no FK -- the key may be revoked/deleted later but the audit record must persist.
 * Wei amounts stored as text to avoid PostgreSQL bigint overflow.
 */
export const directExecutions = pgTable(
  "direct_executions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    apiKeyId: text("api_key_id").notNull(),
    type: text("type").notNull(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - redacted copy of request input, structure varies by execution type
    input: jsonb("input").$type<any>(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - execution result structure varies by execution type
    output: jsonb("output").$type<any>(),
    status: text("status").notNull().default("pending"), // pending | running | completed | failed
    transactionHash: text("transaction_hash"),
    network: text("network"),
    error: text("error"),
    gasUsedWei: text("gas_used_wei"),
    gasPriceWei: text("gas_price_wei"),
    // Populated by a future price-oracle integration; null until then
    estimatedCostUsd: text("estimated_cost_usd"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_direct_executions_org").on(table.organizationId),
    index("idx_direct_executions_status").on(table.status),
  ]
);

// Type exports for Direct Executions table
export type DirectExecution = typeof directExecutions.$inferSelect;
export type NewDirectExecution = typeof directExecutions.$inferInsert;

/**
 * Organization Spend Caps table
 *
 * Per-organization daily spending limits for the direct execution API.
 * One row per organization (enforced by unique constraint on organizationId).
 * dailyCapWei is stored as text for BigInt compatibility.
 *
 * When no row exists for an org, spending is unlimited (no cap enforced).
 */
export const organizationSpendCaps = pgTable("organization_spend_caps", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id),
  dailyCapWei: text("daily_cap_wei").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Type exports for Organization Spend Caps table
export type OrganizationSpendCap = typeof organizationSpendCaps.$inferSelect;
export type NewOrganizationSpendCap = typeof organizationSpendCaps.$inferInsert;

/**
 * Overage Billing Records table
 *
 * Tracks overage charges applied at the end of each billing period.
 * When a paid plan (Pro/Business) exceeds its included execution limit,
 * the excess is billed via Stripe invoice items.
 *
 * Unique constraint on (organizationId, periodStart, periodEnd) ensures
 * idempotent billing -- each period is billed at most once per org.
 *
 * Status lifecycle: pending -> billed | failed
 */
export const overageBillingRecords = pgTable(
  "overage_billing_records",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    executionLimit: integer("execution_limit").notNull(),
    totalExecutions: integer("total_executions").notNull(),
    overageCount: integer("overage_count").notNull(),
    overageRateCents: integer("overage_rate_cents").notNull(),
    totalChargeCents: integer("total_charge_cents").notNull(),
    providerInvoiceItemId: text("provider_invoice_item_id"),
    providerInvoiceId: text("provider_invoice_id"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("overage_billing_org_period").on(
      table.organizationId,
      table.periodStart,
      table.periodEnd
    ),
    index("idx_overage_billing_org").on(table.organizationId),
    index("idx_overage_billing_status").on(table.status),
  ]
);

export type OverageBillingRecord = typeof overageBillingRecords.$inferSelect;
export type NewOverageBillingRecord = typeof overageBillingRecords.$inferInsert;

/**
 * Execution Debt table
 *
 * Tracks unpaid overage executions that reduce the next month's allowance.
 * When a paid org exceeds its monthly limit and doesn't pay the overage invoice
 * within 15 days, the overage count is recorded as debt. The debt reduces the
 * org's effective execution limit until the invoice is paid.
 *
 * Status lifecycle: active -> cleared
 * Minimum floor: even with debt, an org always gets at least 100 executions.
 */
export const executionDebt = pgTable(
  "execution_debt",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    overageRecordId: text("overage_record_id")
      .notNull()
      .unique()
      .references(() => overageBillingRecords.id, { onDelete: "cascade" }),
    providerInvoiceId: text("provider_invoice_id"),
    debtExecutions: integer("debt_executions").notNull(),
    status: text("status").notNull().default("active"),
    enforcedAt: timestamp("enforced_at").notNull(),
    clearedAt: timestamp("cleared_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_execution_debt_org_status").on(
      table.organizationId,
      table.status
    ),
    index("idx_execution_debt_invoice").on(table.providerInvoiceId),
  ]
);

export type ExecutionDebt = typeof executionDebt.$inferSelect;
export type NewExecutionDebt = typeof executionDebt.$inferInsert;

/**
 * Organization Subscriptions table
 *
 * Stores billing subscription state for each organization.
 * One subscription per organization (enforced by unique constraint on organizationId).
 * Free tier orgs have a row with plan="free" and no provider IDs until they upgrade.
 *
 * Status lifecycle: active -> past_due -> canceled/unpaid
 * The cancelAtPeriodEnd flag indicates the user has scheduled cancellation.
 */
export const organizationSubscriptions = pgTable(
  "organization_subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    providerCustomerId: text("provider_customer_id").unique(),
    providerSubscriptionId: text("provider_subscription_id"),
    providerPriceId: text("provider_price_id"),
    plan: text("plan").notNull().default("free"), // free | pro | business | enterprise
    tier: text("tier"), // e.g. "25k", "50k", "100k", "250k", "500k", "1m"
    status: text("status").notNull().default("active"), // active | past_due | canceled | unpaid | trialing | paused
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    billingAlert: text("billing_alert"), // "payment_action_required" | "payment_failed" | "overdue" | null
    billingAlertUrl: text("billing_alert_url"), // hosted invoice URL for action-required
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_org_subscriptions_org").on(table.organizationId),
    index("idx_org_subscriptions_provider_sub").on(
      table.providerSubscriptionId
    ),
  ]
);

// Type exports for Organization Subscriptions table
export type OrganizationSubscription =
  typeof organizationSubscriptions.$inferSelect;
export type NewOrganizationSubscription =
  typeof organizationSubscriptions.$inferInsert;

/**
 * Billing Events table
 *
 * Idempotency log for billing provider webhook events.
 * Each event is stored with its provider event ID (unique) to prevent double-processing.
 * The processed flag tracks whether the event handler completed successfully.
 */
export const billingEvents = pgTable("billing_events", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  providerEventId: text("provider_event_id").notNull().unique(),
  type: text("type").notNull(),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - webhook event data structure varies by event type
  data: jsonb("data").$type<any>(),
  processed: boolean("processed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Type exports for Billing Events table
export type BillingEvent = typeof billingEvents.$inferSelect;
export type NewBillingEvent = typeof billingEvents.$inferInsert;
