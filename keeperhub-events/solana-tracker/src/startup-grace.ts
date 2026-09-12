/**
 * How long a cold start may take before it counts as broken.
 *
 * Shared by two places that must agree. `/livez` fails a process that has not
 * started a single sync pass by then. The reconciler reports a chain that is
 * still waiting to start by then as failed, so its silence clock starts and it
 * can page.
 *
 * A cold start is a serial loop of one RPC round-trip per watched program, and
 * those calls carry no timeout, so it can legitimately outlast the probe's
 * initialDelaySeconds - but not without limit. A start that hangs on one chain
 * would otherwise leave every chain behind it waiting, and silent, forever.
 */
export const STARTUP_GRACE_MS = 600_000;
