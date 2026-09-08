import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireOrganization } from "@/lib/middleware/require-org";
import { createProvisionWalletStreamStart } from "@/lib/turnkey/provision-wallet-stream";

// Reject anonymous / unverified placeholder emails - those orgs never get a
// non-custodial wallet (mirrors the guard in POST /api/user/wallet).
function isProvisionableEmail(email: string | undefined): email is string {
  if (!email) {
    return false;
  }
  if (email.startsWith("temp-")) {
    return false;
  }
  return !(email.includes("@http://") || email.includes("@https://"));
}

export const GET = requireOrganization(
  async (req: NextRequest, context): Promise<Response> => {
    try {
      const organizationId = context.organization?.id;
      if (!organizationId) {
        return NextResponse.json(
          { error: "No active organization" },
          { status: 400 }
        );
      }

      const user = context.user;
      if (!(user && isProvisionableEmail(user.email))) {
        return NextResponse.json(
          { error: "A verified email is required to provision a wallet" },
          { status: 400 }
        );
      }

      const start = createProvisionWalletStreamStart({
        signal: req.signal,
        input: { userId: user.id, organizationId, email: user.email },
      });

      const stream = new ReadableStream<Uint8Array>({ start });

      return await Promise.resolve(
        new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        })
      );
    } catch (error: unknown) {
      return apiError(error, "Failed to start wallet provisioning stream");
    }
  }
);
