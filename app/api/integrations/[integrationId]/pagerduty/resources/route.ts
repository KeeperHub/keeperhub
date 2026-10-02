import { NextResponse } from "next/server";
import { getIntegration as getIntegrationFromDb } from "@/lib/db/integrations";
import { isIntegrationCreatorDeactivated } from "@/lib/integrations/authorization";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import {
  isEuHtmlUrl,
  listEscalationPolicies,
  listPriorities,
  listServices,
  type PagerDutyEscalationPolicy,
  type PagerDutyPriority,
  type PagerDutyService,
  subdomainFromHtmlUrl,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { getCredentialMapping, getIntegration } from "@/plugins/registry";

export type PagerDutyResourcesResponse = {
  services?: PagerDutyService[];
  escalationPolicies?: PagerDutyEscalationPolicy[];
  priorities?: PagerDutyPriority[];
  /** Which PagerDuty account these came from, for the "who am I paging" line. */
  accountSubdomain?: string;
  /** Which service region it lives in, so the preview names the right host. */
  euRegion?: boolean;
  /** True when the account has more than this route will page through. */
  truncated?: boolean;
  /**
   * Whether the connection carries a From email, which only Create Incident
   * needs. The address itself is not returned: the node never has to show it,
   * and the answer to "will this node run" is the boolean.
   */
  hasFromEmail?: boolean;
};

/**
 * Lists the services and escalation policies behind one PagerDuty connection,
 * for the pickers in the node config.
 *
 * Two things this deliberately does not do: it never returns an integration
 * key (the picker only needs ids and names, and a routing key is a
 * credential), and it never accepts credentials from the caller - the
 * connection is resolved from the caller's own organisation, so one
 * organisation cannot read another's PagerDuty account through this route.
 *
 * Names are served live rather than cached in the workflow: a service renamed
 * in PagerDuty keeps its id, so the node keeps paging the right rota and the
 * picker simply shows the new name.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> }
): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return NextResponse.json(
      { error: authContext.error },
      { status: authContext.status }
    );
  }

  const scopeError = requireScope(authContext.scope, SCOPE_MCP_READ, {
    credentialType: authContext.authMethod,
  });
  if (scopeError) {
    return scopeError;
  }

  const { integrationId } = await params;
  if (!integrationId) {
    return NextResponse.json(
      { error: "integrationId is required" },
      { status: 400 }
    );
  }

  const integration = await getIntegrationFromDb(
    integrationId,
    authContext.userId ?? "",
    authContext.organizationId
  );
  if (!integration) {
    return NextResponse.json(
      { error: "Connection not found" },
      { status: 404 }
    );
  }
  if (integration.type !== "pagerduty") {
    return NextResponse.json(
      { error: "This connection is not a PagerDuty connection" },
      { status: 400 }
    );
  }

  // A deactivated creator freezes their connections for everyone, and that has
  // to hold here too. The run-time credential fetch enforces it; this route
  // reads the connection directly, so without this an offboarded person's
  // PagerDuty credential would still work from the editor.
  if (await isIntegrationCreatorDeactivated(integration.createdBy)) {
    return NextResponse.json(
      {
        error:
          "The person who created this connection has been deactivated, which freezes the connections they added. Recreate it under an active member.",
      },
      { status: 403 }
    );
  }

  const plugin = getIntegration("pagerduty");
  if (!plugin) {
    return NextResponse.json(
      { error: "PagerDuty plugin is not registered" },
      { status: 500 }
    );
  }
  const credentials = getCredentialMapping(plugin, integration.config);

  const resource = new URL(request.url).searchParams.get("resource");

  // Answered from the stored connection alone: no PagerDuty call, because the
  // question is about what KeeperHub holds, not about the account.
  if (resource === "from-email") {
    return NextResponse.json({
      hasFromEmail: Boolean(credentials.PAGERDUTY_FROM_EMAIL?.trim()),
    });
  }

  if (resource === "priorities") {
    const priorities = await listPriorities(credentials);
    if (!priorities.ok) {
      return upstreamError(priorities.failure.message);
    }
    return NextResponse.json({ priorities: priorities.value });
  }

  if (resource === "escalation-policies") {
    const policies = await listEscalationPolicies(credentials);
    if (!policies.ok) {
      return upstreamError(policies.failure.message);
    }
    return NextResponse.json({
      escalationPolicies: policies.value.escalationPolicies,
      truncated: policies.value.truncated,
      accountSubdomain: firstSubdomain(policies.value.escalationPolicies),
      euRegion: firstRegion(policies.value.escalationPolicies),
    });
  }

  const services = await listServices(credentials);
  if (!services.ok) {
    return upstreamError(services.failure.message);
  }
  return NextResponse.json({
    services: services.value.services,
    truncated: services.value.truncated,
    accountSubdomain: firstSubdomain(services.value.services),
    euRegion: firstRegion(services.value.services),
  });
}

/**
 * PagerDuty's status is deliberately not echoed as this route's own.
 *
 * A 401 from PagerDuty means its token is wrong; a 401 from a KeeperHub route
 * means the session expired, and any client handling that watches for one
 * would sign the user out because a PagerDuty token was stale. The message
 * carries the real cause.
 */
function upstreamError(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 502 });
}

/** The region of the first object PagerDuty gave a URL for. */
function firstRegion(items: { htmlUrl?: string }[]): boolean | undefined {
  for (const item of items) {
    const eu = isEuHtmlUrl(item.htmlUrl);
    if (eu !== undefined) {
      return eu;
    }
  }
  return;
}

function firstSubdomain(items: { htmlUrl?: string }[]): string | undefined {
  for (const item of items) {
    const subdomain = subdomainFromHtmlUrl(item.htmlUrl);
    if (subdomain) {
      return subdomain;
    }
  }
  return;
}
