import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiApi } from "@/lib/api-client";

const encoder = new TextEncoder();

type MockStreamOptions = {
  keepOpen?: boolean;
  cancel?: (reason: unknown) => void | Promise<void>;
};

function mockStream(
  chunks: Uint8Array[],
  options: MockStreamOptions = {}
): ReadableStream<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (!options.keepOpen) {
        controller.close();
      }
    },
    cancel: options.cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
  return stream;
}

function mockLines(
  lines: unknown[],
  options: MockStreamOptions = {}
): ReadableStream<Uint8Array> {
  return mockStream(
    [
      encoder.encode(
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
      ),
    ],
    options
  );
}

describe("aiApi.generateStream", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects an in-band server error and cancels the still-open response body", async () => {
    const cancel = vi.fn();
    const stream = mockLines(
      [
        { type: "operation", operation: { op: "setName", name: "Partial" } },
        { type: "error", error: "Model provider unavailable" },
        { type: "operation", operation: { op: "setName", name: "Ignored" } },
      ],
      { keepOpen: true, cancel }
    );
    const onUpdate = vi.fn();

    await expect(
      aiApi.generateStream("Build a workflow", onUpdate)
    ).rejects.toThrow("Model provider unavailable");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({
      nodes: [],
      edges: [],
      name: "Partial",
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[API Client] Error:",
      "Model provider unavailable"
    );
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Model provider unavailable" })
    );
    expect(stream.locked).toBe(false);
  });

  it("rejects an error before any operation and provides a fallback reason", async () => {
    const stream = mockLines([{ type: "error" }]);
    const onUpdate = vi.fn();

    await expect(
      aiApi.generateStream("Build a workflow", onUpdate)
    ).rejects.toThrow("Failed to generate workflow");
    expect(onUpdate).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("accumulates newline-delimited operations across byte boundaries without canceling", async () => {
    const text = `${[
      { type: "operation", operation: { op: "setName", name: "Café" } },
      {
        type: "operation",
        operation: { op: "setDescription", description: "Complete workflow" },
      },
      { type: "complete" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`;
    const bytes = encoder.encode(text);
    const cancel = vi.fn();
    const stream = mockStream(
      Array.from(bytes, (byte) => new Uint8Array([byte])),
      { cancel }
    );
    const onUpdate = vi.fn();

    await expect(
      aiApi.generateStream("Build a workflow", onUpdate)
    ).resolves.toEqual({
      nodes: [],
      edges: [],
      name: "Café",
      description: "Complete workflow",
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("skips malformed and blank lines but processes subsequent valid messages", async () => {
    mockStream([
      encoder.encode(
        '\ninvalid JSON\nnull\n42\n"ignored"\n{"type":"operation","operation":{"op":"setName","name":"Recovered"}}\n{"type":"complete"}\n'
      ),
    ]);

    await expect(
      aiApi.generateStream("Build a workflow", vi.fn())
    ).resolves.toEqual({
      nodes: [],
      edges: [],
      name: "Recovered",
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[API Client] Failed to parse JSONL line:",
      expect.any(SyntaxError)
    );
  });

  it.each([
    { label: "empty", messages: [], expected: { nodes: [], edges: [] } },
    {
      label: "partial",
      messages: [
        { type: "operation", operation: { op: "setName", name: "Partial" } },
      ],
      expected: { nodes: [], edges: [], name: "Partial" },
    },
  ])(
    "preserves the existing EOF behavior for a $label stream without a completion message",
    async ({ messages, expected }) => {
      const stream = mockLines(messages);

      await expect(
        aiApi.generateStream("Build a workflow", vi.fn())
      ).resolves.toEqual(expected);
      expect(stream.locked).toBe(false);
    }
  );

  it("preserves the existing handling of an unterminated final line", async () => {
    mockStream([
      encoder.encode(
        '{"type":"operation","operation":{"op":"setName","name":"Kept"}}\n{"type":"error","error":"Unterminated"}'
      ),
    ]);

    await expect(
      aiApi.generateStream("Build a workflow", vi.fn())
    ).resolves.toEqual({ nodes: [], edges: [], name: "Kept" });
  });

  it("propagates update-callback failures and cancels the still-open response body", async () => {
    const cancel = vi.fn();
    const stream = mockLines(
      [
        { type: "operation", operation: { op: "setName", name: "Workflow" } },
        { type: "complete" },
      ],
      { keepOpen: true, cancel }
    );
    const error = new Error("Update failed");

    await expect(
      aiApi.generateStream("Build a workflow", () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(console.error).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(error);
    expect(stream.locked).toBe(false);
  });

  it("preserves the original failure and releases the lock when cancellation rejects", async () => {
    const error = new Error("Update failed");
    const cancel = vi.fn().mockRejectedValue(new Error("Cleanup failed"));
    const stream = mockLines(
      [{ type: "operation", operation: { op: "setName", name: "Workflow" } }],
      { keepOpen: true, cancel }
    );

    await expect(
      aiApi.generateStream("Build a workflow", () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(error);
    expect(stream.locked).toBe(false);
  });

  it("preserves the existing workflow when the server completes without changes", async () => {
    mockLines([{ type: "complete" }]);
    const existingWorkflow = { nodes: [], edges: [], name: "Existing" };

    await expect(
      aiApi.generateStream("Keep it", vi.fn(), existingWorkflow)
    ).resolves.toEqual(existingWorkflow);
    expect(fetch).toHaveBeenCalledWith("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Keep it", existingWorkflow }),
    });
  });
});
