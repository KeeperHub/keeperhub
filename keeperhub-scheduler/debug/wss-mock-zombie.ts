/**
 * KEEP-570 — Mock WSS Server with Selectable Failure Modes
 *
 * Speaks just enough JSON-RPC for ethers v6's WebSocketProvider startup
 * (eth_chainId, eth_blockNumber, net_version, eth_subscribe) and then
 * behaves according to the chosen scenario. Lets us reproduce each of the
 * three suspected failure modes offline.
 *
 * Scenarios:
 *
 *   healthy
 *     Responds to eth_subscribe with a subscription ID and pushes a
 *     newHeads notification every 2 seconds. Baseline / control.
 *
 *   zombie
 *     Responds to eth_subscribe with a subscription ID. Never pushes any
 *     newHeads. Reproduces what Joel observed in prod: "Block subscription
 *     active" + zero newHeads.
 *
 *   subscribe-no-response
 *     Receives the eth_subscribe but never sends back a response. The
 *     ethers SocketSubscriber's #filterId promise never resolves and
 *     _register is never called. Any push that did arrive afterward would
 *     queue in #pending. Reproduces the ethers v6 sharp edge directly.
 *
 *   push-without-register
 *     Responds to eth_subscribe with a subscription ID and starts pushing
 *     newHeads BEFORE the response is fully processed. Tests whether
 *     ethers' #pending queue actually flushes correctly. Use to verify
 *     the queue mechanism on a known-good ethers version.
 *
 * Usage:
 *   pnpm tsx keeperhub-scheduler/debug/wss-mock-zombie.ts <scenario> [port]
 *
 * Example session:
 *   # terminal 1
 *   pnpm tsx keeperhub-scheduler/debug/wss-mock-zombie.ts zombie 8546
 *   # terminal 2
 *   pnpm tsx keeperhub-scheduler/debug/wss-compare.ts ws://localhost:8546 30
 */

import { type WebSocket, WebSocketServer } from "ws";

type Scenario =
  | "healthy"
  | "zombie"
  | "subscribe-no-response"
  | "push-without-register";

const scenario = (process.argv[2] ?? "zombie") as Scenario;
const port = Number.parseInt(process.argv[3] ?? "8546", 10);

const VALID_SCENARIOS: Scenario[] = [
  "healthy",
  "zombie",
  "subscribe-no-response",
  "push-without-register",
];
if (!VALID_SCENARIOS.includes(scenario)) {
  console.error(
    `Invalid scenario '${scenario}'. Valid: ${VALID_SCENARIOS.join(", ")}`,
  );
  process.exit(1);
}

// Bind to loopback only. The debug server has no auth and speaks just enough
// JSON-RPC for ethers' startup; binding to 0.0.0.0 (the WebSocketServer
// default) would advertise a fake-Ethereum endpoint on every interface for
// the lifetime of the script. Loopback is sufficient for wss-compare runs
// on the same host.
const wss = new WebSocketServer({ port, host: "127.0.0.1" });
console.log(
  `Mock WSS listening on ws://127.0.0.1:${port} in '${scenario}' mode`,
);

let blockNumber = 0x1000;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
};

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== 1) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function pushNewHead(ws: WebSocket, subId: string): void {
  blockNumber++;
  const number = `0x${blockNumber.toString(16)}`;
  send(ws, {
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: subId,
      result: {
        number,
        hash: `0x${blockNumber.toString(16).padStart(64, "a")}`,
        parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "b")}`,
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        baseFeePerGas: "0x1",
        miner: "0x0000000000000000000000000000000000000000",
        difficulty: "0x0",
      },
    },
  });
}

wss.on("connection", (ws: WebSocket) => {
  console.log("client connected");
  const subscriptions = new Map<string, NodeJS.Timeout>();

  ws.on("message", (raw: Buffer) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw.toString()) as JsonRpcMessage;
    } catch {
      return;
    }
    console.log(`<- id=${msg.id ?? "-"} method=${msg.method ?? "-"}`);

    if (msg.method === "eth_chainId") {
      send(ws, { jsonrpc: "2.0", id: msg.id, result: "0x1" });
      return;
    }
    if (msg.method === "net_version") {
      send(ws, { jsonrpc: "2.0", id: msg.id, result: "1" });
      return;
    }
    if (msg.method === "eth_blockNumber") {
      send(ws, {
        jsonrpc: "2.0",
        id: msg.id,
        result: `0x${blockNumber.toString(16)}`,
      });
      return;
    }
    if (msg.method === "eth_subscribe") {
      const subId = `0x${Math.random().toString(16).slice(2).padEnd(32, "0")}`;

      if (scenario === "subscribe-no-response") {
        // Drop the eth_subscribe RESPONSE but keep pushing newHeads with
        // the (server-side known) subId. ethers' SocketSubscriber.start()
        // promise chain never resolves -> _register is never called ->
        // every push lands in #pending[subId] forever. Raw ws probe still
        // counts the pushes because it does not need the subscription id
        // to identify eth_subscription method messages. This is the
        // canonical ethers v6 sharp edge that produces ETHERS_ROUTING.
        console.log(
          `   (scenario) dropping subscribe response, pushing newHeads under subId=${subId}`,
        );
        const timer = setInterval(() => {
          pushNewHead(ws, subId);
        }, 2000);
        subscriptions.set(subId, timer);
        return;
      }

      if (scenario === "push-without-register") {
        // Push a frame BEFORE sending the subscribe response. ethers'
        // _processMessage should queue this in #pending. Then send the
        // response; when start()'s .then runs _register, the queued frame
        // should drain.
        console.log("   (scenario) pushing newHead before subscribe response");
        pushNewHead(ws, subId);
      }

      send(ws, { jsonrpc: "2.0", id: msg.id, result: subId });
      console.log(`   subscribed id=${subId}`);

      if (scenario === "zombie") {
        console.log("   (scenario) holding subscription silent");
        return;
      }

      // healthy / push-without-register: stream newHeads
      const intervalMs = 2000;
      const timer = setInterval(() => {
        pushNewHead(ws, subId);
      }, intervalMs);
      subscriptions.set(subId, timer);
      return;
    }
    if (msg.method === "eth_unsubscribe") {
      const params = msg.params as unknown[] | undefined;
      const subId =
        Array.isArray(params) && typeof params[0] === "string"
          ? params[0]
          : null;
      if (subId !== null) {
        const timer = subscriptions.get(subId);
        if (timer) {
          clearInterval(timer);
          subscriptions.delete(subId);
        }
      }
      send(ws, { jsonrpc: "2.0", id: msg.id, result: true });
      return;
    }

    // Unknown method: respond with method-not-found so ethers' send promise
    // resolves instead of hanging.
    send(ws, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `method ${msg.method} not found` },
    });
  });

  ws.on("close", () => {
    console.log("client disconnected");
    for (const timer of subscriptions.values()) {
      clearInterval(timer);
    }
    subscriptions.clear();
  });
});

const shutdown = (): void => {
  console.log("\nshutting down");
  wss.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
