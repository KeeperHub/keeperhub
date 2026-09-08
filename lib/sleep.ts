/**
 * Promise-based sleep. Lives in its own module (not lib/utils) on purpose:
 * step tests routinely mock "@/lib/utils", and a sleep import riding on that
 * module would vanish under those mocks and break retry paths under test.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
