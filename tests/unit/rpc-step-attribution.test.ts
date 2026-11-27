import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AttributableRpcClient,
  noteRpcCall,
  noteRpcCallFailure,
  noteRpcClient,
  noteRpcFailover,
  readRpcAttribution,
  runWithRpcAttribution,
  setRpcAttributionStorage,
} from "@/lib/rpc/engine/step-attribution";
import { RpcOrigin, RpcRoutePosition } from "@/lib/rpc/engine/types";

type FakeEndpoint = { origin: RpcOrigin; configId: string | null };

const PLATFORM: FakeEndpoint = { origin: RpcOrigin.PLATFORM, configId: null };

function orgEndpoint(configId: string): FakeEndpoint {
  return { origin: RpcOrigin.ORG, configId };
}

function fakeClient(endpoint: FakeEndpoint): AttributableRpcClient {
  return { activeEndpoint: () => endpoint };
}

beforeAll(() => {
  setRpcAttributionStorage(new AsyncLocalStorage());
});

describe("rpc step attribution", () => {
  it("collects nothing outside a run", () => {
    noteRpcClient(fakeClient(orgEndpoint("cfg-1")));
    expect(readRpcAttribution()).toBeNull();
  });

  it("is null inside a run that made no RPC call", async () => {
    const result = await runWithRpcAttribution(async () => {
      await Promise.resolve();
      return readRpcAttribution();
    });
    expect(result).toBeNull();
  });

  it("attributes a KeeperHub-only step to the platform", async () => {
    const result = await runWithRpcAttribution(async () => {
      noteRpcClient(fakeClient(PLATFORM));
      await Promise.resolve();
      return readRpcAttribution();
    });
    expect(result).toEqual({
      rpcOrigin: RpcOrigin.PLATFORM,
      rpcConfigId: null,
      rpcFailedOver: false,
      rpcEndpoints: [],
    });
  });

  it("attributes to the organization when any org endpoint served, naming the last config", async () => {
    const result = await runWithRpcAttribution(async () => {
      noteRpcClient(fakeClient(orgEndpoint("cfg-1")));
      noteRpcClient(fakeClient(PLATFORM));
      await Promise.resolve();
      noteRpcClient(fakeClient(orgEndpoint("cfg-2")));
      return readRpcAttribution();
    });
    expect(result).toEqual({
      rpcOrigin: RpcOrigin.ORG,
      rpcConfigId: "cfg-2",
      rpcFailedOver: false,
      rpcEndpoints: [],
    });
  });

  it("marks a step failed over when one of its calls went to a fallback", async () => {
    const result = await runWithRpcAttribution(async () => {
      noteRpcClient(fakeClient(orgEndpoint("cfg-1")));
      await Promise.resolve();
      noteRpcCall(PLATFORM, RpcRoutePosition.FALLBACK);
      noteRpcFailover();
      return readRpcAttribution();
    });
    // The org primary served before the failover, so the step stays org.
    expect(result).toEqual({
      rpcOrigin: RpcOrigin.ORG,
      rpcConfigId: "cfg-1",
      rpcFailedOver: true,
      rpcEndpoints: [
        {
          origin: RpcOrigin.PLATFORM,
          configId: null,
          position: RpcRoutePosition.FALLBACK,
          requests: 1,
          errors: 0,
        },
      ],
    });
  });

  it("keeps a fallback call on a shared manager to the step that made it", async () => {
    const [failed, steady] = await Promise.all([
      runWithRpcAttribution(async () => {
        noteRpcClient(fakeClient(orgEndpoint("cfg-1")));
        await Promise.resolve();
        noteRpcFailover();
        noteRpcCall(orgEndpoint("cfg-1"), RpcRoutePosition.FALLBACK);
        return readRpcAttribution();
      }),
      runWithRpcAttribution(async () => {
        noteRpcClient(fakeClient(orgEndpoint("cfg-1")));
        await new Promise((resolve) => setTimeout(resolve, 5));
        noteRpcCall(orgEndpoint("cfg-1"), RpcRoutePosition.PRIMARY);
        return readRpcAttribution();
      }),
    ]);
    expect(failed?.rpcFailedOver).toBe(true);
    expect(steady?.rpcFailedOver).toBe(false);
  });

  it("counts each endpoint's calls and failures by position", async () => {
    const result = await runWithRpcAttribution(async () => {
      const own = orgEndpoint("cfg-1");
      noteRpcCall(own, RpcRoutePosition.PRIMARY);
      noteRpcCallFailure(own, RpcRoutePosition.PRIMARY);
      noteRpcCall(own, RpcRoutePosition.PRIMARY);
      await Promise.resolve();
      noteRpcCall(PLATFORM, RpcRoutePosition.FALLBACK);
      return readRpcAttribution();
    });
    expect(result?.rpcEndpoints).toEqual([
      {
        origin: RpcOrigin.ORG,
        configId: "cfg-1",
        position: RpcRoutePosition.PRIMARY,
        requests: 2,
        errors: 1,
      },
      {
        origin: RpcOrigin.PLATFORM,
        configId: null,
        position: RpcRoutePosition.FALLBACK,
        requests: 1,
        errors: 0,
      },
    ]);
  });

  it("keeps sibling runs apart", async () => {
    const [a, b] = await Promise.all([
      runWithRpcAttribution(async () => {
        noteRpcClient(fakeClient(orgEndpoint("cfg-a")));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return readRpcAttribution();
      }),
      runWithRpcAttribution(async () => {
        noteRpcClient(fakeClient(PLATFORM));
        await Promise.resolve();
        return readRpcAttribution();
      }),
    ]);
    expect(a?.rpcConfigId).toBe("cfg-a");
    expect(b?.rpcOrigin).toBe(RpcOrigin.PLATFORM);
  });

  it("reports a nested run's clients to the run around it", async () => {
    const result = await runWithRpcAttribution(async () => {
      const inner = await runWithRpcAttribution(async () => {
        noteRpcClient(fakeClient(orgEndpoint("cfg-inner")));
        await Promise.resolve();
        return readRpcAttribution();
      });
      expect(inner?.rpcConfigId).toBe("cfg-inner");
      return readRpcAttribution();
    });
    expect(result?.rpcConfigId).toBe("cfg-inner");
  });
});
