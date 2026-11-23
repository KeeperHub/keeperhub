import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";

type ChainLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
};

type GetLogsParams = {
  address?: string | string[];
  topics?: (string | string[] | null)[];
  fromBlock?: string;
  toBlock?: string;
};

function blockNumberOf(tag: string | undefined, fallback: number): number {
  if (tag === undefined) {
    return fallback;
  }
  return tag === "latest" ? fallback : Number(BigInt(tag));
}

function topicMatches(
  wanted: string | string[] | null | undefined,
  actual: string | undefined
): boolean {
  if (wanted === null || wanted === undefined) {
    return true;
  }
  const options = Array.isArray(wanted) ? wanted : [wanted];
  return options.some(
    (option) => option.toLowerCase() === actual?.toLowerCase()
  );
}

function logMatches(
  log: ChainLog,
  filter: GetLogsParams,
  head: number
): boolean {
  const from = blockNumberOf(filter.fromBlock, head);
  const to = blockNumberOf(filter.toBlock, head);
  if (log.blockNumber < from || log.blockNumber > to) {
    return false;
  }
  if (filter.address !== undefined) {
    const addresses = (
      Array.isArray(filter.address) ? filter.address : [filter.address]
    ).map((address) => address.toLowerCase());
    if (!addresses.includes(log.address.toLowerCase())) {
      return false;
    }
  }
  return (filter.topics ?? []).every((wanted, position) =>
    topicMatches(wanted, log.topics[position])
  );
}

function toRpcLog(log: ChainLog): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: ethers.toQuantity(log.blockNumber),
    blockHash: ethers.zeroPadValue(ethers.toBeHex(log.blockNumber), 32),
    transactionHash: ethers.zeroPadValue(
      ethers.toBeHex(log.blockNumber * 1000 + log.logIndex),
      32
    ),
    transactionIndex: "0x0",
    logIndex: ethers.toQuantity(log.logIndex),
    removed: false,
  };
}

/** A JSON-RPC node over in-memory logs; eth_getLogs filters like a real node. */
export class FakeLogNode extends ethers.JsonRpcProvider {
  readonly head: number;
  readonly logs: ChainLog[];
  readonly getLogsCalls: GetLogsParams[] = [];
  getLogsError: Error | null = null;

  constructor(head: number, logs: ChainLog[] = []) {
    super("http://stub.invalid", 1, { staticNetwork: true });
    this.head = head;
    this.logs = logs;
  }

  override send(method: string, params: unknown[]): Promise<unknown> {
    if (method === "eth_chainId") {
      return Promise.resolve("0x1");
    }
    if (method === "eth_blockNumber") {
      return Promise.resolve(ethers.toQuantity(this.head));
    }
    if (method === "eth_getLogs") {
      const filter = params[0] as GetLogsParams;
      this.getLogsCalls.push(filter);
      if (this.getLogsError) {
        return Promise.reject(this.getLogsError);
      }
      return Promise.resolve(
        this.logs
          .filter((log) => logMatches(log, filter, this.head))
          .map(toRpcLog)
      );
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  }
}

/** The failover manager, reduced to the one endpoint under test. */
export function singleNodeRpc(node: FakeLogNode): RpcProviderManager {
  return {
    executeWithFailover: <T>(
      operation: (provider: ethers.JsonRpcProvider) => Promise<T>
    ): Promise<T> => operation(node),
  } as unknown as RpcProviderManager;
}

/** A log as the chain would store it for `event` emitted with `values`. */
export function emitted(
  address: string,
  iface: ethers.Interface,
  event: string,
  values: unknown[],
  blockNumber: number,
  logIndex: number
): ChainLog {
  const fragment = iface.getEvent(event);
  if (!fragment) {
    throw new Error(`no event ${event} in test ABI`);
  }
  const { data, topics } = iface.encodeEventLog(fragment, values);
  return { address, topics, data, blockNumber, logIndex };
}
