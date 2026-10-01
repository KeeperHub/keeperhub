/**
 * The app decides whether Pyth triggers exist (PYTH_API_KEY on the app) and
 * this worker decides whether anything listens (PYTH_API_KEY here). Set on
 * only one side, the feature fails silently: triggers that never fire, or a
 * worker with nothing to listen to. Returns the warning to log, or null when
 * both sides agree.
 */
export function describePythMismatch(
  workerHasKey: boolean,
  appEnabled: boolean,
  registrations: number,
): string | null {
  if (workerHasKey && !appEnabled) {
    return "[Pyth] PYTH_API_KEY is set on the event worker but Pyth triggers are disabled on the app; nothing will be listened to";
  }
  if (!workerHasKey && appEnabled) {
    return `[Pyth] Pyth triggers are enabled on the app but PYTH_API_KEY is not set on the event worker; ${registrations} enabled Pyth workflow(s) will not fire`;
  }
  return null;
}
