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
  | "paused"
  | "unreachable";

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

/** Health of the saved target; a new or retargeted one has only this session's test. */
export function channelStatus(
  draft: DraftChannel,
  saved: ChannelView | undefined
): MethodStatus {
  const view = saved && sameTarget(draft, saved) ? saved : undefined;
  if (view?.pausedAt && draft.testedOk !== true) {
    return "paused";
  }
  const lastTestOk = draft.testedOk ?? view?.lastTestOk ?? null;
  if (lastTestOk === false) {
    return "failed";
  }
  if (lastTestOk === true || view?.lastDeliveredAt) {
    return "working";
  }
  return "untested";
}
