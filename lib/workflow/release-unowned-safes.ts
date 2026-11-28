import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { safeWallets } from "@/lib/db/schema";
import {
  pinnedSafeIds,
  type StepNeedingSender,
  unsetUnownedSafes,
} from "@/lib/workflow/copy-safe-connections";

/** Steps copied into `organizationId` on a Safe it does not own get no sender. */
export async function releaseUnownedSafes(
  nodes: Record<string, unknown>[],
  organizationId: string
): Promise<{
  nodes: Record<string, unknown>[];
  needingSender: StepNeedingSender[];
}> {
  const ids = pinnedSafeIds(nodes);
  const owned =
    ids.length === 0
      ? []
      : await db
          .select({ id: safeWallets.id })
          .from(safeWallets)
          .where(
            and(
              inArray(safeWallets.id, ids),
              eq(safeWallets.organizationId, organizationId)
            )
          )
          .limit(ids.length);
  return unsetUnownedSafes(nodes, new Set(owned.map((safe) => safe.id)));
}
