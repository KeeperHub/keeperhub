import { authenticateApiKey } from "@/keeperhub/lib/api-key-auth";
import { getOrgContext } from "@/keeperhub/lib/middleware/org-context";
import { auth } from "@/lib/auth";

/**
 * Resolves the organization ID from either an API key or session.
 * Used by PATCH/DELETE routes that only need org-level authorization.
 */
export async function resolveOrganizationId(
  request: Request
): Promise<{ organizationId: string } | { error: string; status: number }> {
  const apiKeyAuth = await authenticateApiKey(request);

  if (apiKeyAuth.authenticated) {
    const organizationId = apiKeyAuth.organizationId;
    if (!organizationId) {
      return { error: "No active organization", status: 400 };
    }
    return { organizationId };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const orgContext = await getOrgContext();
  const organizationId = orgContext.organization?.id;
  if (!organizationId) {
    return { error: "No active organization", status: 400 };
  }
  return { organizationId };
}

/**
 * Resolves both organization ID and user ID from either an API key or session.
 * Used by POST routes that need to track the creator.
 */
export async function resolveCreatorContext(
  request: Request
): Promise<
  { organizationId: string; userId: string } | { error: string; status: number }
> {
  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    const organizationId = apiKeyAuth.organizationId || null;
    const userId = apiKeyAuth.userId || null;
    if (!organizationId) {
      return { error: "No active organization", status: 400 };
    }
    if (!userId) {
      return {
        error: "API key has no associated user. Please recreate the API key.",
        status: 400,
      };
    }
    return { organizationId, userId };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const context = await getOrgContext();
  const organizationId = context.organization?.id || null;
  if (!organizationId) {
    return { error: "No active organization", status: 400 };
  }
  return { organizationId, userId: session.user.id };
}
