import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: mockSelect } }));

import { getChainBuilderRpcUrls } from "@/lib/rpc/engine/sources/platform-source";

function chainRow(row: Record<string, unknown>): void {
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
  });
}

describe("getChainBuilderRpcUrls", () => {
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

    await expect(getChainBuilderRpcUrls(1)).resolves.toEqual({
      titan: "https://titan.example",
    });
  });

  it("returns undefined when the lookup fails", async () => {
    mockSelect.mockImplementation(() => {
      throw new Error("db down");
    });

    await expect(getChainBuilderRpcUrls(1)).resolves.toBeUndefined();
  });
});
