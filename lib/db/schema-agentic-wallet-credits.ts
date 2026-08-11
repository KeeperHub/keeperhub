import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agenticWallets } from "@/lib/db/schema-agentic-wallets";
import { generateId } from "@/lib/utils/id";

/**
 * Agentic Wallet Credits table
 *
 * ONBOARD-03: $0.50 off-chain KeeperHub credit granted at provision time.
 * Phase 34 fund/balance tooling reads this ledger. Phase 33 only writes.
 *
 * UNIQUE `(sub_org_id, allocation_reason)` mitigates T-33-07 (double-grant
 * race) -- a concurrent /provision retry for the same sub-org cannot grant
 * two onboard credits. `allocationReason` defaults to `"onboard_initial"`
 * so Phase 34 may add other reasons (e.g. `"referral_bonus"`) without a
 * schema change.
 *
 * FK cascades on sub-org deletion; orphan credits are meaningless.
 */
export const agenticWalletCredits = pgTable(
  "agentic_wallet_credits",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    subOrgId: text("sub_org_id")
      .notNull()
      .references(() => agenticWallets.subOrgId, { onDelete: "cascade" }),
    amountUsdcCents: integer("amount_usdc_cents").notNull(),
    allocationReason: text("allocation_reason")
      .notNull()
      .default("onboard_initial"),
    grantedAt: timestamp("granted_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_agentic_wallet_credits_sub_org").on(table.subOrgId),
    uniqueIndex("uq_agentic_wallet_credits_sub_org_reason").on(
      table.subOrgId,
      table.allocationReason
    ),
  ]
);

export type AgenticWalletCredit = typeof agenticWalletCredits.$inferSelect;
export type NewAgenticWalletCredit = typeof agenticWalletCredits.$inferInsert;
