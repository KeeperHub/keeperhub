/**
 * KEEP-570 — WSS Subscription Comparison Probe
 *
 * Opens TWO independent WebSocket connections to the same URL:
 *   1. A raw `ws` socket that sends eth_subscribe(["newHeads"]) directly.
 *   2. An ethers v6 WebSocketProvider with provider.on("block", cb).
 *
 * Counts incoming frames on each for a fixed window and prints a verdict.
 *
 * Distinguishes the three failure modes the dispatcher cannot tell apart on
 * its own:
 *
 *   raw newHeads > 0, ethers blocks == 0, ethers pushes > 0
 *     ETHERS_ROUTING: pushes arrive at ethers' socket but never reach the
 *     "block" listener. The bug is in ethers' SocketSubscriber lifecycle,
 *     most likely _register never fired because the eth_subscribe response
 *     was lost or the subscriber.start() chain rejected silently.
 *
 *   raw newHeads > 0, ethers blocks == 0, ethers pushes == 0
 *     CONNECTION_SPECIFIC: same URL, different connection, different
 *     behavior. Suggests the upstream is doing per-connection sticky
 *     routing and sending one client to a healthy backend and another to
 *     a zombie one. Less likely but worth seeing.
 *
 *   raw newHeads == 0, ethers blocks == 0
 *     UPSTREAM_SILENT: the endpoint accepts the subscription but never
 *     sends newHeads pushes to anyone. Provider-side issue, not ours.
 *
 *   raw newHeads > 0, ethers blocks > 0
 *     BOTH_HEALTHY: cannot reproduce the bug against this endpoint right
 *     now. Try again when the dispatcher reports a chain stuck.
 *
 * Usage:
 *   pnpm tsx keeperhub-scheduler/debug/wss-compare.ts <wss-url> [duration-seconds]
 *
 * Example:
 *   pnpm tsx keeperhub-scheduler/debug/wss-compare.ts \
 *     'wss://lb.drpc.live/polygon/<key>' 60
 *
 * To probe a Cloudflare-Access-gated primary, run this inside the cluster:
 *   kubectl run probe --rm -it --image=node:24-slim --restart=Never -- \
 *     sh -c 'npm i ethers ws tsx >/dev/null && \
 *            npx tsx https://raw.githubusercontent.com/.../wss-compare.ts <url>'
 */

import { ethers } from "ethers";
import WebSocket from "ws";

const url = process.argv[2];
const durationSec = Number.parseInt(process.argv[3] ?? "60", 10);
if (!url) {
  console.error(
    "usage: pnpm tsx keeperhub-scheduler/debug/wss-compare.ts <wss-url> [duration-seconds]",
  );
  process.exit(1);
}

console.log(`Probing ${url} for ${durationSec}s`);
console.log("─".repeat(72));

// ---------------------------------------------------------------------------
// Raw ws probe
// ---------------------------------------------------------------------------

const rawWs = new WebSocket(url);
let rawSubscriptionId: string | null = null;
let rawNewHeads = 0;
let rawAllFrames = 0;
const rawStartedAt = Date.now();

rawWs.on("open", () => {
  console.log(`[raw] open at +${Date.now() - rawStartedAt}ms`);
  rawWs.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: ["newHeads"],
    }),
  );
});

rawWs.on("message", (data: Buffer) => {
  rawAllFrames++;
  let msg: { id?: number; result?: string; method?: string };
  try {
    msg = JSON.parse(data.toString("utf8"));
  } catch {
    return;
  }
  if (msg.id === 1 && typeof msg.result === "string") {
    rawSubscriptionId = msg.result;
    console.log(
      `[raw] subscribed at +${Date.now() - rawStartedAt}ms id=${rawSubscriptionId}`,
    );
    return;
  }
  if (msg.method === "eth_subscription") {
    rawNewHeads++;
  }
});

rawWs.on("error", (err: Error) => {
  console.error(`[raw] error: ${err.message}`);
});

rawWs.on("close", (code: number, reason: Buffer) => {
  console.log(
    `[raw] close code=${code} reason=${reason.toString() || "(none)"}`,
  );
});

// ---------------------------------------------------------------------------
// Ethers v6 probe (same code path as the dispatcher)
// ---------------------------------------------------------------------------

const ethersProvider = new ethers.WebSocketProvider(url);
let ethersBlocks = 0;
let ethersAllFrames = 0;
let ethersPushFrames = 0;
const ethersStartedAt = Date.now();

const ethersWs = ethersProvider.websocket as unknown as {
  on?: (event: string, cb: (data: unknown) => void) => void;
};
ethersWs.on?.("message", (data: unknown) => {
  ethersAllFrames++;
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data instanceof Buffer) {
    text = data.toString("utf8");
  } else {
    return;
  }
  try {
    const parsed = JSON.parse(text) as { method?: string };
    if (parsed.method === "eth_subscription") {
      ethersPushFrames++;
    }
  } catch {
    // ignore non-JSON frames
  }
});

async function startEthersProbe(): Promise<void> {
  // Match the dispatcher's connect path: do a real send to confirm readiness.
  const blockNumber = await ethersProvider.getBlockNumber();
  console.log(
    `[ethers] socket ready at +${Date.now() - ethersStartedAt}ms head=${blockNumber}`,
  );
  await ethersProvider.on("block", (n: number) => {
    ethersBlocks++;
    if (ethersBlocks === 1) {
      console.log(
        `[ethers] first block delivered at +${Date.now() - ethersStartedAt}ms (n=${n})`,
      );
    }
  });
  console.log(
    `[ethers] block listener attached at +${Date.now() - ethersStartedAt}ms`,
  );
}

startEthersProbe().catch((err: unknown) => {
  console.error(
    `[ethers] startup error: ${err instanceof Error ? err.message : String(err)}`,
  );
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

setTimeout(() => {
  console.log("─".repeat(72));
  console.log(`Window: ${durationSec}s`);
  console.log(
    `[raw]    subscriptionId=${rawSubscriptionId ?? "NONE"}, allFrames=${rawAllFrames}, newHeads=${rawNewHeads}`,
  );
  console.log(
    `[ethers] blocks=${ethersBlocks}, allFrames=${ethersAllFrames}, subscriptionPushes=${ethersPushFrames}`,
  );
  console.log("─".repeat(72));

  let verdict: string;
  if (rawNewHeads > 0 && ethersBlocks === 0 && ethersPushFrames > 0) {
    verdict =
      "ETHERS_ROUTING: pushes reached ethers' socket but not the listener. " +
      "Bug is in ethers v6 SocketSubscriber. _register likely never fired.";
  } else if (rawNewHeads > 0 && ethersBlocks === 0 && ethersPushFrames === 0) {
    verdict =
      "CONNECTION_SPECIFIC: raw ws receives pushes on this URL but the " +
      "ethers connection to the same URL receives none. Sticky upstream " +
      "routing or per-connection rate limiting.";
  } else if (rawNewHeads === 0 && ethersBlocks === 0) {
    verdict =
      "UPSTREAM_SILENT: neither client receives newHeads. Endpoint is " +
      "in the prod failure state right now. Provider-side issue.";
  } else if (rawNewHeads > 0 && ethersBlocks > 0) {
    verdict =
      "BOTH_HEALTHY: endpoint is delivering newHeads to both clients. " +
      "Cannot reproduce the bug against this URL in this window.";
  } else {
    verdict = "INCONCLUSIVE: see counters above";
  }
  console.log(`VERDICT: ${verdict}`);

  rawWs.close();
  ethersProvider.destroy().catch(() => {
    // ignore teardown errors
  });
  setTimeout(() => process.exit(0), 500);
}, durationSec * 1000);
