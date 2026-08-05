/**
 * KeeperHub Database Schema Extensions
 *
 * This file contains database tables specific to KeeperHub functionality.
 * These are extensions to the base workflow-builder schema.
 *
 * Tables defined here:
 * - organizationWallets: Stores wallet information for Web3 operations
 * - organizationApiKeys: Stores organization-scoped API keys for MCP server authentication
 * - organizationTokens: Tracks ERC20 tokens per organization/chain for balance display
 * - supportedTokens: System-wide default tokens (stablecoins) available on each chain
 * - directExecutions: Audit log for direct API execution requests (transfer, contract-call, check-and-execute)
 * - organizationSpendCaps: Per-organization daily spending limits for direct execution API
 * - gasSponsorshipDelegations: EIP-7702 delegation status per org per chain
 * - gasCreditUsage: Gas cost records for sponsored transactions (credit metering)
 */

import { sql } from "drizzle-orm";
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
  uniqueIndex,
} from "drizzle-orm/pg-core";
// Note: Using relative paths instead of @/ aliases for drizzle-kit compatibility
import type { PlanLimits } from "@/lib/billing/plans";
import { organization, users, workflows } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Organization Wallets table
 *
 * Stores Turnkey wallet information for Web3 integration.
 * Each organization can have one active wallet (enforced by unique partial index on organizationId).
 *
 * NOTE: userId tracks who created the wallet, but the wallet belongs to the organization.
 * Only organization admins and owners can create/manage wallets.
 *
 * This row is where the signing key actually lives. Workflow node configs do
 * not reference it directly - they carry an `integrationId` pointing at the
 * org's single `web3` row in `integrations` (lib/db/schema.ts), which holds no
 * key and exists mainly so the builder has something to show. Resolving a
 * signer means going integration -> org -> this table.
 *
 * One row covers both chain families: `walletAddress` is the EVM address and
 * `solanaAddress` the Solana one, derived from the same Turnkey sub-org. That
 * is why a single integrationId is valid for EVM and Solana actions alike; the
 * chain comes from the node's own `network` config, not from the integration.
 */
export const organizationWallets = pgTable(
  "organization_wallets",
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
    email: text("email").notNull(),
    walletAddress: text("wallet_address").notNull(),
    turnkeySubOrgId: text("turnkey_sub_org_id"),
    turnkeyWalletId: text("turnkey_wallet_id"),
    turnkeyPrivateKeyId: text("turnkey_private_key_id"),
    solanaAddress: text("solana_address"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_wallets_org_active_unique")
      .on(table.organizationId)
      .where(sql`${table.isActive} = true`),
  ]
);

// Type exports
export type OrganizationWallet = typeof organizationWallets.$inferSelect;
export type NewOrganizationWallet = typeof organizationWallets.$inferInsert;

/**
 * Safe Wallets table
 *
 * One row per (organization, chain). A Safe is a smart-contract wallet
 * deployed on a specific chain and owned by the organization's active EOA
 * (Turnkey row in organizationWallets). The Safe itself holds funds;
 * the EOA signs transactions on its behalf.
 *
 * Addresses are deterministic: same (org, chain) always resolves to the
 * same Safe address via CREATE2 (salt = keccak256(orgId, chainId)).
 *
 * Status lifecycle: pending -> deployed | failed
 */
export const safeWallets = pgTable(
  "safe_wallets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    safeAddress: text("safe_address").notNull(),
    ownerWalletId: text("owner_wallet_id").references(
      () => organizationWallets.id,
      { onDelete: "set null" }
    ),
    owners: jsonb("owners").notNull().$type<string[]>(),
    threshold: integer("threshold").notNull(),
    saltNonce: text("salt_nonce").notNull(),
    safeVersion: text("safe_version").notNull().default("1.4.1"),
    singletonAddress: text("singleton_address").notNull(),
    factoryAddress: text("factory_address").notNull(),
    deploymentTxHash: text("deployment_tx_hash"),
    deploymentBlock: integer("deployment_block"),
    status: text("status").notNull().default("pending"),
    deployedAt: timestamp("deployed_at"),
    isSigningActive: boolean("is_signing_active").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("safe_wallets_org_chain_unique").on(
      table.organizationId,
      table.chainId
    ),
    index("idx_safe_wallets_org").on(table.organizationId),
  ]
);

export type SafeWallet = typeof safeWallets.$inferSelect;
export type NewSafeWallet = typeof safeWallets.$inferInsert;

/**
 * Safe Roles table
 *
 * One row per (Safe, role_type). A Safe can have a Zodiac Roles Modifier
 * installed that enforces per-target / per-function / per-parameter policies
 * on everything the delegate (Turnkey EOA) executes. For MVP we create one
 * role per Safe with role_type = "automation"; multi-role support is
 * additive.
 *
 * This row is a cache of on-chain state. Authoritative source of truth is
 * the Roles modifier at `roles_modifier_address`. Every mutation in the UI
 * submits an on-chain tx, waits for confirmation, then refreshes this row
 * from chain.
 */
export const safeRoles = pgTable(
  "safe_roles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    safeWalletId: text("safe_wallet_id")
      .notNull()
      .references(() => safeWallets.id, { onDelete: "cascade" }),
    roleType: text("role_type").notNull().default("automation"),
    /** bytes32 role key, hex-encoded */
    roleKey: text("role_key").notNull(),
    /** Per-Safe Zodiac Roles proxy (deployed via ModuleProxyFactory) */
    rolesModifierAddress: text("roles_modifier_address").notNull(),
    /** Delegate authorised to use the role (today = Safe owner/Turnkey EOA) */
    delegateAddress: text("delegate_address").notNull(),
    installedTxHash: text("installed_tx_hash"),
    lastReconciledAt: timestamp("last_reconciled_at"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("safe_roles_safe_type_unique").on(
      table.safeWalletId,
      table.roleType
    ),
    index("idx_safe_roles_safe").on(table.safeWalletId),
  ]
);

export type SafeRole = typeof safeRoles.$inferSelect;
export type NewSafeRole = typeof safeRoles.$inferInsert;

/**
 * Safe Role Protocols table
 *
 * Cache of which protocol presets are currently applied to the Role's
 * scoped targets. Each row represents a protocol the admin has enabled
 * (Aave V3, CoW Protocol, etc.). The actual permission trees live on-chain;
 * this row tracks status + the selectors applied for audit purposes.
 */
export const safeRoleProtocols = pgTable(
  "safe_role_protocols",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    roleId: text("role_id")
      .notNull()
      .references(() => safeRoles.id, { onDelete: "cascade" }),
    /** Slug matches `ProtocolSlug` in `lib/safe/protocol-registry.ts` */
    protocolSlug: text("protocol_slug").notNull(),
    /** defi-kit template that compiled the permissions */
    templateSlug: text("template_slug").notNull(),
    /** Tokens the preset was compiled with (symbol array) */
    allowedTokenSymbols: jsonb("allowed_token_symbols")
      .notNull()
      .$type<string[]>(),
    /** Target contract addresses the role scopes (for display + audit) */
    targetAddresses: jsonb("target_addresses").notNull().$type<string[]>(),
    /** Function selectors allowed on those targets */
    allowedSelectors: jsonb("allowed_selectors").notNull().$type<string[]>(),
    status: text("status").notNull().default("allowed"),
    lastAppliedTxHash: text("last_applied_tx_hash"),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("safe_role_protocols_role_slug_unique").on(
      table.roleId,
      table.protocolSlug
    ),
    index("idx_safe_role_protocols_role").on(table.roleId),
  ]
);

export type SafeRoleProtocol = typeof safeRoleProtocols.$inferSelect;
export type NewSafeRoleProtocol = typeof safeRoleProtocols.$inferInsert;

/**
 * Safe Role Allowances table
 *
 * Cache of the per-token on-chain allowance buckets on the Roles modifier.
 * Each row is one (role, token) allowance. `allowance_key` is the on-chain
 * bytes32 identifier computed deterministically from (roleKey, token).
 *
 * The `last_chain_*` columns hold the last read from the modifier so the UI
 * can render "used / cap + resets in N" without re-hitting chain every
 * render. A refresh happens on card mount, on window focus, and after every
 * mutation.
 */
export const safeRoleAllowances = pgTable(
  "safe_role_allowances",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    roleId: text("role_id")
      .notNull()
      .references(() => safeRoles.id, { onDelete: "cascade" }),
    /**
     * Protocol slug this allowance bucket belongs to. Combined with
     * `tokenAddress` it uniquely identifies a bucket inside a role:
     * Aave V3's USDC bucket is independent of CoW's USDC bucket.
     */
    protocolSlug: text("protocol_slug").notNull(),
    /** bytes32 on-chain allowance key (= keccak256(roleKey, protocolSlug, token)) */
    allowanceKey: text("allowance_key").notNull(),
    tokenAddress: text("token_address").notNull(),
    tokenSymbol: text("token_symbol").notNull(),
    tokenDecimals: integer("token_decimals").notNull(),
    /** Cap per period (uint128 as stringified wei) */
    maxRefillWei: text("max_refill_wei").notNull(),
    /** Refill per period */
    refillWei: text("refill_wei").notNull(),
    /** Period in seconds */
    periodSeconds: integer("period_seconds").notNull(),
    /** Cached chain state — authoritative is on-chain */
    lastChainBalanceWei: text("last_chain_balance_wei"),
    lastChainTimestamp: timestamp("last_chain_timestamp"),
    lastReconciledAt: timestamp("last_reconciled_at"),
    lastAppliedTxHash: text("last_applied_tx_hash"),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("safe_role_allowances_role_key_unique").on(
      table.roleId,
      table.allowanceKey
    ),
    index("idx_safe_role_allowances_role").on(table.roleId),
  ]
);

export type SafeRoleAllowance = typeof safeRoleAllowances.$inferSelect;
export type NewSafeRoleAllowance = typeof safeRoleAllowances.$inferInsert;

/**
 * Safe Role Direct Rules table
 *
 * Records each direct rule (ERC-20 transfer / approve / native ETH send)
 * configured on a role's "direct" synthetic protocol. Direct rules share
 * allowance buckets in `safe_role_allowances` keyed by token, but the
 * counterparty + kind that scope the rule on chain only live here. Used
 * by the wizard's edit flow to pre-fill existing rules and by the role
 * card to render per-rule details (recipient/spender, kind).
 */
export const safeRoleDirectRules = pgTable(
  "safe_role_direct_rules",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    roleId: text("role_id")
      .notNull()
      .references(() => safeRoles.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /**
     * Token contract for ERC-20 rules. Native-transfer rules use
     * NATIVE_TOKEN_SENTINEL (0x0000000000000000000000000000000000000000) so
     * the unique index below can dedupe them under Postgres' default
     * NULLs-are-distinct semantics. Mirrors `safe_role_allowances.tokenAddress`.
     */
    tokenAddress: text("token_address").notNull(),
    tokenSymbol: text("token_symbol").notNull(),
    tokenDecimals: integer("token_decimals").notNull(),
    /** Recipient (transfer/native) or spender (approve), checksummed */
    counterparty: text("counterparty").notNull(),
    amountHuman: text("amount_human").notNull(),
    periodSeconds: integer("period_seconds").notNull(),
    status: text("status").notNull().default("allowed"),
    lastAppliedTxHash: text("last_applied_tx_hash"),
    lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("safe_role_direct_rules_role_kind_token_cp_unique").on(
      table.roleId,
      table.kind,
      table.tokenAddress,
      table.counterparty
    ),
    index("idx_safe_role_direct_rules_role").on(table.roleId),
  ]
);

export type SafeRoleDirectRule = typeof safeRoleDirectRules.$inferSelect;
export type NewSafeRoleDirectRule = typeof safeRoleDirectRules.$inferInsert;

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
export const organizationApiKeys = pgTable(
  "organization_api_keys",
  {
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
    scope: text("scope"), // Space-separated OAuth scopes; null means full access
  },
  (table) => [
    index("idx_org_api_keys_org_id").on(table.organizationId),
    index("idx_org_api_keys_created_by").on(table.createdBy),
  ]
);

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
    /**
     * When set, the tracking is scoped to that Safe. The same token may
     * be tracked independently at the org-level (safeWalletId = null) for
     * the Turnkey EOA, and per-Safe for as many Safes as the org has. The
     * unique index below treats NULL as a distinct group via COALESCE.
     */
    safeWalletId: text("safe_wallet_id").references(() => safeWallets.id, {
      onDelete: "cascade",
    }),
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
    index("idx_org_tokens_safe").on(table.safeWalletId),
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
 * Distributed lock for serializing nonce assignment across concurrent workflow
 * executions on the same (wallet_address, chain_id). The row IS the lock:
 * a row with locked_by != NULL AND expires_at > NOW() means the lock is held.
 *
 * Acquire is an atomic conditional UPSERT (insert-on-conflict, then update-where-
 * expired). Release clears locked_by/locked_at and sets expires_at to NOW().
 * The expires_at TTL guarantees that a crashed holder cannot wedge the lock
 * forever: any caller can take over once expires_at < NOW().
 */
export const walletLocks = pgTable(
  "wallet_locks",
  {
    walletAddress: text("wallet_address").notNull(),
    chainId: integer("chain_id").notNull(),
    lockedBy: text("locked_by"), // execution ID that holds the lock (null = unlocked)
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

/**
 * KEEP-966: per-transaction on-chain verification result, persisted on
 * directExecutions.receipts. Field names/vocabulary intentionally match
 * lib/db/schema.ts's TransactionHashEntry (the workflow-execution
 * equivalent) so lib/web3/verify-receipt.ts's results map to either shape.
 * No nodeId/nodeName here -- direct-execute has no node concept.
 */
export type DirectExecutionReceiptEntry = {
  hash: string;
  chainId?: number;
  network?: string;
  verified: boolean;
  receiptStatus:
    | "success"
    | "reverted"
    | "not_found"
    | "timeout"
    | "safe_inner_failure";
  blockNumber?: number;
  gasUsed?: string;
  verifiedAt: string;
};

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
    // KEEP-966: on-chain verification results for every transaction hash this
    // execution claims. Populated by completeExecution() regardless of
    // outcome, so a failed reconciliation stays auditable (which hash, why).
    receipts: jsonb("receipts")
      .$type<DirectExecutionReceiptEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    network: text("network"),
    error: text("error"),
    gasUsedWei: text("gas_used_wei"),
    gasPriceWei: text("gas_price_wei"),
    // Native notional value (wei) this execution moves, reserved at request time
    // and summed per org per day by spending-cap enforcement. Null for executions
    // that move no native value (treated as 0). ERC-20 token value is not yet
    // priced into this figure.
    valueWei: text("value_wei"),
    // Native notional value (lamports) a Solana execution moves. Deliberately a
    // separate column from valueWei rather than a shared one: the daily cap sums
    // these per org, and wei and lamports are different units, so a shared
    // column would silently add 1e18-scaled and 1e9-scaled figures together.
    // Exactly one of valueWei / valueLamports is set per row.
    valueLamports: text("value_lamports"),
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
 * Idempotency records for mutating API endpoints.
 *
 * Stripe-style Idempotency-Key support. The first request for a given
 * (organization, scope, key) reserves a row (status "processing"); once the
 * work finishes its response is stored (status "completed") and replayed for
 * any retry within the TTL, so a network retry never double-executes. A retry
 * carrying the same key but a different request body is a conflict. `scope`
 * namespaces the operation (e.g. "webhook:<workflowId>", "execute",
 * "workflow:create") so a key is independent across unrelated operations but
 * unique within one. Expired rows are swept by `expires_at`.
 */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("processing"), // processing | completed | failed
    // Fencing token bumped on every reserve/reclaim so a stale holder whose lock
    // was taken over cannot finalize/release/heartbeat the new holder's row.
    lockVersion: integer("lock_version").notNull().default(0),
    responseStatus: integer("response_status"),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB - stored response body, shape varies by endpoint
    responseBody: jsonb("response_body").$type<any>(),
    resourceId: text("resource_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_idempotency_org_scope_key").on(
      table.organizationId,
      table.scope,
      table.idempotencyKey
    ),
    index("idx_idempotency_expires_at").on(table.expiresAt),
  ]
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;

/**
 * Organization Spend Caps table
 *
 * Per-organization daily spending limits for the direct execution API.
 * One row per organization (enforced by unique constraint on organizationId).
 * Wei amounts are stored as text for BigInt compatibility.
 *
 * `dailyValueCapWei` caps the native notional value moved per org per day and is
 * the enforced limit, set by org admins/owners. `dailyCapWei` is a legacy
 * gas-denominated figure, no longer enforced or displayed; nullable so a
 * value-only cap row can be created without it.
 *
 * `dailySolanaValueCapLamports` is the Solana equivalent, denominated in
 * lamports. Solana native value is NOT charged against `dailyValueCapWei`:
 * that column is wei-denominated and an admin sets it thinking in ETH, so
 * mixing SOL into it would compare two non-commensurable assets against one
 * number. Keeping a separate per-chain-family cap is what lets SOL be
 * accounted at its true 9-decimal precision instead of being scaled to 18
 * decimals to share the ETH cap.
 *
 * When no row exists for an org, or the relevant cap column is null, spending
 * of that kind is unlimited (no cap enforced). The two caps are independent:
 * a null Solana cap does not fall back to the wei cap.
 */
export const organizationSpendCaps = pgTable("organization_spend_caps", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id),
  dailyCapWei: text("daily_cap_wei"),
  dailyValueCapWei: text("daily_value_cap_wei"),
  dailySolanaValueCapLamports: text("daily_solana_value_cap_lamports"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Type exports for Organization Spend Caps table
export type OrganizationSpendCap = typeof organizationSpendCaps.$inferSelect;
export type NewOrganizationSpendCap = typeof organizationSpendCaps.$inferInsert;

/**
 * Organization Value Reservations ledger
 *
 * Unified per-org record of native value moved by execution so the daily value
 * cap covers every path -- direct API, workflow steps, and protocol writes --
 * rather than only the direct-execution routes. Every value-moving core reserves
 * a row before broadcast and settles or releases it afterward.
 *
 * status: `reserved` (in-flight) -> `settled` (broadcast succeeded) | `released`
 * (denied or failed; excluded from the cap SUM). Wei stored as text for BigInt.
 */
export const orgValueReservations = pgTable(
  "org_value_reservations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    valueWei: text("value_wei").notNull(),
    // Native notional value (lamports) for Solana reservations. Separate from
    // valueWei because the two are different units and each daily cap sums only
    // its own column. A Solana row carries valueWei "0" (the column is NOT NULL
    // and predates this) plus the real figure here, so the wei SUM is unaffected
    // by Solana activity and vice versa.
    valueLamports: text("value_lamports"),
    status: text("status").notNull().default("reserved"), // reserved | settled | released
    // Origin of the value-moving execution, for audit only.
    source: text("source"), // direct | workflow | protocol
    // Correlation id (executionId when available), for audit only.
    ref: text("ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_org_value_reservations_org_created").on(
      table.organizationId,
      table.createdAt
    ),
  ]
);

export type OrgValueReservation = typeof orgValueReservations.$inferSelect;
export type NewOrgValueReservation = typeof orgValueReservations.$inferInsert;

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
    // Set once when a Stripe trial actually begins. Its presence marks the org
    // as having consumed its one-time trial and blocks a second one.
    trialStartedAt: timestamp("trial_started_at"),
    // Per-org override of any PlanLimits field. Used for custom enterprise contracts
    // (e.g. higher gas credits, custom SLA, dedicated support) on top of the plan defaults.
    planOverrides: jsonb("plan_overrides").$type<Partial<PlanLimits>>(),
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

/**
 * Gas Sponsorship Delegations table
 *
 * Legacy table from the ERC-4337 sponsorship path that has been replaced by
 * Turnkey's native gas sponsorship (no EOA delegation required). No code
 * writes to it anymore; it is retained until a dedicated drop migration runs.
 *
 * Tracks EIP-7702 delegations per organization per chain: a one-time
 * operation that upgraded an EOA to also function as a smart account.
 * Unique constraint on (organizationId, chainId) ensures at most one
 * active delegation per org per chain.
 *
 * Status lifecycle: pending -> active
 */
export const gasSponsorshipDelegations = pgTable(
  "gas_sponsorship_delegations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),
    chainId: integer("chain_id").notNull(),
    delegationTxHash: text("delegation_tx_hash").notNull(),
    implementationAddress: text("implementation_address").notNull(),
    status: text("status").notNull().default("pending"),
    delegatedAt: timestamp("delegated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("gas_delegation_org_chain").on(table.organizationId, table.chainId),
    index("idx_gas_delegation_org").on(table.organizationId),
  ]
);

export type GasSponsorshipDelegation =
  typeof gasSponsorshipDelegations.$inferSelect;
export type NewGasSponsorshipDelegation =
  typeof gasSponsorshipDelegations.$inferInsert;

/**
 * Gas Credit Usage table
 *
 * Records gas costs for sponsored transactions, used to track credit
 * consumption against the org's monthly gas credit allowance.
 *
 * Wei amounts are stored as text to avoid PostgreSQL bigint overflow.
 * USD cents conversion happens at transaction time using the ETH price
 * at that moment.
 *
 * Unique constraint on (organizationId, txHash) prevents double-counting.
 * Index on (organizationId, createdAt) supports monthly aggregation queries.
 */
export const gasCreditUsage = pgTable(
  "gas_credit_usage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    executionId: text("execution_id"),
    gasUsed: text("gas_used").notNull(),
    gasPriceWei: text("gas_price_wei").notNull(),
    gasCostWei: text("gas_cost_wei").notNull(),
    gasCostMicroUsd: text("gas_cost_micro_usd").notNull(),
    ethPriceUsd: text("eth_price_usd").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("gas_usage_org_tx").on(table.organizationId, table.txHash),
    index("idx_gas_usage_org_created").on(
      table.organizationId,
      table.createdAt
    ),
  ]
);

export type GasCreditUsageRecord = typeof gasCreditUsage.$inferSelect;
export type NewGasCreditUsageRecord = typeof gasCreditUsage.$inferInsert;

/**
 * Gas Credit Allocations table
 *
 * Snapshots the gas credit cap for an org at the start of each billing period.
 * Once locked in, the allocation persists for the entire period even if the
 * env-driven cap changes mid-period.
 *
 * Unique constraint on (organizationId, periodStart) ensures one allocation
 * per org per billing period. The first credit check in a period creates the row.
 */
export const gasCreditAllocations = pgTable(
  "gas_credit_allocations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start").notNull(),
    allocatedCents: integer("allocated_cents").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("gas_credit_alloc_org_period").on(
      table.organizationId,
      table.periodStart
    ),
    index("idx_gas_credit_alloc_org").on(table.organizationId),
  ]
);

export type GasCreditAllocation = typeof gasCreditAllocations.$inferSelect;
export type NewGasCreditAllocation = typeof gasCreditAllocations.$inferInsert;

/**
 * Gas Sponsorship Monthly rollup table
 *
 * One row per (organization, calendar month, chain) summarising sponsored gas
 * from gas_credit_usage. A closed month is immutable, so the read path
 * aggregates each closed month once and persists it here (INSERT ... ON CONFLICT
 * DO NOTHING), then serves history from these tiny rows instead of re-scanning
 * the per-tx ledger on every load. The current month is always recomputed live.
 *
 * Amounts are BigInt strings, matching gas_credit_usage. `sponsored_wei` is in
 * the chain's native gas token; `sponsored_micro_usd` is the frozen-at-execution
 * USD (1/1,000,000 dollar) and is 0 for testnet chains.
 */
export const gasSponsorshipMonthly = pgTable(
  "gas_sponsorship_monthly",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    monthStart: timestamp("month_start").notNull(),
    sponsoredWei: text("sponsored_wei").notNull(),
    sponsoredMicroUsd: text("sponsored_micro_usd").notNull(),
    txCount: integer("tx_count").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("gas_sponsorship_monthly_org_month_chain").on(
      table.organizationId,
      table.monthStart,
      table.chainId
    ),
    index("idx_gas_sponsorship_monthly_org_month").on(
      table.organizationId,
      table.monthStart
    ),
  ]
);

export type GasSponsorshipMonthly = typeof gasSponsorshipMonthly.$inferSelect;
export type NewGasSponsorshipMonthly =
  typeof gasSponsorshipMonthly.$inferInsert;

/**
 * Workflow Votes table
 *
 * Stores user upvotes/downvotes on public hub workflows.
 * Each user can vote once per workflow (enforced by unique constraint).
 * Used for net score display and popularity sorting.
 */
export const workflowRatings = pgTable(
  "workflow_ratings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(), // 1 = upvote, -1 = downvote
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uq_workflow_ratings_workflow_user").on(
      table.workflowId,
      table.userId
    ),
    index("idx_workflow_ratings_workflow").on(table.workflowId),
  ]
);

/**
 * Security Audit Log table
 *
 * Durable forensic record of sensitive account/security actions: who did
 * what, when, from where, and -- for mutations -- a structured before/after
 * diff. The out-of-band email notifications are the real-time alert; this
 * table is the queryable history that answers "who changed this" after the
 * fact.
 *
 * `actorUserId` and `organizationId` use ON DELETE SET NULL so a purged user
 * or org never erases the audit trail of what they did. `diff` holds the
 * deep-diff between the prior and new state (null for pure create/delete
 * events that have no meaningful field-level diff); `metadata` carries
 * request context (ip, user agent) and any action-specific details.
 */
export const securityAuditLog = pgTable(
  "security_audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Denormalized actor identity (e.g. email or name) captured at write time.
    // The FK above nulls on user deletion (onDelete: set null), which would
    // erase attribution from the very deletion events we audit; this column is
    // the durable fallback that survives the actor row.
    actorLabel: text("actor_label"),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    // Durable org identity, same reasoning as actorLabel: an org-deletion
    // cascade nulls the FK above, so reads after the org is gone fall back here.
    organizationLabel: text("organization_label"),
    authMethod: text("auth_method").notNull(), // session | api-key | oauth | internal | unknown
    apiKeyId: text("api_key_id"),
    action: text("action").notNull(), // e.g. "api_key.created", "api_key.revoked"
    resourceType: text("resource_type"), // e.g. "api_key", "user", "workflow"
    resourceId: text("resource_id"),
    // Groups every row emitted by one logical operation (e.g. an account
    // deactivation that fans out to sessions, API keys, wallets). Null for
    // standalone single-row events; lets a cascade be read back as one unit.
    correlationId: text("correlation_id"),
    // Operation outcome. Success rows are written inside the action's own
    // transaction; a "failed" row is written out-of-band (global db, post
    // rollback) so a rolled-back cascade still leaves a durable trace.
    outcome: text("outcome").notNull().default("succeeded"), // succeeded | failed | partial
    // biome-ignore lint/suspicious/noExplicitAny: JSONB - deep-diff change records; shape varies by action
    diff: jsonb("diff").$type<any>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Audit reads are always "filter by one dimension, newest first", so each
    // index trails with createdAt -- Postgres satisfies ORDER BY createdAt DESC
    // via a backward scan, so the filter and the sort are both served by one
    // index with no separate sort step.
    // Org admin viewing their audit trail (primary access path).
    index("idx_security_audit_org_created").on(
      table.organizationId,
      table.createdAt
    ),
    // "Who did it" -- a single actor's timeline.
    index("idx_security_audit_actor_created").on(
      table.actorUserId,
      table.createdAt
    ),
    // "What happened to this resource" -- e.g. one API key's full history.
    index("idx_security_audit_resource_created").on(
      table.resourceType,
      table.resourceId,
      table.createdAt
    ),
    // Filter by event type -- e.g. all "api_key.revoked" events.
    index("idx_security_audit_action_created").on(
      table.action,
      table.createdAt
    ),
    // Read an entire cascade back as one unit, newest first.
    index("idx_security_audit_correlation_created").on(
      table.correlationId,
      table.createdAt
    ),
  ]
);

// Type exports for Security Audit Log table
export type SecurityAuditLog = typeof securityAuditLog.$inferSelect;
export type NewSecurityAuditLog = typeof securityAuditLog.$inferInsert;

/**
 * Workflow History table
 *
 * One row per saved workflow version. Complements security_audit_log: that
 * table keeps a lightweight cross-resource "who did what" event for each
 * workflow change; this table holds the heavy per-version payload needed to
 * load, diff, and restore a past version. It mirrors the audit-log actor
 * capture (changedByUserId, authMethod, createdAt) so "who did it" is
 * answerable here too.
 *
 * `snapshot` stores the full definition (incl. edges, which are structural --
 * the executor builds its run graph from them). `change` is the deep-diff
 * against the previous version, and both it and `contentHash` are computed
 * over the MEANINGFUL definition only (cosmetic ReactFlow state stripped via
 * lib/workflow/content-hash.ts), so a cosmetic node drag does not create a
 * version while a connection change does. `contentHash` joins to
 * workflow_executions.executed_workflow_hash.
 */
export const workflowHistory = pgTable(
  "workflow_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    // Per-workflow monotonic version (MAX(version)+1 at write time).
    version: integer("version").notNull(),
    changedByUserId: text("changed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authMethod: text("auth_method").notNull(),
    source: text("source").notNull(), // create | update | listing
    // biome-ignore lint/suspicious/noExplicitAny: JSONB - full workflow snapshot, shape is the workflow definition
    snapshot: jsonb("snapshot").$type<any>(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB - deep-diff change records vs the previous version
    change: jsonb("change").$type<any>(),
    contentHash: text("content_hash").notNull(),
    previousVersion: integer("previous_version"),
    previousHash: text("previous_hash"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_workflow_history_workflow_version").on(
      table.workflowId,
      table.version
    ),
    index("idx_workflow_history_content_hash").on(table.contentHash),
  ]
);

export type WorkflowHistory = typeof workflowHistory.$inferSelect;
export type NewWorkflowHistory = typeof workflowHistory.$inferInsert;

/**
 * Pay As You Go config table
 *
 * One row per org on the PAYG plan. Holds the user-set spend caps and the
 * period anchor. The current billing period is the monthly window anchored to
 * `startedAt` that contains now (computed, not stored) and bounds the per-period
 * cap + usage reporting. Amounts are USDC 6-decimal raw units stored as text.
 *
 * Both caps always carry a value: "0" is a real zero that blocks all spend, not
 * an "unset" that waves charges through. An org with no row at all runs on the
 * PAYG_DEFAULT_* caps.
 */
export const paygConfig = pgTable(
  "payg_config",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    dailyCapRaw: text("daily_cap_raw").notNull().default("0"),
    periodCapRaw: text("period_cap_raw").notNull().default("0"),
    chainId: integer("chain_id").notNull().default(8453),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("idx_payg_config_org").on(table.organizationId)]
);

export type PaygConfig = typeof paygConfig.$inferSelect;
export type NewPaygConfig = typeof paygConfig.$inferInsert;

/**
 * Pay As You Go payments table
 *
 * One row per charged execution (settled USDC to the treasury). The source of
 * truth for guard-rail spend sums (day/period) and the UI usage/history view.
 * Idempotent on (organization_id, execution_id) so a retried finalization does
 * not double-charge. `amountRaw` is USDC 6-decimal raw units stored as text.
 */
export const paygPayments = pgTable(
  "payg_payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    executionId: text("execution_id").notNull(),
    amountRaw: text("amount_raw").notNull(),
    txHash: text("tx_hash"),
    chainId: integer("chain_id").notNull(),
    payerAddress: text("payer_address").notNull(),
    treasuryAddress: text("treasury_address").notNull(),
    status: text("status").notNull().default("settled"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("payg_payments_org_execution").on(
      table.organizationId,
      table.executionId
    ),
    index("idx_payg_payments_org_created").on(
      table.organizationId,
      table.createdAt
    ),
  ]
);

export type PaygPayment = typeof paygPayments.$inferSelect;
export type NewPaygPayment = typeof paygPayments.$inferInsert;
