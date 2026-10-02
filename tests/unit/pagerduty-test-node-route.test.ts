import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const { mockGetIntegrationFromDb } = vi.hoisted(() => ({
  mockGetIntegrationFromDb: vi.fn(),
}));
vi.mock("@/lib/db/integrations", () => ({
  getIntegration: (...args: unknown[]) => mockGetIntegrationFromDb(...args),
}));

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockAuth(...args),
}));

const { mockRequireScope } = vi.hoisted(() => ({
  mockRequireScope: vi.fn(),
}));
vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: (...args: unknown[]) => mockRequireScope(...args),
}));

const { mockCreatorDeactivated } = vi.hoisted(() => ({
  mockCreatorDeactivated: vi.fn(),
}));
vi.mock("@/lib/integrations/authorization", () => ({
  isIntegrationCreatorDeactivated: (...args: unknown[]) =>
    mockCreatorDeactivated(...args),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "external_service" },
  logUserError: vi.fn(),
}));

import { POST } from "@/app/api/integrations/[integrationId]/pagerduty/test-node/route";
import { clearRoutingKeyCache } from "@/plugins/pagerduty/steps/pagerduty-core";

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

function request(body: unknown) {
  return new Request("https://app.keeperhub.com/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ integrationId: "int-1" });

/** Service read, integration read, then each event this route sends. */
function pagerDutyAccepts(serviceStatus = "active") {
  safeFetch
    .mockResolvedValueOnce(
      response(200, {
        service: {
          status: serviceStatus,
          integrations: [
            { id: "PI1", type: "events_api_v2_inbound_integration" },
          ],
        },
      })
    )
    .mockResolvedValueOnce(
      response(200, { integration: { integration_key: "R1" } })
    )
    .mockResolvedValue(response(202, { status: "success" }));
}

beforeEach(() => {
  safeFetch.mockReset();
  mockGetIntegrationFromDb.mockReset();
  mockAuth.mockReset();
  mockRequireScope.mockReset();
  clearRoutingKeyCache();

  mockAuth.mockResolvedValue({
    userId: "user-1",
    organizationId: "org-1",
    scope: "mcp:write",
    authMethod: "session",
  });
  mockRequireScope.mockReturnValue(undefined);
  mockCreatorDeactivated.mockReset();
  mockCreatorDeactivated.mockResolvedValue(false);
  mockGetIntegrationFromDb.mockResolvedValue({
    id: "int-1",
    type: "pagerduty",
    createdBy: "user-1",
    config: { apiToken: "tok" },
  });
});

describe("POST /api/integrations/[integrationId]/pagerduty/test-node", () => {
  /**
   * The point of the round trip: it ends with nothing open. A test that left
   * an alert behind is one somebody has to go and tidy up in PagerDuty, and
   * on-call would see it sitting there.
   */
  it("opens an alert, acknowledges it and resolves it", async () => {
    pagerDutyAccepts();
    safeFetch.mockResolvedValue(response(202, { status: "success" }));

    const res = await POST(request({ serviceId: "PSVC1" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.legs.map((leg: { step: string }) => leg.step)).toEqual([
      "trigger",
      "acknowledge",
      "resolve",
    ]);
    expect(body.legs.every((leg: { ok: boolean }) => leg.ok)).toBe(true);

    // Calls 0 and 1 resolve the routing key; 2, 3 and 4 are the events; the
    // last is the best-effort read-back for the incident link.
    const actions = safeFetch.mock.calls
      .slice(2, 5)
      .map(
        (call) =>
          JSON.parse(String((call[1] as { body: string }).body)).event_action
      );
    expect(actions).toEqual(["trigger", "acknowledge", "resolve"]);
  });

  /**
   * A test must never be able to merge into, or close, an alert a workflow
   * opened. Its key is this route's own and is not derived from any node.
   */
  it("uses a dedup key of its own, not a node's", async () => {
    pagerDutyAccepts();
    safeFetch.mockResolvedValue(response(202, { status: "success" }));

    const body = await (
      await POST(request({ serviceId: "PSVC1" }), { params })
    ).json();

    expect(body.dedupKey).toMatch(/^keeperhub\/test\//);
    const sent = JSON.parse(
      String((safeFetch.mock.calls[2][1] as { body: string }).body)
    );
    expect(sent.dedup_key).toBe(body.dedupKey);
    expect(sent.payload.severity).toBe("info");
    expect(sent.payload.summary).toContain("KeeperHub test alert");
  });

  it("reports the leg that failed rather than a bare false", async () => {
    pagerDutyAccepts();
    safeFetch.mockResolvedValue(
      response(400, { message: "Event object is invalid" })
    );

    const body = await (
      await POST(request({ serviceId: "PSVC1" }), { params })
    ).json();

    expect(body.ok).toBe(false);
    expect(body.legs).toHaveLength(1);
    expect(body.legs[0]).toMatchObject({ step: "trigger", ok: false });
    expect(body.legs[0].error).toContain("Event object is invalid");
  });

  /**
   * The case this button exists for: the credential is fine, and the service
   * somebody just picked cannot take events at all.
   */
  it("explains a service with no Events API v2 integration", async () => {
    safeFetch.mockResolvedValueOnce(
      response(200, { service: { status: "active", integrations: [] } })
    );

    const res = await POST(request({ serviceId: "PSVC1" }), { params });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("no Events API v2 integration");
  });

  it("says the test proves nothing when the service swallows events", async () => {
    pagerDutyAccepts("maintenance");
    safeFetch.mockResolvedValue(response(202, { status: "success" }));

    const body = await (
      await POST(request({ serviceId: "PSVC1" }), { params })
    ).json();

    expect(body.ok).toBe(true);
    expect(body.warning).toContain("maintenance");
  });

  it("refuses a service id that is not one", async () => {
    const res = await POST(request({ serviceId: "../../etc/passwd" }), {
      params,
    });
    expect(res.status).toBe(400);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses a connection belonging to another organisation", async () => {
    mockGetIntegrationFromDb.mockResolvedValue(null);
    const res = await POST(request({ serviceId: "PSVC1" }), { params });
    expect(res.status).toBe(404);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses a connection that is not a PagerDuty one", async () => {
    mockGetIntegrationFromDb.mockResolvedValue({
      id: "int-1",
      type: "slack",
      config: {},
    });
    const res = await POST(request({ serviceId: "PSVC1" }), { params });
    expect(res.status).toBe(400);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  /** It pages a real service, so a read scope is not enough. */
  it("requires a write scope", async () => {
    mockRequireScope.mockReturnValue(
      new Response(JSON.stringify({ error: "insufficient scope" }), {
        status: 403,
      })
    );
    const res = await POST(request({ serviceId: "PSVC1" }), { params });
    expect(res.status).toBe(403);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  /**
   * Deactivating someone freezes the connections they added, for everyone.
   * The run-time credential fetch enforces that; this route reads the
   * connection directly, so without its own check an offboarded person's
   * credential would still page a service from the editor.
   */
  it("refuses a connection whose creator has been deactivated", async () => {
    mockCreatorDeactivated.mockResolvedValue(true);
    const res = await POST(request({ serviceId: "PSVC1" }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("deactivated");
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

/**
 * The three events are each answered 202, which says they were accepted and
 * nothing about what PagerDuty did with them - the reason Resolve carries a
 * send delay at all. Claiming the test "leaves nothing open" off those three
 * would be the one thing this route asserts without checking.
 */
describe("what the test says about the alert afterwards", () => {
  /**
   * Service read, integration read, the three events, then the read-back.
   * The events have to be queued explicitly: `pagerDutyAccepts`'s catch-all
   * only serves calls the queue has run out for, so a read-back queued behind
   * it would have been eaten by the trigger.
   */
  function acceptsThenReadsBack(incidents: unknown) {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            status: "active",
            integrations: [
              { id: "PI1", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        response(200, { integration: { integration_key: "R1" } })
      )
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(response(200, incidents));
  }

  it("warns when the alert is still open a moment later", async () => {
    acceptsThenReadsBack({
      incidents: [
        {
          id: "PINC1",
          status: "triggered",
          html_url: "https://acme.pagerduty.com/incidents/PINC1",
        },
      ],
    });

    const body = await (
      await POST(request({ serviceId: "PABC123" }), {
        params,
      })
    ).json();

    expect(body.incidentStatus).toBe("triggered");
    expect(body.warning).toContain("still triggered");
  });

  it("says nothing extra when it really did close", async () => {
    acceptsThenReadsBack({
      incidents: [
        {
          id: "PINC1",
          status: "resolved",
          html_url: "https://acme.pagerduty.com/incidents/PINC1",
        },
      ],
    });

    const body = await (
      await POST(request({ serviceId: "PABC123" }), {
        params,
      })
    ).json();

    expect(body.incidentStatus).toBe("resolved");
    expect(body.warning).toBeUndefined();
  });
});
