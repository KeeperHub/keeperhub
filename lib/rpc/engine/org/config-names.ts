import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationRpcConfigs } from "@/lib/db/schema-rpc";

/** Names of the organization's configs among `configIds`; removed ones are absent. */
export async function rpcConfigNamesOf(
  organizationId: string | null,
  configIds: Iterable<string>
): Promise<Map<string, string>> {
  const ids = [...new Set(configIds)];
  if (organizationId === null || ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: organizationRpcConfigs.id,
      name: organizationRpcConfigs.name,
    })
    .from(organizationRpcConfigs)
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, organizationId),
        inArray(organizationRpcConfigs.id, ids)
      )
    );
  return new Map(rows.map((row) => [row.id, row.name]));
}
