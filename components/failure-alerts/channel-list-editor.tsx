"use client";

import { Plus } from "lucide-react";
import { type Ref, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MAX_CHANNELS } from "@/lib/notifications/failure-alerts/constants";
import type {
  ChannelView,
  ConnectionView,
} from "@/lib/notifications/failure-alerts/view-types";
import { ChannelMethodCard, focusMethodAt } from "./method-card";
import {
  type DraftChannel,
  METHODS_FULL,
  newMethodDraft,
  nextKey,
  restoreMethod,
} from "./method-drafts";

/** "Add a method", off once the list holds as many methods as a save takes. */
export function AddMethodButton({
  count,
  onClick,
  buttonRef,
  testId,
}: {
  count: number;
  onClick: () => void;
  buttonRef: Ref<HTMLButtonElement>;
  testId?: string;
}): React.ReactElement {
  const full = count >= MAX_CHANNELS;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        data-testid={testId}
        disabled={full}
        onClick={onClick}
        ref={buttonRef}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" />
        Add a method
      </Button>
      {full && <p className="text-muted-foreground text-xs">{METHODS_FULL}</p>}
    </div>
  );
}

/**
 * A workflow's own methods, as the same cards as Settings. Nothing saves here:
 * the panel's Save sends the whole list.
 */
export function ChannelListEditor({
  organizationId,
  channels,
  savedChannels,
  connections,
  onChange,
  onConnectionsChanged,
}: {
  organizationId: string;
  channels: DraftChannel[];
  /** The workflow's stored channels, for each card's health. */
  savedChannels: ChannelView[];
  connections: ConnectionView[];
  onChange: (channels: DraftChannel[]) => void;
  onConnectionsChanged: () => Promise<void> | void;
}): React.ReactElement {
  // An Undo can come long after the removal, so it works on the list as it
  // is by then rather than the one it was removed from.
  const latest = useRef({ channels, onChange });
  latest.current = { channels, onChange };
  const listRef = useRef<HTMLUListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const remove = (channel: DraftChannel, label: string): void => {
    const index = channels.findIndex((c) => c.key === channel.key);
    onChange(channels.filter((c) => c.key !== channel.key));
    focusMethodAt(listRef, channel.fresh ? channels.length : index, addRef);
    if (channel.fresh) {
      return;
    }
    const view = savedChannels.find((c) => c.id === channel.id);
    toast(`${label} removed`, {
      action: {
        label: "Undo",
        onClick: () => {
          // It comes back as a new row, and a paused one comes back paused.
          const next = restoreMethod(
            latest.current.channels,
            {
              ...channel,
              id: undefined,
              key: nextKey(),
              pausedReason: view?.pausedAt
                ? (view.pausedReason ?? "It stopped working.")
                : channel.pausedReason,
            },
            index
          );
          if (next === "full") {
            toast.error(METHODS_FULL);
          } else if (next) {
            latest.current.onChange(next);
          }
        },
      },
    });
  };

  return (
    <div className="space-y-2">
      {channels.length > 0 && (
        <ul aria-label="Alert methods" className="space-y-2" ref={listRef}>
          {channels.map((channel) => (
            <ChannelMethodCard
              canManage
              connections={connections}
              draft={channel}
              key={channel.key}
              onChange={(next) =>
                onChange(channels.map((c) => (c.key === next.key ? next : c)))
              }
              onConnectionsChanged={onConnectionsChanged}
              onRemove={(label) => remove(channel, label)}
              organizationId={organizationId}
              saved={savedChannels.find((c) => c.id === channel.id)}
            />
          ))}
        </ul>
      )}
      <AddMethodButton
        buttonRef={addRef}
        count={channels.length}
        onClick={() => {
          onChange([...channels, newMethodDraft(connections)]);
          focusMethodAt(listRef, channels.length, null);
        }}
      />
    </div>
  );
}
