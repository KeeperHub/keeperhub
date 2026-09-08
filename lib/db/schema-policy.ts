import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, users } from "@/lib/db/schema";
import type { Capability } from "@/lib/policy/capabilities";
import type {
  CatalogEntrySource,
  SelectorCatalogEntry,
} from "@/lib/policy/catalog/types";
import type {
  PolicyDecisionReason,
  PolicyEnforcementMode,
  PolicyOutcome,
} from "@/lib/policy/constants";
import type { PolicyDocument } from "@/lib/policy/types";
import { generateId } from "@/lib/utils/id";

/**
 * Organization policy documents.
 *
 * One row per policy, many per organization. The document is stored verbatim
 * as authored so it round-trips through the editor unchanged; the compiled
 * form is derived at read time and cached in process, never persisted, so a
 * change to the compiler cannot leave stale artifacts behind.
 *
 * `version` increments on every save. A run pins the version it started with,
 * which is what stops one execution being judged half against an old policy
 * and half against a new one.
 */
export const organizationPolicies = pgTable(
  "organization_policies",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // A disabled policy is inert but retained. This is the costless first rung
    // of the revocation ladder: stop the rule without losing what it said.
    enabled: boolean("enabled").notNull().default(true),
    // "monitor" evaluates and records exactly as "enforce" does, and never
    // changes the outcome of a request.
    enforcement: text("enforcement")
      .$type<PolicyEnforcementMode>()
      .notNull()
      .default("monitor"),
    document: jsonb("document").$type<PolicyDocument>().notNull(),
    version: integer("version").notNull().default(1),
    // An edit is recorded immediately but takes effect after this delay, so a
    // malicious or mistaken relaxation is visible before it takes hold. Zero
    // means immediate.
    changeDelayHours: integer("change_delay_hours").notNull().default(0),
    effectiveAt: timestamp("effective_at").notNull().defaultNow(),
    // A protected policy needs a second approver to relax or remove it.
    protected: boolean("protected").notNull().default(false),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_org_policies_org_enabled").on(
      table.organizationId,
      table.enabled
    ),
    uniqueIndex("idx_org_policies_org_name").on(
      table.organizationId,
      table.name
    ),
  ]
);

export type OrganizationPolicyRow = typeof organizationPolicies.$inferSelect;

/**
 * Resource grants: what a subject can reach at all.
 *
 * A grant is the capability half of the model. Policy says what may be done;
 * a grant says whether the resource is reachable in the first place. A subject
 * holding no grant for a resource cannot act on it, whatever policy permits.
 *
 * `grantedBy` is load-bearing rather than audit trim: attenuation is checked
 * against that user's own reach at issuance, so a grant can never exceed what
 * the granter holds. That is what makes an agent unable to exceed the human it
 * acts for, without a separate check at each call site.
 */
export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // "workflow" grants bind to a workflow id; "principal" grants bind to a
    // member, API key or OAuth client.
    subjectKind: text("subject_kind")
      .$type<"workflow" | "principal">()
      .notNull(),
    subjectId: text("subject_id").notNull(),
    // A resource identifier, possibly a pattern. Normalized at write time so
    // matching is a plain string compare.
    resource: text("resource").notNull(),
    capabilities: jsonb("capabilities")
      .$type<readonly Capability[]>()
      .notNull(),
    grantedBy: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Retained for the audit trail: who held what, and when it stopped.
    revokedAt: timestamp("revoked_at"),
    revokedBy: text("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_resource_grants_subject").on(
      table.organizationId,
      table.subjectKind,
      table.subjectId
    ),
    index("idx_resource_grants_org_revoked").on(
      table.organizationId,
      table.revokedAt
    ),
  ]
);

export type ResourceGrantRow = typeof resourceGrants.$inferSelect;

/**
 * The decision log, and the receipt the signing-time check consumes.
 *
 * One row per evaluated request. This is the table that makes monitor mode
 * worth anything: it records what a policy would have done before anyone
 * turns enforcement on.
 *
 * It is also the only part of this design that scales badly. Three evaluations
 * per run on an hourly three-node workflow is roughly 2,160 rows a month for
 * that workflow alone, so retention and sampling of unmanaged decisions are a
 * requirement rather than a later optimization.
 *
 * `intentDigest` is content-addressed over the effective action, which is how
 * the node check and the signing-time check recognise the same action and
 * avoid charging a budget twice.
 */
export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    checkpoint: text("checkpoint").notNull(),
    capability: text("capability").$type<Capability>().notNull(),
    resource: text("resource"),
    outcome: text("outcome").$type<PolicyOutcome>().notNull(),
    reason: text("reason").$type<PolicyDecisionReason>().notNull(),
    // Empty when unmanaged. Statement ids, so a verdict is explainable without
    // re-running evaluation.
    matchedSids: jsonb("matched_sids").$type<readonly string[]>(),
    governingPolicyIds: jsonb("governing_policy_ids").$type<
      readonly string[]
    >(),
    // Redacted at write time. Never carries raw credentials or full calldata.
    facts: jsonb("facts").$type<Record<string, unknown>>(),
    signals: jsonb("signals").$type<Record<string, unknown>>(),
    observedOnly: boolean("observed_only").notNull().default(false),
    intentDigest: text("intent_digest"),
    // pending until consumed by the signing-time check, then consumed. An
    // expired receipt authorises nothing.
    receiptStatus: text("receipt_status").$type<
      "pending" | "consumed" | "expired"
    >(),
    receiptExpiresAt: timestamp("receipt_expires_at"),
    policyVersion: text("policy_version"),
    principalKind: text("principal_kind"),
    principalId: text("principal_id"),
    executionId: text("execution_id"),
    nodeId: text("node_id"),
    workflowId: text("workflow_id"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_policy_decisions_org_created").on(
      table.organizationId,
      table.createdAt
    ),
    index("idx_policy_decisions_outcome").on(
      table.organizationId,
      table.outcome,
      table.createdAt
    ),
    index("idx_policy_decisions_execution").on(table.executionId),
    // Receipt lookup by the signing-time check.
    index("idx_policy_decisions_digest").on(
      table.organizationId,
      table.intentDigest,
      table.receiptStatus
    ),
  ]
);

export type PolicyDecisionRow = typeof policyDecisions.$inferSelect;

/**
 * Derived selector catalog, one row per contract.
 *
 * Global rather than organization-scoped: what a contract's functions do is a
 * property of the chain, not of who calls them. The row is what the policy
 * builder reads to offer functions, risk classes, and the condition keys that
 * can bind on each selector.
 *
 * `address` is what appears as `to` on the wire, so for an upgradeable protocol
 * it is the proxy. `implementationAddress` records where the ABI came from.
 * Storing both is what keeps a rule about an upgradeable protocol matching:
 * pinning the implementation instead would silently match nothing.
 *
 * `abiHash` detects an implementation change behind a stable proxy, and
 * `catalogVersion` detects a change in the derivation rules. Either one makes
 * the row stale.
 */
export const contractCatalog = pgTable(
  "contract_catalog",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    implementationAddress: text("implementation_address"),
    protocolSlug: text("protocol_slug"),
    /**
     * The ABI JSON exactly as fetched, null when the contract is unverified.
     * Kept so a change to the derivation rules re-derives from storage instead
     * of re-fetching every contract from a rate-limited explorer.
     */
    abi: text("abi"),
    /** sha256 of `abi`, so an implementation swap behind a proxy is detectable. */
    abiHash: text("abi_hash"),
    entries: jsonb("entries")
      .$type<SelectorCatalogEntry[]>()
      .notNull()
      .default([]),
    collisions: jsonb("collisions").$type<string[]>().notNull().default([]),
    source: text("source").$type<CatalogEntrySource>().notNull(),
    catalogVersion: text("catalog_version").notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contract_catalog_chain_address_idx").on(
      table.chainId,
      table.address
    ),
    index("contract_catalog_protocol_idx").on(table.protocolSlug),
  ]
);

export type ContractCatalogRow = typeof contractCatalog.$inferSelect;

/**
 * Cumulative usage against one limit, in one window.
 *
 * The row is the counter, and reserving is a conditional increment: two
 * concurrent actions cannot both read the same headroom and both proceed,
 * because the second update sees the first one's increment. Counting after the
 * fact would let both through and discover the overspend afterwards, which is
 * exactly what a spend limit exists to prevent.
 */
export const policyLimitUsage = pgTable(
  "policy_limit_usage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    policyId: text("policy_id").notNull(),
    sid: text("sid").notNull(),
    metric: text("metric").notNull(),
    window: text("window").notNull(),
    /** Start of the window this row counts, so an old window is never reused. */
    windowStart: timestamp("window_start").notNull(),
    /** What the limit is counted per: the organization, a workflow, an asset. */
    scopeKey: text("scope_key").notNull(),
    /** Decimal string, so a token amount survives without float rounding. */
    used: numeric("used").notNull().default("0"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("policy_limit_usage_window_idx").on(
      table.policyId,
      table.sid,
      table.metric,
      table.window,
      table.windowStart,
      table.scopeKey
    ),
    index("policy_limit_usage_org_idx").on(table.organizationId),
  ]
);

/**
 * One reservation held against a window.
 *
 * Settled when the action succeeds and released when it fails, so a failed
 * transaction does not permanently consume budget. A signed authorization
 * someone else can redeem later is settled immediately and never released,
 * because its redemption is not observable to us.
 */
export const policyLimitReservations = pgTable(
  "policy_limit_reservations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    usageId: text("usage_id")
      .notNull()
      .references(() => policyLimitUsage.id, { onDelete: "cascade" }),
    amount: numeric("amount").notNull(),
    status: text("status")
      .$type<"reserved" | "settled" | "released">()
      .notNull()
      .default("reserved"),
    /** A reservation nothing settles or releases is swept back after this. */
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("policy_limit_reservations_usage_idx").on(table.usageId),
    index("policy_limit_reservations_status_idx").on(
      table.status,
      table.expiresAt
    ),
  ]
);

export type PolicyLimitUsageRow = typeof policyLimitUsage.$inferSelect;
export type PolicyLimitReservationRow =
  typeof policyLimitReservations.$inferSelect;
