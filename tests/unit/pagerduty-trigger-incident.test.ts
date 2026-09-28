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

const { mockCountConsecutiveRuns } = vi.hoisted(() => ({
  mockCountConsecutiveRuns: vi.fn(),
}));
vi.mock("@/plugins/pagerduty/steps/consecutive-core", async (original) => {
  const actual =
    await original<
      typeof import("@/plugins/pagerduty/steps/consecutive-core")
    >();
  return {
    ...actual,
    countConsecutiveRuns: (...args: unknown[]) =>
      mockCountConsecutiveRuns(...args),
  };
});

import {
  clearOAuthTokenCache,
  clearRoutingKeyCache,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { triggerIncidentStep } from "@/plugins/pagerduty/steps/trigger-incident";

const CONTEXT = {
  nodeId: "node-3",
  nodeName: "Page on-call",
  nodeType: "pagerduty/trigger-incident",
  workflowId: "wf-8",
  executionId: "exec-1",
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

/** Service lookup, then integration lookup, then the event itself. */
function mockHappyPath(eventStatus = 202, serviceStatus = "active") {
  safeFetch
    .mockResolvedValueOnce(
      response(200, {
        service: {
          id: "PSVC1",
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
    .mockResolvedValueOnce(
      response(eventStatus, {
        status: "success",
        dedup_key: "keeperhub/wf-8/node-3",
      })
    );
}

function run(overrides: Record<string, unknown> = {}) {
  return triggerIncidentStep({
    integrationId: "int-1",
    pagerdutyServiceId: "PSVC1",
    summary: "Keeper stalled",
    _context: CONTEXT,
    ...overrides,
  } as never);
}

beforeEach(() => {
  safeFetch.mockReset();
  mockFetchCredentials.mockReset();
  mockFetchCredentials.mockResolvedValue({ PAGERDUTY_API_TOKEN: "t" });
  mockCountConsecutiveRuns.mockReset();
  mockCountConsecutiveRuns.mockResolvedValue(1);
  clearOAuthTokenCache();
  clearRoutingKeyCache();
});

describe("trigger incident", () => {
  it("resolves the routing key from the service and sends the event", async () => {
    mockHappyPath();
    const result = await run();

    expect(result).toMatchObject({
      success: true,
      delivered: true,
      status: "triggered",
      dedupKey: "keeperhub/wf-8/node-3",
    });

    const [eventUrl, eventInit] = safeFetch.mock.calls[2] as [
      string,
      Record<string, unknown>,
    ];
    expect(eventUrl).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse(String(eventInit.body));
    expect(body.routing_key).toBe("R1");
    expect(body.event_action).toBe("trigger");
    expect(body.payload.source).toBe("Page on-call");
    expect(body.payload.custom_details.keeperhub_workflow_id).toBe("wf-8");
  });

  it("never lets the routing key into the step output", async () => {
    mockHappyPath();
    const result = await run();
    expect(JSON.stringify(result)).not.toContain("R1");
  });

  it("refuses a run with no service selected", async () => {
    const result = await run({ pagerdutyServiceId: "" });
    expect(result).toMatchObject({ success: false });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  /**
   * A broken template is not a reason to stay silent. The page goes out with
   * a title that says what happened, carrying the template that produced
   * nothing so it can be fixed.
   */
  it("still pages when the summary template renders empty", async () => {
    mockHappyPath();
    const result = await run({ summary: "   " });

    expect(result).toMatchObject({
      success: true,
      delivered: true,
      summaryFellBack: true,
    });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.payload.summary).toContain("summary template rendered empty");
    expect(body.payload.summary).toContain("Page on-call");
    expect(body.payload.custom_details.keeperhub_summary_template).toBe("   ");
  });

  it("does not claim a fallback when the summary is fine", async () => {
    mockHappyPath();
    const result = await run();
    expect(result).toMatchObject({ summaryFellBack: false });
  });

  it("puts the links a responder needs on the alert", async () => {
    mockHappyPath();
    await run({
      links:
        "Etherscan | https://etherscan.io/tx/0xabc\nhttps://grafana.example.com/d/keepers\nnot a url\n",
    });

    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.links).toEqual([
      { href: "https://etherscan.io/tx/0xabc", text: "Etherscan" },
      {
        href: "https://grafana.example.com/d/keepers",
        text: "https://grafana.example.com/d/keepers",
      },
    ]);
  });

  it("fires the backup for a maintenance window when told to", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            id: "PSVC1",
            status: "maintenance",
            integrations: [
              { id: "PI1", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        response(200, { integration: { integration_key: "R1" } })
      )
      .mockResolvedValueOnce(response(202, {}))
      .mockResolvedValueOnce(response(204, {}));
    mockFetchCredentials
      .mockResolvedValueOnce({ PAGERDUTY_API_TOKEN: "t" })
      .mockResolvedValueOnce({
        webhookUrl: "https://discord.com/api/webhooks/1/abc",
      });

    const result = await run({
      failOnError: false,
      treatMaintenanceAsUndelivered: true,
      backupIntegrationId: "int-discord",
    });

    expect(result).toMatchObject({
      delivered: false,
      backupDelivered: true,
    });
  });

  it("holds the page until the configured run streak is reached", async () => {
    mockCountConsecutiveRuns.mockResolvedValue(1);
    const result = await run({ consecutiveRuns: 3 });

    expect(result).toMatchObject({
      success: true,
      delivered: false,
      status: "held",
      consecutiveRuns: 1,
      requiredRuns: 3,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("pages once the streak is reached", async () => {
    mockCountConsecutiveRuns.mockResolvedValue(3);
    mockHappyPath();
    const result = await run({ consecutiveRuns: 3 });
    expect(result).toMatchObject({ delivered: true, status: "triggered" });
  });

  it("fails the run when PagerDuty will not take the event", async () => {
    safeFetch.mockResolvedValue(response(404, {}));
    const result = await run();
    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error).toContain("no longer exists");
    }
  });

  it("soft-fails with delivered false when the node is set to continue", async () => {
    safeFetch.mockResolvedValue(response(404, {}));
    const result = await run({ failOnError: false });
    expect(result).toMatchObject({ success: true, delivered: false });
    if (result.success) {
      expect(result.error).toContain("no longer exists");
    }
  });

  /**
   * A Condition branching on `status` must not read an undelivered page as a
   * sent one.
   */
  it("reports status failed on a soft failure, not triggered", async () => {
    safeFetch.mockResolvedValue(response(404, {}));
    const result = await run({ failOnError: false });
    expect(result).toMatchObject({ status: "failed" });
  });

  /**
   * A disabled service takes the event with a 202 and raises nothing, which
   * the event response cannot reveal. The service read can, so it does.
   */
  it("refuses to page a disabled service instead of reporting success", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            id: "PSVC1",
            status: "disabled",
            integrations: [
              { id: "PI1", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        response(200, { integration: { integration_key: "R1" } })
      );

    const result = await run();
    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect(result.error).toContain("disabled");
    }
    // Three calls would mean the event was sent anyway.
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("says so when a maintenance window will swallow the event", async () => {
    mockHappyPath(202, "maintenance");
    const result = await run();
    expect(result).toMatchObject({
      delivered: true,
      suppressedByService: true,
      serviceStatus: "maintenance",
    });
    if (result.success) {
      expect(result.message).toContain("maintenance");
    }
  });

  it("retries the routing-key read, not only the event", async () => {
    safeFetch
      .mockResolvedValueOnce(response(500, {}))
      .mockResolvedValueOnce(
        response(200, {
          service: {
            id: "PSVC1",
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
      .mockResolvedValueOnce(response(202, { dedup_key: "k" }));

    const result = await run({ retryAttempts: 2 });
    expect(result).toMatchObject({ delivered: true });
  });

  it("passes the run's organization when it reaches for the backup connection", async () => {
    safeFetch
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(response(204, {}));
    mockFetchCredentials
      .mockResolvedValueOnce({ PAGERDUTY_API_TOKEN: "t" })
      .mockResolvedValueOnce({
        webhookUrl: "https://discord.com/api/webhooks/1/abc",
      });

    await run({ failOnError: false, backupIntegrationId: "int-discord" });

    // Org scoping is what stops a workflow naming another organisation's
    // connection as its backup.
    expect(mockFetchCredentials).toHaveBeenLastCalledWith("int-discord", {
      organizationId: "org-1",
    });
  });

  /**
   * "triggered" is a PagerDuty incident state. A maintenance window means no
   * incident was raised at all, so reporting it as triggered tells a Condition
   * downstream that somebody was paged when nobody was.
   */
  it("calls a swallowed event suppressed rather than triggered", async () => {
    mockHappyPath(202, "maintenance");
    const result = await run();
    expect(result).toMatchObject({
      success: true,
      delivered: true,
      status: "suppressed",
      suppressedByService: true,
    });
  });

  it("still calls a real page triggered", async () => {
    mockHappyPath();
    expect(await run()).toMatchObject({
      status: "triggered",
      suppressedByService: false,
    });
  });

  /**
   * The status travels in the routing-key cache, which lives for five minutes.
   * Reusing a cached "disabled" would refuse to page for the rest of that TTL
   * after somebody re-enabled the service - during the minutes when somebody
   * is toggling a service because an incident is in progress.
   */
  it("re-reads a service it last saw disabled instead of trusting the cache", async () => {
    mockHappyPath(202, "disabled");
    const first = await run({ failOnError: false });
    expect(first).toMatchObject({ delivered: false, status: "failed" });

    safeFetch.mockReset();
    mockHappyPath(202, "active");
    const second = await run();
    expect(second).toMatchObject({ delivered: true, status: "triggered" });
    // Three calls again: service, integration, event. The cached disabled
    // entry was not reused.
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  /**
   * A template renders at run time, so an over-limit value is invisible in the
   * editor. The responder sees a cut title and cannot know it was cut; the
   * author can fix it and will not be looking at the incident. So the run says.
   */
  it("reports a summary it had to shorten", async () => {
    mockHappyPath();
    const result = await run({ summary: "x".repeat(1500) });

    const trimmed = (result as { fieldsTrimmed?: string }).fieldsTrimmed;
    expect(String(trimmed)).toContain("Summary was 1500");
    expect(String(trimmed)).toContain("1024");
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.payload.summary).toHaveLength(1024);
    // The page still went out. A shortened title beats no page.
    expect(result).toMatchObject({ delivered: true, status: "triggered" });
  });

  it("reports an over-long dedup key, which quietly merges two alerts into one", async () => {
    mockHappyPath();
    const result = await run({ dedupKey: "k".repeat(300) });
    expect(
      String((result as { fieldsTrimmed?: string }).fieldsTrimmed)
    ).toContain("Dedup key was 300");
    // The key that actually went to PagerDuty. The output reports the key
    // PagerDuty echoed back, which is the one that identifies the alert.
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.dedup_key).toHaveLength(255);
  });

  it("says nothing about trimming when everything fits", async () => {
    mockHappyPath();
    const result = await run();
    expect(
      (result as { fieldsTrimmed?: string }).fieldsTrimmed
    ).toBeUndefined();
  });

  /**
   * PagerDuty publishes five service statuses today and the node's whole
   * report turns on which group one falls into. A sixth added later would
   * match neither, and reading "not one of the two I know swallow events" as
   * "fine" would report a page PagerDuty never raised - silently, and only on
   * services in that new state.
   */
  it("says so when PagerDuty reports a service status it does not know", async () => {
    mockHappyPath(202, "hibernating");
    const result = await run();

    // Still delivered: refusing to page over an unfamiliar status string
    // would be far worse than not knowing what came of it.
    expect(result).toMatchObject({
      delivered: true,
      status: "triggered",
      serviceStatus: "hibernating",
      suppressedByService: false,
    });
    const note = (result as { message?: string }).message;
    expect(String(note)).toContain("does not recognise");
    expect(String(note)).toContain("hibernating");
  });

  it.each(["active", "warning", "critical"])(
    "says nothing extra for the known paging status %s",
    async (status) => {
      mockHappyPath(202, status);
      const result = await run();
      expect(result).toMatchObject({ delivered: true, status: "triggered" });
      expect(
        String((result as { message?: string }).message ?? "")
      ).not.toContain("does not recognise");
    }
  );

  it("sends the links it could use and counts the ones it could not", async () => {
    mockHappyPath();
    const result = await run({
      links: [
        "Etherscan | https://etherscan.io/tx/0x1",
        "http://internal-dashboard/vault",
        "https://grafana.example/d/abc",
      ].join("\n"),
    });

    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.links).toEqual([
      { href: "https://etherscan.io/tx/0x1", text: "Etherscan" },
      {
        href: "https://grafana.example/d/abc",
        text: "https://grafana.example/d/abc",
      },
    ]);
    // Reported rather than silent: the responder never sees the link that was
    // dropped, so the author has to.
    expect(result).toMatchObject({ linksDropped: 1 });
  });

  it("says nothing about dropped links when every line was usable", async () => {
    mockHappyPath();
    const result = await run({ links: "https://grafana.example/d/abc" });
    expect((result as { linksDropped?: number }).linksDropped).toBeUndefined();
  });

  it("sends the backup notification when the page cannot be delivered", async () => {
    safeFetch
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(response(204, {}));
    mockFetchCredentials
      .mockResolvedValueOnce({ PAGERDUTY_API_TOKEN: "t" })
      .mockResolvedValueOnce({
        webhookUrl: "https://discord.com/api/webhooks/1/abc",
      });

    const result = await run({
      failOnError: false,
      backupIntegrationId: "int-discord",
    });

    expect(result).toMatchObject({
      delivered: false,
      backupAttempted: true,
      backupDelivered: true,
      backupChannel: "discord",
    });
    const [backupUrl, backupInit] = safeFetch.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
    expect(backupUrl).toBe("https://discord.com/api/webhooks/1/abc");
    expect(String(backupInit.body)).toContain("PagerDuty page FAILED");
  });

  it("reports a backup that itself failed, rather than swallowing it", async () => {
    safeFetch
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(response(500, {}));
    mockFetchCredentials
      .mockResolvedValueOnce({ PAGERDUTY_API_TOKEN: "t" })
      .mockResolvedValueOnce({
        webhookUrl: "https://discord.com/api/webhooks/1/abc",
      });

    const result = await run({
      failOnError: false,
      backupIntegrationId: "int-discord",
    });
    expect(result).toMatchObject({
      backupAttempted: true,
      backupDelivered: false,
    });
  });

  it("refuses a backup connection that is not a messaging connection", async () => {
    safeFetch.mockResolvedValueOnce(response(404, {}));
    mockFetchCredentials
      .mockResolvedValueOnce({ PAGERDUTY_API_TOKEN: "t" })
      .mockResolvedValueOnce({});

    const result = await run({
      failOnError: false,
      backupIntegrationId: "int-unknown",
    });
    expect(result).toMatchObject({
      backupAttempted: true,
      backupDelivered: false,
    });
  });

  it("retries a rate limit and succeeds on the second attempt", async () => {
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
      )
      .mockResolvedValueOnce(response(429, {}))
      .mockResolvedValueOnce(response(202, { dedup_key: "k" }));

    const result = await run({ retryAttempts: 2 });
    expect(result).toMatchObject({ delivered: true });
    expect(safeFetch).toHaveBeenCalledTimes(4);
  });

  it("uses an explicit dedup key when the author gives one", async () => {
    mockHappyPath();
    await run({ dedupKey: "vault-7" });
    const body = JSON.parse(
      String(
        (safeFetch.mock.calls[2] as [string, Record<string, unknown>])[1].body
      )
    );
    expect(body.dedup_key).toBe("vault-7");
  });
});
