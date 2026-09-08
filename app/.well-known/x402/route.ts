import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const rows = await db
    .select({
      listedSlug: workflows.listedSlug,
      priceUsdcPerCall: workflows.priceUsdcPerCall,
      workflowType: workflows.workflowType,
    })
    .from(workflows)
    .where(and(eq(workflows.isListed, true), workflowNotDeleted()));

  const resources: string[] = [];
  for (const row of rows) {
    // Both read and write listings can be paid -- a priced write listing
    // charges for the calldata it returns, so it belongs in the resource
    // index alongside read listings.
    if (row.listedSlug && Number(row.priceUsdcPerCall ?? "0") > 0) {
      resources.push(`POST /api/mcp/workflows/${row.listedSlug}/call`);
    }
  }

  return Response.json(
    { version: 1, resources },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    }
  );
}
