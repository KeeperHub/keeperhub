import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ScanResponse } from "@/lib/scan/types";
import { generateId } from "@/lib/utils/id";

/**
 * Scan results cache table.
 *
 * One row per lowercased EVM address (enforced by a UNIQUE index on `address`,
 * which is also the upsert conflict target). The full multi-chain scan result
 * is stored as a single JSONB blob keyed by address. TTL is enforced via
 * `expires_at`; the Phase 55 cron sweeper deletes rows older than 1 hour.
 * Cache reads filter `WHERE expires_at > NOW()` (5-minute TTL on write).
 */
export const scanResults = pgTable(
  "scan_results",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    /** Lowercased EVM address (no EIP-55 checksum). Unique cache key. */
    address: text("address").notNull(),
    /** Full ScanResponse blob. Checksummed address lives inside result_json. */
    resultJson: jsonb("result_json").notNull().$type<ScanResponse>(),
    /** Set to NOW() on write. Read-only after insert. */
    scannedAt: timestamp("scanned_at").notNull().defaultNow(),
    /** Set to NOW() + 5 minutes on write. Phase 55 sweeper uses > 1 hour. */
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_scan_results_address").on(table.address),
    index("idx_scan_results_expires").on(table.expiresAt),
  ]
);

export type ScanResultRow = typeof scanResults.$inferSelect;
