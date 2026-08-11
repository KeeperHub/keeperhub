/**
 * Verifies persistSuggestion prefills the alert node's recipient with the
 * signed-in user's email. Without this the sendgrid node ships with an empty
 * (schema-required) emailTo and Run / Save fail config validation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  api: { workflow: { execute: mockExecute } },
}));

import { persistSuggestion } from "@/lib/scan/persist-suggestion";
import { buildBaselineSuggestions } from "@/lib/scan/suggestions/baseline";

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

type WorkflowNode = {
  data: { config?: { actionType?: string; emailTo?: string } };
};

function createBodyNodes(mockFetch: ReturnType<typeof vi.fn>): WorkflowNode[] {
  const createCall = mockFetch.mock.calls.find(([url]) =>
    String(url).endsWith("/api/workflows/create")
  );
  const body = JSON.parse(
    ((createCall as unknown[])[1] as { body: string }).body
  ) as {
    nodes: WorkflowNode[];
  };
  return body.nodes;
}

function emailNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.filter(
    (n) => n.data.config?.actionType === "sendgrid/send-email"
  );
}

describe("persistSuggestion email prefill", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ id: "wf_1" });
  });

  it("fills a blank emailTo with the signed-in user's email", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "wf_1" }) });
    vi.stubGlobal("fetch", mockFetch);

    const descriptor = buildBaselineSuggestions(ADDRESS)[0];
    await persistSuggestion(descriptor, "run", {
      defaultEmail: "user@example.com",
    });

    const emails = emailNodes(createBodyNodes(mockFetch));
    expect(emails.length).toBeGreaterThan(0);
    for (const node of emails) {
      expect(node.data.config?.emailTo).toBe("user@example.com");
    }
  });

  it("leaves emailTo blank when no email is provided (anonymous)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "wf_1" }) });
    vi.stubGlobal("fetch", mockFetch);

    const descriptor = buildBaselineSuggestions(ADDRESS)[0];
    await persistSuggestion(descriptor, "run");

    const emails = emailNodes(createBodyNodes(mockFetch));
    expect(emails.length).toBeGreaterThan(0);
    for (const node of emails) {
      expect(node.data.config?.emailTo).toBe("");
    }
  });
});
