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
const { mockSleep } = vi.hoisted(() => ({
  mockSleep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/sleep", () => ({ sleep: mockSleep }));

import { acknowledgeIncidentStep } from "@/plugins/pagerduty/steps/acknowledge-incident";
import {
  clearOAuthTokenCache,
  clearRoutingKeyCache,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { resolveIncidentStep } from "@/plugins/pagerduty/steps/resolve-incident";
import {
  MAX_SEND_DELAY_SECONDS,
  resolveSendDelayMs,
} from "@/plugins/pagerduty/steps/update-incident-core";

const CONTEXT = {
  nodeId: "node-9",
  nodeName: "Resolve",
  nodeType: "pagerduty/resolve-incident",
  workflowId: "wf-8",
  organizationId: "org-1",
};

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

function mockRoutingKey() {
  safeFetch
    .mockResolvedValueOnce(
      response(200, {
        service: {
          integrations: [
            { id: "PI1", type: "events_api_v2_inbound_integration" },
          ],
        },
      })
    )
    .mockResolvedValueOnce(
      response(200, { integration: { integration_key: "R1" } })
    );
}

beforeEach(() => {
  safeFetch.mockReset();
  mockFetchCredentials.mockReset();
  mockFetchCredentials.mockResolvedValue({ PAGERDUTY_API_TOKEN: "t" });
  clearOAuthTokenCache();
  clearRoutingKeyCache();
  mockSleep.mockClear();
});

/**
 * One ordering loses an incident: a resolve reaching PagerDuty before the
 * trigger it was meant to close. PagerDuty drops an update matching no open
 * alert, answering 202, and the trigger then opens an alert nobody closes.
 * This field buys the trigger a head start.
 */
describe("resolveSendDelayMs", () => {
  it("waits for nothing by default", () => {
    expect(resolveSendDelayMs(undefined)).toBe(0);
    expect(resolveSendDelayMs("")).toBe(0);
    expect(resolveSendDelayMs(null)).toBe(0);
    expect(resolveSendDelayMs(0)).toBe(0);
  });

  it("accepts the editor's strings and an MCP caller's numbers alike", () => {
    expect(resolveSendDelayMs("2")).toBe(2000);
    expect(resolveSendDelayMs(2)).toBe(2000);
    expect(resolveSendDelayMs(1.5)).toBe(1500);
  });

  it("caps at the documented maximum rather than rejecting", () => {
    expect(resolveSendDelayMs(60)).toBe(MAX_SEND_DELAY_SECONDS * 1000);
    expect(resolveSendDelayMs("999")).toBe(MAX_SEND_DELAY_SECONDS * 1000);
  });

  /**
   * The failure mode of this whole node is an incident that stays open, so no
   * malformed or hostile value may hold a resolve back at all.
   */
  it("waits for nothing on a value it cannot read", () => {
    expect(resolveSendDelayMs("soon")).toBe(0);
    expect(resolveSendDelayMs(Number.NaN)).toBe(0);
    // Infinity is not a long wait, it is an unreadable value - so it waits for
    // nothing rather than being capped.
    expect(resolveSendDelayMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(resolveSendDelayMs(-5)).toBe(0);
    expect(resolveSendDelayMs({})).toBe(0);
  });
});

describe("resolve incident", () => {
  it("sends resolve with the dedup key of the alert it is closing", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, { status: "success" }));

    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "keeperhub/wf-8/node-3",
      _context: CONTEXT,
    } as never);

    expect(result).toMatchObject({
      success: true,
      delivered: true,
      action: "resolve",
    });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body).toEqual({
      routing_key: "R1",
      event_action: "resolve",
      dedup_key: "keeperhub/wf-8/node-3",
    });
  });

  /**
   * The Events API requires a dedup key for resolve, and deriving one from
   * this node's id would produce a key no alert has ever carried - PagerDuty
   * would answer 202 and drop it. Failing loudly is the only safe answer.
   */
  /**
   * The healthy branch of a check never runs the trigger node, so a template
   * reference to its output cannot resolve there. Picking the trigger node
   * derives the same key without needing it to have run.
   */
  it("derives the trigger node's key when the node is picked", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKeyFromNodeId: "node-3",
      _context: CONTEXT,
    } as never);

    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.dedup_key).toBe("keeperhub/wf-8/node-3");
  });

  it("prefers an explicit key over the picked node", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKeyFromNodeId: "node-3",
      dedupKey: "vault-7",
      _context: CONTEXT,
    } as never);

    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.dedup_key).toBe("vault-7");
  });

  it("refuses to run without a dedup key instead of sending one nothing matches", async () => {
    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      _context: CONTEXT,
    } as never);

    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error).toContain("Trigger Incident node");
    }
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reports the incident as already resolved when the check is on", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC1", status: "resolved" }] })
      );

    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: CONTEXT,
    } as never);

    // The read happens after the event, so this is the state observed
    // afterwards - it cannot claim the incident was ALREADY resolved.
    expect(result).toMatchObject({
      delivered: true,
      incidentStatus: "resolved",
    });
  });

  /**
   * The default dedup key is per node, so every incident that node has ever
   * opened carries it. PagerDuty sorts /incidents by created_at ascending, so
   * asking for one without a sort returns the oldest in the six-month window -
   * a resolve would read back the status of an incident from months ago.
   */
  it("asks PagerDuty for the newest incident carrying the key", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC9", status: "resolved" }] })
      );

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: CONTEXT,
    } as never);

    const url = String((safeFetch.mock.calls[3] as [string])[0]);
    expect(url).toContain("sort_by=created_at%3Adesc");
  });

  it("calls an inconclusive check unknown, and still succeeds", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(response(403, {}));

    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: CONTEXT,
    } as never);

    expect(result).toMatchObject({
      success: true,
      delivered: true,
      incidentStatus: "unknown",
    });
    if (result.success) {
      expect(result.verificationError).toBeTruthy();
    }
  });

  it("does not call the incidents API when the check is turned off", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "k1",
      verifyWithPagerDuty: false,
      _context: CONTEXT,
    } as never);

    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  /**
   * The editor seeds the action's declared default into the config when
   * somebody picks the action, so a node built there always carries this
   * field. A node built through the API or by an MCP caller does not, and
   * reading an absent value as "no" turned the check off for all of them -
   * silently, and against what the action, its help text and the docs say.
   */
  it("reads the incident back when the field was never set at all", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC1", status: "resolved" }] })
      );

    const result = await resolveIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "k1",
      _context: CONTEXT,
    } as never);

    expect(result).toMatchObject({ incidentStatus: "resolved" });
  });
});

describe("acknowledge incident", () => {
  it("sends acknowledge, not resolve", async () => {
    mockRoutingKey();
    safeFetch.mockResolvedValueOnce(response(202, {}));

    const result = await acknowledgeIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "k1",
      _context: { ...CONTEXT, nodeType: "pagerduty/acknowledge-incident" },
    } as never);

    expect(result).toMatchObject({ action: "acknowledge" });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.event_action).toBe("acknowledge");
  });

  it("reports an already acknowledged incident as such when checked", async () => {
    mockRoutingKey();
    safeFetch
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "P1", status: "acknowledged" }] })
      );

    const result = await acknowledgeIncidentStep({
      integrationId: "int-1",
      pagerdutyServiceId: "PSVC1",
      dedupKey: "k1",
      verifyWithPagerDuty: true,
      _context: { ...CONTEXT, nodeType: "pagerduty/acknowledge-incident" },
    } as never);

    expect(result).toMatchObject({ incidentStatus: "acknowledged" });
  });

  describe("waiting before the resolve is sent", () => {
    it("does not wait at all when the field is left alone", async () => {
      mockRoutingKey();
      safeFetch.mockResolvedValue(response(202, {}));

      const result = await resolveIncidentStep({
        integrationId: "int-1",
        pagerdutyServiceId: "PSVC1",
        dedupKey: "k1",
        verifyWithPagerDuty: false,
        _context: CONTEXT,
      } as never);

      expect(mockSleep).not.toHaveBeenCalled();
      expect(
        (result as { delayedSeconds?: number }).delayedSeconds
      ).toBeUndefined();
    });

    it("waits the configured seconds and reports that it did", async () => {
      mockRoutingKey();
      safeFetch.mockResolvedValue(response(202, {}));

      const result = await resolveIncidentStep({
        integrationId: "int-1",
        pagerdutyServiceId: "PSVC1",
        dedupKey: "k1",
        sendDelaySeconds: 2,
        verifyWithPagerDuty: false,
        _context: CONTEXT,
      } as never);

      expect(mockSleep).toHaveBeenCalledWith(2000);
      expect(result).toMatchObject({ delivered: true, delayedSeconds: 2 });
    });

    /**
     * The wait sits between resolving the routing key and sending, so it is as
     * close to the send as it can be - which is what the race needs - and a run
     * that cannot resolve its routing key fails immediately instead of waiting
     * first for no reason.
     */
    it("waits after the routing key is resolved, not before", async () => {
      const order: string[] = [];
      mockSleep.mockImplementation(() => {
        order.push("slept");
        return Promise.resolve(undefined);
      });
      safeFetch.mockImplementation((url: string) => {
        order.push(String(url).includes("/v2/enqueue") ? "sent" : "read");
        if (String(url).includes("/integrations/")) {
          return Promise.resolve(
            response(200, { integration: { integration_key: "R1" } })
          );
        }
        if (String(url).includes("/services/")) {
          return Promise.resolve(
            response(200, {
              service: {
                integrations: [
                  { id: "PI1", type: "events_api_v2_inbound_integration" },
                ],
              },
            })
          );
        }
        return Promise.resolve(response(202, {}));
      });

      await resolveIncidentStep({
        integrationId: "int-1",
        pagerdutyServiceId: "PSVC1",
        dedupKey: "k1",
        sendDelaySeconds: 3,
        verifyWithPagerDuty: false,
        _context: CONTEXT,
      } as never);

      expect(order).toEqual(["read", "read", "slept", "sent"]);
    });

    it("does not wait when the routing key could not be resolved", async () => {
      safeFetch.mockResolvedValueOnce(response(404, {}));

      const result = await resolveIncidentStep({
        integrationId: "int-1",
        pagerdutyServiceId: "PSVC1",
        dedupKey: "k1",
        sendDelaySeconds: 5,
        failOnError: false,
        _context: CONTEXT,
      } as never);

      expect(mockSleep).not.toHaveBeenCalled();
      expect(result).toMatchObject({ delivered: false });
    });

    /**
     * Acknowledge hits the same ordering. What it costs is different - a
     * dropped acknowledge leaves PagerDuty escalating rather than leaving an
     * incident open - but it is still not what the workflow asked for.
     */
    it("waits for an acknowledge too, and reports it", async () => {
      mockRoutingKey();
      safeFetch.mockResolvedValue(response(202, {}));

      const result = await acknowledgeIncidentStep({
        integrationId: "int-1",
        pagerdutyServiceId: "PSVC1",
        dedupKey: "k1",
        sendDelaySeconds: 3,
        verifyWithPagerDuty: false,
        _context: CONTEXT,
      } as never);

      expect(mockSleep).toHaveBeenCalledWith(3000);
      expect(result).toMatchObject({
        delivered: true,
        action: "acknowledge",
        delayedSeconds: 3,
      });
    });

    it("does not wait for an acknowledge that was not asked to", async () => {
      mockRoutingKey();
      safeFetch.mockResolvedValue(response(202, {}));

      await acknowledgeIncidentStep({
        integrationId: "int-1",
        pagerdutyServiceId: "PSVC1",
        dedupKey: "k1",
        verifyWithPagerDuty: false,
        _context: CONTEXT,
      } as never);

      expect(mockSleep).not.toHaveBeenCalled();
    });

    it("never waits longer than the documented maximum", async () => {
      mockRoutingKey();
      safeFetch.mockResolvedValue(response(202, {}));

      await resolveIncidentStep({
        integrationId: "int-1",
        pagerdutyServiceId: "PSVC1",
        dedupKey: "k1",
        sendDelaySeconds: "600",
        verifyWithPagerDuty: false,
        _context: CONTEXT,
      } as never);

      expect(mockSleep).toHaveBeenCalledWith(MAX_SEND_DELAY_SECONDS * 1000);
    });
  });
});
