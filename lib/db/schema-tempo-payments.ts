import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization, users } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Held payment status pgEnum.
 *
 * Lifecycle of a Tempo held payment: signed now, broadcast later. Distinct DB
 * type name ("tempo_held_payment_status") to avoid collision with the other
 * status enums. Terminal states are `confirmed`, `failed`, `expired`,
 * `canceled`; `broadcasting` is the transient claim held by a single broadcaster.
 */
export const tempoHeldPaymentStatus = pgEnum("tempo_held_payment_status", [
  "pending",
  "broadcasting",
  "broadcast",
  "confirmed",
  "failed",
  "expired",
  "canceled",
]);

/**
 * Tempo Held Payments table.
 *
 * A payment signed now as a native Tempo scheduled transaction (its
 * `valid_before` is the on-chain safety expiry) whose broadcast KeeperHub owns.
 * `serialized_tx` is the self-contained 0x76 blob; broadcasting it needs no
 * further signing. A null `broadcast_at` is a manual hold (released from a
 * workflow action or the UI); a set `broadcast_at` is the target time a
 * scheduled poller fires it.
 *
 * The bound fields (`from_address`, `to_address`, `token_address`, `amount_raw`)
 * are fixed at sign time and never re-derived; they mirror what the signed blob
 * commits to and exist only for display and audit.
 */
export const tempoHeldPayments = pgTable(
  "tempo_held_payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // SET NULL preserves the audit trail if the creator's user is deleted,
    // matching the rationale on wallet_approval_requests.resolved_by_user_id.
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    workflowId: text("workflow_id"),
    executionId: text("execution_id"),
    chainId: integer("chain_id").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    tokenAddress: text("token_address").notNull(),
    amountRaw: text("amount_raw").notNull(),
    tokenSymbol: text("token_symbol"),
    tokenDecimals: integer("token_decimals"),
    amountDisplay: text("amount_display"),
    memo: text("memo"),
    serializedTx: text("serialized_tx").notNull(),
    precomputedHash: text("precomputed_hash").notNull(),
    nonceKey: text("nonce_key").notNull(),
    maxFeePerGas: text("max_fee_per_gas"),
    // Native Tempo scheduled-transaction window (unix seconds). `valid_before`
    // is the on-chain safety expiry: the tx can never settle after it, even if
    // our broadcaster misfires. bigint so it never hits the int4 2038 ceiling.
    validAfter: bigint("valid_after", { mode: "number" }),
    validBefore: bigint("valid_before", { mode: "number" }).notNull(),
    // Null = manual release. Set = scheduled target for the due poller.
    broadcastAt: timestamp("broadcast_at"),
    status: tempoHeldPaymentStatus("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    broadcastTxHash: text("broadcast_tx_hash"),
    dispatchKey: text("dispatch_key"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_tempo_held_payments_org").on(table.organizationId),
    // Serves the org-scoped list ordered by created_at (the paginated UI query).
    index("idx_tempo_held_payments_org_created").on(
      table.organizationId,
      table.createdAt
    ),
    index("idx_tempo_held_payments_status").on(table.status),
    // Due poller: pending rows whose broadcast_at has arrived.
    index("idx_tempo_held_payments_due").on(table.status, table.broadcastAt),
    // Expiry sweep: pending rows whose valid_before has lapsed.
    index("idx_tempo_held_payments_expiry").on(table.status, table.validBefore),
    // One row per signed blob: re-inserting the same signed tx is blocked.
    uniqueIndex("uq_tempo_held_payments_hash").on(table.precomputedHash),
    // Belt-and-suspenders idempotency for the scheduled poller.
    uniqueIndex("uq_tempo_held_payments_dispatch_key").on(table.dispatchKey),
  ]
);

export type TempoHeldPayment = typeof tempoHeldPayments.$inferSelect;
export type NewTempoHeldPayment = typeof tempoHeldPayments.$inferInsert;
