import { logger } from "../../lib/utils/logger";
import { formatError } from "../format-error";
import {
  type BlockSource,
  type ConnectionHealth,
  type ConnectionState,
  type Endpoint,
  disconnectedHealth,
} from "./block-source";

/**
 * Worst-member-wins ordering for a composite chain's reported health. Higher
 * wins. "unimplemented" outranks the healthy states because a chain routed to
 * an unwired source really is not ingesting, but stays below the states that
 * describe a live fault, so a genuine failure is never masked by a seam.
 */
const STATE_SEVERITY: Record<ConnectionState, number> = {
  live: 0,
  subscribing: 1,
  idle: 2,
  unimplemented: 3,
  reconnecting: 4,
  stale: 5,
  failed: 6,
};

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
      return disconnectedHealth(
        this.chainId,
        "composite",
        this.endpoints,
        "no sources",
      );
    }
    // Healthy only when every member is: one disconnected member means a whole
    // trigger type has stopped being served, which the chain's health must show.
    //
    // Ranked by severity rather than by array order. Picking the first
    // unhealthy member made the reported endpoint and error depend on which
    // source happened to be constructed first, so a composite with a genuinely
    // failed member could report an unimplemented one instead.
    const worst = [...healths].sort(
      (a, b) => STATE_SEVERITY[b.state] - STATE_SEVERITY[a.state],
    )[0];
    // Counters are summed across members instead of taken from the worst one.
    // Which member ranks worst can change between scrapes, so reading its
    // totals would jump the chain's counters between two unrelated histories.
    // A sum of monotonic totals stays monotonic.
    return {
      ...worst,
      reconnects: healths.reduce((total, h) => total + h.reconnects, 0),
      abandonedSubscriptions: healths.reduce(
        (total, h) => total + h.abandonedSubscriptions,
        0,
      ),
    };
  }
}
