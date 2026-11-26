import { Connection } from "@solana/web3.js";
import { ethers, type WebSocketLike } from "ethers";
import { assertUrlIsPublic, SsrfBlockedError } from "@/lib/safe-fetch";
import { safeSolanaFetch } from "../../providers/solana";
import { safeEthersGetUrl } from "../../safe-ethers-fetch";
import { SOLANA_GENESIS_HASHES } from "../../solana-chains";
import { SecretUrl } from "../secret-url";
import { type RpcChain, RpcChainType, RpcTransport } from "../types";
import { RpcUrlCheckFailure } from "./codes";
import {
  RPC_CONFIG_SLOTS_BY_CHAIN_TYPE,
  RPC_CONFIG_URL_SLOTS,
  RpcConfigUrlSlot,
  type RpcConfigUrls,
  type RpcConfigVerification,
  type RpcUrlCheck,
  SLOT_TRANSPORT,
} from "./url-slots";

export { RpcUrlCheckFailure } from "./codes";

const PROBE_TIMEOUT_MS = 10_000;

/** The only scheme accepted for each transport. */
const SECURE_SCHEME: Readonly<Record<RpcTransport, string>> = {
  [RpcTransport.HTTP]: "https:",
  [RpcTransport.WSS]: "wss:",
};

/** URL schemes the public-host check understands, for each WebSocket scheme. */
const WS_TO_HTTP_SCHEME: Readonly<Record<string, string>> = {
  "ws:": "http:",
  "wss:": "https:",
};

const EVM_CHAIN_ID_METHOD = "eth_chainId";
const EVM_BLOCK_NUMBER_METHOD = "eth_blockNumber";

/** The live calls a check makes. Injected in tests so no network is used. */
export type RpcProbe = {
  assertPublic(url: string): Promise<void>;
  /** `eth_chainId`, plus `eth_blockNumber` when `readsBlocks` is set. */
  evm(
    url: string,
    transport: RpcTransport,
    chainId: number,
    readsBlocks: boolean
  ): Promise<bigint>;
  solanaGenesisHash(url: string): Promise<string>;
};

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(RpcUrlCheckFailure.UNREACHABLE)),
      PROBE_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function evmProvider(
  url: string,
  transport: RpcTransport,
  chainId: number
): ethers.JsonRpcProvider | ethers.WebSocketProvider {
  const network = ethers.Network.from(chainId);
  if (transport === RpcTransport.WSS) {
    // The platform WebSocket reports connection errors as events instead of
    // throwing, so a refused socket cannot take the process down.
    const createSocket = (): WebSocketLike =>
      new WebSocket(url) as unknown as WebSocketLike;
    return new ethers.WebSocketProvider(createSocket, network, {
      staticNetwork: true,
    });
  }
  const request = new ethers.FetchRequest(url);
  request.timeout = PROBE_TIMEOUT_MS;
  request.getUrlFunc = safeEthersGetUrl;
  return new ethers.JsonRpcProvider(request, network, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

export const liveRpcProbe: RpcProbe = {
  async assertPublic(url: string): Promise<void> {
    const parsed = new URL(url);
    const httpScheme = WS_TO_HTTP_SCHEME[parsed.protocol];
    if (httpScheme) {
      parsed.protocol = httpScheme;
    }
    await assertUrlIsPublic(parsed.toString());
  },

  async evm(
    url: string,
    transport: RpcTransport,
    chainId: number,
    readsBlocks: boolean
  ): Promise<bigint> {
    const provider = evmProvider(url, transport, chainId);
    try {
      const answered = await withTimeout(
        provider.send(EVM_CHAIN_ID_METHOD, []) as Promise<string>
      );
      if (readsBlocks) {
        await withTimeout(provider.send(EVM_BLOCK_NUMBER_METHOD, []));
      }
      return BigInt(answered);
    } finally {
      await provider.destroy();
    }
  },

  async solanaGenesisHash(url: string): Promise<string> {
    const connection = new Connection(url, { fetch: safeSolanaFetch });
    return await withTimeout(connection.getGenesisHash());
  },
};

export type VerifyRpcUrlInput = {
  slot: RpcConfigUrlSlot;
  url: string;
  chain: RpcChain;
};

function failed(
  code: RpcUrlCheckFailure,
  error: string,
  checkedAt: string
): RpcUrlCheck {
  return { ok: false, code, error, checkedAt };
}

function chainMismatchMessage(chain: RpcChain): string {
  return `This endpoint does not serve ${chain.name}. Use a URL for chain ${chain.chainId}.`;
}

/**
 * Prove an endpoint serves the chain it was added for, by calling it. We
 * know nothing about RPC vendors: the URL either answers for this chain or
 * it is refused. No result ever contains the URL.
 */
export async function verifyRpcUrl(
  input: VerifyRpcUrlInput,
  probe: RpcProbe = liveRpcProbe
): Promise<RpcUrlCheck> {
  const { slot, chain } = input;
  const checkedAt = new Date().toISOString();

  if (!RPC_CONFIG_SLOTS_BY_CHAIN_TYPE[chain.chainType].includes(slot)) {
    return failed(
      RpcUrlCheckFailure.SLOT_NOT_SUPPORTED,
      `${chain.name} configs do not take this kind of URL.`,
      checkedAt
    );
  }

  let url: SecretUrl;
  try {
    url = SecretUrl.parse(input.url);
  } catch {
    return failed(
      RpcUrlCheckFailure.INVALID_URL,
      "This is not a valid URL.",
      checkedAt
    );
  }

  // Organization URLs usually carry an API key, so only encrypted schemes.
  const transport = SLOT_TRANSPORT[slot];
  if (new URL(url.reveal()).protocol !== SECURE_SCHEME[transport]) {
    return failed(
      RpcUrlCheckFailure.WRONG_SCHEME,
      transport === RpcTransport.WSS
        ? "Use a wss:// URL here."
        : "Use an https:// URL here.",
      checkedAt
    );
  }

  try {
    await probe.assertPublic(url.reveal());
  } catch (error) {
    return failed(
      RpcUrlCheckFailure.NOT_PUBLIC,
      error instanceof SsrfBlockedError
        ? "The endpoint must be reachable on the public internet."
        : "The endpoint's host could not be resolved.",
      checkedAt
    );
  }

  try {
    if (chain.chainType === RpcChainType.SOLANA) {
      const genesis = await probe.solanaGenesisHash(url.reveal());
      return genesis === SOLANA_GENESIS_HASHES[chain.chainId]
        ? { ok: true, checkedAt }
        : failed(
            RpcUrlCheckFailure.WRONG_CHAIN,
            chainMismatchMessage(chain),
            checkedAt
          );
    }
    const answered = await probe.evm(
      url.reveal(),
      transport,
      chain.chainId,
      slot !== RpcConfigUrlSlot.PRIVATE_TX
    );
    return answered === BigInt(chain.chainId)
      ? { ok: true, checkedAt }
      : failed(
          RpcUrlCheckFailure.WRONG_CHAIN,
          chainMismatchMessage(chain),
          checkedAt
        );
  } catch {
    return failed(
      RpcUrlCheckFailure.UNREACHABLE,
      "The endpoint did not answer. Check the URL and its API key.",
      checkedAt
    );
  }
}

export type VerifyRpcConfigResult = {
  ok: boolean;
  verification: RpcConfigVerification;
};

/** Check every URL a config holds, in parallel. */
export async function verifyRpcConfigUrls(
  urls: Partial<RpcConfigUrls>,
  chain: RpcChain,
  probe: RpcProbe = liveRpcProbe
): Promise<VerifyRpcConfigResult> {
  const slots = RPC_CONFIG_URL_SLOTS.filter((slot) => Boolean(urls[slot]));
  const checks = await Promise.all(
    slots.map((slot) =>
      verifyRpcUrl({ slot, url: urls[slot] as string, chain }, probe)
    )
  );
  const verification: RpcConfigVerification = {};
  for (const [index, slot] of slots.entries()) {
    verification[slot] = checks[index];
  }
  return { ok: checks.every((check) => check.ok), verification };
}
