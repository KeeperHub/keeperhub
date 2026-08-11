import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";
import { logger } from "../../lib/utils/logger";
import {
  enqueueWorkflowBlockTrigger,
  enqueueWorkflowEventTrigger,
} from "../../lib/workflow-sqs";
import {
  type AnchorEventDecoder,
  createEventDecoder,
} from "../decode/solana-idl";
import type { DedupStore } from "../dedup";
import { formatError } from "../format-error";
import { type BlockFire, matchBlocks } from "../match/block-matcher";
import { type EventFire, matchEvents } from "../match/event-matcher";
import type { NormalizedBlock } from "../match/types";
import type { ChainRegistration } from "../registrations";
import type { BlockSource, ConnectionHealth, Endpoint } from "./block-source";
import { createBlockSource } from "./source-factory";

/**
 * Per-chain ingestor. Owns a BlockSource (getBlock polling by default, Geyser
 * when configured) and, for every block it produces, runs both matchers and
 * fans out to phantom + SQS. The source-vs-match split keeps ingestion swappable
 * without touching matching/decode/enqueue.
 */
export interface BlockIngestorDeps {
  registration: ChainRegistration;
  sqs: SQSClient;
  sqsQueueUrl: string;
  dedup: DedupStore;
}

export class BlockIngestor {
  private registration: ChainRegistration;
  private readonly deps: BlockIngestorDeps;
  private source: BlockSource | null = null;
  private decoders = new Map<string, AnchorEventDecoder | null>();
  private started = false;

  constructor(deps: BlockIngestorDeps) {
    this.deps = deps;
    this.registration = deps.registration;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.rebuildDecoders();
    this.source = createBlockSource(
      {
        chainId: this.registration.chainId,
        endpoints: this.endpoints(),
        commitment: this.registration.commitment,
        watchedProgramIds: this.registration.eventTriggers.map(
          (t) => t.programId,
        ),
        onBlock: (block) => this.processBlock(block),
      },
      {
        geyser: this.registration.geyserEndpoint
          ? {
              endpoint: this.registration.geyserEndpoint,
              token: this.registration.geyserToken,
            }
          : undefined,
        sourceMode: this.registration.sourceMode,
        hasBlockTriggers: this.registration.blockTriggers.length > 0,
      },
    );
    await this.source.start();
    this.started = true;
    logger.log(
      `[ingestor] chain ${this.registration.chainId} started (events=${this.registration.eventTriggers.length}, blocks=${this.registration.blockTriggers.length})`,
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.source) {
      await this.source.stop();
      this.source = null;
    }
    logger.log(`[ingestor] chain ${this.registration.chainId} stopped`);
  }

  /** In-place refresh when only the trigger set changed (endpoints unchanged). */
  updateRegistration(registration: ChainRegistration): void {
    this.registration = registration;
    this.rebuildDecoders();
  }

  hasConfigChanged(registration: ChainRegistration): boolean {
    return registration.configHash !== this.registration.configHash;
  }

  sameEndpoints(registration: ChainRegistration): boolean {
    return (
      registration.rpcUrl === this.registration.rpcUrl &&
      registration.fallbackRpcUrl === this.registration.fallbackRpcUrl &&
      registration.wssUrl === this.registration.wssUrl &&
      registration.fallbackWssUrl === this.registration.fallbackWssUrl &&
      registration.commitment === this.registration.commitment &&
      registration.geyserEndpoint === this.registration.geyserEndpoint &&
      registration.sourceMode === this.registration.sourceMode
    );
  }

  getHealth(): ConnectionHealth | undefined {
    return this.source?.getHealth();
  }

  private endpoints(): Endpoint[] {
    const endpoints: Endpoint[] = [
      { rpcUrl: this.registration.rpcUrl, wssUrl: this.registration.wssUrl },
    ];
    if (this.registration.fallbackWssUrl) {
      endpoints.push({
        rpcUrl: this.registration.fallbackRpcUrl ?? this.registration.rpcUrl,
        wssUrl: this.registration.fallbackWssUrl,
      });
    }
    return endpoints;
  }

  private rebuildDecoders(): void {
    this.decoders = new Map();
    for (const trigger of this.registration.eventTriggers) {
      this.decoders.set(
        trigger.workflowId,
        createEventDecoder(trigger.idl, trigger.workflowId),
      );
    }
  }

  /** Runs both matchers over one produced block and fans out to phantom + SQS. */
  private async processBlock(block: NormalizedBlock): Promise<void> {
    for (const fire of matchBlocks(block, this.registration.blockTriggers)) {
      await this.enqueueBlock(fire);
    }
    const eventFires = matchEvents(
      block,
      this.registration.eventTriggers,
      this.decoders,
      this.registration.commitment,
    );
    for (const fire of eventFires) {
      await this.enqueueEvent(fire);
    }
  }

  private async enqueueEvent(fire: EventFire): Promise<void> {
    let alreadyProcessed = false;
    try {
      alreadyProcessed = await this.deps.dedup.isProcessed(
        fire.workflowId,
        fire.signature,
      );
    } catch (err) {
      logger.warn(
        `[ingestor] dedup read failed for ${fire.workflowId}/${fire.signature}, proceeding: ${formatError(err)}`,
      );
    }
    if (alreadyProcessed) {
      return;
    }
    const executionId = await createPhantomExecution(
      fire.workflowId,
      fire.userId,
      "event",
      "events",
    );
    try {
      await enqueueWorkflowEventTrigger(this.deps.sqs, this.deps.sqsQueueUrl, {
        executionId,
        workflowId: fire.workflowId,
        userId: fire.userId,
        triggerData: fire.payload,
      });
    } catch (err) {
      if (executionId) {
        await failPhantomExecution(
          executionId,
          "ES-0001",
          `Solana event trigger failed to dispatch: ${formatError(err)}`,
          "events",
        );
      }
      throw err;
    }
    logger.log(
      `[ingestor] chain ${this.registration.chainId} enqueued event ${fire.workflowId}/${fire.signature.slice(0, 12)} (slot ${fire.payload.slot})`,
    );
    try {
      await this.deps.dedup.markProcessed(fire.workflowId, fire.signature);
    } catch (err) {
      logger.warn(
        `[ingestor] dedup mark failed for ${fire.workflowId}/${fire.signature}: ${formatError(err)}`,
      );
    }
  }

  private async enqueueBlock(fire: BlockFire): Promise<void> {
    // Block triggers have no natural idempotency key like an event's tx
    // signature; dedup on (workflowId, blockHeight) so a re-processed block
    // (e.g. an enqueue that partially failed and was retried) does not
    // double-fire the workflow.
    const dedupKey = `block:${fire.payload.blockHeight}`;
    let alreadyProcessed = false;
    try {
      alreadyProcessed = await this.deps.dedup.isProcessed(
        fire.workflowId,
        dedupKey,
      );
    } catch (err) {
      logger.warn(
        `[ingestor] dedup read failed for ${fire.workflowId}/${dedupKey}, proceeding: ${formatError(err)}`,
      );
    }
    if (alreadyProcessed) {
      return;
    }
    const executionId = await createPhantomExecution(
      fire.workflowId,
      fire.userId,
      "block",
      "scheduler",
    );
    try {
      await enqueueWorkflowBlockTrigger(this.deps.sqs, this.deps.sqsQueueUrl, {
        executionId,
        workflowId: fire.workflowId,
        userId: fire.userId,
        triggerData: fire.payload,
      });
    } catch (err) {
      if (executionId) {
        await failPhantomExecution(
          executionId,
          "BS-0001",
          `Solana block trigger failed to dispatch: ${formatError(err)}`,
          "scheduler",
        );
      }
      throw err;
    }
    logger.log(
      `[ingestor] chain ${this.registration.chainId} enqueued block ${fire.workflowId} (height ${fire.payload.blockHeight})`,
    );
    try {
      await this.deps.dedup.markProcessed(fire.workflowId, dedupKey);
    } catch (err) {
      logger.warn(
        `[ingestor] dedup mark failed for ${fire.workflowId}/${dedupKey}: ${formatError(err)}`,
      );
    }
  }
}
