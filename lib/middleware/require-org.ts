import { type NextRequest, NextResponse } from "next/server";
import { getOrgContext, hasPermission, type OrgContext } from "./org-context";

export function requireOrganization(
  handler: (req: NextRequest, context: OrgContext) => Promise<Response>
) {
  return async (req: NextRequest) => {
    const context = await getOrgContext();

    if (context.isAnonymous) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    if (context.needsOrganization) {
      return NextResponse.json(
        { error: "You must create or join an organization" },
        { status: 403 }
      );
    }

    return handler(req, context);
  };
}

// Permission-based wrapper
export function requirePermission(
  resource: string,
  actions: string[],
  handler: (req: NextRequest, context: OrgContext) => Promise<Response>
) {
  return requireOrganization(async (req, context) => {
    const canPerform = await hasPermission(resource, actions);

    if (!canPerform) {
      return NextResponse.json(
        { error: `Missing permission: ${resource}:${actions.join(",")}` },
        { status: 403 }
      );
    }

    return handler(req, context);
  });
}

// Convenience wrappers for common permissions
export function requireWorkflowAccess(
  handler: (req: NextRequest, context: OrgContext) => Promise<Response>
) {
  return requirePermission("workflow", ["read"], handler);
}

export function requireWorkflowWrite(
  handler: (req: NextRequest, context: OrgContext) => Promise<Response>
) {
  return requirePermission("workflow", ["create", "update"], handler);
}

export function requireCredentialAccess(
  handler: (req: NextRequest, context: OrgContext) => Promise<Response>
) {
  return requirePermission("credential", ["read"], handler);
}

export function requireCredentialWrite(
  handler: (req: NextRequest, context: OrgContext) => Promise<Response>
) {
  return requirePermission("credential", ["create", "update"], handler);
}

export function requireWalletManage(
  handler: (req: NextRequest, context: OrgContext) => Promise<Response>
) {
  return requirePermission("wallet", ["create", "update", "delete"], handler);
}
