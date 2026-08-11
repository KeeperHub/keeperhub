import { NextResponse } from "next/server";
import { getStepLogs } from "@/lib/analytics/queries";
import { apiError } from "@/lib/api-error";
import { getOrgContext } from "@/lib/middleware/org-context";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: executionId } = await context.params;
  const orgContext = await getOrgContext();
  const organizationId = orgContext.organization?.id;

  if (!organizationId) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 403 }
    );
  }

  try {
    const steps = await getStepLogs(executionId, organizationId);
    return NextResponse.json(steps);
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch step logs");
  }
}
