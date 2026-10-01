import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  openPolicyWriteWindow,
  POLICY_WRITE_COOKIE,
  POLICY_WRITE_WINDOW_MINUTES,
} from "@/lib/mfa/policy-write-window";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { isTrustedOrigin, normaliseOrigin } from "@/lib/trusted-origins";

/**
 * Answer the challenge that opens a policy editing window.
 *
 * The write routes do not run the challenge themselves. Editing a policy is a
 * handful of writes, and a challenge on each would mean an email per statement,
 * so the cost of the guardrail would fall hardest on the organizations that use
 * it most. The challenge is answered here once and the window carries the rest
 * of the sitting.
 *
 * Opening a window is itself worth recording: it is the moment someone proved
 * who they were in order to change the rules, and the writes that follow are
 * only as trustworthy as this.
 */

type StepUpBody = {
  code?: string;
  emailOtp?: string;
  signature?: string;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;

  // This route mints the credential the write routes trust, so it checks the
  // caller's origin itself rather than inheriting the check getDualAuthContext
  // performs for the routes that consume it.
  const origin = normaliseOrigin(
    request.headers.get("origin") ?? request.headers.get("referer")
  );
  if (!(origin && isTrustedOrigin(origin))) {
    return NextResponse.json(
      {
        error: "untrusted_origin",
        detail: "This request did not come from the application",
      },
      { status: 403 }
    );
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as StepUpBody;

  // The owner floor is checked here as well as on the write itself. A window
  // handed to somebody who cannot write anything is a challenge they were asked
  // to answer for nothing.
  const authorized = await authorizeAction({
    session,
    action: STEP_UP_ACTIONS.policyWrite,
    roleFloor: "owner",
    organizationId,
    body,
    headers: request.headers,
  });
  if (!authorized.ok) {
    return authorized.response;
  }

  const { token, expiresAt } = await openPolicyWriteWindow({
    userId: session.user.id,
    organizationId,
  });

  await recordAuditEvent({
    actor: { userId: session.user.id, organizationId, authMethod: "session" },
    action: "org.policy_step_up",
    resourceType: "organization_policy",
    after: { windowMinutes: POLICY_WRITE_WINDOW_MINUTES },
    metadata: buildAuditMetadata(request),
  });

  const response = NextResponse.json({
    ok: true,
    expiresAt: expiresAt.toISOString(),
    windowMinutes: POLICY_WRITE_WINDOW_MINUTES,
  });

  // The token never reaches scripts on the page: a policy window is not
  // something a cross-site request should be able to spend, and nothing in the
  // browser needs to read it.
  response.cookies.set({
    name: POLICY_WRITE_COOKIE,
    value: token,
    // Path and the absent Domain are what __Host- requires; Secure travels
    // with it. Strict same-site means a navigation from anywhere else does not
    // carry the window, so it can only be spent by the app itself.
    path: "/",
    sameSite: "strict",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: POLICY_WRITE_WINDOW_MINUTES * 60,
  });

  return response;
}
