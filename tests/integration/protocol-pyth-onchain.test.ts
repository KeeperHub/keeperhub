/**
 * Pyth Network On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Pyth protocol definition produces valid
 * calldata that deployed Pyth oracle contracts accept on EVM testnet/mainnet.
 * Runs against live RPC endpoints.
 */

import { ethers } from "ethers";
import { describe, expect, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";
import pythDef from "@/protocols/pyth";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "11155111"; // Sepolia
const CHAIN_ID_NUMBER = 11_155_111;
const ETH_USD_FEED =
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

// Resolve Sepolia RPC URLs via shared config pipeline
const rpcConfig = parseRpcConfig(process.env.CHAIN_RPC_CONFIG);
const resolveRpcUrl = createRpcUrlResolver(rpcConfig);
const SEPOLIA_PRIMARY_URL = resolveRpcUrl(
  "eth-sepolia",
  "CHAIN_SEPOLIA_PRIMARY_RPC",
  PUBLIC_RPCS.SEPOLIA,
  "primary"
);
const SEPOLIA_FALLBACK_URL = resolveRpcUrl(
  "eth-sepolia",
  "CHAIN_SEPOLIA_FALLBACK_RPC",
  PUBLIC_RPCS.SEPOLIA,
  "fallback"
);

describe("Pyth Network on-chain integration (Sepolia)", () => {
  const makeProvider = () =>
    getRpcProviderFromUrls(
      SEPOLIA_PRIMARY_URL,
      SEPOLIA_FALLBACK_URL,
      CHAIN_ID_NUMBER,
      "Sepolia (Pyth integration test)"
    );

  itOnchain(
    "get-price-unsafe: eth_call returns decodable price tuple",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: pythDef,
        actionSlug: "get-price-unsafe",
        sampleInputs: { id: ETH_USD_FEED },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      const result = await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );

      const abi = JSON.parse(contract.abi as string);
      const iface = new ethers.Interface(abi);
      const decoded = iface.decodeFunctionResult("getPriceUnsafe", result);

      expect(decoded).toBeDefined();
      expect(
        typeof decoded.price === "bigint" || typeof decoded.price === "number"
      ).toBe(true);
      expect(
        typeof decoded.conf === "bigint" || typeof decoded.conf === "number"
      ).toBe(true);
      expect(
        typeof decoded.expo === "bigint" || typeof decoded.expo === "number"
      ).toBe(true);
      expect(
        typeof decoded.publishTime === "bigint" ||
          typeof decoded.publishTime === "number"
      ).toBe(true);
    },
    30_000
  );

  itOnchain(
    "get-ema-price-unsafe: eth_call returns decodable EMA price tuple",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: pythDef,
        actionSlug: "get-ema-price-unsafe",
        sampleInputs: { id: ETH_USD_FEED },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      const result = await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );

      const abi = JSON.parse(contract.abi as string);
      const iface = new ethers.Interface(abi);
      const decoded = iface.decodeFunctionResult("getEmaPriceUnsafe", result);

      expect(decoded).toBeDefined();
      expect(
        typeof decoded.price === "bigint" || typeof decoded.price === "number"
      ).toBe(true);
    },
    30_000
  );
});
