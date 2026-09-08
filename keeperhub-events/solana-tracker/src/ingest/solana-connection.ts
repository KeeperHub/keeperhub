import {
  type Commitment,
  type ConfirmedSignatureInfo,
  Connection,
  type Finality,
  type GetVersionedBlockConfig,
  PublicKey,
  type SignaturesForAddressOptions,
  type VersionedBlockResponse,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { logger } from "../../lib/utils/logger";

/**
 * Per-chain Solana connection: a web3.js Connection providing both the WS
 * `slotSubscribe` tick and the HTTP `getBlock`/`getBlocks` reads, with a
 * slot-staleness watchdog that rebuilds the connection and rotates
 * primary<->fallback endpoints when the slot stream stalls (the analog of the
 * EVM block-dispatcher's no-block-advance reconnect).
 */

const SLOT_STALENESS_CHECK_MS = 15_000;
const SLOT_STALENESS_TIMEOUT_MS = 60_000;

export interface Endpoint {
  rpcUrl: string;
  wssUrl: string;
}

export interface ConnectionHealth {
  chainId: number;
  connected: boolean;
  reconnecting: boolean;
  lastSlotAt: number | null;
  activeEndpoint: string;
  lastError: string | null;
}

function toFinality(commitment: Commitment): Finality {
  return commitment === "finalized" ? "finalized" : "confirmed";
}

export class SolanaConnection {
  private connection: Connection | null = null;
  private slotSubId: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private activeIndex = 0;
  private lastSlotAt: number | null = null;
  private reconnecting = false;
  private lastError: string | null = null;
  private stopped = false;

  constructor(
    private readonly opts: {
      chainId: number;
      endpoints: Endpoint[];
      commitment: Commitment;
      onSlot: (slot: number) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.openAndSubscribe();
    if (!this.watchdog) {
      this.watchdog = setInterval(
        () => this.checkStaleness(),
        SLOT_STALENESS_CHECK_MS,
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    await this.removeSub();
    this.connection = null;
  }

  private getConnection(): Connection {
    if (!this.connection) {
      const endpoint = this.opts.endpoints[this.activeIndex];
      this.connection = new Connection(endpoint.rpcUrl, {
        wsEndpoint: endpoint.wssUrl,
        commitment: this.opts.commitment,
      });
    }
    return this.connection;
  }

  private openAndSubscribe(): void {
    try {
      const connection = this.getConnection();
      this.slotSubId = connection.onSlotChange((info) => {
        this.lastSlotAt = Date.now();
        this.lastError = null;
        this.reconnecting = false;
        if (!this.stopped) {
          this.opts.onSlot(info.slot);
        }
      });
      this.lastSlotAt = Date.now();
      logger.log(
        `[solana-conn] chain ${this.opts.chainId} slot subscription on ${this.opts.endpoints[this.activeIndex].wssUrl}`,
      );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[solana-conn] chain ${this.opts.chainId} subscribe failed: ${this.lastError}`,
      );
    }
  }

  private checkStaleness(): void {
    if (this.stopped || this.reconnecting || this.lastSlotAt === null) {
      return;
    }
    if (Date.now() - this.lastSlotAt > SLOT_STALENESS_TIMEOUT_MS) {
      logger.warn(
        `[solana-conn] chain ${this.opts.chainId} slot stream stale; reconnecting`,
      );
      void this.reconnect();
    }
  }

  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    await this.removeSub();
    this.connection = null;
    if (this.opts.endpoints.length > 1) {
      this.activeIndex = (this.activeIndex + 1) % this.opts.endpoints.length;
    }
    this.openAndSubscribe();
  }

  private async removeSub(): Promise<void> {
    if (this.slotSubId !== null && this.connection) {
      const id = this.slotSubId;
      const connection = this.connection;
      await connection.removeSlotChangeListener(id).catch(() => {
        // best-effort; socket may already be gone
      });
    }
    this.slotSubId = null;
  }

  async getBlock(
    slot: number,
    transactionDetails: "full" | "none",
  ): Promise<VersionedBlockResponse | null> {
    const config: GetVersionedBlockConfig = {
      commitment: toFinality(this.opts.commitment),
      maxSupportedTransactionVersion: 0,
      rewards: false,
      transactionDetails,
    };
    return (await this.getConnection().getBlock(
      slot,
      config,
    )) as VersionedBlockResponse | null;
  }

  async getProducedSlots(from: number, to: number): Promise<number[]> {
    return this.getConnection().getBlocks(
      from,
      to,
      toFinality(this.opts.commitment),
    );
  }

  async getCurrentSlot(): Promise<number> {
    return this.getConnection().getSlot(toFinality(this.opts.commitment));
  }

  /**
   * Server-side program-filtered signature query - the Solana analog of EVM
   * `eth_getLogs`'s `address` filter (used by the SignaturesSource).
   */
  async getSignaturesForAddress(
    address: string,
    options: SignaturesForAddressOptions,
  ): Promise<ConfirmedSignatureInfo[]> {
    return this.getConnection().getSignaturesForAddress(
      new PublicKey(address),
      options,
      toFinality(this.opts.commitment),
    );
  }

  async getTransaction(
    signature: string,
  ): Promise<VersionedTransactionResponse | null> {
    return this.getConnection().getTransaction(signature, {
      commitment: toFinality(this.opts.commitment),
      maxSupportedTransactionVersion: 0,
    });
  }

  getHealth(): ConnectionHealth {
    return {
      chainId: this.opts.chainId,
      connected: this.slotSubId !== null && !this.reconnecting,
      reconnecting: this.reconnecting,
      lastSlotAt: this.lastSlotAt,
      activeEndpoint: this.opts.endpoints[this.activeIndex]?.wssUrl ?? "",
      lastError: this.lastError,
    };
  }
}
