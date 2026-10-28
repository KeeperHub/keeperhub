"use client";

import { Plus } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type {
  ChannelView,
  ConnectionView,
} from "@/lib/notifications/failure-alerts/view-types";
import { ChannelMethodCard } from "./method-card";
import {
  type DraftChannel,
  newMethodDraft,
  nextKey,
  sameTarget,
} from "./method-drafts";

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

  const remove = (channel: DraftChannel, label: string): void => {
    const index = channels.findIndex((c) => c.key === channel.key);
    onChange(channels.filter((c) => c.key !== channel.key));
    if (channel.fresh) {
      return;
    }
    const view = savedChannels.find((c) => c.id === channel.id);
    toast(`${label} removed`, {
      action: {
        label: "Undo",
        onClick: () => {
          const current = latest.current.channels;
          if (current.some((c) => sameTarget(c, channel))) {
            return;
          }
          const next = [...current];
          // It comes back as a new row, and a paused one comes back paused.
          next.splice(Math.min(index, next.length), 0, {
            ...channel,
            id: undefined,
            key: nextKey(),
            pausedReason: view?.pausedAt
              ? (view.pausedReason ?? "It stopped working.")
              : channel.pausedReason,
          });
          latest.current.onChange(next);
        },
      },
    });
  };

  return (
    <div className="space-y-2">
      {channels.length > 0 && (
        <ul className="space-y-2">
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
      <Button
        onClick={() => onChange([...channels, newMethodDraft(connections)])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" />
        Add a method
      </Button>
    </div>
  );
}
