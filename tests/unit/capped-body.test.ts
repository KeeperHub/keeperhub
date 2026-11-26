import { describe, expect, it, vi } from "vitest";
import { readCappedBody } from "@/lib/web3/capped-body";

const encoder = new TextEncoder();

// A body served in the given chunks; `cancel` records a cancelled stream.
function streamed(
  chunks: string[],
  options: { cancel?: () => void; failAfter?: boolean } = {}
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      if (options.failAfter) {
        controller.error(new Error("socket hang up"));
        return;
      }
      controller.close();
    },
    cancel: options.cancel,
  });
  return new Response(stream);
}

describe("readCappedBody", () => {
  it("reads a body at or under the cap", async () => {
    expect(await readCappedBody(streamed(["ab", "cd"]), 4)).toBe("abcd");
    expect(await readCappedBody(new Response("hello"), 1024)).toBe("hello");
  });

  it("reads a missing body as empty text", async () => {
    expect(await readCappedBody(new Response(null, { status: 204 }), 4)).toBe(
      ""
    );
  });

  it("stops past the cap and cancels the stream", async () => {
    const cancel = vi.fn();
    const result = await readCappedBody(
      streamed(["abc", "def", "ghi"], { cancel }),
      4
    );
    expect(result).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("swallows an error from the cancel itself", async () => {
    const result = await readCappedBody(
      streamed(["abcdef"], {
        cancel: () => {
          throw new Error("cancel failed");
        },
      }),
      4
    );
    expect(result).toBeUndefined();
  });

  it("refuses a declared length over the cap without reading", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-length": "99" },
    });
    expect(await readCappedBody(response, 4)).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reads a stream that fails part way as undefined", async () => {
    expect(
      await readCappedBody(streamed(["ab"], { failAfter: true }), 1024)
    ).toBeUndefined();
  });

  it("decodes a character split across chunks and drops a byte-order mark", async () => {
    const bytes = encoder.encode(`${String.fromCodePoint(0xfe_ff)}{"a":"é"}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 3));
        controller.enqueue(bytes.slice(bytes.length - 3));
        controller.close();
      },
    });
    const text = await readCappedBody(new Response(stream), 1024);
    expect(text).toBe('{"a":"é"}');
    expect(JSON.parse(text ?? "")).toEqual({ a: "é" });
  });
});
