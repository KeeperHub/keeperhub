import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HermesPrice,
  consumeHermesStream,
} from "../../src/pyth/hermes-stream";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../lib/utils/logger", () => ({ logger: { warn } }));

const feedId = "a".repeat(64);
const frame = (publishTime: number): string =>
  `data: ${JSON.stringify({
    parsed: [
      {
        id: feedId,
        price: {
          price: String(publishTime),
          conf: "1",
          expo: 0,
          publish_time: publishTime,
        },
      },
    ],
  })}\n\n`;

let push: (text: string) => void;
let upstream: AbortSignal;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: URL, init: RequestInit) => {
      upstream = init.signal as AbortSignal;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
          upstream.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open(onPrice: (price: HermesPrice) => Promise<void>) {
  const stop = new AbortController();
  const stream = consumeHermesStream({
    apiKey: "test-only-key",
    feedId,
    signal: stop.signal,
    onPrice,
  });
  await vi.advanceTimersByTimeAsync(0);
  return { stop, stream };
}

describe("Hermes stream delivery", () => {
  it("keeps reading during a slow delivery and resumes on the newest price", async () => {
    let release: () => void = () => undefined;
    const delivered: number[] = [];
    const { stop, stream } = await open(async (price) => {
      delivered.push(price.price.publish_time);
      if (delivered.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    push(frame(1));
    await vi.advanceTimersByTimeAsync(0);
    // Delivery outlasts the idle timeout while Hermes keeps sending.
    for (let second = 2; second <= 4; second++) {
      await vi.advanceTimersByTimeAsync(10_000);
      push(frame(second));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream.aborted).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual([1, 4]);
    stop.abort();
    await stream.catch(() => undefined);
  });

  it("aborts when Hermes goes silent", async () => {
    const { stream } = await open(async () => undefined);
    const outcome = stream.then(
      () => "returned",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(upstream.aborted).toBe(true);
    expect(await outcome).toBe("rejected");
  });

  it("delivers only the first update for each publish time", async () => {
    const delivered: string[] = [];
    const { stop, stream } = await open(async (price) => {
      delivered.push(`${price.price.publish_time}:${price.price.price}`);
    });
    push(frame(5));
    await vi.advanceTimersByTimeAsync(0);
    push(frame(5).replace('"price":"5"', '"price":"6"'));
    push(frame(4));
    push(frame(6));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["5:5", "6:6"]);
    stop.abort();
    await stream.catch(() => undefined);
  });

  it("skips a malformed frame without dropping the connection", async () => {
    const delivered: number[] = [];
    const { stop, stream } = await open(async (price) => {
      delivered.push(price.price.publish_time);
    });
    push("data: {not json\n\n");
    push(frame(7));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual([7]);
    expect(upstream.aborted).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    stop.abort();
    await stream.catch(() => undefined);
  });
});
