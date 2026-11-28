/**
 * A fake block builder for anvil e2e tests: an in-process eth_sendBundle
 * endpoint that checks X-Flashbots-Signature, and a miner that drives anvil
 * one block at a time, including a bundle only at its target block and only
 * when its transaction does not revert there. Anvil is the fee oracle: a
 * bundle counts as included only when its receipt is in the mined block.
 * Not a builder auction: the miner takes the first valid bundle in builder
 * order, not the highest tip.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";

/**
 * accept: takes and may include. decline: takes, never includes. refuse: a
 * JSON-RPC error at 200; rpc-error-400: the same at HTTP 400. timeout, null,
 * http500 and garbage take the bundle (and may include it) but answer late,
 * with `result: null`, a 500 or a body that is not JSON.
 */
export type BuilderMode =
  | "accept"
  | "decline"
  | "refuse"
  | "rpc-error-400"
  | "timeout"
  | "null"
  | "http500"
  | "garbage";

// Longer than the client's 2 s builder timeout.
const SLOW_ANSWER_MS = 2500;

export type ReceivedBundle = {
  target: number;
  raw: string;
  hash: string;
  body: string;
  // Unix seconds: a builder that honours it never builds the bundle into an earlier block.
  minTimestamp?: number;
};

type JsonRpcRequest = {
  method?: string;
  params?: { txs?: string[]; blockNumber?: string; minTimestamp?: number }[];
};

export type FakeBuilder = {
  name: string;
  url: string;
  mode: BuilderMode;
  received: ReceivedBundle[];
  // Requests refused for a bad or missing signature.
  badSignatures: number;
  close: () => Promise<void>;
};

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The header is `<address>:<EIP-191 signature of the body's keccak hex>`.
function signedBy(header: string | undefined, body: string): string | null {
  const [address, signature] = (header ?? "").split(":");
  if (!(address && signature)) {
    return null;
  }
  try {
    const recovered = ethers.verifyMessage(ethers.id(body), signature);
    return recovered.toLowerCase() === address.toLowerCase() ? recovered : null;
  } catch {
    return null;
  }
}

async function answerTaken(
  res: ServerResponse,
  mode: BuilderMode,
  body: string
): Promise<void> {
  switch (mode) {
    case "timeout":
      await new Promise((resolve) => setTimeout(resolve, SLOW_ANSWER_MS));
      if (!res.destroyed) {
        answer(res, 200, { jsonrpc: "2.0", id: 1, result: null });
      }
      return;
    case "null":
      answer(res, 200, { jsonrpc: "2.0", id: 1, result: null });
      return;
    case "http500":
      answer(res, 500, { message: "internal error" });
      return;
    case "garbage":
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not json</html>");
      return;
    default:
      answer(res, 200, {
        jsonrpc: "2.0",
        id: 1,
        result: { bundleHash: ethers.id(body) },
      });
  }
}

/** Start a fake builder that only takes bundles signed by `searcher`. */
export async function startFakeBuilder(
  name: string,
  searcher: string
): Promise<FakeBuilder> {
  const builder: FakeBuilder = {
    name,
    url: "",
    mode: "accept",
    received: [],
    badSignatures: 0,
    close: async () => undefined,
  };
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const signer = signedBy(
      req.headers["x-flashbots-signature"] as string | undefined,
      body
    );
    if (signer?.toLowerCase() !== searcher.toLowerCase()) {
      builder.badSignatures += 1;
      answer(res, 403, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_025, message: "invalid flashbots signature" },
      });
      return;
    }
    const request = JSON.parse(body) as JsonRpcRequest;
    const bundle = request.params?.[0];
    const raw = bundle?.txs?.[0];
    if (request.method !== "eth_sendBundle" || !raw || !bundle?.blockNumber) {
      answer(res, 400, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_602, message: "invalid bundle" },
      });
      return;
    }
    if (builder.mode === "refuse" || builder.mode === "rpc-error-400") {
      answer(res, builder.mode === "refuse" ? 200 : 400, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_602, message: "bundle refused by test builder" },
      });
      return;
    }
    builder.received.push({
      target: Number(bundle.blockNumber),
      raw,
      hash: ethers.keccak256(raw),
      body,
      ...(typeof bundle.minTimestamp === "number" && {
        minTimestamp: bundle.minTimestamp,
      }),
    });
    await answerTaken(res, builder.mode, body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  builder.url = `http://127.0.0.1:${port}`;
  builder.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return builder;
}

export async function anvilRpc<T>(
  url: string,
  method: string,
  params: unknown[] = []
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (body.error) {
    throw new Error(`${method}: ${body.error.message}`);
  }
  return body.result as T;
}

export type Miner = {
  // Which received bundles may be included at a block: (target, first target seen).
  includeIf: (target: number, firstTarget: number) => boolean;
  // Bundles a builder could not include: an invalid transaction, or a revert.
  rejected: { hash: string; reason: string }[];
  // Anything that went wrong driving anvil; a test expects none.
  errors: string[];
  // Runs before a block is built, e.g. to change state under a bundle.
  beforeBlock?: (block: number) => Promise<void>;
  tickMs: number;
  // Seconds between a block and the one before it; 12 unless a test misses a slot.
  secondsBefore?: (block: number) => number;
  included: { block: number; hash: string }[];
  // Past every target, keep mining one block per tick while anvil's pool holds a transaction. Off by default.
  minePool: boolean;
  // The base fee every next block gets (anvil_setNextBlockBaseFeePerGas); anvil's own when unset.
  baseFee?: bigint;
  // Mine `count` empty blocks now.
  mine: (count?: number) => Promise<void>;
  stop: () => Promise<void>;
};

const BLOCK_SECONDS = 12;
// Blocks mined past the last target, so a watcher sees it pass the margin.
const BLOCKS_PAST_TARGET = 4;

type Header = { timestamp: string };

// Anvil's answers when the pool already holds the transaction, or one at its nonce it will not replace.
const IN_POOL_ERROR =
  /already known|already imported|replacement transaction underpriced|replacement underpriced/i;

/**
 * Drive anvil (automine and interval mining off): while any builder holds a
 * bundle for a block not yet past, mine one block per tick, 12 s apart; past
 * the targets, only while anvil's pool holds a transaction (minePool).
 */
export function startMiner(
  anvilUrl: string,
  builders: readonly FakeBuilder[]
): Miner {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const call = <T>(method: string, params: unknown[] = []) =>
    anvilRpc<T>(anvilUrl, method, params);

  const gapBefore = (block: number): number =>
    miner.secondsBefore?.(block) ?? BLOCK_SECONDS;

  const poolHasTransactions = async (): Promise<boolean> => {
    const status = await call<{ pending: string; queued: string }>(
      "txpool_status"
    );
    return Number(status.pending) > 0;
  };

  const mineOne = async (): Promise<number> => {
    const latest = await call<{ timestamp: string; number: string }>(
      "eth_getBlockByNumber",
      ["latest", false]
    );
    const next = Number(latest.number) + 1;
    if (miner.baseFee !== undefined) {
      await call("anvil_setNextBlockBaseFeePerGas", [
        ethers.toQuantity(miner.baseFee),
      ]);
    }
    await call("evm_mine", [Number(latest.timestamp) + gapBefore(next)]);
    return Number(await call<string>("eth_blockNumber"));
  };

  // A builder's own checks for the block it builds: not before the bundle's
  // minTimestamp, a valid transaction (nonce, balance for gasLimit x maxFee +
  // value) that does not revert at that block's number and time. The base fee
  // is left to anvil itself.
  const rejection = async (
    bundle: ReceivedBundle,
    next: number
  ): Promise<string | undefined> => {
    const tx = ethers.Transaction.from(bundle.raw);
    const from = tx.from ?? "";
    const latest = await call<Header>("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const time = Number(latest.timestamp) + gapBefore(next);
    if (bundle.minTimestamp !== undefined && time < bundle.minTimestamp) {
      return "before minTimestamp";
    }
    const nonce = Number(
      await call<string>("eth_getTransactionCount", [from, "latest"])
    );
    if (nonce !== tx.nonce) {
      return `nonce ${tx.nonce}, wallet at ${nonce}`;
    }
    const maxFee = tx.maxFeePerGas ?? BigInt(0);
    const balance = BigInt(
      await call<string>("eth_getBalance", [from, "latest"])
    );
    if (balance < tx.gasLimit * maxFee + tx.value) {
      return "insufficient funds for gas * price + value";
    }
    try {
      await call("eth_call", [
        {
          from,
          to: tx.to,
          data: tx.data,
          value: ethers.toQuantity(tx.value),
          gas: ethers.toQuantity(tx.gasLimit),
        },
        "latest",
        {},
        {
          number: ethers.toQuantity(next),
          time: ethers.toQuantity(time),
        },
      ]);
      return;
    } catch {
      return "reverts";
    }
  };

  const miner: Miner = {
    includeIf: () => true,
    rejected: [],
    errors: [],
    tickMs: 300,
    included: [],
    minePool: false,
    mine: async (count = 1) => {
      await running;
      for (let i = 0; i < count; i += 1) {
        await mineOne();
      }
    },
    stop: async () => {
      stopped = true;
      await running;
    },
  };

  const tick = async (): Promise<void> => {
    const latest = Number(await call<string>("eth_blockNumber"));
    const all = builders.flatMap((builder) =>
      builder.mode === "decline" ? [] : builder.received
    );
    const live = builders.flatMap((builder) => builder.received);
    const lastTarget = Math.max(0, ...live.map((bundle) => bundle.target));
    if (latest >= lastTarget + BLOCKS_PAST_TARGET) {
      // A public copy (or any pooled transaction) is mined from the pool, as on a real chain.
      if (miner.minePool && (await poolHasTransactions())) {
        await miner.beforeBlock?.(latest + 1);
        await mineOne();
      }
      return;
    }
    const next = latest + 1;
    await miner.beforeBlock?.(next);
    const firstTarget = Math.min(...live.map((bundle) => bundle.target));
    const candidates = all.filter(
      (bundle) => bundle.target === next && miner.includeIf(next, firstTarget)
    );
    let sent: string | undefined;
    for (const bundle of candidates) {
      const reason = await rejection(bundle, next);
      if (reason) {
        miner.rejected.push({ hash: bundle.hash, reason });
        continue;
      }
      try {
        await call("eth_sendRawTransaction", [bundle.raw]);
      } catch (error) {
        // Already known: the pool's same bytes are mined. Replacement underpriced: the pool's other bytes at this
        // nonce are mined, not the bundle's, though the bundle is logged as sent.
        if (!IN_POOL_ERROR.test(String(error))) {
          throw error;
        }
      }
      sent = bundle.hash;
      break;
    }
    const block = await mineOne();
    if (!sent) {
      return;
    }
    const receipt = await call<{ blockNumber: string } | null>(
      "eth_getTransactionReceipt",
      [sent]
    );
    if (receipt && Number(receipt.blockNumber) === block) {
      miner.included.push({ block, hash: sent });
      return;
    }
    // Anvil would not mine it (a max fee below the real base fee): a builder
    // never includes it later outside its target.
    miner.rejected.push({ hash: sent, reason: "not mined by anvil" });
    await call("anvil_dropTransaction", [sent]);
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      running = tick().catch((error: unknown) => {
        miner.errors.push(String(error));
      });
      await running;
      await new Promise((resolve) => setTimeout(resolve, miner.tickMs));
    }
  };
  loop().catch((error: unknown) => {
    miner.errors.push(String(error));
  });
  return miner;
}

export type RpcProxy = {
  url: string;
  // JSON-RPC requests the code under test made, in order.
  requests: { method: string; params: unknown[] }[];
  close: () => Promise<void>;
};

/** A pass-through JSON-RPC proxy in front of anvil that records each method called. */
export async function startRpcProxy(target: string): Promise<RpcProxy> {
  const proxy: RpcProxy = {
    url: "",
    requests: [],
    close: async () => undefined,
  };
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    type Request = { method?: string; params?: unknown[] };
    try {
      const parsed = JSON.parse(body) as Request | Request[];
      for (const request of Array.isArray(parsed) ? parsed : [parsed]) {
        proxy.requests.push({
          method: request.method ?? "",
          params: request.params ?? [],
        });
      }
    } catch {
      proxy.requests.push({ method: "unparsed", params: [] });
    }
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  proxy.url = `http://127.0.0.1:${port}`;
  proxy.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return proxy;
}
