/**
 * Resolve the pinned fork block for a chain from the protocol registry.
 *
 * Protocols whose fixtures bind state recorded at a specific block
 * declare `pinnedBlock` in their testData (see
 * lib/test-data/types.ts). The Tier 1 harness runs those protocols
 * against a dedicated fork pinned there
 * (PROTOCOL_SIM_RPC_<chainId>_PINNED); the rig
 * (scripts/protocol-local.sh) and the CI tier1 job start that fork with
 * the block this script prints, so the pin has exactly one source of
 * truth - the registry - and a fixture refresh touches only the
 * protocol's testData.
 *
 * One pinned fork exists per chain, so every pinned protocol on a chain
 * must agree on the block; disagreement fails loudly here rather than
 * running some protocol's fixtures at the wrong pin.
 *
 * Usage: tsx scripts/protocol-pinned-block.ts <chainId>
 * Prints the block number; exits 1 when no protocol declares a pin.
 */

import "../protocols";
import { getRegisteredProtocols } from "../lib/protocol-registry";

function main(): void {
  const [chainId] = process.argv.slice(2);
  if (!chainId) {
    process.stderr.write(
      "usage: tsx scripts/protocol-pinned-block.ts <chainId>\n"
    );
    process.exit(2);
  }
  const pins = new Map<number, string[]>();
  for (const protocol of getRegisteredProtocols()) {
    const pin = protocol.testData?.[chainId]?.pinnedBlock;
    if (pin === undefined) {
      continue;
    }
    pins.set(pin, [...(pins.get(pin) ?? []), protocol.slug]);
  }
  if (pins.size === 0) {
    process.stderr.write(
      `no protocol declares a pinnedBlock on chain ${chainId}\n`
    );
    process.exit(1);
  }
  if (pins.size > 1) {
    const detail = [...pins.entries()]
      .map(([block, slugs]) => `${block} (${slugs.join(", ")})`)
      .join(" vs ");
    process.stderr.write(
      `pinned protocols on chain ${chainId} disagree on the block: ${detail}. ` +
        "One pinned fork exists per chain; align the pinnedBlock values.\n"
    );
    process.exit(1);
  }
  const [block] = pins.keys();
  process.stdout.write(`${block}\n`);
}

main();
