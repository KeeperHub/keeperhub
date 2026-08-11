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
import type { ErrorCode } from "../errors/error-codes";
import type { ExecutionErrorType } from "../errors/execution-error-type";
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
// Created by @workflow/world-postgres migrations in `public` and referenced
// cross-schema by `workflow.workflow_waits.status`. Declared here so
// `pnpm db:push` does not emit a DROP that Postgres rejects with
// "cannot drop type wait_status because other objects depend on it".
export const workflowWaitStatus = pgEnum("wait_status", [
  "waiting",
  "completed",
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
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  // Wallet (SIWE) accounts start with a generated handle and must confirm or
  // edit it in the rename modal on first login. Flipped true once chosen so
  // returning wallet users are not re-prompted.
  displayNameConfirmed: boolean("display_name_confirmed")
    .notNull()
    .default(false),
  // True once the user finishes (or skips through) the /welcome onboarding
  // wizard. Server-side so the flow is not re-shown on another device/browser.
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  // Wallet-only per-action step-up policy: maps a sensitive action to the
  // extra factors the wallet user opted into (e.g. {"wallet_withdraw":["totp"]}).
  // Email/TOTP users always use dual-factor regardless and ignore this column.
  stepUpPolicy: jsonb("step_up_policy"),
  // Verified, deliverable email a wallet user added for email-OTP step-up.
  // Only written after the user confirms it with a code; presence = verified.
  // Distinct from `email` (the synthetic SIWE login identity).
  stepUpEmail: text("step_up_email"),
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
    requiresMfa: boolean("requires_mfa").notNull().default(false),
    mfaVerifiedAt: timestamp("mfa_verified_at"),
    riskFlagsJson: text("risk_flags_json"),
  },
  (table) => [index("idx_sessions_user_id").on(table.userId)]
);

/**
 * Wallet addresses linked to a user, populated by Better Auth's SIWE plugin
 * (Sign-In With Ethereum). One user may link multiple addresses; the first
 * one is flagged `isPrimary`. Field shape mirrors the plugin's expected
 * `walletAddress` model so the Drizzle adapter can satisfy its reads/writes.
 */
export const walletAddress = pgTable(
  "wallet_address",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    chainId: integer("chain_id").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_wallet_address_user_id").on(table.userId),
    uniqueIndex("idx_wallet_address_address_unique").on(table.address),
  ]
);

/**
 * Per-user allowlist of trusted IPs. A successful /verify-ip flow
 * inserts the request IP here; subsequent sessions originating from
 * the same IP pass `assessLoginRisk` without prompting the user.
 *
 * `country` is captured at the moment of trust for forensic audit but
 * is not used to decide trust: a user crossing a border on the same
 * laptop should still be trusted once the IP is in the list.
 *
 * The (user_id, ip) pair is unique so a re-verify of a known IP
 * upserts the `last_seen_at` rather than duplicating rows.
 */
export const userTrustedIps = pgTable(
  "user_trusted_ips",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ip: text("ip").notNull(),
    country: text("country"),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_user_trusted_ips_user_id").on(table.userId),
    uniqueIndex("idx_user_trusted_ips_user_ip").on(table.userId, table.ip),
  ]
);

/**
 * Per-user allowlist of trusted countries. Trust is keyed on the
 * Cloudflare-attested country (CF-IPCountry), not the IP: once a user has
 * signed in from a country, later sign-ins from any IP within it pass
 * without a second MFA round. A country never seen before defers the
 * session to the /verify-ip dual-factor flow, which inserts the row here
 * on success.
 *
 * The (user_id, country) pair is unique so re-entry from a known country
 * upserts `last_seen_at` rather than duplicating rows.
 */
export const userTrustedCountries = pgTable(
  "user_trusted_countries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    country: text("country").notNull(),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_user_trusted_countries_user_id").on(table.userId),
    uniqueIndex("idx_user_trusted_countries_user_country").on(
      table.userId,
      table.country
    ),
  ]
);

/**
 * Per-user inventory of devices that have signed in, identified by the
 * random id carried in the signed `kh_device_id` cookie. A device not
 * already in this list signing in (from a trusted country) is allowed
 * through but triggers a courtesy warning email; the row is recorded so
 * the next sign-in from the same device is silent. `user_agent` stores
 * the most recent label for the email and active-sessions panel.
 *
 * The (user_id, device_id) pair is unique so a repeat sign-in upserts
 * `last_seen_at` rather than duplicating rows.
 */
export const userTrustedDevices = pgTable(
  "user_trusted_devices",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    userAgent: text("user_agent"),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_user_trusted_devices_user_id").on(table.userId),
    uniqueIndex("idx_user_trusted_devices_user_device").on(
      table.userId,
      table.deviceId
    ),
  ]
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    // Nullable: backup codes are generated only when the user explicitly
    // requests them via /api/user/totp/backup-codes, not at TOTP setup.
    // A row with secret + null backup_codes is a valid enrolled user who
    // simply hasn't generated codes yet.
    backupCodes: text("backup_codes"),
    name: text("name"),
    enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
    // Better Auth's two-factor plugin expects a `verified` field on this
    // model. Its verify-totp path reads the row and, when `verified` is
    // not strictly true, issues an UPDATE setting it to true. Without the
    // column the drizzle adapter strips that field, producing an empty
    // SET that Postgres rejects and breaking every fresh TOTP sign-in.
    // Defaults to true so rows enrolled through our own routes are treated
    // as verified and the plugin skips the write entirely.
    verified: boolean("verified").notNull().default(true),
    // The same contract as `verified` above, for the plugin's account-lockout
    // feature. It is enabled by default - resolveAccountLockoutConfig reads
    // `enabled: lockout?.enabled ?? true` and we pass no accountLockout option -
    // so resetTwoFactorFailures runs on every successful verification and
    // updates exactly these two fields. Without the columns the adapter strips
    // both, leaving an empty SET that Postgres rejects, so a correct TOTP code
    // 500s after validating.
    //
    // They also have to exist for the control to do anything:
    // assertTwoFactorNotLocked gates on `lockedUntil`, which reads as undefined
    // when the column is absent, so the cap on consecutive failed verifications
    // (NIST SP 800-63B 5.2.2) silently never applies.
    //
    // Property names must match Better Auth's field names exactly -
    // failedVerificationCount and lockedUntil - because the drizzle adapter
    // maps by property, not column.
    failedVerificationCount: integer("failed_verification_count")
      .notNull()
      .default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (table) => [index("idx_two_factor_user_id").on(table.userId)]
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
  // Set when the org is deactivated. Cascaded from owner deactivation by the
  // cascade_org_deactivation_on_owner trigger (only when no active owner
  // remains) and honored as a hard access/execution gate. Reactivation clears
  // it manually, mirroring users.deactivatedAt.
  deactivatedAt: timestamp("deactivated_at"),
  // Owner-set switch requiring every member to carry a second factor while this
  // org is their active context. Email/TOTP members already enforce dual-factor
  // globally; this is what makes the gate bite for wallet (SIWE) members, who
  // are otherwise MFA-exempt. enforcedMfaFactors lists which factors satisfy it
  // (e.g. ["totp"], ["email"], or both); null/empty means no extra requirement.
  enforceMfa: boolean("enforce_mfa").notNull().default(false),
  enforcedMfaFactors: jsonb("enforced_mfa_factors"),
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
    uniqueIndex("member_org_single_owner")
      .on(table.organizationId)
      .where(sql`${table.role} = 'owner'`),
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
  (table) => [
    index("idx_address_book_org").on(table.organizationId),
    uniqueIndex("idx_address_book_org_address").on(
      table.organizationId,
      table.address
    ),
  ]
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
// - private: only owner / org members can view (default)
// - unlisted: anyone with the URL can view read-only; not surfaced in Hub feed
// - public: viewable by anyone AND listed on the Hub
export type WorkflowVisibility = "private" | "unlisted" | "public";

// Workflows table with user association
export const workflows = pgTable(
  "workflows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    // createdBy (audit only). The authoritative owner of a workflow is its
    // organization; userId records who created it and must NOT be used as an
    // ownership/authority signal. See lib/workflow/access.ts and executable.ts.
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // The owning organization. Authoritative owner. NOT NULL: every account
    // (anonymous included) has an org, so there are no org-less workflows.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    // DEPRECATED: always false. Encoded "created by a logged-out session with
    // no org", a state that no longer exists (every account has an org and
    // organizationId is NOT NULL); normalized to false by migration 0101.
    // Column drop is a follow-up alongside retiring the claim route + dialog.
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
    /** When true, execution status is shareable via deep link for public/unlisted workflows. Opt-in; default false. */
    shareExecutionStatus: boolean("share_execution_status")
      .default(false)
      .notNull(),
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
    // Set when the workflow is deactivated. A distinct state from `enabled`
    // (automation toggle) and `deletedAt` (slug-hiding soft-delete): a
    // deactivated workflow cannot be enabled or triggered manually. Cleared
    // manually on reactivation.
    deactivatedAt: timestamp("deactivated_at"),
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

// Integration visibility controls which principals may use a credential at
// workflow execution time (not just view it).
// - private: only the owner (creator) may use it (default / opt-in)
// - specific_members: the owner plus users with an integration_grants row
// - organization: any current member of the owning organization may use it
export const integrationVisibility = pgEnum("integration_visibility", [
  "private",
  "specific_members",
  "organization",
]);

// Integrations table for storing user credentials
export const integrations = pgTable(
  "integrations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    createdBy: text("created_by")
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
    visibility: integrationVisibility("visibility")
      .notNull()
      .default("private"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // At most one web3 integration row per org. Today the only web3 row is
    // the cosmetic KeeperHub-wallet entry; the broader rule is enforced
    // here so any future web3 write hits the same guard. Closes the race
    // in ensureWalletIntegration where two concurrent /api/integrations
    // GETs could both pass the existence check and both insert.
    //
    // "Cosmetic" is load-bearing, and the indirection it implies is the part
    // that reads like a bug until you know it: this row holds no key. A web3
    // action node references `integrations.id`, but the signing material sits
    // in the org's `organizationWallets` row (lib/db/schema-extensions.ts),
    // which carries both `wallet_address` (EVM) and `solana_address` against
    // one set of Turnkey identifiers.
    //
    // Because the org has exactly one web3 integration and one active wallet,
    // a single integrationId legitimately serves EVM and Solana actions across
    // every chain. Seeing the same integrationId on an Ethereum transfer and a
    // Solana balance check is correct, not copy-paste: the chain is selected by
    // the node's own `network` config, never by the integration.
    //
    // Corollary for anyone hunting a "wrong wallet" bug: changing integrationId
    // cannot change which address signs. Look at organizationWallets instead.
    uniqueIndex("idx_integrations_org_web3")
      .on(table.organizationId)
      .where(
        sql`${table.type} = 'web3' AND ${table.organizationId} IS NOT NULL`
      ),
    index("idx_integrations_created_by").on(table.createdBy),
  ]
);

// Per-user grants for integrations with visibility = 'specific_members'.
// A row authorizes `userId` to use `integrationId` at execution time.
// Rows are deleted (cascade) when the integration or grantee user is removed,
// which is the lazy-revocation mechanism: dropping the row fails execution closed.
export const integrationGrants = pgTable(
  "integration_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_integration_grants_integration_user").on(
      table.integrationId,
      table.userId
    ),
    index("idx_integration_grants_user").on(table.userId),
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
  // KEEP-966: independent on-chain verification result for this hash,
  // populated by logWorkflowCompleteDb/selfHealWorkflowAfterLateStepCommit at
  // finalize time. Named receiptStatus (not `status`) to avoid colliding with
  // the execution's own top-level `status` column in any flattened read.
  verified?: boolean;
  receiptStatus?:
    | "success"
    | "reverted"
    | "not_found"
    | "timeout"
    | "safe_inner_failure";
  blockNumber?: number;
  gasUsed?: string;
  verifiedAt?: string;
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
    // Audit lineage only (the workflow's createdBy, or the triggering user
    // where one exists). Execution AUTHORITY - quotas, billing, credentials -
    // is the owning org: resolve it via getOrganizationIdFromExecution.
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().$type<
      | "pending"
      | "running"
      // A run whose claimed transaction hashes could not be read on chain.
      // Non-terminal: settled to success or error by the reconciler.
      | "unconfirmed"
      | "success"
      | "error"
      | "cancelled"
      | "phantom"
      | "system_error"
    >(),
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
      | "billing"
      | "database"
      | "auth"
      | "infrastructure"
      | "workflow_engine"
      | "unknown"
    >(),
    errorType: text("error_type").$type<ExecutionErrorType>(),
    errorCode: text("error_code").$type<ErrorCode>(),
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
     * Run-total gas (sum of per-step `gasUsed`, in wei), denormalised out of the
     * per-step workflow_execution_logs.output JSONB. Populated at terminal
     * finalize (success or error), alongside transaction_hashes
     * (lib/workflow/executor/logging.ts), so org-scoped /analytics summary and
     * spend-cap reads can aggregate a first-class column instead of full-scanning
     * and detoasting the logs table.
     *
     * Nullable on legacy rows until backfilled, and on runs that produced no
     * on-chain gas. Network is intentionally NOT denormalised here: it is a
     * per-step property (each web3 node targets its own chain), so a run can
     * span multiple networks and no single run-level value is correct. The
     * per-network gas breakdown keeps reading step-level log data.
     */
    gasUsedWei: numeric("gas_used_wei"),
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
    /**
     * KEEP-612 attribution columns. Populated on insert from the request
     * context so detection alerts can group by source. Nullable on legacy
     * rows and for internal callers without a request (e.g. scheduler).
     *
     * - `triggered_by_user_api_key_id` FKs `api_keys.id` (wfb_* webhook keys).
     * - `triggered_by_org_api_key_id` FKs `organization_api_keys.id`
     *   (kh_* org keys) — FK added in migration 0093 because that table
     *   lives in schema-extensions.ts and would create a circular import.
     * - `triggered_by_ip` is the canonical client IP (Cloudflare
     *   `cf-connecting-ip` preferred). See lib/security/request-attribution.ts.
     * - `trigger_source` records the entry point: manual | webhook |
     *   scheduled | mcp | internal | block | event.
     */
    triggeredByUserApiKeyId: text("triggered_by_user_api_key_id").references(
      () => apiKeys.id,
      { onDelete: "set null" }
    ),
    triggeredByOrgApiKeyId: text("triggered_by_org_api_key_id"),
    triggeredByIp: text("triggered_by_ip"),
    triggeredByCountry: text("triggered_by_country"),
    triggerSource: text("trigger_source"),
    /**
     * Durable credential descriptor captured at trigger time. The
     * `triggered_by_*_api_key_id` FKs above are nulled when a key is revoked
     * (user keys are hard-deleted), which erases "what did this credential
     * run" exactly when an investigation needs it. These two columns survive
     * revocation: `type` is the credential class (webhook_key | org_api_key |
     * oauth | session | internal) and `label` is a stable, non-secret handle
     * (e.g. the key prefix `wfb_abc1234`, or the internal caller name).
     */
    triggeredByCredentialType: text("triggered_by_credential_type"),
    triggeredByCredentialLabel: text("triggered_by_credential_label"),
    /**
     * sha256 of the workflow definition (nodes + edges) as it existed when
     * this run was triggered -- see lib/workflow/content-hash.ts. Ties a run
     * to the exact definition that produced it even after the workflow is
     * later edited, and joins to `workflow_history.content_hash` to resolve
     * the full stored snapshot without duplicating the graph per execution.
     */
    executedWorkflowHash: text("executed_workflow_hash"),
    /**
     * Dispatch-idempotency key. The schedule and block dispatchers
     * run two replicas with leader election; this key makes a duplicate
     * dispatch a no-op instead of a second SQS message and a second run. The
     * dispatcher sets a stable per-occurrence value
     * (`schedule:<scheduleId>:<occurrenceIso>` / `block:<workflowId>:<chainId>:<blockNumber>`)
     * and the create-phantom insert is `ON CONFLICT DO NOTHING` on the unique
     * index below, so an overlapping leader or a catch-up window that re-runs an
     * occurrence collides and skips its enqueue. Null for rows with no dedup key
     * (manual/webhook/direct); Postgres treats those NULLs as distinct so they
     * never collide.
     */
    dispatchKey: text("dispatch_key"),
    /**
     * Soft-delete marker for execution history. Purging a workflow's runs sets
     * this instead of hard-deleting the row; billing usage counters count all
     * rows regardless of deleted_at, while user-facing execution listings
     * filter deleted_at IS NULL.
     */
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_workflow_executions_status").on(table.status),
    index("idx_workflow_executions_user_id").on(table.userId),
    // Resolve "which runs executed this snapshot" / join to workflow_history.
    index("idx_workflow_executions_executed_hash").on(
      table.executedWorkflowHash
    ),
    // Idempotency guard for dispatch dedup; NULL keys are distinct so only real
    // per-occurrence keys are constrained.
    uniqueIndex("idx_workflow_executions_dispatch_key").on(table.dispatchKey),
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
    /**
     * Per-step network + on-chain gas, denormalised out of the input/output
     * JSONB so the /analytics per-network gas breakdown can aggregate
     * first-class columns instead of re-parsing the double-encoded JSONB on
     * every row (the cost behind the networks-endpoint 524). network is read
     * from input at step start; gas_used_wei from output at step complete.
     * Both nullable on legacy rows until backfilled
     * (scripts/backfill-exec-log-network-gas.ts) and on non-web3 steps.
     */
    network: text("network"),
    gasUsedWei: numeric("gas_used_wei"),
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
// KeeperHub: Organization Wallets, Organization API Keys, and Organization Tokens (imported from KeeperHub schema extensions)
// Note: Using relative path instead of @/ alias for drizzle-kit compatibility
export {
  type BillingEvent,
  billingEvents,
  type DirectExecution,
  type DirectExecutionReceiptEntry,
  directExecutions,
  type ExecutionDebt,
  executionDebt,
  type GasCreditAllocation,
  type GasSponsorshipMonthly,
  gasCreditAllocations,
  gasCreditUsage,
  gasSponsorshipDelegations,
  gasSponsorshipMonthly,
  keyExportCodes,
  type NewBillingEvent,
  type NewDirectExecution,
  type NewExecutionDebt,
  type NewGasCreditAllocation,
  type NewGasSponsorshipMonthly,
  type NewOrganizationApiKey,
  type NewOrganizationSpendCap,
  type NewOrganizationSubscription,
  type NewOrganizationToken,
  type NewOrganizationWallet,
  type NewPaygConfig,
  type NewPaygPayment,
  type NewPublicTag,
  type NewSafeRole,
  type NewSafeRoleAllowance,
  type NewSafeRoleDirectRule,
  type NewSafeRoleProtocol,
  type NewSafeWallet,
  type NewSecurityAuditLog,
  type NewSupportedToken,
  type NewWorkflowHistory,
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
  type PaygConfig,
  type PaygPayment,
  type PendingTransaction,
  type PublicTag,
  paygConfig,
  paygPayments,
  pendingTransactions,
  publicTags,
  type SafeRole,
  type SafeRoleAllowance,
  type SafeRoleDirectRule,
  type SafeRoleProtocol,
  type SafeWallet,
  type SecurityAuditLog,
  type SupportedToken,
  safeRoleAllowances,
  safeRoleDirectRules,
  safeRoleProtocols,
  safeRoles,
  safeWallets,
  securityAuditLog,
  supportedTokens,
  type WalletLock,
  type WorkflowHistory,
  type WorkflowPublicTag,
  walletLocks,
  workflowHistory,
  workflowPublicTags,
  workflowRatings,
} from "./schema-extensions";
export { feedback, feedbackStatus } from "./schema-feedback";
// Internal-service HMAC secrets (versioned, encrypted at rest). See
// lib/internal-service-auth.ts for the verifier that consumes these.
export {
  type InternalServiceHmacSecret,
  internalServiceHmacSecrets,
  type NewInternalServiceHmacSecret,
} from "./schema-internal-auth";
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
export {
  type NewTempoHeldPayment,
  type TempoHeldPayment,
  tempoHeldPaymentStatus,
  tempoHeldPayments,
} from "./schema-tempo-payments";

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
  scope: text("scope"), // Space-separated OAuth scopes; null means full access
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

// Per-org scheduled execution-digest config. Paid-only (Pro+); the cron
// job and settings API both gate on the org plan. subscriberUserIds is the
// explicit recipient list managed by owners/admins; non-members are skipped at
// send time. lastSentAt drives the daily/weekly due check.
export const workflowExecutionDigestSettings = pgTable(
  "workflow_execution_digest_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    // An org can subscribe to any combination of cadences; each one sends on its
    // own schedule. Defaults to weekly for parity with the original single-choice.
    cadences: jsonb("cadences")
      .$type<("daily" | "weekly" | "monthly")[]>()
      .notNull()
      .default(["weekly"]),
    subscriberUserIds: jsonb("subscriber_user_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    // Last-sent timestamp (ISO string) keyed by cadence, so a daily send does not
    // suppress the weekly/monthly send and vice versa.
    lastSent: jsonb("last_sent")
      .$type<Partial<Record<"daily" | "weekly" | "monthly", string>>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_execution_digest_enabled").on(table.enabled)]
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
    // Human-readable slugs a workflow listing's `chain` field may use in
    // place of the numeric chainId, e.g. ["ethereum", "eth"] for chainId 1.
    // Matched case-insensitively by classifyChainTag in
    // lib/agentic-wallet/workflow-binding.ts. Empty for chains with no
    // registered alias.
    aliases: jsonb("aliases").notNull().default([]).$type<string[]>(),
    // Whether this chain is one of KeeperHub's own payment settlement rails
    // (Base, Tempo) rather than a read-only data chain. Determines whether
    // classifyChainTag treats a workflow's chain tag as a payment-chain pin
    // (caller must match) or a data-chain hint (either payment rail
    // accepted).
    isPaymentRail: boolean("is_payment_rail").notNull().default(false),
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
    // Support maturity signal surfaced to agents via list_action_schemas:
    // "stable" | "experimental" | "deprecated". Orthogonal to isEnabled.
    status: text("status").notNull().default("stable"),
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
    backupExplorerApiType: text("backup_explorer_api_type"), // fallback API type if primary fails
    backupExplorerApiUrl: text("backup_explorer_api_url"), // fallback API URL if primary fails
    backupExplorerApiKeyNeeded: boolean("backup_explorer_api_key_needed")
      .notNull()
      .default(false),
    backupExplorerApiKey: text("backup_explorer_api_key"), // API key for backup provider (required when backupExplorerApiKeyNeeded is true)
    backupExplorerUrl: text("backup_explorer_url"), // display URL for backup provider (e.g. "https://blockscout.com")
    backupExplorerTxPath: text("backup_explorer_tx_path"), // tx link path template for backup provider
    backupExplorerAddressPath: text("backup_explorer_address_path"), // address link path template for backup provider
    backupExplorerContractPath: text("backup_explorer_contract_path"), // contract link path template for backup provider
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
export type IntegrationVisibility =
  (typeof integrationVisibility.enumValues)[number];
export type IntegrationGrant = typeof integrationGrants.$inferSelect;
export type NewIntegrationGrant = typeof integrationGrants.$inferInsert;
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;
export type NewWorkflowExecutionLog = typeof workflowExecutionLogs.$inferInsert;
// OrganizationWallet types are exported from ./schema-extensions
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
