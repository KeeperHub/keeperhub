/**
 * Tier 1 simulations, parameterized per chain.
 *
 * Each chain gates on PROTOCOL_SIM_RPC_<chainId> pointing at an anvil fork
 * of that chain and skips cleanly when absent (CI without the fork, local
 * without the rig), so one env var selects exactly which chains run.
 *
 * Protocols whose testData declares a pinnedBlock (pendle: markets expire,
 * so bindings target state recorded at a specific block) run against a
 * dedicated fork pinned there instead of the shared near-head fork, gated
 * on PROTOCOL_SIM_RPC_<chainId>_PINNED. The rig and CI resolve the pin
 * from the registry via scripts/protocol-pinned-block.ts.
 *
 * Run via: scripts/protocol-local.sh sim [chain]
 */

import { describe } from "vitest";
import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { runSimulation } from "./_shared/simulate";

const CHAINS = [
  { name: "ethereum", chainId: "1" },
  { name: "sepolia", chainId: "11155111" },
  { name: "base", chainId: "8453" },
  { name: "arbitrum", chainId: "42161" },
] as const;

for (const chain of CHAINS) {
  const rpcUrl = process.env[`PROTOCOL_SIM_RPC_${chain.chainId}`];
  const pinnedRpcUrl = process.env[`PROTOCOL_SIM_RPC_${chain.chainId}_PINNED`];
  describe.skipIf(!rpcUrl)(`protocol simulation (${chain.name})`, () => {
    for (const protocol of getRegisteredProtocols()) {
      const chainData = protocol.testData?.[chain.chainId];
      if (!chainData || chainData.pinnedBlock !== undefined) {
        continue;
      }
      describe(protocol.slug, () => {
        runSimulation({
          protocol: protocol.slug,
          chainId: chain.chainId,
          rpcUrl: rpcUrl as string,
        });
      });
    }
  });
  describe.skipIf(!pinnedRpcUrl)(
    `protocol simulation (${chain.name}, pinned block)`,
    () => {
      for (const protocol of getRegisteredProtocols()) {
        const chainData = protocol.testData?.[chain.chainId];
        if (!chainData || chainData.pinnedBlock === undefined) {
          continue;
        }
        describe(protocol.slug, () => {
          runSimulation({
            protocol: protocol.slug,
            chainId: chain.chainId,
            rpcUrl: pinnedRpcUrl as string,
          });
        });
      }
    }
  );
}
