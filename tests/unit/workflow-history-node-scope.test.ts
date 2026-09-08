import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { api } from "@/lib/api-client";

/**
 * The node-scoped History tab depends on the scope reaching the server: the
 * panel no longer filters the fetched page, so a dropped parameter would show
 * the whole timeline instead of the node's.
 */
describe("api.workflow.getHistory node scope", () => {
  let requestedUrl: string;

  beforeEach(() => {
    requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        requestedUrl = String(input);
        return Promise.resolve(
          new Response(JSON.stringify({ items: [], meta: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      })
    );
  });

  it("forwards the node id and label", async () => {
    await api.workflow.getHistory("wf-1", {
      page: 3,
      limit: 10,
      nodeId: "node-a",
      nodeLabel: "Send Webhook",
    });

    const params = new URL(requestedUrl, "http://localhost").searchParams;
    expect(params.get("page")).toBe("3");
    expect(params.get("limit")).toBe("10");
    expect(params.get("nodeId")).toBe("node-a");
    expect(params.get("nodeLabel")).toBe("Send Webhook");
  });

  it("omits the scope entirely for the unscoped timeline", async () => {
    await api.workflow.getHistory("wf-1", { page: 1, limit: 10 });

    const params = new URL(requestedUrl, "http://localhost").searchParams;
    expect(params.has("nodeId")).toBe(false);
    expect(params.has("nodeLabel")).toBe(false);
  });

  it("omits a null label so a node with no label still scopes by id", async () => {
    await api.workflow.getHistory("wf-1", {
      nodeId: "node-a",
      nodeLabel: null,
    });

    const params = new URL(requestedUrl, "http://localhost").searchParams;
    expect(params.get("nodeId")).toBe("node-a");
    expect(params.has("nodeLabel")).toBe(false);
  });
});
