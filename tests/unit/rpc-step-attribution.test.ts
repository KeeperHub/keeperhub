import { AsyncLocalStorage } from "node:async_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AttributableRpcClient,
  noteRpcClient,
  readRpcAttribution,
  runWithRpcAttribution,
  setRpcAttributionStorage,
} from "@/lib/rpc/engine/step-attribution";
import { RpcOrigin } from "@/lib/rpc/engine/types";

type FakeEndpoint = { origin: RpcOrigin; configId: string | null };

const PLATFORM: FakeEndpoint = { origin: RpcOrigin.PLATFORM, configId: null };

function orgEndpoint(configId: string): FakeEndpoint {
  return { origin: RpcOrigin.ORG, configId };
}

/** A client whose primary and fallback can be switched between mid-step. */
function fakeClient(
  primary: FakeEndpoint,
  fallback?: FakeEndpoint
): AttributableRpcClient & { failOver(): void } {
  let onFallback = false;
  return {
    activeEndpoint: () => (onFallback && fallback ? fallback : primary),
    manager: { isCurrentlyUsingFallback: () => onFallback },
    failOver: () => {
      onFallback = true;
    },
  };
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
    });
  });

  it("marks a step failed over when a client is on its fallback at completion", async () => {
    const result = await runWithRpcAttribution(async () => {
      const client = fakeClient(orgEndpoint("cfg-1"), PLATFORM);
      noteRpcClient(client);
      await Promise.resolve();
      client.failOver();
      return readRpcAttribution();
    });
    // The org primary served before the failover, so the step stays org.
    expect(result).toEqual({
      rpcOrigin: RpcOrigin.ORG,
      rpcConfigId: "cfg-1",
      rpcFailedOver: true,
    });
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
