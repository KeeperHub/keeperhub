const SINGLETON_PREFIX = "keeperhub.rpc.engine.";

/**
 * One value per process, whichever copy of this module asks. Next.js can load
 * a module once for instrumentation and again for routes and steps; state
 * that both sides share (the usage accumulator, attribution storage, source
 * caches) must not be split between those copies.
 */
export function processSingleton<T>(name: string, create: () => T): T {
  const key = Symbol.for(`${SINGLETON_PREFIX}${name}`);
  const slots = globalThis as unknown as Record<symbol, T | undefined>;
  const existing = slots[key];
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  slots[key] = created;
  return created;
}
