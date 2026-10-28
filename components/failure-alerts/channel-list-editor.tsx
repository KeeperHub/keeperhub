"use client";

import { useSetAtom } from "jotai";
import { Loader2, Plus, X } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PagerDutyServiceField } from "@/components/workflow/config/pagerduty-resource-field";
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
} from "@/lib/db/schema-failure-alerts";
import { integrationsVersionAtom } from "@/lib/integrations-store";
import {
  CHANNEL_LABEL,
  type ChannelView,
  type ConnectionView,
  type TestResult,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { sendFailureAlertTest } from "./api";
import { TestResultLine } from "./test-result-line";

/** A channel as the form holds it: saved (with health) or just added. */
export type DraftChannel = {
  key: string;
  id?: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  destination: string;
  role: FailureAlertChannelRole;
  view?: ChannelView;
  /** Set by a test in this session; a new channel stays "Untested" until then. */
  testedOk?: boolean;
};

const KINDS: FailureAlertChannelKind[] = [
  "telegram",
  "discord",
  "slack",
  "pagerduty",
];

const TRAILING_DOTS = /\.+$/;

let draftCounter = 0;
function nextKey(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

export function draftsFromViews(views: ChannelView[]): DraftChannel[] {
  return views.map((view) => ({
    key: view.id,
    id: view.id,
    kind: view.kind,
    integrationId: view.integrationId,
    destination: view.destination,
    role: view.role,
    view,
  }));
}

export function channelsPayload(channels: DraftChannel[]): {
  id?: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  destination: string;
  role: FailureAlertChannelRole;
}[] {
  return channels.map(({ id, kind, integrationId, destination, role }) => ({
    id,
    kind,
    integrationId,
    destination,
    role,
  }));
}

function destinationLabel(
  channel: Pick<DraftChannel, "kind" | "destination">,
  connectionName: string | undefined
): string {
  if (channel.kind === "discord") {
    return connectionName ?? "Discord";
  }
  if (channel.kind === "pagerduty") {
    return `service ${channel.destination}`;
  }
  return channel.destination;
}

function HealthLine({
  channel,
}: {
  channel: DraftChannel;
}): React.ReactElement {
  const view = channel.view;
  if (!view) {
    return <span className="text-muted-foreground">Not saved yet</span>;
  }
  if (view.pausedAt) {
    return (
      <span className="text-destructive">
        {(view.pausedReason ?? "").replace(TRAILING_DOTS, "")} (
        {timeAgo(view.pausedAt)}). Test it to turn it back on.
      </span>
    );
  }
  const failedLast =
    view.lastFailedAt &&
    (!view.lastDeliveredAt || view.lastFailedAt > view.lastDeliveredAt);
  if (failedLast && view.lastFailedAt) {
    return (
      <span className="text-destructive">
        Last delivery failed {timeAgo(view.lastFailedAt)}: {view.lastError}
      </span>
    );
  }
  if (view.lastDeliveredAt) {
    return (
      <span className="text-muted-foreground">
        Last delivered {timeAgo(view.lastDeliveredAt)}
      </span>
    );
  }
  return <span className="text-muted-foreground">Never used yet</span>;
}

function isUntested(channel: DraftChannel): boolean {
  if (channel.testedOk) {
    return false;
  }
  const view = channel.view;
  return !(view?.lastTestOk || view?.lastDeliveredAt);
}

type PagerDutyMode = "change" | "page";

function PagerDutyModeChoice({
  value,
  onChange,
  idPrefix,
}: {
  value: PagerDutyMode;
  onChange: (mode: PagerDutyMode) => void;
  idPrefix: string;
}): React.ReactElement {
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">How to test PagerDuty</legend>
      <label
        className="flex cursor-pointer items-start gap-2 text-sm"
        htmlFor={`${idPrefix}-change`}
      >
        <input
          checked={value === "change"}
          className="mt-1 accent-current"
          id={`${idPrefix}-change`}
          name={`${idPrefix}-mode`}
          onChange={() => onChange("change")}
          type="radio"
        />
        <span>
          Check the connection (recommended)
          <span className="block text-muted-foreground text-xs">
            Sends a change event. It shows on the service timeline and never
            pages anyone.
          </span>
        </span>
      </label>
      <label
        className="flex cursor-pointer items-start gap-2 text-sm"
        htmlFor={`${idPrefix}-page`}
      >
        <input
          checked={value === "page"}
          className="mt-1 accent-current"
          id={`${idPrefix}-page`}
          name={`${idPrefix}-mode`}
          onChange={() => onChange("page")}
          type="radio"
        />
        <span>
          Send a real test page
          <span className="block text-muted-foreground text-xs">
            Opens a "KeeperHub test" incident and resolves it straight away.
            Whoever is on call may be paged.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

function ChannelRow({
  channel,
  connections,
  organizationId,
  canManage,
  onChange,
  onRemove,
}: {
  channel: DraftChannel;
  connections: ConnectionView[];
  organizationId: string;
  canManage: boolean;
  onChange: (next: DraftChannel) => void;
  onRemove: (label: string) => void;
}): React.ReactElement {
  const connection = connections.find((c) => c.id === channel.integrationId);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [pdMode, setPdMode] = useState<PagerDutyMode>("change");
  const [choosingPdMode, setChoosingPdMode] = useState(false);
  const label = `${CHANNEL_LABEL[channel.kind]} ${destinationLabel(
    channel,
    connection?.name ?? channel.view?.connectionName ?? undefined
  )}`;

  const runTest = useCallback(async () => {
    setTesting(true);
    setResult(null);
    const outcome = await sendFailureAlertTest(organizationId, {
      channel: channel.kind,
      integrationId: channel.integrationId,
      destination: channel.destination,
      channelId: channel.id,
      pagerDutyMode: pdMode,
    });
    setTesting(false);
    setChoosingPdMode(false);
    setResult(outcome);
    if (outcome.delivered) {
      onChange({
        ...channel,
        testedOk: true,
        view: channel.view
          ? {
              ...channel.view,
              pausedAt: null,
              pausedReason: null,
              lastTestOk: true,
            }
          : channel.view,
      });
    }
  }, [channel, onChange, organizationId, pdMode]);

  const paused = Boolean(channel.view?.pausedAt);

  return (
    <li
      className={cn(
        "space-y-2 rounded-lg border bg-background/40 p-3",
        paused && "border-destructive/50"
      )}
      data-testid="failure-alert-channel"
    >
      {/* Stacked in a narrow column (a phone, or the Properties panel) so the
          name and its health line get the full width instead of a sliver
          beside the controls. */}
      <div className="flex flex-col gap-3 @xl/settings:flex-row @xl/settings:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <IntegrationIcon className="size-4" integration={channel.kind} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="min-w-0 break-words @xl/settings:truncate">
                {label}
              </span>
              {paused && (
                <Badge
                  className="border-destructive/50 text-destructive"
                  variant="outline"
                >
                  Paused
                </Badge>
              )}
              {!paused && isUntested(channel) && (
                <Badge
                  className="border-yellow-500/40 text-yellow-600 dark:text-yellow-400"
                  variant="outline"
                >
                  Untested
                </Badge>
              )}
            </div>
            <p className="text-xs">
              <HealthLine channel={channel} />
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 @xl/settings:shrink-0">
          <Select
            disabled={!canManage}
            onValueChange={(role) =>
              onChange({ ...channel, role: role as FailureAlertChannelRole })
            }
            value={channel.role}
          >
            <SelectTrigger
              aria-label={`When to use ${label}`}
              className="h-8 min-w-0 flex-1 text-xs @xl/settings:w-40 @xl/settings:flex-none"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always</SelectItem>
              <SelectItem value="backup">Only as a backup</SelectItem>
            </SelectContent>
          </Select>
          {canManage && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                aria-expanded={
                  channel.kind === "pagerduty" ? choosingPdMode : undefined
                }
                aria-label={`Test ${label}`}
                disabled={testing}
                onClick={() =>
                  channel.kind === "pagerduty"
                    ? setChoosingPdMode((open) => !open)
                    : runTest()
                }
                size="sm"
                type="button"
                variant={paused || isUntested(channel) ? "default" : "outline"}
              >
                {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Test
              </Button>
              <Button
                aria-label={`Remove ${label}`}
                onClick={() => onRemove(label)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
      {!connection && (
        <Notice tone="danger">
          Its connection was deleted or is no longer shared with the
          organization.
        </Notice>
      )}
      {channel.role === "backup" && (
        <p className="text-muted-foreground text-xs">
          Gets an alert only when email or another channel could not deliver it,
          with a note saying which one failed.
        </p>
      )}
      {choosingPdMode && (
        <div className="space-y-3 rounded-md border p-3">
          <PagerDutyModeChoice
            idPrefix={`pd-${channel.key}`}
            onChange={setPdMode}
            value={pdMode}
          />
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setChoosingPdMode(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={testing}
              onClick={runTest}
              size="sm"
              type="button"
            >
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Send test
            </Button>
          </div>
        </div>
      )}
      {result && <TestResultLine result={result} />}
    </li>
  );
}

function AddChannelForm({
  organizationId,
  connections,
  unsharedConnections,
  onAdd,
  onCancel,
  onConnectionsChanged,
}: {
  organizationId: string;
  connections: ConnectionView[];
  unsharedConnections: ConnectionView[];
  onAdd: (channel: DraftChannel) => void;
  onCancel: () => void;
  onConnectionsChanged: () => Promise<void> | void;
}): React.ReactElement {
  const { push } = useOverlay();
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const idPrefix = useId();
  const [kind, setKind] = useState<FailureAlertChannelKind>("telegram");
  // Start with a connection picked, as switching the channel type does.
  const [integrationId, setIntegrationId] = useState(
    () => connections.find((c) => c.kind === "telegram")?.id ?? ""
  );
  const [destination, setDestination] = useState("");
  const [pdMode, setPdMode] = useState<PagerDutyMode>("change");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const ofKind = connections.filter((c) => c.kind === kind);
  const unsharedOfKind = unsharedConnections.filter((c) => c.kind === kind);
  const needsDestination = kind !== "discord";
  const ready =
    Boolean(integrationId) && (!needsDestination || destination.trim());

  const pickKind = (next: FailureAlertChannelKind): void => {
    setKind(next);
    setIntegrationId(connections.find((c) => c.kind === next)?.id ?? "");
    setDestination("");
    setResult(null);
  };

  const newConnection = (): void => {
    push(ConfigureConnectionOverlay, {
      type: kind,
      onSuccess: async (id: string) => {
        // Workflow-node connection pickers that are open elsewhere refetch on
        // this, so the new connection shows up there too.
        setIntegrationsVersion((v) => v + 1);
        await onConnectionsChanged();
        setIntegrationId(id);
      },
    });
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    setResult(
      await sendFailureAlertTest(organizationId, {
        channel: kind,
        integrationId,
        destination: destination.trim(),
        pagerDutyMode: pdMode,
      })
    );
    setTesting(false);
  };

  const add = (): void => {
    onAdd({
      key: nextKey(),
      kind,
      integrationId,
      destination: needsDestination ? destination.trim() : "",
      role: "always",
      testedOk: result?.delivered ?? false,
    });
  };

  return (
    <div
      className="space-y-4 rounded-lg border bg-background/40 p-4"
      data-testid="failure-alert-add-channel"
    >
      <fieldset>
        <legend className="mb-2 font-medium text-sm">Channel</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {KINDS.map((option) => (
            <label
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-xs transition-colors hover:bg-muted/50",
                "has-[:checked]:border-foreground/60 has-[:checked]:bg-muted",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
              )}
              htmlFor={`${idPrefix}-kind-${option}`}
              key={option}
            >
              <input
                checked={kind === option}
                className="sr-only"
                id={`${idPrefix}-kind-${option}`}
                name={`${idPrefix}-kind`}
                onChange={() => pickKind(option)}
                type="radio"
                value={option}
              />
              <IntegrationIcon className="size-5" integration={option} />
              {CHANNEL_LABEL[option]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="failure-alert-connection">Connection</Label>
        {ofKind.length > 0 || unsharedOfKind.length > 0 ? (
          <Select
            onValueChange={setIntegrationId}
            value={integrationId || undefined}
          >
            <SelectTrigger className="w-full" id="failure-alert-connection">
              <SelectValue placeholder="Pick a connection" />
            </SelectTrigger>
            <SelectContent>
              {ofKind.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
              {unsharedOfKind.map((c) => (
                <SelectItem disabled key={c.id} value={c.id}>
                  {c.name} (not shared with the organization)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {ofKind.length === 0 && (
          <p className="text-muted-foreground text-xs">
            No {CHANNEL_LABEL[kind]} connection shared with the organization
            yet.
          </p>
        )}
        <Button
          className="h-auto px-0 text-xs"
          onClick={newConnection}
          type="button"
          variant="link"
        >
          <Plus className="size-3" />
          New {CHANNEL_LABEL[kind]} connection
        </Button>
        <p className="text-muted-foreground text-xs">
          New connections are shared with the whole organization.
        </p>
      </div>

      {kind === "slack" && (
        <div className="space-y-1.5">
          <Label htmlFor="failure-alert-destination">Slack channel</Label>
          <Input
            id="failure-alert-destination"
            onChange={(e) => setDestination(e.target.value)}
            placeholder="#alerts"
            value={destination}
          />
        </div>
      )}
      {kind === "telegram" && (
        <div className="space-y-1.5">
          <Label htmlFor="failure-alert-destination">Chat ID</Label>
          <Input
            className="font-mono"
            id="failure-alert-destination"
            onChange={(e) => setDestination(e.target.value)}
            placeholder="-1001234567890"
            value={destination}
          />
          <p className="text-muted-foreground text-xs">
            <a
              className="underline"
              href="https://docs.keeperhub.com/plugins/telegram"
              rel="noopener"
              target="_blank"
            >
              Step by step
            </a>
            . In short: a numeric ID, or @name for a public channel. Add the bot
            to the group, send it a message, then open
            api.telegram.org/bot&lt;token&gt;/getUpdates: the ID is under chat.
          </p>
        </div>
      )}
      {kind === "pagerduty" && (
        <div className="space-y-3">
          {/* The service picker's trigger takes no id, so the fieldset's legend
              is what names it. */}
          <fieldset className="space-y-1.5">
            <legend className="font-medium text-sm leading-none">
              Service to page
            </legend>
            <PagerDutyServiceField
              integrationId={integrationId || undefined}
              onChange={setDestination}
              value={destination}
            />
          </fieldset>
          <PagerDutyModeChoice
            idPrefix="pd-new"
            onChange={setPdMode}
            value={pdMode}
          />
        </div>
      )}
      {kind === "discord" && (
        <p className="text-muted-foreground text-xs">
          The connection already holds the webhook, so there is nothing else to
          fill in.
        </p>
      )}

      {result && <TestResultLine result={result} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          disabled={!ready || testing}
          onClick={runTest}
          size="sm"
          type="button"
          variant="outline"
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Send test
        </Button>
        <div className="flex gap-2">
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={!ready} onClick={add} size="sm" type="button">
            {result?.delivered ? "Add tested channel" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The chat and PagerDuty channels of a failure-notification setup, shared by
 * the org settings card and a workflow's own settings. Every row and the add
 * form have a Test button that goes through the real senders.
 */
export function ChannelListEditor({
  organizationId,
  channels,
  connections,
  unsharedConnections = [],
  canManage,
  onChange,
  onConnectionsChanged,
}: {
  organizationId: string;
  channels: DraftChannel[];
  connections: ConnectionView[];
  /** The viewer's own connections that the org cannot use, shown disabled. */
  unsharedConnections?: ConnectionView[];
  canManage: boolean;
  onChange: (channels: DraftChannel[]) => void;
  onConnectionsChanged: () => Promise<void> | void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  // An Undo can come long after the removal, so it works on the list as it
  // is by then rather than the one it was removed from.
  const latest = useRef({ channels, onChange });
  latest.current = { channels, onChange };

  const remove = (channel: DraftChannel, label: string): void => {
    const index = channels.findIndex((c) => c.key === channel.key);
    onChange(channels.filter((c) => c.key !== channel.key));
    toast(`${label} removed`, {
      action: {
        label: "Undo",
        onClick: () => {
          const current = latest.current.channels;
          const back = current.some(
            (c) =>
              c.kind === channel.kind &&
              c.integrationId === channel.integrationId &&
              c.destination === channel.destination
          );
          if (back) {
            return;
          }
          const next = [...current];
          // The saved row is gone, so it comes back as a new one.
          next.splice(Math.min(index, next.length), 0, {
            ...channel,
            id: undefined,
            key: nextKey(),
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
            <ChannelRow
              canManage={canManage}
              channel={channel}
              connections={connections}
              key={channel.key}
              onChange={(next) =>
                onChange(channels.map((c) => (c.key === next.key ? next : c)))
              }
              onRemove={(label) => remove(channel, label)}
              organizationId={organizationId}
            />
          ))}
        </ul>
      )}
      {canManage &&
        (adding ? (
          <AddChannelForm
            connections={connections}
            onAdd={(channel) => {
              onChange([...channels, channel]);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
            onConnectionsChanged={onConnectionsChanged}
            organizationId={organizationId}
            unsharedConnections={unsharedConnections}
          />
        ) : (
          <Button
            onClick={() => setAdding(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" />
            Add channel
          </Button>
        ))}
    </div>
  );
}
