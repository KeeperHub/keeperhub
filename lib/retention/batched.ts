import "server-only";

/** Wall-clock budget shared by every pass in one run. */
export class RunBudget {
  private readonly deadline: number;

  constructor(maxRuntimeMs: number) {
    this.deadline = Date.now() + maxRuntimeMs;
  }

  get exhausted(): boolean {
    return Date.now() >= this.deadline;
  }
}

export type BatchedPassResult<P extends string> = {
  pass: P;
  /** Rows acted on, or candidates in a dry run. */
  rows: number;
  /** True when the runtime budget stopped this pass before it drained. */
  budgetExhausted: boolean;
};

export type BatchedPass<P extends string> = {
  pass: P;
  config: { dryRun: boolean; batchSize: number };
  budget: RunBudget;
  selectIds: (limit: number) => Promise<Array<{ id: string }>>;
  apply: (ids: string[]) => Promise<unknown>;
  /**
   * How many rows this pass would touch, over the same predicate `selectIds`
   * uses and with no limit. Only ever called on a dry run, which is the one
   * mode whose whole purpose is to report a number an operator will act on.
   */
  countEligible: () => Promise<number>;
};

/**
 * Select a bounded page of ids, then act on exactly those ids. The two-step
 * shape is what keeps memory flat: at most `batchSize` ids exist at once,
 * unlike purgeExpiredAuditEvents, which materialises every deleted id in one go
 * and would not survive a large table.
 *
 * Every batch is its own statement, so no transaction is held open long enough
 * to block autovacuum -- the exact failure mode that pinned the database on
 * 2026-09-02.
 */
export async function runBatched<P extends string>({
  pass,
  config,
  budget,
  selectIds,
  apply,
  countEligible,
}: BatchedPass<P>): Promise<BatchedPassResult<P>> {
  // A dry run counts instead of deleting. It cannot loop -- with nothing
  // changed the same page would come back forever -- so counting one page and
  // reporting that was capping every figure at `batchSize`, per pass and per
  // organization. The number the operator reads before turning dry-run off is
  // the whole point of the mode, so it has to be the real one.
  if (config.dryRun) {
    if (budget.exhausted) {
      return { pass, rows: 0, budgetExhausted: true };
    }
    return { pass, rows: await countEligible(), budgetExhausted: false };
  }

  let rows = 0;

  for (;;) {
    if (budget.exhausted) {
      return { pass, rows, budgetExhausted: true };
    }

    const victims = await selectIds(config.batchSize);
    if (victims.length === 0) {
      return { pass, rows, budgetExhausted: false };
    }

    await apply(victims.map((victim) => victim.id));
    rows += victims.length;
  }
}
