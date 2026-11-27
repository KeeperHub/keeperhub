import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { EvmRpcClient } from "@/lib/rpc/engine/engine";
import { isOrgRpcError } from "@/lib/rpc/engine/org-rpc-error";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import type { RpcTelemetrySink } from "@/lib/rpc/engine/telemetry/sink";
import {
  type RpcEndpoint,
  RpcEndpointRole,
  RpcOrigin,
  type RpcRoute,
  RpcRoutePosition,
  RpcTransport,
} from "@/lib/rpc/engine/types";
import { viemTransportsOf } from "@/lib/rpc/engine/viem";

const KEY = "s3cr3tkey0123456789abcdef";

function sink(): RpcTelemetrySink {
  return {
    attempt: vi.fn(),
    failure: vi.fn(),
    success: vi.fn(),
    latency: vi.fn(),
    errorType: vi.fn(),
    failover: vi.fn(),
    recovery: vi.fn(),
    bothFailed: vi.fn(),
    event: vi.fn(),
  };
}

function clientFor(url: string, origin: RpcOrigin): EvmRpcClient {
  const primary: RpcEndpoint = {
    origin,
    role: RpcEndpointRole.PRIMARY,
    transport: RpcTransport.HTTP,
    url: SecretUrl.parse(url),
    configId: null,
    configName: null,
  };
  return {
    route: { primary } as RpcRoute,
    manager: {} as EvmRpcClient["manager"],
    telemetry: sink(),
    activeEndpoint: () => primary,
  };
}

async function failingBlockNumber(client: EvmRpcClient): Promise<unknown> {
  const [transport] = viemTransportsOf(client);
  try {
    await createPublicClient({ transport }).getBlockNumber();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("viemTransportsOf", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    server = createServer((_req, res) => {
      res.writeHead(403).end("forbidden");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/v2/${KEY}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps the URL out of an organization endpoint's error and marks it", async () => {
    const client = clientFor(url, RpcOrigin.ORG);
    const error = (await failingBlockNumber(client)) as Error;

    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      KEY
    );
    expect(error.message).not.toContain(KEY);
    expect(error.stack ?? "").not.toContain(KEY);
    expect(isOrgRpcError(error)).toBe(true);
    expect(client.telemetry.attempt).toHaveBeenCalledWith(
      RpcRoutePosition.PRIMARY,
      "read"
    );
    expect(client.telemetry.failure).toHaveBeenCalled();
  });

  it("leaves a KeeperHub endpoint's error unmarked", async () => {
    const error = await failingBlockNumber(clientFor(url, RpcOrigin.PLATFORM));

    expect((error as Error).message).not.toContain(KEY);
    expect(isOrgRpcError(error)).toBe(false);
  });
});
