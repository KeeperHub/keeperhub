import { logger } from "../../lib/utils/logger";

const MAX_EVENT_CHARS = 262_144;

/** Incremental SSE decoder: supports CR, LF, CRLF and multiline data fields. */
export class SseDecoder {
  private line = "";
  private data: string[] = [];
  private size = 0;
  private skipLf = false;

  push(text: string): string[] {
    const messages: string[] = [];
    for (const character of text) {
      if (this.skipLf && character === "\n") {
        this.skipLf = false;
        continue;
      }
      this.skipLf = character === "\r";
      if (character === "\r" || character === "\n") {
        if (this.line === "") {
          if (this.data.length > 0) {
            messages.push(this.data.join("\n"));
          }
          this.data = [];
          this.size = 0;
        } else if (this.line === "data" || this.line.startsWith("data:")) {
          const value =
            this.line === "data" ? "" : this.line.slice(5).replace(/^ /, "");
          this.data.push(value);
          this.size += value.length + 1;
        }
        this.line = "";
      } else {
        this.line += character;
      }
      if (this.size + this.line.length > MAX_EVENT_CHARS) {
        throw new Error("Hermes SSE event exceeded the size limit");
      }
    }
    return messages;
  }
}

export type HermesPrice = {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
};

export function decodeHermesMessage(
  data: string,
  feedId: string,
): HermesPrice[] {
  const message = JSON.parse(data) as { parsed?: HermesPrice[] };
  if (!message || !Array.isArray(message.parsed)) {
    throw new Error("Hermes message has no parsed prices");
  }
  return message.parsed
    .filter((update) => update && update.id === feedId && update.price)
    .map((update) => ({ id: update.id, price: update.price }));
}

/** One connection; the registry owns retries and what a reconnect means. */
export async function consumeHermesStream(options: {
  apiKey: string;
  feedId: string;
  signal: AbortSignal;
  onPrice: (price: HermesPrice) => Promise<void>;
}): Promise<void> {
  // Fixed provider origin: workflow configuration cannot redirect the API key.
  const url = new URL(
    "https://pyth.dourolabs.app/hermes/v2/updates/price/stream",
  );
  url.searchParams.set("ids[]", options.feedId);
  url.searchParams.set("parsed", "true");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) {
    controller.abort();
  }
  let timeout = setTimeout(abort, 10_000);
  // Reading never waits on delivery. Prices that arrive while one is being
  // delivered replace each other, so a slow fan-out resumes on the freshest
  // price instead of backing up the socket and ageing a queue past
  // maxAgeSeconds.
  let latest: HermesPrice | null = null;
  let latestPublishTime = 0;
  let delivering = false;
  let delivery: Promise<void> | undefined;
  const deliver = async (): Promise<void> => {
    delivering = true;
    try {
      while (latest && !controller.signal.aborted) {
        const price: HermesPrice = latest;
        latest = null;
        await options.onPrice(price);
      }
    } finally {
      delivering = false;
    }
  };
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "text/event-stream",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Hermes stream returned HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("Hermes returned an unexpected content type");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = new SseDecoder();
    try {
      while (!controller.signal.aborted) {
        // The idle timeout measures Hermes silence, never delivery time.
        clearTimeout(timeout);
        timeout = setTimeout(abort, 20_000);
        const { done, value } = await reader.read();
        clearTimeout(timeout);
        if (done) {
          return;
        }
        for (const data of events.push(
          decoder.decode(value, { stream: true }),
        )) {
          try {
            for (const price of decodeHermesMessage(data, options.feedId)) {
              // Hermes sends several updates per publish_time, and evaluation
              // rejects all but the first as out_of_order, so the rest would
              // only cost a round trip and a transaction per workflow.
              if (price.price.publish_time > latestPublishTime) {
                latestPublishTime = price.price.publish_time;
                latest = price;
              }
            }
          } catch {
            // One bad frame must not tear down every workflow on the feed.
            logger.warn(
              `[Pyth] skipped a malformed Hermes message on feed ${options.feedId}`,
            );
          }
        }
        if (latest && !delivering) {
          delivery = deliver().catch(abort);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
    controller.abort();
    // Never return while a fan-out is in flight: the next connection would
    // interleave observations for the same workflows.
    await delivery;
  }
}
