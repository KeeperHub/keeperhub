import type { InFlightTracker } from "./in-flight";

export type ReceiveLoopDeps<M> = {
  /** Long-poll the queue for at most `maxMessages` messages. */
  receive: (maxMessages: number) => Promise<M[]>;
  /** Handle one message; the loop does not wait for it. */
  process: (message: M) => Promise<void>;
  inFlight: InFlightTracker;
  /** Most messages handled at once, and the largest batch asked for. */
  maxInFlight: number;
  isStopping: () => boolean;
  /** Log a failed receive and wait before the next one. */
  onReceiveError: (error: unknown) => Promise<void>;
  onProcessError: (error: unknown) => void;
  /** Messages that arrived as the loop was stopping and were not started. */
  onIgnoredWhileStopping: (count: number) => void;
};

/**
 * Receive and handle queue messages with up to `maxInFlight` handlers running
 * at once. The loop goes back to the queue as soon as a slot is free instead of
 * waiting for the whole previous batch, so one slow handler (a warm-pool offer
 * waiting for its ack, a slow Job create) does not hold up the messages behind
 * it.
 */
export async function runReceiveLoop<M>(deps: ReceiveLoopDeps<M>): Promise<void> {
  while (!deps.isStopping()) {
    const free = deps.maxInFlight - deps.inFlight.size;
    if (free <= 0) {
      await deps.inFlight.settleAny();
      continue;
    }

    let messages: M[];
    try {
      messages = await deps.receive(free);
    } catch (error) {
      if (deps.isStopping()) {
        // The aborted long poll rejects; that is the loop's exit, not a fault.
        break;
      }
      await deps.onReceiveError(error);
      continue;
    }

    if (deps.isStopping()) {
      // A batch that landed as the abort fired. It is already invisible on the
      // queue, so leave it to redeliver after the visibility timeout rather
      // than start work the drain cannot see through.
      if (messages.length > 0) {
        deps.onIgnoredWhileStopping(messages.length);
      }
      break;
    }

    for (const message of messages) {
      deps.inFlight.track(deps.process(message)).catch(deps.onProcessError);
    }
  }
}
