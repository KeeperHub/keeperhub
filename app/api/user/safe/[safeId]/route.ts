import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { safeWallets } from "@/lib/db/schema";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";

type PatchBody = {
  isSigningActive?: boolean;
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ safeId: string }> }
): Promise<NextResponse> {
  try {
    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const { safeId } = await params;
    const safe = await getSafeForOrg({
      safeId,
      organizationId: admin.organizationId,
    });
    if (!safe) {
      return NextResponse.json(
        { error: "Safe not found for this organization" },
        { status: 404 }
      );
    }

    const body = (await request.json()) as PatchBody;
    if (typeof body.isSigningActive !== "boolean") {
      return NextResponse.json(
        { error: "isSigningActive (boolean) is required" },
        { status: 400 }
      );
    }

    // Never route workflows through a Safe that isn't fully deployed.
    if (body.isSigningActive && safe.status !== "deployed") {
      return NextResponse.json(
        {
          error: `Safe is not yet deployed (status: ${safe.status}); cannot activate signing`,
        },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(safeWallets)
      .set({
        isSigningActive: body.isSigningActive,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(safeWallets.id, safe.id),
          eq(safeWallets.organizationId, admin.organizationId)
        )
      )
      .returning();

    return NextResponse.json({
      success: true,
      safe: {
        id: updated.id,
        chainId: updated.chainId,
        safeAddress: updated.safeAddress,
        status: updated.status,
        isSigningActive: updated.isSigningActive,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to update Safe");
  }
}
