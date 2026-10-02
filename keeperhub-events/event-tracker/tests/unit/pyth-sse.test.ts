import { describe, expect, it } from "vitest";
import { SseDecoder, decodeHermesMessage } from "../../src/pyth/hermes-stream";

describe("Hermes SSE parsing", () => {
  it.each(["\n", "\r", "\r\n"])(
    "handles %j delimiters at every chunk boundary",
    (newline) => {
      const decoder = new SseDecoder();
      const source = `:heartbeat${newline}event: message${newline}data: {"parsed":${newline}data: []}${newline}${newline}`;
      const messages = [...source].flatMap((character) =>
        decoder.push(character),
      );
      expect(messages).toEqual(['{"parsed":\n[]}']);
    },
  );

  it("keeps multiple messages separate and ignores events without data", () => {
    expect(
      new SseDecoder().push(":heartbeat\n\nid: 1\n\ndata: one\n\ndata:two\n\n"),
    ).toEqual(["one", "two"]);
  });

  it("never dispatches a partial frame after a disconnect", () => {
    expect(new SseDecoder().push('data: {"parsed":[]')).toEqual([]);
  });

  it("bounds incomplete and multiline messages", () => {
    expect(() => new SseDecoder().push("x".repeat(262_145))).toThrow(
      "size limit",
    );
    expect(() =>
      new SseDecoder().push(
        `data:${"x".repeat(150_000)}\ndata:${"x".repeat(150_000)}\n`,
      ),
    ).toThrow("size limit");
  });

  it("forwards only the requested feed and discards the unused binary payload", () => {
    const price = { price: "100", conf: "1", expo: -8, publish_time: 1000 };
    const messages = decodeHermesMessage(
      JSON.stringify({
        binary: { data: ["unused"] },
        parsed: [
          { id: "feed", price, metadata: {} },
          { id: "other", price },
        ],
      }),
      "feed",
    );
    expect(messages).toEqual([{ id: "feed", price }]);
    expect(() => decodeHermesMessage("{}", "feed")).toThrow("parsed prices");
  });
});
