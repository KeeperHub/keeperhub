/**
 * Loop-back iteration accounting for the workflow executor.
 *
 * A back edge (see `lib/workflow/editor/back-edges.ts`) sends control from a
 * node to one of its ancestors so the graph from that ancestor down runs again.
 * Nothing in the graph itself bounds how often that can happen: a condition that
 * never flips its branch loops forever, burning steps, gas and quota. Two caps
 * bound it.
 *
 * The per-loop cap is what an author hits when their exit condition is wrong.
 * The per-execution cap is the backstop for topologies where the per-loop cap
 * alone is not enough: nested loops multiply, so two loops capped at 100 each
 * would otherwise allow 10,000 traversals.
 *
 * Hitting either cap fails the run. Stopping quietly and carrying on would hand
 * back the partial state of whichever iteration happened to be last, which for a
 * loop that moves value is worse than a loud failure.
 */

/** Times one back edge may re-enter its loop entry within a single execution. */
export const MAX_LOOP_ITERATIONS = 100;

/** Loop-back traversals allowed across one execution, whatever the topology. */
export const MAX_LOOP_TRAVERSALS_PER_EXECUTION = 1000;

export type LoopAdmission =
  | { admitted: true; iteration: number }
  | { admitted: false; error: string };

export type LoopBackTrackerOptions = {
  maxIterationsPerLoop?: number;
  maxTraversalsPerExecution?: number;
  /** Node ID -> display label, for readable cap messages. */
  labelOf?: (nodeId: string) => string;
};

export type LoopBackTracker = {
  /**
   * Account for one traversal of `sourceNodeId -> loopEntryNodeId`. On success
   * the returned iteration number is the pass the loop body is about to make
   * (1 for the first re-entry), and every node in `bodyNodeIds` is recorded as
   * running that pass.
   */
  admit(
    sourceNodeId: string,
    loopEntryNodeId: string,
    bodyNodeIds: Iterable<string>
  ): LoopAdmission;
  /** Pass a node is on: 0 until a loop has re-entered it. */
  iterationOf(nodeId: string): number;
  /** Total admitted traversals, for run-completion logging. */
  totalTraversals(): number;
};

export function createLoopBackTracker(
  options: LoopBackTrackerOptions = {}
): LoopBackTracker {
  const maxPerLoop = options.maxIterationsPerLoop ?? MAX_LOOP_ITERATIONS;
  const maxPerExecution =
    options.maxTraversalsPerExecution ?? MAX_LOOP_TRAVERSALS_PER_EXECUTION;
  const labelOf = options.labelOf ?? ((nodeId: string): string => nodeId);

  const iterationsPerLoop = new Map<string, number>();
  const iterationPerNode = new Map<string, number>();
  let traversals = 0;

  return {
    admit(sourceNodeId, loopEntryNodeId, bodyNodeIds) {
      const loopKey = `${sourceNodeId}::${loopEntryNodeId}`;
      const nextIteration = (iterationsPerLoop.get(loopKey) ?? 0) + 1;

      if (nextIteration > maxPerLoop) {
        return {
          admitted: false,
          error:
            `Loop back to "${labelOf(loopEntryNodeId)}" stopped after ${maxPerLoop} ` +
            "iterations. Add a condition that leaves the loop, or move the work " +
            "into a For Each step.",
        };
      }
      if (traversals + 1 > maxPerExecution) {
        return {
          admitted: false,
          error:
            `This run reached its limit of ${maxPerExecution} loop iterations across ` +
            `all loops while looping back to "${labelOf(loopEntryNodeId)}". Reduce how ` +
            "many times the nested loops repeat.",
        };
      }

      traversals += 1;
      iterationsPerLoop.set(loopKey, nextIteration);
      for (const bodyNodeId of bodyNodeIds) {
        iterationPerNode.set(bodyNodeId, nextIteration);
      }
      return { admitted: true, iteration: nextIteration };
    },

    iterationOf(nodeId) {
      return iterationPerNode.get(nodeId) ?? 0;
    },

    totalTraversals() {
      return traversals;
    },
  };
}

export type LoopBodyState = {
  visited: Set<string>;
  convergenceArrivals: Map<string, Set<string>>;
  convergenceSkipArrivals: Map<string, Set<string>>;
  skippedNodes: Set<string>;
};

/**
 * Clear the per-pass traversal state for a loop body so the next pass runs it
 * from scratch: the nodes become unvisited, and convergence barriers inside the
 * body re-arm instead of counting the previous pass's arrivals as this one's.
 *
 * `results` and `outputs` are deliberately left alone. They are keyed by node
 * and each pass overwrites them, so downstream templates and the run panel read
 * the newest pass, which is what a step that ran twice should report.
 */
export function resetLoopBodyState(
  bodyNodeIds: Iterable<string>,
  state: LoopBodyState
): void {
  for (const nodeId of bodyNodeIds) {
    state.visited.delete(nodeId);
    state.convergenceArrivals.delete(nodeId);
    state.convergenceSkipArrivals.delete(nodeId);
    state.skippedNodes.delete(nodeId);
  }
}

/**
 * Back edges that touch a For Each loop body, in either direction.
 *
 * Body nodes run through the body runner's own dispatcher, which has no
 * loop-back handling, so such an edge would be silently ignored rather than
 * looping. The executor refuses the run instead of running a workflow that does
 * not do what the canvas shows.
 */
export function findUnsupportedBackEdges<
  E extends { source: string; target: string },
>(backEdges: E[], forEachBodyNodeIds: ReadonlySet<string>): E[] {
  return backEdges.filter(
    (edge) =>
      forEachBodyNodeIds.has(edge.source) || forEachBodyNodeIds.has(edge.target)
  );
}
