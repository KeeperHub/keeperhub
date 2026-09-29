import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);
vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    VALIDATION: "validation",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const { mockFetchCredentials } = vi.hoisted(() => ({
  mockFetchCredentials: vi.fn(),
}));
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

import { createIncidentStep } from "@/plugins/pagerduty/steps/create-incident";
import {
  clearOAuthTokenCache,
  clearRoutingKeyCache,
  createIncident,
  findIncidentByKey,
  isHeaderSafeEmail,
  isPagerDutyId,
  resolveRoutingKey,
} from "@/plugins/pagerduty/steps/pagerduty-core";

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

const CREDS = { PAGERDUTY_API_TOKEN: "t" };

beforeEach(() => {
  safeFetch.mockReset();
  mockFetchCredentials.mockReset();
  mockFetchCredentials.mockResolvedValue(CREDS);
  clearOAuthTokenCache();
  clearRoutingKeyCache();
});

describe("id validation", () => {
  it("accepts the ids PagerDuty issues", () => {
    expect(isPagerDutyId("PIJ90N7")).toBe(true);
    expect(isPagerDutyId("P1")).toBe(true);
  });

  it.each([
    ["path traversal", "../../users"],
    ["a slash", "PABC/integrations"],
    ["a newline", "PABC\nX-Injected: 1"],
    ["a space", "P ABC"],
    ["empty", ""],
    ["an absurd length", "P".repeat(200)],
  ])("rejects %s", (_label, value) => {
    expect(isPagerDutyId(value)).toBe(false);
  });

  it("refuses to call PagerDuty with a crafted service id", async () => {
    const result = await resolveRoutingKey(CREDS, "../../users");
    expect(result.ok).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("refuses a crafted service id on the incident lookup too", async () => {
    const result = await findIncidentByKey(CREDS, {
      serviceId: "../../users",
      incidentKey: "k",
    });
    expect(result.ok).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("percent-encodes an id it does accept, so nothing escapes the path", async () => {
    safeFetch.mockResolvedValue(response(404, {}));
    await resolveRoutingKey(CREDS, "P-ab_12");
    expect(String(safeFetch.mock.calls[0][0])).toContain("/services/P-ab_12?");
  });
});

describe("From header safety", () => {
  it.each([
    ["ops@acme.io", true],
    ["first.last+tag@acme.co.uk", true],
    ["ops@acme.io\r\nX-Injected: 1", false],
    ["ops@acme.io\nX-Injected: 1", false],
    ["not-an-email", false],
    ["", false],
  ])("%s", (value, expected) => {
    expect(isHeaderSafeEmail(value)).toBe(expected);
  });

  it("never sends a header-injecting From value to PagerDuty", async () => {
    const result = await createIncident(CREDS, {
      serviceId: "PSVC1",
      title: "t",
      fromEmail: "ops@acme.io\r\nX-Injected: 1",
    });
    expect(result.ok).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("create incident", () => {
  /** The body of the last request, which is the incident POST in these cases. */
  function lastBody(): unknown {
    return (safeFetch.mock.calls.at(-1) as [string, Record<string, unknown>])[1]
      .body;
  }

  function run(overrides: Record<string, unknown> = {}) {
    return createIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      title: "Keeper stalled",
      fromEmail: "ops@acme.io",
      _context: {
        nodeId: "n1",
        nodeName: "Create",
        nodeType: "pagerduty/create-incident",
        organizationId: "org-1",
      },
      ...overrides,
    } as never);
  }

  it("creates the incident and returns its identity", async () => {
    safeFetch.mockResolvedValue(
      response(201, {
        incident: { id: "PINC1", incident_number: 7, html_url: "https://x" },
      })
    );
    const result = await run();
    expect(result).toMatchObject({
      success: true,
      delivered: true,
      incidentId: "PINC1",
      incidentNumber: 7,
    });
  });

  it("asks for a From email rather than guessing one", async () => {
    mockFetchCredentials.mockResolvedValue({ PAGERDUTY_API_TOKEN: "t" });
    const result = await run({ fromEmail: "" });
    expect(result).toMatchObject({ success: false });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("falls back to the service policy when the chosen one is gone", async () => {
    safeFetch
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(response(201, { incident: { id: "PINC1" } }));

    const result = await run({ pagerdutyEscalationPolicyId: "PGONE" });

    expect(result).toMatchObject({
      success: true,
      escalationPolicyFellBack: true,
    });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[1] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.incident.escalation_policy).toBeUndefined();
  });

  it("fails instead when the fallback is turned off", async () => {
    safeFetch.mockResolvedValueOnce(response(404, {}));
    const result = await run({
      pagerdutyEscalationPolicyId: "PGONE",
      fallbackToServicePolicy: false,
    });
    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error).toContain("no longer exists");
    }
  });

  /** High urgency was silently dropped, so a high-urgency incident did not page. */
  it("sends the urgency the author picked", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    await run({ urgency: "high" });
    const body = JSON.parse(String(lastBody()));
    expect(body.incident.urgency).toBe("high");
  });

  it("sends low urgency too", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    await run({ urgency: "low" });
    expect(JSON.parse(String(lastBody())).incident.urgency).toBe("low");
  });

  it("leaves urgency to PagerDuty when the service default is chosen", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    await run({ urgency: "service-default" });
    expect(JSON.parse(String(lastBody())).incident.urgency).toBeUndefined();
  });

  it("sets the account priority when one is picked", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    await run({ pagerdutyPriorityId: "PSLWBL8" });
    expect(JSON.parse(String(lastBody())).incident.priority).toEqual({
      id: "PSLWBL8",
      type: "priority_reference",
    });
  });

  it("sends no priority for the leave-it-to-PagerDuty sentinel", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    await run({ pagerdutyPriorityId: "none" });
    expect(JSON.parse(String(lastBody())).incident.priority).toBeUndefined();
  });

  /**
   * The sentinel was kept out of the request but not out of the output, so a
   * node that left the priority to PagerDuty reported a priority of "none" to
   * every downstream node reading the field.
   */
  it("reports no priority either when the sentinel was stored", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    const result = await run({ pagerdutyPriorityId: "none" });
    expect(result).toMatchObject({ success: true });
    expect((result as { priorityId?: string }).priorityId).toBeUndefined();
  });

  it("reports the priority it was given", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    const result = await run({ pagerdutyPriorityId: "PSLWBL8" });
    expect(result).toMatchObject({ priorityId: "PSLWBL8" });
  });

  it("falls back to the connection's From email", async () => {
    mockFetchCredentials.mockResolvedValue({
      PAGERDUTY_API_TOKEN: "t",
      PAGERDUTY_FROM_EMAIL: "connection@acme.io",
    });
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));

    await run({ fromEmail: "" });

    const headers = (
      safeFetch.mock.calls.at(-1) as [string, Record<string, unknown>]
    )[1].headers as Record<string, string>;
    expect(headers.From).toBe("connection@acme.io");
  });

  it("keeps a policy that still exists", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          escalation_policy: { id: "PEP1", name: "Platform On-Call" },
        })
      )
      .mockResolvedValueOnce(response(201, { incident: { id: "PINC1" } }));

    const result = await run({ pagerdutyEscalationPolicyId: "PEP1" });
    expect(result).toMatchObject({ escalationPolicyFellBack: false });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[1] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.incident.escalation_policy.id).toBe("PEP1");
  });
});
