import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { generateId } from "@/lib/utils/id";

/**
 * The artifact a payment bought. Populated only for `kind: "calldata"` sales,
 * where the caller pays for unsigned transaction data rather than an
 * execution. Storing it is what makes an idempotent replay honest: the payment
 * hash covers the credential alone, not the request body, so a replay must be
 * answered with the bytes originally sold rather than regenerated from a body
 * that could since have changed.
 */
export type PaymentDeliverable = {
  type: "calldata";
  to: string;
  data: string;
  value: string;
};

/**
 * Workflow Payments table
 *
 * Records payment events for x402 pay-per-call workflow invocations.
 * The paymentHash column enforces idempotency at the DB level -- a duplicate
 * PAYMENT-SIGNATURE header is rejected before a second execution is created.
 *
 * NOTE: No FK to workflows -- the payment record must survive workflow deletion
 * for audit and billing reconciliation purposes.
 */
export const workflowPayments = pgTable(
  "workflow_payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id").notNull(),
    paymentHash: text("payment_hash").notNull(),
    // NULL for calldata-only sales: a paid write workflow returns unsigned
    // calldata and runs no executor, so there is no workflow_executions row
    // to point at.
    executionId: text("execution_id"),
    kind: varchar("kind", { length: 16 }).notNull().default("execution"),
    deliverable: jsonb("deliverable").$type<PaymentDeliverable | null>(),
    amountUsdc: numeric("amount_usdc").notNull(),
    payerAddress: text("payer_address"),
    creatorWalletAddress: text("creator_wallet_address").notNull(),
    settledAt: timestamp("settled_at").notNull().defaultNow(),
    protocol: varchar("protocol", { length: 10 }).notNull().default("x402"),
    chain: text("chain").notNull().default("base"),
  },
  (table) => [
    uniqueIndex("idx_workflow_payments_hash").on(table.paymentHash),
    index("idx_workflow_payments_workflow").on(table.workflowId),
  ]
);

export type WorkflowPayment = typeof workflowPayments.$inferSelect;
export type NewWorkflowPayment = typeof workflowPayments.$inferInsert;
