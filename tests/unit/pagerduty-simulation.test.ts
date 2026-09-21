/**
 * End-to-end simulations of a PagerDuty node in a real workflow.
 *
 * Unlike the unit tests beside this file, nothing here stubs a single call and
 * asserts on it. Each simulation builds a node's config the way the product
 * builds it, keeps a live execution history, and runs the node over a sequence
 * of runs - held, paged, recovered, cancelled, refused, duplicated - asserting
 * on what the on-call engineer would actually experience.
 *
 * The PagerDuty API is the only thing faked. Everything else is the real code
 * path: the plugin's own field definitions, the editor's config builder, the
 * streak query against a history that grows as runs happen.
 */
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
    DATABASE: "database",
  },
  logUserError: vi.fn(),
  logSystemWarn: vi.fn(),
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

/**
 * A workflow's run history, standing in for the two tables the streak query
 * reads. Simulations append to it as runs happen, so the guard sees the same
 * sequence a real workflow would produce.
 */
type RunRow = {
  id: string;
  status: string;
  startedAt: Date;
  reachedNodes: string[];
};
const history: RunRow[] = [];
let clock = Date.parse("2026-03-01T00:00:00Z");

function recordRun(status: string, reachedNodes: string[]): RunRow {
  clock += 3_600_000;
  const row = {
    id: `exec-${history.length + 1}`,
    status,
    startedAt: new Date(clock),
    reachedNodes,
  };
  history.push(row);
  return row;
}

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {
    id: "id",
    status: "status",
    workflowId: "workflow_id",
    startedAt: "started_at",
    completedAt: "completed_at",
    deletedAt: "deleted_at",
  },
  workflowExecutionLogs: {
    executionId: "execution_id",
    nodeId: "node_id",
    deletedAt: "deleted_at",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  eq: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  isNotNull: (value: unknown) => value,
  isNull: (value: unknown) => value,
  lt: (...args: unknown[]) => args,
}));

/**
 * The streak query, served from `history`. Three shapes in a fixed order:
 * this run's start time, the finished runs before it, then which of those
 * reached the node.
 */
const currentRun = { id: "", startedAt: new Date(0), nodeId: "" };
let priorSlice: RunRow[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: (columns: Record<string, unknown>) => {
      if ("startedAt" in columns && !("id" in columns)) {
        return {
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([{ startedAt: currentRun.startedAt }]),
            }),
          }),
        };
      }
      if ("id" in columns) {
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: (n: number) => {
                  priorSlice = history
                    .filter((row) => row.startedAt < currentRun.startedAt)
                    .sort(
                      (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
                    )
                    .slice(0, n);
                  return Promise.resolve(
                    priorSlice.map((row) => ({
                      id: row.id,
                      status: row.status,
                    }))
                  );
                },
              }),
            }),
          }),
        };
      }
      return {
        from: () => ({
          where: () =>
            Promise.resolve(
              priorSlice
                .filter((row) => row.reachedNodes.includes(currentRun.nodeId))
                .map((row) => ({ executionId: row.id }))
            ),
        }),
      };
    },
  },
}));

import { remapNodeReferencesInConfig } from "@/lib/utils/template";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import pagerDutyPlugin from "@/plugins/pagerduty";
import { acknowledgeIncidentStep } from "@/plugins/pagerduty/steps/acknowledge-incident";
import { createIncidentStep } from "@/plugins/pagerduty/steps/create-incident";
import {
  clearOAuthTokenCache,
  clearRoutingKeyCache,
  deriveDedupKey,
} from "@/plugins/pagerduty/steps/pagerduty-core";
import { resolveIncidentStep } from "@/plugins/pagerduty/steps/resolve-incident";
import { triggerIncidentStep } from "@/plugins/pagerduty/steps/trigger-incident";

const WORKFLOW_ID = "wf-vault-health";
const TRIGGER_NODE = "node-page";
const RESOLVE_NODE = "node-resolve";

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

/** Service read, integration read, then the event. What one page costs. */
function pagerDutyIsHealthy(serviceStatus = "active", eventStatus = 202) {
  safeFetch.mockReset();
  safeFetch
    .mockResolvedValueOnce(
      response(200, {
        service: {
          id: "PSVC1",
          status: serviceStatus,
          html_url: "https://acme.pagerduty.com/services/PSVC1",
          integrations: [
            { id: "PI1", type: "events_api_v2_inbound_integration" },
          ],
        },
      })
    )
    .mockResolvedValueOnce(
      response(200, { integration: { integration_key: "R1" } })
    )
    .mockResolvedValue(response(eventStatus, { status: "success" }));
}

/**
 * The config the editor stores when somebody picks this action and fills in
 * only what is required. Built by the product's own transition builder from
 * the plugin's own field definitions, so the defaults under test are the ones
 * a real node carries.
 */
function configureAsEditor(
  slug: string,
  filledIn: Record<string, unknown>
): Record<string, unknown> {
  const action = pagerDutyPlugin.actions.find((a) => a.slug === slug);
  if (!action) {
    throw new Error(`no action ${slug}`);
  }
  return {
    ...buildConfigForActionTypeChange(`pagerduty/${slug}`, {}),
    ...filledIn,
  };
}

async function runTrigger(
  run: RunRow,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  currentRun.id = run.id;
  currentRun.startedAt = run.startedAt;
  currentRun.nodeId = TRIGGER_NODE;
  return (await triggerIncidentStep({
    integrationId: "int-pd",
    ...config,
    _context: {
      nodeId: TRIGGER_NODE,
      nodeName: "Page on-call",
      nodeType: "pagerduty/trigger-incident",
      workflowId: WORKFLOW_ID,
      executionId: run.id,
      organizationId: "org-1",
    },
  } as never)) as unknown as Record<string, unknown>;
}

beforeEach(() => {
  history.length = 0;
  clock = Date.parse("2026-03-01T00:00:00Z");
  safeFetch.mockReset();
  mockSleep.mockReset();
  mockSleep.mockResolvedValue(undefined);
  mockFetchCredentials.mockReset();
  mockFetchCredentials.mockResolvedValue({ PAGERDUTY_API_TOKEN: "tok" });
  clearOAuthTokenCache();
  clearRoutingKeyCache();
});

/**
 * The workflow this node exists for: an hourly check, a Condition, and a page
 * on the unhealthy branch with a resolve on the healthy one.
 */
describe("simulation: hourly vault check that flaps, then breaks, then recovers", () => {
  const triggerConfig = configureAsEditor("trigger-incident", {
    pagerdutyServiceId: "PSVC1",
    summary: "Vault 0xabc has not been poked in 6 hours",
    consecutiveRuns: 3,
  });

  it("holds the first two unhealthy runs and pages on the third", async () => {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      const run = recordRun("success", [TRIGGER_NODE]);
      pagerDutyIsHealthy();
      results.push(await runTrigger(run, triggerConfig));
    }

    expect(results.map((r) => r.status)).toEqual(["held", "held", "triggered"]);
    expect(results[2]).toMatchObject({ delivered: true, consecutiveRuns: 3 });
    // The held runs never touched PagerDuty at all.
    expect(results[0].delivered).toBe(false);
  });

  /**
   * The outage the guard must not hide: the check node itself times out,
   * because the thing it is checking is down. That run proves nothing either
   * way, so it neither advances the streak nor resets it - and the page still
   * arrives once enough runs have actually seen the condition. Before, it
   * reset the count, and on a check that failed every other run the page
   * never arrived at all.
   */
  it("keeps the streak across a run whose check errored", async () => {
    recordRun("success", [TRIGGER_NODE]);
    recordRun("error", []);
    const second = recordRun("success", [TRIGGER_NODE]);
    pagerDutyIsHealthy();

    expect(await runTrigger(second, triggerConfig)).toMatchObject({
      status: "held",
      consecutiveRuns: 2,
    });

    const third = recordRun("success", [TRIGGER_NODE]);
    pagerDutyIsHealthy();
    expect(await runTrigger(third, triggerConfig)).toMatchObject({
      status: "triggered",
      delivered: true,
      consecutiveRuns: 3,
    });
  });

  it("is cleared by a genuinely healthy run and starts again", async () => {
    recordRun("success", [TRIGGER_NODE]);
    recordRun("success", []);
    const run = recordRun("success", [TRIGGER_NODE]);
    pagerDutyIsHealthy();

    expect(await runTrigger(run, triggerConfig)).toMatchObject({
      status: "held",
      consecutiveRuns: 1,
    });
  });

  /**
   * A run the platform refused before it started, one somebody cancelled
   * mid-flight, one the executor lost. None of them reached the node and none
   * of them says the vault recovered, so the streak survives - it just does
   * not advance on the strength of a run that never looked.
   */
  it.each(["skipped", "cancelled", "system_error", "phantom"])(
    "is not cleared by a %s run",
    async (status) => {
      recordRun("success", [TRIGGER_NODE]);
      recordRun(status, []);
      const run = recordRun("success", [TRIGGER_NODE]);
      pagerDutyIsHealthy();

      expect(await runTrigger(run, triggerConfig)).toMatchObject({
        status: "held",
        consecutiveRuns: 2,
      });
    }
  );

  it("closes the alert it opened when the vault recovers", async () => {
    const paging = recordRun("success", [TRIGGER_NODE]);
    pagerDutyIsHealthy();
    const paged = await runTrigger(paging, {
      ...triggerConfig,
      consecutiveRuns: 1,
    });
    expect(paged).toMatchObject({ status: "triggered" });

    const resolveConfig = configureAsEditor("resolve-incident", {
      pagerdutyServiceId: "PSVC1",
      dedupKeyFromNodeId: TRIGGER_NODE,
    });
    // The routing key is still warm from the page a moment ago, so the resolve
    // costs the event and the read-back - not another two REST reads. That
    // cache is the reason a REST blip cannot stop a page.
    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(
        response(200, {
          incidents: [
            { id: "PINC1", status: "resolved", html_url: "https://x" },
          ],
        })
      );

    const resolved = (await resolveIncidentStep({
      integrationId: "int-pd",
      ...resolveConfig,
      _context: {
        nodeId: RESOLVE_NODE,
        nodeName: "Close the page",
        nodeType: "pagerduty/resolve-incident",
        workflowId: WORKFLOW_ID,
        executionId: "exec-recovery",
        organizationId: "org-1",
      },
    } as never)) as Record<string, unknown>;

    // The key the resolve sent has to be the key the trigger opened.
    expect(resolved).toMatchObject({
      delivered: true,
      dedupKey: paged.dedupKey,
      incidentStatus: "resolved",
    });
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });
});

/**
 * The same node built by an API or MCP caller rather than the editor. Nothing
 * seeds defaults on that path, so whatever the step does with an absent value
 * is what that user gets.
 */
describe("simulation: a node created through the API rather than the editor", () => {
  it("still confirms the resolve with PagerDuty", async () => {
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
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC1", status: "resolved" }] })
      );

    const result = (await resolveIncidentStep({
      integrationId: "int-pd",
      // Exactly what an MCP caller sends: the required fields, nothing else.
      pagerdutyServiceId: "PSVC1",
      dedupKey: "keeperhub/wf/node-page",
      _context: {
        nodeId: RESOLVE_NODE,
        nodeName: "Close",
        nodeType: "pagerduty/resolve-incident",
        workflowId: WORKFLOW_ID,
        organizationId: "org-1",
      },
    } as never)) as Record<string, unknown>;

    expect(result).toMatchObject({ delivered: true });
    // The action's own default is "read the incident back", and the docs say
    // so. A caller that did not mention the field must get that, not silence.
    expect(result.incidentStatus).toBe("resolved");
  });
});

describe("simulation: things that go wrong while it is live", () => {
  const triggerConfig = configureAsEditor("trigger-incident", {
    pagerdutyServiceId: "PSVC1",
    summary: "Keeper stalled",
    backupIntegrationId: "int-discord",
  });

  it("falls back to Discord when the PagerDuty token is revoked", async () => {
    mockFetchCredentials
      .mockResolvedValueOnce({ PAGERDUTY_API_TOKEN: "revoked" })
      .mockResolvedValueOnce({
        webhookUrl: "https://discord.com/api/webhooks/1/abc",
      });
    safeFetch
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(response(204, {}));

    const run = recordRun("success", [TRIGGER_NODE]);
    const result = await runTrigger(run, {
      ...triggerConfig,
      failOnError: false,
    });

    expect(result).toMatchObject({
      delivered: false,
      status: "failed",
      backupAttempted: true,
      backupDelivered: true,
      backupChannel: "discord",
    });
    const posted = String(
      (safeFetch.mock.calls.at(-1) as [string, { body: string }])[1].body
    );
    expect(posted).toContain("PagerDuty page FAILED");
    expect(posted).toContain("PSVC1");
  });

  it("does not claim a page when a maintenance window swallows the event", async () => {
    pagerDutyIsHealthy("maintenance");
    const run = recordRun("success", [TRIGGER_NODE]);
    const result = await runTrigger(run, triggerConfig);

    expect(result).toMatchObject({
      delivered: true,
      status: "suppressed",
      suppressedByService: true,
    });
  });

  it("refuses to pretend, and fires the backup, on a disabled service", async () => {
    mockFetchCredentials
      .mockResolvedValueOnce({ PAGERDUTY_API_TOKEN: "tok" })
      .mockResolvedValueOnce({
        webhookUrl: "https://discord.com/api/webhooks/1/abc",
      });
    pagerDutyIsHealthy("disabled");
    safeFetch.mockResolvedValue(response(204, {}));
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            status: "disabled",
            integrations: [
              { id: "PI1", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        response(200, { integration: { integration_key: "R1" } })
      )
      .mockResolvedValueOnce(response(204, {}));

    const run = recordRun("success", [TRIGGER_NODE]);
    const result = await runTrigger(run, {
      ...triggerConfig,
      failOnError: false,
    });

    expect(result).toMatchObject({
      delivered: false,
      status: "failed",
      backupDelivered: true,
    });
    expect(String(result.error)).toContain("disabled");
  });
});

/**
 * Duplicating a workflow gives every node a new id. The resolve action names
 * the trigger node by bare id rather than by template, so unless that id is
 * remapped with the rest, the copy closes an alert the copy never opened -
 * and PagerDuty answers 202 to that, so nothing anywhere says otherwise.
 */
describe("simulation: the workflow is duplicated", () => {
  const COPY_WORKFLOW = "wf-vault-health-copy";
  const COPY_TRIGGER = "node-page-copy";

  it("closes the copy's own alert, not the original's", () => {
    const idMap = new Map([[TRIGGER_NODE, COPY_TRIGGER]]);
    const original = configureAsEditor("resolve-incident", {
      pagerdutyServiceId: "PSVC1",
      dedupKeyFromNodeId: TRIGGER_NODE,
    });

    const copied = remapNodeReferencesInConfig(
      original,
      idMap,
      new Set(["dedupKeyFromNodeId"])
    ) as Record<string, unknown>;

    // The alert the copy's own trigger node opens.
    const openedByCopy = deriveDedupKey(undefined, {
      workflowId: COPY_WORKFLOW,
      nodeId: COPY_TRIGGER,
    });
    expect(
      deriveDedupKey(undefined, {
        workflowId: COPY_WORKFLOW,
        nodeId: String(copied.dedupKeyFromNodeId),
      })
    ).toBe(openedByCopy);

    // What the copy resolved before the reference travelled with it: the new
    // workflow, the original's node. A key no alert has ever carried, which
    // PagerDuty accepts with a 202 and drops.
    expect(
      deriveDedupKey(undefined, {
        workflowId: COPY_WORKFLOW,
        nodeId: TRIGGER_NODE,
      })
    ).not.toBe(openedByCopy);
  });
});

describe("simulation: runs that overlap, and the very first run", () => {
  const triggerConfig = configureAsEditor("trigger-incident", {
    pagerdutyServiceId: "PSVC1",
    summary: "Keeper stalled",
    consecutiveRuns: 3,
  });

  it("holds the first run a brand new workflow ever makes", async () => {
    const run = recordRun("success", [TRIGGER_NODE]);
    pagerDutyIsHealthy();
    expect(await runTrigger(run, triggerConfig)).toMatchObject({
      status: "held",
      consecutiveRuns: 1,
      requiredRuns: 3,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  /**
   * A schedule whose runs overlap. The sibling started after this one and has
   * not reached the node yet; counting it as a run that skipped the node would
   * break the streak on every single run and hold the page forever.
   */
  it("ignores a sibling run that started after this one", async () => {
    const first = recordRun("success", [TRIGGER_NODE]);
    const second = recordRun("success", [TRIGGER_NODE]);
    recordRun("running", []);

    pagerDutyIsHealthy();
    currentRun.startedAt = second.startedAt;
    expect(await runTrigger(second, triggerConfig)).toMatchObject({
      consecutiveRuns: 2,
    });
    expect(first.startedAt < second.startedAt).toBe(true);
  });
});

describe("simulation: acknowledge while somebody looks, then resolve", () => {
  it("acknowledges and resolves the same alert the trigger opened", async () => {
    const run = recordRun("success", [TRIGGER_NODE]);
    pagerDutyIsHealthy();
    const paged = await runTrigger(run, {
      ...configureAsEditor("trigger-incident", {
        pagerdutyServiceId: "PSVC1",
        summary: "Keeper stalled",
      }),
    });

    const shared = {
      integrationId: "int-pd",
      ...configureAsEditor("acknowledge-incident", {
        pagerdutyServiceId: "PSVC1",
        dedupKeyFromNodeId: TRIGGER_NODE,
      }),
      _context: {
        nodeId: "node-ack",
        nodeName: "Acknowledge",
        nodeType: "pagerduty/acknowledge-incident",
        workflowId: WORKFLOW_ID,
        organizationId: "org-1",
      },
    };

    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC1", status: "acknowledged" }] })
      );
    const acked = (await acknowledgeIncidentStep(shared as never)) as Record<
      string,
      unknown
    >;

    expect(acked).toMatchObject({
      delivered: true,
      action: "acknowledge",
      dedupKey: paged.dedupKey,
      incidentStatus: "acknowledged",
    });

    safeFetch.mockReset();
    safeFetch
      .mockResolvedValueOnce(response(202, { status: "success" }))
      .mockResolvedValueOnce(
        response(200, { incidents: [{ id: "PINC1", status: "resolved" }] })
      );
    const resolved = (await resolveIncidentStep({
      ...shared,
      ...configureAsEditor("resolve-incident", {
        pagerdutyServiceId: "PSVC1",
        dedupKeyFromNodeId: TRIGGER_NODE,
      }),
      _context: { ...shared._context, nodeId: RESOLVE_NODE },
    } as never)) as Record<string, unknown>;

    expect(resolved).toMatchObject({
      dedupKey: paged.dedupKey,
      incidentStatus: "resolved",
    });
  });
});

/**
 * The first-timer's mistake the setup instructions make likely: the connection
 * holds the read-only key the docs told them to create, and then they reach
 * for the one action that writes.
 */
describe("simulation: Create Incident on a read-only connection", () => {
  it("says the key is read-only rather than repeating PagerDuty's Access Denied", async () => {
    mockFetchCredentials.mockResolvedValue({
      PAGERDUTY_API_TOKEN: "readonly",
      PAGERDUTY_FROM_EMAIL: "ops@acme.io",
    });
    safeFetch.mockResolvedValueOnce(
      response(403, { error: { message: "Access Denied" } })
    );

    const result = (await createIncidentStep({
      integrationId: "int-pd",
      ...configureAsEditor("create-incident", {
        pagerdutyServiceId: "PSVC1",
        title: "Page the database rota directly",
      }),
      failOnError: false,
      _context: {
        nodeId: "node-create",
        nodeName: "Create",
        nodeType: "pagerduty/create-incident",
        workflowId: WORKFLOW_ID,
        organizationId: "org-1",
      },
    } as never)) as Record<string, unknown>;

    const message = String(result.error);
    expect(message).toContain("read-only");
    expect(message).toContain("Access Denied");
  });
});

/**
 * Two nodes, or two runs, hitting PagerDuty at the same moment.
 *
 * Everything this node sends carries a dedup key, which is what makes the
 * concurrent cases safe rather than lucky: PagerDuty merges repeat triggers
 * sharing a key into the one open alert. These pin that down, and pin down the
 * one ordering that is genuinely unsafe.
 */
describe("simulation: two nodes fire at once", () => {
  const sharedConfig = configureAsEditor("trigger-incident", {
    pagerdutyServiceId: "PSVC1",
    summary: "Keeper stalled",
  });

  /**
   * Two runs of the same workflow overlapping - a schedule firing faster than
   * the workflow finishes. Both reach the node, both derive the same key from
   * the node id, and PagerDuty folds them into one alert. One page, not two.
   */
  it("sends one alert for two overlapping runs of the same node", async () => {
    const first = recordRun("success", [TRIGGER_NODE]);
    const second = recordRun("success", [TRIGGER_NODE]);

    pagerDutyIsHealthy();
    const a = await runTrigger(first, sharedConfig);
    pagerDutyIsHealthy();
    const b = await runTrigger(second, sharedConfig);

    expect(a.dedupKey).toBe(b.dedupKey);
    expect(a).toMatchObject({ delivered: true });
    expect(b).toMatchObject({ delivered: true });
  });

  /**
   * Two genuinely concurrent calls, awaited together. The routing key cache is
   * a plain Map behind an await, so both can miss and both can fetch; the
   * point is that both still send, with the same key, and neither corrupts
   * what the other cached.
   */
  it("survives two calls racing through the routing key cache", async () => {
    const first = recordRun("success", [TRIGGER_NODE]);
    const second = recordRun("success", [TRIGGER_NODE]);

    safeFetch.mockReset();
    safeFetch.mockImplementation((url: string) => {
      if (String(url).includes("/integrations/")) {
        return Promise.resolve(
          response(200, { integration: { integration_key: "R1" } })
        );
      }
      if (String(url).includes("/services/")) {
        return Promise.resolve(
          response(200, {
            service: {
              status: "active",
              integrations: [
                { id: "PI1", type: "events_api_v2_inbound_integration" },
              ],
            },
          })
        );
      }
      return Promise.resolve(response(202, { status: "success" }));
    });

    const [a, b] = await Promise.all([
      runTrigger(first, sharedConfig),
      runTrigger(second, sharedConfig),
    ]);

    expect(a).toMatchObject({ delivered: true, status: "triggered" });
    expect(b).toMatchObject({ delivered: true, status: "triggered" });
    expect(a.dedupKey).toBe(b.dedupKey);
  });

  /**
   * Two different nodes deliberately given the same explicit dedup key. They
   * share one alert, which is what a shared key means - and it also means a
   * resolve on either closes the alert the other opened. Worth knowing, and
   * the reason the dedup key help text calls this out.
   */
  it("gives two nodes with the same explicit key one shared alert", async () => {
    const run = recordRun("success", [TRIGGER_NODE]);
    pagerDutyIsHealthy();
    const fromA = await runTrigger(run, {
      ...sharedConfig,
      dedupKey: "vault-0xabc",
    });

    currentRun.nodeId = "node-other";
    pagerDutyIsHealthy();
    const fromB = (await triggerIncidentStep({
      integrationId: "int-pd",
      ...sharedConfig,
      dedupKey: "vault-0xabc",
      _context: {
        nodeId: "node-other",
        nodeName: "Second pager",
        nodeType: "pagerduty/trigger-incident",
        workflowId: WORKFLOW_ID,
        executionId: run.id,
        organizationId: "org-1",
      },
    } as never)) as unknown as Record<string, unknown>;

    expect(fromA.dedupKey).toBe("vault-0xabc");
    expect(fromB.dedupKey).toBe("vault-0xabc");
  });

  /**
   * The one ordering that genuinely loses: a resolve arriving before the
   * trigger it was meant to close. PagerDuty drops an update whose key matches
   * no open alert, answering 202, and the trigger then opens an alert nobody
   * closes.
   *
   * A node cannot reorder two runs. What it can do is not report success at
   * the resolve, and it does: the read-back is on by default and comes back
   * with no incident to show, which is the only signal there is.
   */
  it("reports a resolve that arrived before its trigger as closing nothing", async () => {
    safeFetch.mockReset();
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
      // PagerDuty takes the resolve and drops it: nothing carries that key yet.
      .mockResolvedValueOnce(response(202, { status: "success" }))
      // ...so the read-back finds no incident.
      .mockResolvedValueOnce(response(200, { incidents: [] }));

    const resolved = (await resolveIncidentStep({
      integrationId: "int-pd",
      ...configureAsEditor("resolve-incident", {
        pagerdutyServiceId: "PSVC1",
        dedupKeyFromNodeId: TRIGGER_NODE,
      }),
      _context: {
        nodeId: RESOLVE_NODE,
        nodeName: "Close",
        nodeType: "pagerduty/resolve-incident",
        workflowId: WORKFLOW_ID,
        organizationId: "org-1",
      },
    } as never)) as Record<string, unknown>;

    // PagerDuty accepted the event, so `delivered` is true and says nothing.
    expect(resolved.delivered).toBe(true);
    // The read-back is the part that does say something.
    expect(resolved.incidentStatus).toBe("unknown");
  });

  /**
   * The same race with the delay field set. The resolve holds back before
   * sending, the trigger lands in the meantime, and the resolve then closes a
   * real alert instead of being dropped.
   */
  it("loses that race deliberately when the resolve is told to wait", async () => {
    const arrived: string[] = [];
    let triggerHasLanded = false;

    mockSleep.mockImplementation(() => {
      // What the wait is for: the trigger's event reaching PagerDuty first.
      triggerHasLanded = true;
      arrived.push("trigger");
      return Promise.resolve(undefined);
    });

    safeFetch.mockReset();
    safeFetch.mockImplementation((url: string) => {
      const target = String(url);
      if (target.includes("/integrations/")) {
        return Promise.resolve(
          response(200, { integration: { integration_key: "R1" } })
        );
      }
      if (target.includes("/services/")) {
        return Promise.resolve(
          response(200, {
            service: {
              status: "active",
              integrations: [
                { id: "PI1", type: "events_api_v2_inbound_integration" },
              ],
            },
          })
        );
      }
      if (target.includes("/incidents")) {
        // PagerDuty has the alert only because the trigger got there first.
        return Promise.resolve(
          response(200, {
            incidents: triggerHasLanded
              ? [{ id: "PINC1", status: "resolved" }]
              : [],
          })
        );
      }
      arrived.push("resolve");
      return Promise.resolve(response(202, { status: "success" }));
    });

    const resolved = (await resolveIncidentStep({
      integrationId: "int-pd",
      ...configureAsEditor("resolve-incident", {
        pagerdutyServiceId: "PSVC1",
        dedupKeyFromNodeId: TRIGGER_NODE,
        sendDelaySeconds: 2,
      }),
      _context: {
        nodeId: RESOLVE_NODE,
        nodeName: "Close",
        nodeType: "pagerduty/resolve-incident",
        workflowId: WORKFLOW_ID,
        organizationId: "org-1",
      },
    } as never)) as Record<string, unknown>;

    expect(mockSleep).toHaveBeenCalledWith(2000);
    expect(arrived).toEqual(["trigger", "resolve"]);
    expect(resolved).toMatchObject({
      delivered: true,
      delayedSeconds: 2,
      incidentStatus: "resolved",
    });
  });
});
