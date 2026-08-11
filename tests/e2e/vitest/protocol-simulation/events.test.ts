/**
 * Tier 1 event-decoding simulations, parameterized per chain.
 *
 * Mirrors chains.test.ts gating: each chain runs only when
 * PROTOCOL_SIM_RPC_<chainId> points at an anvil fork of that chain, so the
 * same env var selects which chains execute. A protocol opts into event
 * simulation on a chain by declaring an `events` block in its
 * testData[chain]; see _shared/simulate-events.ts.
 *
 * Pinned protocols (testData.pinnedBlock - pendle) route to a dedicated fork
 * pinned at that block (PROTOCOL_SIM_RPC_<chainId>_PINNED) and are excluded
 * from the shared near-head fork, exactly as the action harness does.
 *
 * Run via: scripts/protocol-local.sh sim [chain]
 */

import { describe } from "vitest";
import "@/protocols";
import {
  getRegisteredProtocols,
  type ProtocolDefinition,
} from "@/lib/protocol-registry";
import { runEventSimulation } from "./_shared/simulate-events";

const CHAINS = [
  { name: "ethereum", chainId: "1" },
  { name: "sepolia", chainId: "11155111" },
  { name: "base", chainId: "8453" },
] as const;

function hasEvents(protocol: ProtocolDefinition, chainId: string): boolean {
  const chainData = protocol.testData?.[chainId];
  return Boolean(chainData?.events && protocol.events?.length);
}

function anyUnpinnedEvents(chainId: string): boolean {
  for (const protocol of getRegisteredProtocols()) {
    const chainData = protocol.testData?.[chainId];
    if (hasEvents(protocol, chainId) && chainData?.pinnedBlock === undefined) {
      return true;
    }
  }
  return false;
}

function anyPinnedEvents(chainId: string): boolean {
  for (const protocol of getRegisteredProtocols()) {
    const chainData = protocol.testData?.[chainId];
    if (hasEvents(protocol, chainId) && chainData?.pinnedBlock !== undefined) {
      return true;
    }
  }
  return false;
}

for (const chain of CHAINS) {
  const rpcUrl = process.env[`PROTOCOL_SIM_RPC_${chain.chainId}`];
  const pinnedRpcUrl = process.env[`PROTOCOL_SIM_RPC_${chain.chainId}_PINNED`];

  describe.skipIf(!(rpcUrl && anyUnpinnedEvents(chain.chainId)))(
    `protocol event simulation (${chain.name})`,
    () => {
      for (const protocol of getRegisteredProtocols()) {
        const chainData = protocol.testData?.[chain.chainId];
        if (
          !hasEvents(protocol, chain.chainId) ||
          chainData?.pinnedBlock !== undefined
        ) {
          continue;
        }
        describe(protocol.slug, () => {
          runEventSimulation({
            protocol: protocol.slug,
            chainId: chain.chainId,
            rpcUrl: rpcUrl as string,
          });
        });
      }
    }
  );

  describe.skipIf(!(pinnedRpcUrl && anyPinnedEvents(chain.chainId)))(
    `protocol event simulation (${chain.name}, pinned block)`,
    () => {
      for (const protocol of getRegisteredProtocols()) {
        const chainData = protocol.testData?.[chain.chainId];
        if (
          !hasEvents(protocol, chain.chainId) ||
          chainData?.pinnedBlock === undefined
        ) {
          continue;
        }
        describe(protocol.slug, () => {
          runEventSimulation({
            protocol: protocol.slug,
            chainId: chain.chainId,
            rpcUrl: pinnedRpcUrl as string,
          });
        });
      }
    }
  );
}
