import "server-only";
import type {
  EventId,
  EventStore,
  StreamId,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MAX_EVENTS_PER_STREAM = 1000;
const STREAM_TTL_MS = 60 * 60 * 1000; // 1 hour

interface StoredEvent {
  eventId: EventId;
  message: JSONRPCMessage;
  timestamp: number;
}

interface StreamEntry {
  events: StoredEvent[];
  createdAt: number;
}

export class McpEventStore implements EventStore {
  private readonly streams = new Map<StreamId, StreamEntry>();
  private readonly eventToStream = new Map<EventId, StreamId>();

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    this.evictExpired();

    const eventId = crypto.randomUUID();
    let entry = this.streams.get(streamId);

    if (!entry) {
      entry = { events: [], createdAt: Date.now() };
      this.streams.set(streamId, entry);
    }

    entry.events.push({ eventId, message, timestamp: Date.now() });

    if (entry.events.length > MAX_EVENTS_PER_STREAM) {
      const removed = entry.events.splice(
        0,
        entry.events.length - MAX_EVENTS_PER_STREAM
      );
      for (const ev of removed) {
        this.eventToStream.delete(ev.eventId);
      }
    }

    this.eventToStream.set(eventId, streamId);
    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this.eventToStream.get(eventId));
  }

  async replayEventsAfter(
    lastEventId: EventId,
    {
      send,
    }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const streamId = this.eventToStream.get(lastEventId);
    if (!streamId) {
      throw new Error(`Unknown event ID: ${lastEventId}`);
    }

    const entry = this.streams.get(streamId);
    if (!entry) {
      throw new Error(`Stream not found for event ID: ${lastEventId}`);
    }

    let found = false;
    for (const ev of entry.events) {
      if (found) {
        await send(ev.eventId, ev.message);
      }
      if (ev.eventId === lastEventId) {
        found = true;
      }
    }

    return streamId;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - STREAM_TTL_MS;
    for (const [streamId, entry] of this.streams) {
      if (entry.createdAt < cutoff) {
        for (const ev of entry.events) {
          this.eventToStream.delete(ev.eventId);
        }
        this.streams.delete(streamId);
      }
    }
  }
}
