import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getActiveOrgId } from "@/lib/middleware/org-context";

type OrgOwnerResult =
  | { orgId: string; userId: string; email: string }
  | { error: NextResponse };

export async function requireOrgOwner(): Promise<OrgOwnerResult> {
  const hdrs = await headers();

  const session = await auth.api.getSession({ headers: hdrs });
  if (!session?.user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const activeOrgId = getActiveOrgId(session);
  if (!activeOrgId) {
    return {
      error: NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      ),
    };
  }

  const activeMember = await auth.api.getActiveMember({ headers: hdrs });
  if (activeMember?.role !== "owner") {
    return {
      error: NextResponse.json(
        { error: "Only organization owners can manage billing" },
        { status: 403 }
      ),
    };
  }

  return {
    orgId: activeOrgId,
    userId: session.user.id,
    email: session.user.email,
  };
}
