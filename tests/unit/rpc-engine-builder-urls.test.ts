import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: mockSelect } }));

import { builderRpcUrlsFor } from "@/lib/rpc/engine/sources/platform-source";
import type { RpcRoute } from "@/lib/rpc/engine/types";

function route(ownRpcOnly: boolean): RpcRoute {
  return { chain: { chainId: 1 }, ownRpcOnly } as RpcRoute;
}

function chainRow(row: Record<string, unknown>): void {
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
  });
}

describe("builderRpcUrlsFor", () => {
  beforeEach(() => {
    mockSelect.mockReset();
  });

  it("returns the chain's https builder endpoints", async () => {
    chainRow({
      builderRpcUrls: {
        titan: "https://titan.example",
        plain: "http://plain.example",
      },
    });

    await expect(builderRpcUrlsFor(route(false))).resolves.toEqual({
      titan: "https://titan.example",
    });
  });

  it("sends an own-RPC-only route to no builder", async () => {
    chainRow({ builderRpcUrls: { titan: "https://titan.example" } });

    await expect(builderRpcUrlsFor(route(true))).resolves.toBeUndefined();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns undefined when the lookup fails", async () => {
    mockSelect.mockImplementation(() => {
      throw new Error("db down");
    });

    await expect(builderRpcUrlsFor(route(false))).resolves.toBeUndefined();
  });
});
