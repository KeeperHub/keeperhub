import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  type OAuthScope,
  SCOPE_MCP_READ,
  SCOPE_MCP_WRITE,
} from "@/lib/mcp/oauth-scopes";
import {
  ORG_ANY_MEMBER,
  ORG_MANAGERS,
  type OrgRoleAccess,
  requireOrgRole,
} from "@/lib/middleware/require-org-role";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import type { OrgRpcFailure } from "./service";
import { RpcConfigUrlSlot } from "./url-slots";

export const RpcAuditAction = {
  CONFIG_CREATED: "org.rpc_config_created",
  CONFIG_UPDATED: "org.rpc_config_updated",
  CONFIG_DELETED: "org.rpc_config_deleted",
  POLICY_CHANGED: "org.rpc_policy_changed",
} as const;
export type RpcAuditAction =
  (typeof RpcAuditAction)[keyof typeof RpcAuditAction];

const AUDIT_RESOURCE_CONFIG = "organization_rpc_config";
const AUDIT_RESOURCE_POLICY = "organization_rpc_policy";

export const RpcAccess = {
  READ: "read",
  WRITE: "write",
} as const;
export type RpcAccess = (typeof RpcAccess)[keyof typeof RpcAccess];

const NAME_MAX_LENGTH = 64;
const URL_MAX_LENGTH = 2048;

const urlField = z.string().trim().min(1).max(URL_MAX_LENGTH);

export const createRpcConfigBody = z.object({
  chainId: z.number().int().positive(),
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
  urls: z.object({
    [RpcConfigUrlSlot.HTTP_PRIMARY]: urlField,
    [RpcConfigUrlSlot.HTTP_FALLBACK]: urlField.optional(),
    [RpcConfigUrlSlot.WSS_PRIMARY]: urlField.optional(),
    [RpcConfigUrlSlot.WSS_FALLBACK]: urlField.optional(),
    [RpcConfigUrlSlot.PRIVATE_TX]: urlField.optional(),
  }),
});

const urlChange = urlField.nullable().optional();

export const updateRpcConfigBody = z.object({
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
  urls: z
    .object({
      [RpcConfigUrlSlot.HTTP_PRIMARY]: urlField.optional(),
      [RpcConfigUrlSlot.HTTP_FALLBACK]: urlChange,
      [RpcConfigUrlSlot.WSS_PRIMARY]: urlChange,
      [RpcConfigUrlSlot.WSS_FALLBACK]: urlChange,
      [RpcConfigUrlSlot.PRIVATE_TX]: urlChange,
    })
    .optional(),
});

export const rpcPolicyBody = z.object({ ownRpcOnly: z.boolean() });

const ACCESS_RULES: Readonly<
  Record<RpcAccess, { roles: typeof ORG_ANY_MEMBER; scope: OAuthScope }>
> = {
  [RpcAccess.READ]: { roles: ORG_ANY_MEMBER, scope: SCOPE_MCP_READ },
  [RpcAccess.WRITE]: { roles: ORG_MANAGERS, scope: SCOPE_MCP_WRITE },
};

/**
 * Any member may read configs (the node editor lists them); only owners
 * and admins may change them, since they decide where traffic goes.
 */
export async function authorizeRpcRequest(
  request: Request,
  organizationId: string,
  access: RpcAccess
): Promise<OrgRoleAccess | NextResponse> {
  const rule = ACCESS_RULES[access];
  const caller = await requireOrgRole(request, organizationId, rule.roles);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }
  const scopeError = requireScope(caller.scope, rule.scope, {
    credentialType: caller.authMethod,
  });
  return scopeError ?? caller;
}

export function failureResponse(failure: OrgRpcFailure): NextResponse {
  return NextResponse.json(
    {
      error: failure.message,
      code: failure.code,
      verification: failure.verification,
      gaps: failure.gaps,
    },
    { status: failure.status }
  );
}

export function invalidBodyResponse(error: z.ZodError): NextResponse {
  return NextResponse.json(
    { error: "Invalid request", issues: z.treeifyError(error) },
    { status: 400 }
  );
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function serverErrorResponse(
  error: unknown,
  endpoint: string,
  message: string
): NextResponse {
  logSystemError(ErrorCategory.DATABASE, `[RPC Configs] ${message}`, error, {
    endpoint,
  });
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function auditRpcChange(input: {
  request: Request;
  caller: OrgRoleAccess;
  organizationId: string;
  action: RpcAuditAction;
  resourceId: string;
  after?: Record<string, unknown>;
}): Promise<void> {
  await recordAuditEvent({
    actor: {
      userId: input.caller.userId,
      organizationId: input.organizationId,
      authMethod: input.caller.authMethod,
      apiKeyId: input.caller.apiKeyId,
    },
    action: input.action,
    resourceType:
      input.action === RpcAuditAction.POLICY_CHANGED
        ? AUDIT_RESOURCE_POLICY
        : AUDIT_RESOURCE_CONFIG,
    resourceId: input.resourceId,
    after: input.after,
    metadata: buildAuditMetadata(input.request),
  });
}
