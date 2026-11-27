import type { LookupFunction } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ChainProviderManagerOptions } from "../../src/chains/provider-manager";
import { RouteProviderPool } from "../../src/chains/route-provider-pool";
import { RpcOrigin } from "../../src/chains/rpc-route";
import {
  ORG_FALLBACK_URL,
  ORG_PRIMARY_ADDRESSES,
  ORG_PRIMARY_URL,
  makeRoute,
} from "./helpers/route-mocks";

const dialled = vi.hoisted(
  () => [] as { url: string; lookup: LookupFunction | undefined }[],
);

vi.mock("../../src/chains/provider-manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/chains/provider-manager")>();
  return {
    ...actual,
    createWebSocketProvider: (url: string, lookup?: LookupFunction) => {
      dialled.push({ url, lookup });
      return {};
    },
  };
});

function lookupAll(lookup: LookupFunction): Promise<unknown> {
  return new Promise((resolve, reject) => {
    lookup("ignored.example", { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });
}

describe("RouteProviderPool dialling", () => {
  it("pins the organization endpoint and resolves the KeeperHub one normally", async () => {
    let factory: ChainProviderManagerOptions["factory"];
    const pool = new RouteProviderPool({
      createManager: (opts) => {
        factory = opts.factory;
        return { destroy: async () => undefined } as never;
      },
    });
    pool.acquire(makeRoute());
    factory?.(ORG_PRIMARY_URL);
    factory?.(ORG_FALLBACK_URL);

    const [primary, fallback] = dialled;
    expect(primary?.url).toBe(ORG_PRIMARY_URL);
    expect(primary?.lookup).toBeDefined();
    await expect(lookupAll(primary?.lookup as LookupFunction)).resolves.toEqual(
      ORG_PRIMARY_ADDRESSES.map((address) => ({ address, family: 4 })),
    );
    expect(fallback?.url).toBe(ORG_FALLBACK_URL);
    expect(fallback?.lookup).toBeUndefined();
  });

  it("keeps the endpoints the manager was built with when a route under its key differs", async () => {
    dialled.length = 0;
    let factory: ChainProviderManagerOptions["factory"];
    const pool = new RouteProviderPool({
      createManager: (opts) => {
        factory = opts.factory;
        return { destroy: async () => undefined } as never;
      },
    });
    pool.acquire(makeRoute());
    pool.acquire(
      makeRoute({
        primary: {
          url: ORG_FALLBACK_URL,
          origin: RpcOrigin.ORG,
          configId: "cfg-1",
          addresses: ORG_PRIMARY_ADDRESSES,
        },
        fallback: undefined,
      }),
    );
    factory?.(ORG_PRIMARY_URL);
    factory?.("wss://unknown.example/key");

    const [primary, unknown] = dialled;
    await expect(lookupAll(primary?.lookup as LookupFunction)).resolves.toEqual(
      ORG_PRIMARY_ADDRESSES.map((address) => ({ address, family: 4 })),
    );
    await expect(lookupAll(unknown?.lookup as LookupFunction)).rejects.toThrow(
      "No vetted address",
    );
  });
});
