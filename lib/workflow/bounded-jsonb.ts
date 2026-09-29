import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  MAX_STORED_OUTPUT_BYTES,
  TRUNCATED_PREVIEW_CHARS,
} from "@/lib/workflow/output-limits";

/**
 * Select a JSONB column with a size guard applied by the database.
 *
 * A value larger than `maxBytes` comes back as the truncated marker instead of
 * the value, so the row never crosses the wire and is never parsed or
 * re-serialised by the app. Use it through `extras` (with the real column
 * excluded from `columns`) or in a `select` list:
 *
 *   extras: { output: boundedJsonb(workflowExecutions.output).as("output") }
 *
 * Postgres evaluates `octet_length(col::text)` on the detoasted value, so the
 * database still reads the large row; it is the app process that is spared.
 */
export function boundedJsonb(
  column: PgColumn,
  maxBytes: number = MAX_STORED_OUTPUT_BYTES
): SQL<unknown> {
  return sql`CASE WHEN octet_length(${column}::text) > ${maxBytes} THEN jsonb_build_object('_truncated', true, 'originalSize', octet_length(${column}::text), 'preview', left(${column}::text, ${TRUNCATED_PREVIEW_CHARS})) ELSE ${column} END`;
}
