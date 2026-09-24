import "server-only";

import { ErrorCategory, logSystemError } from "@/lib/logging";
import { type ArnSegment, PolicyRole } from "@/lib/policy";
import { decideControlPlane } from "@/lib/policy/control-plane";
import {
  isMutation,
  matchControlPlaneRoute,
} from "@/lib/policy/control-plane-routes";
import { getOrgRole } from "@/lib/security/org-role";

/**
 * The organization policy check, run from the shared auth resolvers.
 *
 * Policy used to be a call each route made for itself, which meant it applied
 * to whichever routes someone remembered. Putting it here instead means a route
 * is governed because of where it gets its principal, not because its author
 * added a line, and the checks arrive in the order the model requires: the role
 * floor first, then policy, so policy can only ever subtract.
 *
 * A mutating request whose route the manifest does not classify is refused.
 * That case should be unreachable, because the coverage test fails the build on
 * an unclassified route, and refusing rather than trusting is what keeps it
 * unreachable instead of merely unlikely.
 */

export type PolicyRefusal = {
  error: string;
  code: "policy_denied";
  status: 403;
};

export type PolicyGateContext = {
  organizationId: string;
  userId: string;
  authMethod?: "oauth" | "api-key" | "session";
  apiKeyId?: string | null;
};

/**
 * The project a creation targets, read from the request body.
 *
 * A thing being created has no id yet, so "where" is the only scope a rule can
 * narrow it by. The body is cloned because the route still has to read it.
 * Anything unparseable leaves the fact absent, which an `allow` cannot be
 * satisfied by, so a rule scoped to a project refuses rather than guesses.
 */
async function readBody(
  request: Request
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.clone().json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    // No body, or not JSON. Absent is the right answer either way.
    return null;
  }
}

function stringField(
  body: Record<string, unknown> | null,
  field: string
): string | undefined {
  const value = body?.[field];
  return typeof value === "string" ? value : undefined;
}

/** Stands in for the id a not-yet-created object does not have. */
const NEW_OBJECT = "new";

function refuse(error: string): PolicyRefusal {
  return { error, code: "policy_denied", status: 403 };
}

export async function policyRefusalFor(
  request: Request,
  context: PolicyGateContext
): Promise<PolicyRefusal | null> {
  const { pathname } = new URL(request.url);
  const match = matchControlPlaneRoute(request.method, pathname);

  if (match === null) {
    // Only a mutation under /api can be missing a classification. The matcher
    // ignores every other method, and the manifest only claims to cover /api,
    // so a path outside it is not a gap in the manifest.
    if (!(isMutation(request.method) && pathname.startsWith("/api/"))) {
      return null;
    }
    logSystemError(
      ErrorCategory.CONFIGURATION,
      `[PolicyGate] No route classification for ${request.method} ${pathname}`,
      undefined,
      { method: request.method }
    );
    return refuse("This action has no policy classification, so it is refused");
  }

  if (match.governance.kind !== "governed") {
    return null;
  }

  const { capability, resource, creates } = match.governance;
  const role =
    ((await getOrgRole(
      context.userId,
      context.organizationId
    )) as PolicyRole | null) ?? PolicyRole.MEMBER;

  const body = await readBody(request);
  const id = resource
    ? ((resource.param ? match.params[resource.param] : undefined) ??
      stringField(body, resource.bodyField ?? ""))
    : undefined;
  // A creation names the type it will produce; `new` is what a statement
  // scoped to `kh:<type>/*` matches before the object has an id.
  let target: { type: ArnSegment; id: string } | undefined;
  if (resource && id) {
    target = { type: resource.type, id };
  } else if (creates) {
    target = { type: creates, id: NEW_OBJECT };
  }

  const verdict = await decideControlPlane({
    projectId: stringField(body, "projectId"),
    organizationId: context.organizationId,
    userId: context.userId,
    role,
    capability,
    resource: target,
    authMethod: context.authMethod,
    apiKeyId: context.apiKeyId ?? undefined,
  });

  return verdict.blocked
    ? refuse(verdict.message ?? "Blocked by an organization policy")
    : null;
}
