/**
 * Protocol docUrl Reachability Integration Tests
 *
 * Verifies that every docUrl referenced from a protocol input override points
 * to a live documentation page (HTTP 2xx). Iterates all registered protocols
 * via `getRegisteredProtocols()`, collects unique docUrls, and makes one HTTP
 * request per URL.
 *
 * Deliberately NOT gated: stale or broken docs links should surface on every
 * PR, not hide behind an opt-in flag. If a referenced doc page is moved or
 * removed, CI breaks here until a protocol maintainer updates the URL.
 *
 * Today this covers Chainlink (CCIP_DOCS). As other protocols adopt the
 * helpTip + docUrl pattern, they are picked up automatically - no changes
 * to this file required.
 *
 * Defensive measures against CI getting bot-blocked or rate-limited as the
 * test grows:
 * - Descriptive User-Agent identifies requests as a good-faith CI check
 *   rather than anonymous bot traffic
 * - Per-host serialization with a short gap between successive requests to
 *   the same hostname, keeping cross-host requests parallel-friendly
 * - One retry on HTTP 429 (Too Many Requests) after a fixed backoff
 */

import { describe, expect, it } from "vitest";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
// Side-effect import: registers every protocol definition so the registry
// is populated when the test iterates it.
import "@/protocols";

type FetchOpts = { method: "HEAD" | "GET"; redirect: "follow" };

const REQUEST_TIMEOUT_MS = 15_000;
const SAME_HOST_GAP_MS = 250;
const RATE_LIMIT_BACKOFF_MS = 2000;
const USER_AGENT =
  "KeeperHub-docs-link-check/1.0 (+https://github.com/KeeperHub/keeperhub)";

const HEAD_OPTS: FetchOpts = { method: "HEAD", redirect: "follow" };
const GET_OPTS: FetchOpts = { method: "GET", redirect: "follow" };

// Tracks the last-request timestamp per hostname so successive calls against
// the same host honour SAME_HOST_GAP_MS. Module-scoped so the throttle spans
// every it() block in this file regardless of vitest's internal test order.
const lastRequestAtByHost = new Map<string, number>();

function collectDocUrls(): string[] {
  const urls = new Set<string>();
  const protocols = getRegisteredProtocols();
  for (const protocol of protocols) {
    for (const action of protocol.actions) {
      for (const input of action.inputs) {
        if (input.docUrl) {
          urls.add(input.docUrl);
        }
      }
    }
  }
  return Array.from(urls).sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttlePerHost(url: string): Promise<void> {
  const host = new URL(url).host;
  const last = lastRequestAtByHost.get(host);
  if (last !== undefined) {
    const elapsed = Date.now() - last;
    if (elapsed < SAME_HOST_GAP_MS) {
      await sleep(SAME_HOST_GAP_MS - elapsed);
    }
  }
  lastRequestAtByHost.set(host, Date.now());
}

async function fetchWithTimeout(
  url: string,
  opts: FetchOpts,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkOnce(
  url: string
): Promise<{ status: number; via: string }> {
  const head = await fetchWithTimeout(url, HEAD_OPTS, REQUEST_TIMEOUT_MS);
  if (head.status === 405 || head.status === 501) {
    // Some hosts reject HEAD; retry with GET for those specific codes.
    const get = await fetchWithTimeout(url, GET_OPTS, REQUEST_TIMEOUT_MS);
    return { status: get.status, via: "GET" };
  }
  return { status: head.status, via: "HEAD" };
}

async function checkUrl(url: string): Promise<{ status: number; via: string }> {
  await throttlePerHost(url);
  const first = await checkOnce(url);
  if (first.status !== 429) {
    return first;
  }
  // Rate-limited: back off and retry once. A single retry is enough to clear
  // transient bursts; sustained 429s indicate a genuine block and should fail.
  await sleep(RATE_LIMIT_BACKOFF_MS);
  await throttlePerHost(url);
  return checkOnce(url);
}

describe("Protocol docUrl reachability", () => {
  const urls = collectDocUrls();

  it("there is at least one docUrl registered across all protocols", () => {
    expect(urls.length).toBeGreaterThan(0);
  });

  // One test per URL so a single broken link surfaces as a specific failure
  // rather than masking the rest.
  for (const url of urls) {
    it(
      `reaches 2xx: ${url}`,
      async () => {
        const { status, via } = await checkUrl(url);
        expect(
          status,
          `${url} returned ${status} via ${via} - expected 2xx`
        ).toBeGreaterThanOrEqual(200);
        expect(status).toBeLessThan(300);
      },
      REQUEST_TIMEOUT_MS * 2 + RATE_LIMIT_BACKOFF_MS + 5000
    );
  }
});
