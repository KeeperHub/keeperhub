import { createPublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: () =>
    Promise.reject(new DOMException("The operation was aborted", "AbortError")),
}));

import type { EvmRpcClient } from "@/lib/rpc/engine/engine";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import {
  type RpcEndpoint,
  RpcEndpointRole,
  RpcOrigin,
  type RpcRoute,
  RpcTransport,
} from "@/lib/rpc/engine/types";
import { viemTransportsOf } from "@/lib/rpc/engine/viem";

describe("viemTransportsOf with a read-only error", () => {
  it("lets an error whose text cannot be rewritten through as itself", async () => {
    const primary: RpcEndpoint = {
      origin: RpcOrigin.ORG,
      role: RpcEndpointRole.PRIMARY,
      transport: RpcTransport.HTTP,
      url: SecretUrl.parse("https://org.example.com/v2/key"),
      configId: null,
      configName: null,
    };
    const noop = vi.fn();
    const client: EvmRpcClient = {
      route: { primary } as RpcRoute,
      manager: {} as EvmRpcClient["manager"],
      telemetry: {
        attempt: noop,
        failure: noop,
        success: noop,
        latency: noop,
        errorType: noop,
        failover: noop,
        recovery: noop,
        bothFailed: noop,
        event: noop,
      },
      activeEndpoint: () => primary,
    };
    const [transport] = viemTransportsOf(client);

    const error = await createPublicClient({ transport })
      .getBlockNumber()
      .catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain("/v2/key");
  });
});
