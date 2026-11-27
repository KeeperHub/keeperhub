/** A network-free stand-in for the web3.js Connection, recording what was built. */

export interface FakeConnRecord {
  rpcUrl: string;
  wsEndpoint: string | undefined;
  fireSlot: (slot: number) => void;
  removed: boolean;
}

export interface FakeWeb3State {
  slot: number;
  instances: FakeConnRecord[];
  /** RPC URLs whose slot subscription throws. */
  subscribeThrows: Set<string>;
  /** RPC URLs whose HTTP reads reject. */
  rpcRejects: Set<string>;
}

export function createFakeWeb3State(): FakeWeb3State {
  return {
    slot: 100,
    instances: [],
    subscribeThrows: new Set(),
    rpcRejects: new Set(),
  };
}

export function resetFakeWeb3(state: FakeWeb3State): void {
  state.slot = 100;
  state.instances.length = 0;
  state.subscribeThrows.clear();
  state.rpcRejects.clear();
}

export function makeFakeConnection(state: FakeWeb3State): unknown {
  return class FakeConnection {
    private cb: ((info: { slot: number }) => void) | null = null;
    private readonly record: FakeConnRecord;
    constructor(rpcUrl: string, config: { wsEndpoint?: string } = {}) {
      this.record = {
        rpcUrl,
        wsEndpoint: config.wsEndpoint,
        fireSlot: (slot: number) => this.cb?.({ slot }),
        removed: false,
      };
      state.instances.push(this.record);
    }
    onSlotChange(cb: (info: { slot: number }) => void): number {
      if (state.subscribeThrows.has(this.record.rpcUrl)) {
        throw new Error(`subscribe failed for ${this.record.rpcUrl}`);
      }
      this.cb = cb;
      return 1;
    }
    removeSlotChangeListener(): Promise<void> {
      this.record.removed = true;
      return Promise.resolve();
    }
    private read<T>(value: T): Promise<T> {
      if (state.rpcRejects.has(this.record.rpcUrl)) {
        return Promise.reject(
          new Error(`request to ${this.record.rpcUrl} failed`),
        );
      }
      return Promise.resolve(value);
    }
    getSlot(): Promise<number> {
      return this.read(state.slot);
    }
    getBlocks(): Promise<number[]> {
      return this.read([]);
    }
    getBlock(): Promise<null> {
      return this.read(null);
    }
    getSignaturesForAddress(): Promise<unknown[]> {
      return this.read([]);
    }
    getTransaction(): Promise<null> {
      return this.read(null);
    }
  };
}
