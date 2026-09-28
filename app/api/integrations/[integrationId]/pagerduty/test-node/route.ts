import { NextResponse } from "next/server";
import { getIntegration as getIntegrationFromDb } from "@/lib/db/integrations";
import { isIntegrationCreatorDeactivated } from "@/lib/integrations/authorization";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { generateId } from "@/lib/utils/id";
import {
  buildTriggerEvent,
  buildUpdateEvent,
  findIncidentByKey,
  isPagerDutyId,
  postEvent,
  resolveRoutingKey,
  serviceSwallowsEvents,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { getCredentialMapping, getIntegration } from "@/plugins/registry";

/**
 * Send a real alert through a PagerDuty service and take it back again, so
 * somebody configuring a node can see it work before an incident depends on it.
 *
 * It is a round trip on purpose: trigger, acknowledge, resolve, in that order
 * and against one dedup key of its own. Each leg is the same call the node
 * makes, so this exercises the routing key, the service's Events API v2
 * integration and the account's permissions rather than approximating them -
 * and it ends with nothing open, because a test that leaves an alert behind is
 * one somebody has to go and tidy up in PagerDuty.
 *
 * It does put a real alert on a real service for a few seconds. The dedup key
 * is this route's own, never a node's, so a test can neither merge into an
 * alert a workflow opened nor resolve one; and the summary says what it is, in
 * case the service notifies before the resolve lands.
 */

type Leg = {
  step: "trigger" | "acknowledge" | "resolve";
  ok: boolean;
  error?: string;
};

/**
 * What, if anything, qualifies "the test passed".
 *
 * A service in maintenance takes every event and pages nobody; and each event
 * is answered 202 whether or not PagerDuty acted on it, so the only evidence
 * the alert actually closed is reading it back.
 */
function describeWarning(state: {
  serviceStatus?: string;
  suppressed: boolean;
  stillOpen: boolean;
  incidentStatus?: string;
}): string | undefined {
  if (state.suppressed) {
    return `PagerDuty accepted every event, but this service is ${state.serviceStatus} and raises no incident from them - so this test proves the routing works and proves nothing about anybody being paged.`;
  }
  if (state.stillOpen) {
    const described =
      state.incidentStatus === "unknown"
        ? "in a state this node does not recognise"
        : `still ${state.incidentStatus}`;
    return `PagerDuty accepted every event, but the test alert is ${described} a moment later rather than resolved. The Events API applies events in its own time, so this usually settles on its own - open it below and close it by hand if it does not.`;
  }
  return;
}

export type PagerDutyTestNodeResponse = {
  ok: boolean;
  legs: Leg[];
  /** The alert this test opened and closed, when PagerDuty would say. */
  incidentUrl?: string;
  /**
   * What PagerDuty says that alert is now, when the credential can read it.
   * The three 202s above prove only that the events were accepted.
   */
  incidentStatus?: string;
  /** Set when the service takes events and raises no incident from them. */
  warning?: string;
  dedupKey: string;
};

type TestNodeBody = { serviceId?: string; summary?: string };

const SUMMARY_PREFIX = "KeeperHub test alert";

export async function POST(
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

  // A write scope, not a read one: this genuinely pages a service.
  const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
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

  let body: TestNodeBody = {};
  try {
    body = (await request.json()) as TestNodeBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body" },
      { status: 400 }
    );
  }

  const serviceId = body.serviceId?.trim() ?? "";
  if (!isPagerDutyId(serviceId)) {
    return NextResponse.json(
      { error: "Select a PagerDuty service on the node first." },
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

  const routingKey = await resolveRoutingKey(credentials, serviceId);
  if (!routingKey.ok) {
    return NextResponse.json(
      { error: routingKey.failure.message },
      { status: 502 }
    );
  }

  // This route's own key, never a node's, so a test can neither merge into an
  // alert a workflow opened nor close one.
  const dedupKey = `keeperhub/test/${generateId()}`;
  const summary = body.summary?.trim()
    ? `${SUMMARY_PREFIX}: ${body.summary.trim()}`
    : `${SUMMARY_PREFIX} - configuring a workflow, no action needed`;

  const legs: Leg[] = [];
  const { body: triggerBody } = buildTriggerEvent({
    routingKey: routingKey.value.routingKey,
    dedupKey,
    timestamp: new Date().toISOString(),
    input: {
      summary,
      // The lowest severity there is. A test should not page at high urgency
      // on a service whose rule keys off severity.
      severity: "info",
      source: "KeeperHub connection test",
      customDetails: {
        keeperhub_test: true,
        note: "Sent by KeeperHub from the node configuration screen, and resolved immediately afterwards.",
      },
      client: "KeeperHub",
    },
  });

  const triggered = await postEvent(credentials, triggerBody);
  legs.push({
    step: "trigger",
    ok: triggered.ok,
    error: triggered.ok ? undefined : triggered.failure.message,
  });

  if (triggered.ok) {
    for (const action of ["acknowledge", "resolve"] as const) {
      const result = await postEvent(
        credentials,
        buildUpdateEvent({
          routingKey: routingKey.value.routingKey,
          dedupKey,
          action,
        })
      );
      legs.push({
        step: action,
        ok: result.ok,
        error: result.ok ? undefined : result.failure.message,
      });
    }
  }

  // Best effort, and never the reason the test fails: it needs incidents.read,
  // which a scoped OAuth app only has if it was granted.
  //
  // It is also the only thing here that can say the alert actually closed.
  // Every event above is answered 202 whether or not PagerDuty did anything
  // with it, which is the whole reason Resolve offers a send delay - and the
  // Events API is asynchronous, so a resolve processed before its own trigger
  // is dropped and leaves a real alert open on a real service. Reporting
  // "nothing left open" off three 202s would be the one claim this code makes
  // that it has not checked.
  let incidentUrl: string | undefined;
  let incidentStatus: string | undefined;
  let incidentFound = false;
  if (triggered.ok) {
    const lookup = await findIncidentByKey(credentials, {
      serviceId,
      incidentKey: dedupKey,
    });
    if (lookup.ok) {
      incidentUrl = lookup.value.htmlUrl;
      incidentStatus = lookup.value.status;
      // The status is reported as "unknown" both when the search found
      // nothing and when it found an alert whose state is not one of the
      // three this plugin models. Only the id separates them, and the
      // difference matters: the first is PagerDuty not having indexed the
      // alert yet, the second is a real alert sitting open on a real service.
      incidentFound = Boolean(lookup.value.id);
    }
  }

  const suppressed = serviceSwallowsEvents(routingKey.value.serviceStatus);
  // A search that found nothing says nothing: the read-back happens
  // milliseconds after the resolve and the Events API indexes in its own
  // time, so an empty result is the ordinary case. An alert that was found
  // and is not resolved is the opposite - including one whose state this
  // plugin does not model, which is still an alert nobody closed.
  const stillOpen = incidentFound && incidentStatus !== "resolved";
  const response: PagerDutyTestNodeResponse = {
    ok: legs.every((leg) => leg.ok),
    legs,
    incidentUrl,
    incidentStatus,
    dedupKey,
    warning: describeWarning({
      serviceStatus: routingKey.value.serviceStatus,
      suppressed,
      stillOpen,
      incidentStatus,
    }),
  };
  return NextResponse.json(response);
}
