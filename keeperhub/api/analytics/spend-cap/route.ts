import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSpendCapData } from "@/keeperhub/lib/analytics/queries";
import { apiError } from "@/keeperhub/lib/api-error";
import { requireOrganization } from "@/keeperhub/lib/middleware/require-org";

export const GET = requireOrganization(
  async (_req: NextRequest, context): Promise<Response> => {
    const organizationId = context.organization?.id;
    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 403 }
      );
    }

    try {
      const data = await getSpendCapData(organizationId);
      return NextResponse.json(data);
    } catch (error: unknown) {
      return apiError(error, "Failed to fetch spend cap data");
    }
  }
);
