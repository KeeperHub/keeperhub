import type { ethers } from "ethers";
import type { ProviderFactory } from "../../../src/chains/provider-manager";
import {
  RpcOrigin,
  type RpcRoute,
  RpcTransport,
} from "../../../src/chains/rpc-route";

type BlockHandler = (blockNumber: number) => void | Promise<void>;
type ErrorHandler = (err: Error) => void;

/** The slice of ethers.WebSocketProvider that ChainProviderManager uses. */
export class MockProvider {
  public readonly sendCalls: string[] = [];
  public getLogsResponses: unknown[] = [];
  public destroyed = false;
  private blockHandler: BlockHandler | null = null;
  private errorHandler: ErrorHandler | null = null;

  constructor(public readonly url: string) {}

  on(event: string, handler: BlockHandler | ErrorHandler): void {
    if (event === "block") {
      this.blockHandler = handler as BlockHandler;
    } else if (event === "error") {
      this.errorHandler = handler as ErrorHandler;
    }
  }

  off(event: string, handler: BlockHandler | ErrorHandler): void {
    if (event === "block" && this.blockHandler === handler) {
      this.blockHandler = null;
    } else if (event === "error" && this.errorHandler === handler) {
      this.errorHandler = null;
    }
  }

  async getBlockNumber(): Promise<number> {
    return 1;
  }

  async send(method: string, _params: unknown[]): Promise<unknown> {
    this.sendCalls.push(method);
    if (method === "eth_subscribe") {
      return "0xprobe";
    }
    if (method === "eth_unsubscribe") {
      return true;
    }
    if (method === "eth_getLogs") {
      const next = this.getLogsResponses.shift() ?? [];
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
    return "0x1";
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  async emitBlock(blockNumber: number): Promise<void> {
    await this.blockHandler?.(blockNumber);
  }

  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
}

export function makeMockFactory(): {
  factory: ProviderFactory;
  created: MockProvider[];
  failWith: (err: Error | null) => void;
} {
  const created: MockProvider[] = [];
  let failure: Error | null = null;
  const factory: ProviderFactory = (url) => {
    if (failure) {
      throw failure;
    }
    const provider = new MockProvider(url);
    created.push(provider);
    return provider as unknown as ethers.WebSocketProvider;
  };
  return {
    factory,
    created,
    failWith: (err) => {
      failure = err;
    },
  };
}

export const ROUTE_CHAIN_ID = 8453;
export const ORG_ID = "org-1";
export const ORG_PRIMARY_URL = "wss://org-primary.example/secret-key-1";
export const ORG_FALLBACK_URL = "wss://org-fallback.example/secret-key-2";

export function makeRoute(overrides: Partial<RpcRoute> = {}): RpcRoute {
  return {
    key: "route-a",
    organizationId: ORG_ID,
    chainId: ROUTE_CHAIN_ID,
    transport: RpcTransport.WSS,
    primary: {
      url: ORG_PRIMARY_URL,
      origin: RpcOrigin.ORG,
      configId: "cfg-1",
    },
    fallback: {
      url: ORG_FALLBACK_URL,
      origin: RpcOrigin.PLATFORM,
      configId: null,
    },
    ...overrides,
  };
}
