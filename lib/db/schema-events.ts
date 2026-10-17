import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Transactional outbox for execution events.
 *
 * A row is written in the same transaction as the status change it describes,
 * so an event exists exactly when the change committed: a rolled-back write
 * leaves no event, and a committed one cannot lose its event to a crash
 * between the commit and a queue publish. A relay later reads undispatched
 * rows and hands them to delivery, stamping `dispatched_at`.
 *
 * `dedupe_key` is unique, and writers insert with ON CONFLICT DO NOTHING, so
 * each execution produces at most one final event however many times its
 * terminal write is retried. `data` is a snapshot taken at commit time, so
 * delivery never has to re-read a row that may since have been deleted.
 */
export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Catalog name, e.g. `direct_execution.succeeded`.
    eventType: text("event_type").notNull(),
    // A direct or workflow execution id, depending on the event type. Not a
    // foreign key: the two kinds live in different tables.
    executionId: text("execution_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Set by the relay once the event is handed to delivery. Null means the
    // event still has to be dispatched.
    dispatchedAt: timestamp("dispatched_at"),
  },
  (table) => [
    uniqueIndex("uq_event_outbox_dedupe_key").on(table.dedupeKey),
    // The relay's scan: oldest undispatched events first. Partial, so the
    // index stays the size of the backlog rather than of the table.
    index("idx_event_outbox_undispatched")
      .on(table.createdAt)
      .where(sql`${table.dispatchedAt} IS NULL`),
  ]
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type NewEventOutboxRow = typeof eventOutbox.$inferInsert;
