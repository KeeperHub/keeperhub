/**
 * A string-keyed cache holding at most `limit` entries. Reading or writing a
 * key makes it the most recent; past the limit the least recent is dropped.
 */
export class BoundedCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }

  forEach(visit: (value: V, key: string) => void): void {
    for (const [key, value] of this.entries) {
      visit(value, key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
