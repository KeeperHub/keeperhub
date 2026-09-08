import { logger } from "../../lib/utils/logger";
import { formatError } from "../format-error";
import {
  type BlockSource,
  type ConnectionHealth,
  type Endpoint,
  disconnectedHealth,
} from "./block-source";

/**
 * Runs several BlockSources for one chain behind the single BlockSource
 * contract. Used when one chain needs two ingestion strategies at once: the
 * filtered `signatures` source for event triggers plus a header-only `getBlock`
 * for block triggers, because no single source serves both without pulling
 * whole blocks.
 *
 * Members produce blocks independently and each calls `onBlock` itself. They
 * serve disjoint trigger sets (signatures emits one-tx blocks with a null
 * blockHeight, so block matching is a no-op on them; the header-only getBlock
 * carries no transactions, so event matching is a no-op on it), which is what
 * keeps a workflow from firing twice for the same on-chain activity.
 */
export class CompositeSource implements BlockSource {
  constructor(
    private readonly chainId: number,
    private readonly endpoints: Endpoint[],
    readonly sources: BlockSource[],
  ) {}

  async start(): Promise<void> {
    const started: BlockSource[] = [];
    try {
      for (const source of this.sources) {
        await source.start();
        started.push(source);
      }
    } catch (err) {
      // A half-started composite would serve one trigger type and silently drop
      // the other. Unwind what did start so the reconciler sees a clean failure
      // and retries the whole chain.
      for (const source of started) {
        await source.stop().catch(() => {
          // best-effort unwind; the start error is the one worth propagating
        });
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const source of this.sources) {
      await source.stop().catch((err) => {
        logger.warn(
          `[composite] chain ${this.chainId} member stop failed: ${formatError(err)}`,
        );
      });
    }
  }

  getHealth(): ConnectionHealth {
    const healths = this.sources.map((source) => source.getHealth());
    if (healths.length === 0) {
      return disconnectedHealth(this.chainId, this.endpoints, "no sources");
    }
    // Healthy only when every member is: one disconnected member means a whole
    // trigger type has stopped being served, which the chain's health must show.
    return healths.find((health) => !health.connected) ?? healths[0];
  }
}
