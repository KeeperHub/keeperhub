import { describe, expect, it } from "vitest";
import { runGasDisplay } from "@/components/analytics/runs-table";
import {
  normalizeRunsResponse,
  type WireRunsResponse,
} from "@/lib/analytics/runs-response";

// A response shaped by a server older than this bundle: the run carries the
// fields that server knew about and none of the ones added since.
const LEGACY_RESPONSE = {
  runs: [
    {
      id: "run",
      source: "workflow",
      status: "success",
      startedAt: new Date(0).toISOString(),
      completedAt: null,
      durationMs: null,
      workflowId: "wf",
      workflowName: "wf",
      directType: null,
      network: "8453",
      networks: ["8453"],
      gasCostWei: null,
      gasUsedWei: null,
      totalSteps: null,
      completedSteps: null,
      error: null,
      errorCode: null,
      errorType: null,
      errorCategory: null,
    },
  ],
  nextCursor: null,
  total: 1,
  page: 1,
  pageSize: 50,
} satisfies WireRunsResponse;

describe("normalizeRunsResponse", () => {
  it("fills the array fields a stale server omitted", () => {
    const [run] = normalizeRunsResponse(LEGACY_RESPONSE).runs;

    expect(run.gasNetworks).toEqual([]);
    expect(run.transactionHashes).toEqual([]);
    expect(run.networks).toEqual(["8453"]);
  });

  it("renders the gas cell of a normalized stale run without throwing", () => {
    const [run] = normalizeRunsResponse(LEGACY_RESPONSE).runs;

    expect(runGasDisplay(run)).toBe("-");
  });

  it("leaves a current response untouched", () => {
    const response = normalizeRunsResponse({
      ...LEGACY_RESPONSE,
      runs: [
        {
          ...LEGACY_RESPONSE.runs[0],
          gasNetworks: ["8453"],
          transactionHashes: [],
        },
      ],
    });

    expect(response.runs[0].gasNetworks).toEqual(["8453"]);
  });

  it("passes a notification row's detail through untouched", () => {
    const notification = {
      title: "Alert: Nightly sync",
      kind: "alert",
      state: "delivered",
      channel: "email",
      recipient: "ops@example.com",
      connectionName: null,
      isBackup: false,
      attempts: 1,
      lastError: null,
      note: null,
      workflows: [{ id: "wf", name: "Nightly sync" }],
    };
    const [run] = normalizeRunsResponse({
      ...LEGACY_RESPONSE,
      runs: [
        {
          ...LEGACY_RESPONSE.runs[0],
          source: "notification",
          network: null,
          networks: undefined,
          notification,
        },
      ],
    }).runs;

    expect(run.notification).toEqual(notification);
    expect(run.networks).toEqual([]);
    expect(runGasDisplay(run)).toBe("-");
  });
});
