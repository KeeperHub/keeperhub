import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
} from "@/lib/db/schema-failure-alerts";
import type { ChannelView } from "@/lib/notifications/failure-alerts/view-types";

/** A chat or PagerDuty method as a card holds it: saved (with an id) or new. */
export type DraftChannel = {
  key: string;
  id?: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  destination: string;
  role: FailureAlertChannelRole;
  /** The outcome of a test of the current target in this session. */
  testedOk?: boolean;
  /** A paused channel put back by Undo: it is saved paused, not live. */
  pausedReason?: string;
  /** Opened by "Add a method": its method can still be picked. */
  fresh?: boolean;
};

export type ChannelPayload = {
  id?: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  destination: string;
  role: FailureAlertChannelRole;
  pausedReason?: string;
};

/** A method's state as its badge shows it. */
export type MethodStatus =
  | "working"
  | "untested"
  | "failed"
  | "delivery"
  | "paused"
  | "missing"
  | "unsaved"
  | "refused"
  | "unreachable";

/** States a method row opens itself for, so the problem is in view. */
export const BROKEN_STATUSES: readonly MethodStatus[] = [
  "failed",
  "delivery",
  "paused",
  "missing",
  "refused",
  "unreachable",
];

const TELEGRAM_CHAT_ID = /^-?\d+$|^@[A-Za-z]\w{4,}$/;

export const CHANNEL_KINDS: FailureAlertChannelKind[] = [
  "telegram",
  "discord",
  "slack",
  "pagerduty",
];

let draftCounter = 0;
export function nextKey(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

/** The card "Add a method" opens, on the first method that has a connection. */
export function newMethodDraft(
  connections: { id: string; kind: FailureAlertChannelKind }[]
): DraftChannel {
  const kind =
    CHANNEL_KINDS.find((k) => connections.some((c) => c.kind === k)) ??
    "telegram";
  return {
    key: nextKey(),
    kind,
    integrationId: connections.find((c) => c.kind === kind)?.id ?? "",
    destination: "",
    role: "always",
    fresh: true,
  };
}

export function draftFromView(view: ChannelView): DraftChannel {
  return {
    key: view.id,
    id: view.id,
    kind: view.kind,
    integrationId: view.integrationId,
    destination: view.destination,
    role: view.role,
  };
}

export function draftsFromViews(views: ChannelView[]): DraftChannel[] {
  return views.map(draftFromView);
}

export function channelPayload(channel: DraftChannel): ChannelPayload {
  const { id, kind, integrationId, destination, role, pausedReason } = channel;
  return { id, kind, integrationId, destination, role, pausedReason };
}

export function channelsPayload(channels: DraftChannel[]): ChannelPayload[] {
  return channels.map(channelPayload);
}

/** Discord's webhook lives in the connection, so it has no destination. */
export function needsDestination(kind: FailureAlertChannelKind): boolean {
  return kind !== "discord";
}

/** Same place to send to: a test of one counts for the other. */
export function sameTarget(
  a: Pick<DraftChannel, "kind" | "integrationId" | "destination">,
  b: Pick<DraftChannel, "kind" | "integrationId" | "destination">
): boolean {
  return (
    a.kind === b.kind &&
    a.integrationId === b.integrationId &&
    a.destination === b.destination
  );
}

/** Differs from what was saved, or was never saved. */
export function isChannelDirty(
  draft: DraftChannel,
  saved: ChannelView | undefined
): boolean {
  if (!saved) {
    return true;
  }
  return !sameTarget(draft, saved) || draft.role !== saved.role;
}

/** A target the server would refuse anyway, caught before asking it. */
export function destinationProblem(draft: DraftChannel): string | null {
  const value = draft.destination.trim();
  if (draft.kind === "telegram" && value && !TELEGRAM_CHAT_ID.test(value)) {
    return "That is not a chat ID. Use a number such as -1001234567890, or @name for a public channel.";
  }
  return null;
}

/** The last delivery failed and nothing has been delivered since. */
function lastDeliveryFailed(view: ChannelView): boolean {
  return Boolean(
    view.lastFailedAt &&
      (!view.lastDeliveredAt || view.lastFailedAt > view.lastDeliveredAt)
  );
}

/** Could reach people right now, as far as KeeperHub knows. */
export function channelWorks(view: ChannelView): boolean {
  return !(view.pausedAt || view.connectionMissing || lastDeliveryFailed(view));
}

/** Health of the saved target, else this session's test; `connectionKnown` false = connection not listed. */
export function channelStatus(
  draft: DraftChannel,
  saved: ChannelView | undefined,
  connectionKnown: boolean
): MethodStatus {
  const missing = Boolean(draft.integrationId) && !connectionKnown;
  if (!(saved && sameTarget(draft, saved))) {
    if (missing) {
      return "missing";
    }
    return draft.testedOk === false ? "failed" : "unsaved";
  }
  if (missing || saved.connectionMissing) {
    return "missing";
  }
  if (draft.testedOk === true) {
    return "working";
  }
  if (saved.pausedAt) {
    return "paused";
  }
  if (draft.testedOk === false) {
    return "failed";
  }
  if (lastDeliveryFailed(saved)) {
    return "delivery";
  }
  const testedLater =
    saved.lastTestedAt &&
    (!saved.lastDeliveredAt || saved.lastTestedAt > saved.lastDeliveredAt);
  if (saved.lastTestOk === false && testedLater) {
    return "failed";
  }
  if (saved.lastDeliveredAt || saved.lastTestOk || saved.lastHealthCheckAt) {
    return "working";
  }
  return "untested";
}
