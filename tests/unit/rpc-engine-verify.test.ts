import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RpcConfigUrlSlot } from "@/lib/rpc/engine/org/url-slots";
import {
  type RpcProbe,
  RpcUrlCheckFailure,
  verifyRpcConfigUrls,
  verifyRpcUrl,
} from "@/lib/rpc/engine/org/verify";
import {
  type RpcChain,
  RpcChainType,
  RpcTransport,
} from "@/lib/rpc/engine/types";
import { SOLANA_GENESIS_HASHES } from "@/lib/rpc/solana-chains";
import { SsrfBlockedError } from "@/lib/safe-fetch";

const KEY = "s3cr3tkey0123456789abcdef";
const HTTP_URL = `https://rpc.example.com/v2/${KEY}`;
const WSS_URL = `wss://rpc.example.com/v2/${KEY}`;

const mainnet: RpcChain = {
  chainId: 1,
  name: "Ethereum",
  chainType: RpcChainType.EVM,
  isEnabled: true,
};
const solana: RpcChain = {
  chainId: 101,
  name: "Solana",
  chainType: RpcChainType.SOLANA,
  isEnabled: true,
};

function probe(overrides: Partial<RpcProbe> = {}): RpcProbe {
  return {
    assertPublic: vi.fn().mockResolvedValue(undefined),
    evm: vi.fn().mockResolvedValue(BigInt(1)),
    solanaGenesisHash: vi
      .fn()
      .mockResolvedValue(SOLANA_GENESIS_HASHES[solana.chainId]),
    ...overrides,
  };
}

describe("verifyRpcUrl", () => {
  it("accepts an endpoint that answers for the chain", async () => {
    const live = probe();
    const check = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.HTTP_PRIMARY, url: HTTP_URL, chain: mainnet },
      live
    );
    expect(check.ok).toBe(true);
    expect(live.evm).toHaveBeenCalledWith(HTTP_URL, RpcTransport.HTTP, 1, true);
  });

  it("only asks a private endpoint for its chain id", async () => {
    const live = probe();
    await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.PRIVATE_TX, url: HTTP_URL, chain: mainnet },
      live
    );
    expect(live.evm).toHaveBeenCalledWith(
      HTTP_URL,
      RpcTransport.HTTP,
      1,
      false
    );
  });

  it("refuses an endpoint serving another chain", async () => {
    const check = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.HTTP_PRIMARY, url: HTTP_URL, chain: mainnet },
      probe({ evm: vi.fn().mockResolvedValue(BigInt(8453)) })
    );
    expect(check).toMatchObject({
      ok: false,
      code: RpcUrlCheckFailure.WRONG_CHAIN,
    });
  });

  it("refuses the wrong scheme for the slot", async () => {
    const check = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.WSS_PRIMARY, url: HTTP_URL, chain: mainnet },
      probe()
    );
    expect(check.code).toBe(RpcUrlCheckFailure.WRONG_SCHEME);
  });

  it("refuses private hosts before calling them", async () => {
    const live = probe({
      assertPublic: vi.fn().mockRejectedValue(
        new SsrfBlockedError({
          hostname: "rpc.example.com",
          reason: "private-ip",
          message: "blocked",
        } as ConstructorParameters<typeof SsrfBlockedError>[0])
      ),
    });
    const check = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.HTTP_PRIMARY, url: HTTP_URL, chain: mainnet },
      live
    );
    expect(check.code).toBe(RpcUrlCheckFailure.NOT_PUBLIC);
    expect(live.evm).not.toHaveBeenCalled();
  });

  it("reports an endpoint that does not answer", async () => {
    const check = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.WSS_PRIMARY, url: WSS_URL, chain: mainnet },
      probe({ evm: vi.fn().mockRejectedValue(new Error(`boom ${WSS_URL}`)) })
    );
    expect(check.code).toBe(RpcUrlCheckFailure.UNREACHABLE);
  });

  it("checks Solana endpoints by genesis hash", async () => {
    const ok = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.HTTP_PRIMARY, url: HTTP_URL, chain: solana },
      probe()
    );
    expect(ok.ok).toBe(true);

    const devnet = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.HTTP_PRIMARY, url: HTTP_URL, chain: solana },
      probe({
        solanaGenesisHash: vi
          .fn()
          .mockResolvedValue(SOLANA_GENESIS_HASHES[103]),
      })
    );
    expect(devnet.code).toBe(RpcUrlCheckFailure.WRONG_CHAIN);
  });

  it("refuses slots a Solana config cannot hold", async () => {
    const check = await verifyRpcUrl(
      { slot: RpcConfigUrlSlot.WSS_PRIMARY, url: WSS_URL, chain: solana },
      probe()
    );
    expect(check.code).toBe(RpcUrlCheckFailure.SLOT_NOT_SUPPORTED);
  });

  it("never puts the URL in a result", async () => {
    const results = await Promise.all([
      verifyRpcUrl(
        { slot: RpcConfigUrlSlot.HTTP_PRIMARY, url: HTTP_URL, chain: mainnet },
        probe({ evm: vi.fn().mockRejectedValue(new Error(HTTP_URL)) })
      ),
      verifyRpcUrl(
        {
          slot: RpcConfigUrlSlot.HTTP_PRIMARY,
          url: `${KEY} not a url`,
          chain: mainnet,
        },
        probe()
      ),
    ]);
    expect(JSON.stringify(results)).not.toContain(KEY);
  });
});

describe("verifyRpcConfigUrls", () => {
  it("checks every URL given and fails if any fails", async () => {
    const live = probe({
      evm: vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(url.startsWith("wss") ? BigInt(5) : BigInt(1))
        ),
    });
    const result = await verifyRpcConfigUrls(
      {
        [RpcConfigUrlSlot.HTTP_PRIMARY]: HTTP_URL,
        [RpcConfigUrlSlot.WSS_PRIMARY]: WSS_URL,
      },
      mainnet,
      live
    );
    expect(result.ok).toBe(false);
    expect(result.verification[RpcConfigUrlSlot.HTTP_PRIMARY]?.ok).toBe(true);
    expect(result.verification[RpcConfigUrlSlot.WSS_PRIMARY]?.code).toBe(
      RpcUrlCheckFailure.WRONG_CHAIN
    );
    expect(result.verification[RpcConfigUrlSlot.HTTP_FALLBACK]).toBeUndefined();
  });
});
