import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization, users } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Approval status pgEnum
 *
 * Lifecycle of a wallet approval request. Distinct DB type name
 * ("approval_status") to avoid collision with workflowRunStatus's
 * "status" enum.
 */
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

/**
 * Approval risk level pgEnum
 *
 * GUARD-03 classification for a pending signing operation. Distinct DB
 * type name ("approval_risk_level") to avoid collision with any other
 * status-like enum. `risk_level` is notNull with NO default: the caller
 * must explicitly classify every request.
 */
export const approvalRiskLevel = pgEnum("approval_risk_level", [
  "auto",
  "ask",
  "block",
]);

/**
 * Agentic Wallets table
 *
 * Turnkey sub-orgs owned by KeeperHub and operated on behalf of an agent
 * installation. Each row is ONE sub-org with two wallet addresses
 * (Base + Tempo). Anonymous wallets have null linked_user_id; linking
 * is late-bound via `npx @keeperhub/wallet link` (ONBOARD-04, Phase 33).
 *
 * Permanent by design (ONBOARD-06) -- there is intentionally no
 * expiry column. Wallet rows survive user deletion (linked_user_id
 * uses ON DELETE SET NULL) so cold storage stays usable.
 */
export const agenticWallets = pgTable(
  "agentic_wallets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    subOrgId: text("sub_org_id").notNull().unique(),
    walletAddressBase: text("wallet_address_base").notNull(),
    walletAddressTempo: text("wallet_address_tempo").notNull(),
    // REVIEW CR-01: nullable to avoid migration deploy break on tables with
    // pre-existing rows (Phase 32 test seeds). The runtime invariant is that
    // `provisionAgenticWallet` always writes a non-null 64-hex-char secret for
    // new rows; callers (verifyHmacRequest -> lookupHmacSecret) treat null as
    // "unknown sub-org" and return 404. A follow-up backfill + NOT NULL
    // migration can tighten the schema once legacy rows are reconciled.
    hmacSecret: text("hmac_secret"),
    linkedUserId: text("linked_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * The organization answerable for what this wallet signs.
     *
     * Policy is written by an organization, so a wallet with no organization is
     * a wallet no rule can reach. It is set when the wallet is linked, because
     * that is the first moment anybody knows who the wallet belongs to, and it
     * is nullable because a wallet can be provisioned before it is linked and
     * because a linking user may belong to more than one organization, which is
     * a choice to record rather than a guess to make at every signature.
     */
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    linkedAt: timestamp("linked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_agentic_wallets_linked_user").on(table.linkedUserId),
    index("idx_agentic_wallets_organization").on(table.organizationId),
    index("idx_agentic_wallets_wallet_base").on(table.walletAddressBase),
    index("idx_agentic_wallets_wallet_tempo").on(table.walletAddressTempo),
  ]
);

/**
 * Wallet Approval Requests table
 *
 * Pending signing operations awaiting human approval (GUARD-03 ask-decision).
 * Created by Phase 33's /api/agentic-wallet/approval-request endpoint,
 * resolved by the /approve endpoint. Phase 32 only defines the shape.
 *
 * FK target is agenticWallets.subOrgId (not .id) so the approval carries
 * the same identifier the agent client sends, avoiding an extra join.
 * Same precedent as explorerConfigs.chainId -> chains.chainId.
 */
export const walletApprovalRequests = pgTable(
  "wallet_approval_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    subOrgId: text("sub_org_id")
      .notNull()
      .references(() => agenticWallets.subOrgId, { onDelete: "cascade" }),
    operationPayload: jsonb("operation_payload")
      .notNull()
      .$type<Record<string, unknown>>(),
    status: approvalStatus("status").notNull().default("pending"),
    riskLevel: approvalRiskLevel("risk_level").notNull(),
    // Phase 37 fix B1: bind approval to a specific recipient/amount/chain/contract
    // so the future re-enable of the ask-tier server flow cannot be one-click
    // approved into a different operation.
    boundRecipient: text("bound_recipient"),
    boundAmountMicro: text("bound_amount_micro"),
    boundChain: text("bound_chain"),
    boundContract: text("bound_contract"),
    // Phase 37 fix B2: hard 15-minute TTL. /approve rejects with 410 GONE
    // past this; the cron sweeper marks rows expired and deletes terminal
    // rows older than 7 days.
    expiresAt: timestamp("expires_at")
      .notNull()
      .default(sql`now() + interval '15 minutes'`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    // SET NULL preserves the approval audit trail if the approver's user is
    // deleted. Mirrors the audit-preservation rationale on
    // agenticWallets.linked_user_id -- a deleted approver must not erase the
    // fact that an approval occurred.
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("idx_wallet_approval_sub_org").on(table.subOrgId),
    index("idx_wallet_approval_status").on(table.status),
    index("idx_wallet_approval_created").on(table.createdAt),
    // REVIEW MED-02: index the FK target so ON DELETE SET NULL does not
    // seq-scan wallet_approval_requests on user deletion, and so "approvals
    // resolved by user X" queries in Phase 33 use an index.
    index("idx_wallet_approval_resolved_by").on(table.resolvedByUserId),
  ]
);

/**
 * Agentic wallet HMAC secrets -- versioned, encrypted at rest.
 *
 * Phase 37 fixes #6 (no rotation path) and #9 (plaintext storage). One row
 * per (sub_org_id, key_version). Rotation creates a new row at version+1
 * and stamps the previous row's `expires_at = now() + 24h` for grace.
 *
 * `secret_ciphertext` is AES-256-GCM with a 12-byte IV, encoded as
 * `${base64(iv)}:${base64(authTag)}:${base64(ciphertext)}`. The encryption
 * key comes from process.env.AGENTIC_WALLET_HMAC_KMS_KEY (32 bytes b64).
 */
export const agenticWalletHmacSecrets = pgTable(
  "agentic_wallet_hmac_secrets",
  {
    subOrgId: text("sub_org_id")
      .notNull()
      .references(() => agenticWallets.subOrgId, { onDelete: "cascade" }),
    keyVersion: integer("key_version").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
  },
  (table) => [primaryKey({ columns: [table.subOrgId, table.keyVersion] })]
);

/**
 * Agentic wallet rate-limit buckets. Replaces the in-memory per-pod limiter
 * in lib/mcp/rate-limit.ts for the /provision route. Phase 37 fix #7.
 *
 * key shape: `${routeName}:${trustedClientIp}` (e.g. "provision:1.2.3.4").
 * bucket_start: hour-truncated timestamp via date_trunc('hour', now()).
 * Hot-row contention is acceptable at /provision throughput (5/hour/IP).
 * The cron sweeper deletes rows with bucket_start older than 24h.
 */
export const agenticWalletRateLimits = pgTable(
  "agentic_wallet_rate_limits",
  {
    key: text("key").notNull(),
    bucketStart: timestamp("bucket_start").notNull(),
    requestCount: integer("request_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.bucketStart] }),
    index("idx_agentic_wallet_rate_limits_bucket").on(table.bucketStart),
  ]
);

/**
 * Agentic wallet per-sub-org per-day spend cap. Phase 37 fix-pack-2 R1.
 *
 * HMAC compromise on its own does not let an attacker drain a wallet: /sign
 * binds payTo + amount to a listed workflow in the registry. But an attacker
 * who also lists their own workflow at a below-ask-tier price ($49.99 <
 * the $50 ask threshold in risk.ts) can point a stolen HMAC at that workflow
 * and auto-tier-sign repeatedly. This table bounds the total daily drain via
 * an atomic reserve-and-rollback pattern keyed on the authenticated sub-org.
 *
 * Composite PK (sub_org_id, day_utc) serializes concurrent /sign calls on
 * the row lock. The cron sweeper deletes rows with day_utc older than 2 days.
 *
 * spent_micros is bigint so the cap can scale beyond int4 (2.1 billion
 * micros = ~$2147) without schema change.
 */
export const agenticWalletDailySpend = pgTable(
  "agentic_wallet_daily_spend",
  {
    subOrgId: text("sub_org_id")
      .notNull()
      .references(() => agenticWallets.subOrgId, { onDelete: "cascade" }),
    dayUtc: date("day_utc").notNull(),
    spentMicros: bigint("spent_micros", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    primaryKey({ columns: [table.subOrgId, table.dayUtc] }),
    index("idx_agentic_wallet_daily_spend_day").on(table.dayUtc),
  ]
);

export type AgenticWallet = typeof agenticWallets.$inferSelect;
export type NewAgenticWallet = typeof agenticWallets.$inferInsert;
export type WalletApprovalRequest = typeof walletApprovalRequests.$inferSelect;
export type NewWalletApprovalRequest =
  typeof walletApprovalRequests.$inferInsert;
export type AgenticWalletHmacSecret =
  typeof agenticWalletHmacSecrets.$inferSelect;
export type NewAgenticWalletHmacSecret =
  typeof agenticWalletHmacSecrets.$inferInsert;
export type AgenticWalletRateLimit =
  typeof agenticWalletRateLimits.$inferSelect;
export type NewAgenticWalletRateLimit =
  typeof agenticWalletRateLimits.$inferInsert;
export type AgenticWalletDailySpend =
  typeof agenticWalletDailySpend.$inferSelect;
export type NewAgenticWalletDailySpend =
  typeof agenticWalletDailySpend.$inferInsert;
