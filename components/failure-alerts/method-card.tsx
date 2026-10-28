"use client";

import { useSetAtom } from "jotai";
import { Loader2, Mail, Plus } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Label } from "@/components/ui/label";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
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
  channelLabel,
  type MemberView,
  type TestResult,
} from "@/lib/notifications/failure-alerts/view-types";
import { roleLabel } from "@/lib/organization/role-label";
import { cn } from "@/lib/utils";
import { sendFailureAlertTest } from "./api";
import { memberLabel } from "./member-label";
import {
  CHANNEL_KINDS,
  channelStatus,
  type DraftChannel,
  isChannelDirty,
  type MethodStatus,
  needsDestination,
  sameTarget,
} from "./method-drafts";
import {
  type SaveAction,
  SaveError,
  SaveFeedback,
  useSaveState,
} from "./save-state";
import { TestResultLine } from "./test-result-line";

const TRAILING_DOTS = /\.+$/;

const STATUS_BADGE: Record<MethodStatus, { label: string; className: string }> =
  {
    working: {
      label: "Working",
      className: "border-keeperhub-green/40 text-keeperhub-green-dark",
    },
    untested: { label: "Untested", className: WARNING_TEXT },
    failed: {
      label: "Test failed",
      className: "border-destructive/50 text-destructive",
    },
    paused: {
      label: "Paused",
      className: "border-destructive/50 text-destructive",
    },
    unreachable: {
      label: "Nobody reachable",
      className: "border-destructive/50 text-destructive",
    },
  };

function StatusBadge({ status }: { status: MethodStatus }): React.ReactElement {
  const badge = STATUS_BADGE[status];
  return (
    <Badge
      className={badge.className}
      data-testid="failure-alert-method-status"
      variant="outline"
    >
      {badge.label}
    </Badge>
  );
}

/** A label above its field, the same on every card. */
function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label className="text-xs" htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * The one layout every method shares: icon, name and status; the target; when
 * to use it; then Test, Save and Remove in the same place on every card.
 */
function MethodCardFrame({
  kind,
  icon,
  name,
  status,
  dirty,
  health,
  picker,
  target,
  whenToUse,
  notices,
  actions,
}: {
  kind: string;
  icon: ReactNode;
  name: string;
  status: MethodStatus;
  dirty: boolean;
  health: ReactNode;
  picker?: ReactNode;
  target: ReactNode;
  whenToUse: ReactNode;
  notices?: ReactNode;
  actions?: ReactNode;
}): React.ReactElement {
  return (
    <li
      className={cn(
        "min-w-0 rounded-lg border bg-background/40",
        (status === "paused" || status === "unreachable") &&
          "border-destructive/50"
      )}
      data-dirty={dirty}
      data-kind={kind}
      data-status={status}
      data-testid="failure-alert-method"
    >
      <div className="flex items-start gap-3 p-3 @xl/settings:px-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="font-medium text-sm">{name}</h4>
            <StatusBadge status={status} />
          </div>
          <p className="mt-0.5 break-words text-xs">{health}</p>
        </div>
      </div>
      <div className="space-y-4 border-t p-3 @xl/settings:px-4">
        {picker}
        {target}
        {whenToUse}
        {notices}
      </div>
      {actions && (
        <div className="border-t p-3 @xl/settings:px-4">{actions}</div>
      )}
    </li>
  );
}

/** Test and Save on the left, Remove on the right, on every card. */
function ActionsRow({
  test,
  save,
  remove,
}: {
  test: ReactNode;
  save?: ReactNode;
  remove?: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {test}
      {save}
      {remove && <div className="ml-auto">{remove}</div>}
    </div>
  );
}

function SaveButton({
  label,
  dirty,
  ready,
  save,
  onSave,
}: {
  label: string;
  dirty: boolean;
  ready: boolean;
  save: ReturnType<typeof useSaveState>;
  onSave: SaveAction;
}): React.ReactElement {
  return (
    <>
      <Button
        aria-label={`Save ${label}`}
        disabled={!(dirty && ready) || save.state === "saving"}
        onClick={() => save.run(onSave)}
        size="sm"
        type="button"
      >
        {save.state === "saving" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : null}
        Save
      </Button>
      <SaveFeedback
        dirty={dirty}
        state={save.state}
        testId="failure-alert-method-save"
      />
    </>
  );
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

function MethodPicker({
  value,
  onPick,
  idPrefix,
}: {
  value: FailureAlertChannelKind;
  onPick: (kind: FailureAlertChannelKind) => void;
  idPrefix: string;
}): React.ReactElement {
  return (
    <fieldset data-testid="failure-alert-method-picker">
      <legend className="mb-1.5 font-medium text-xs">Method</legend>
      <div className="grid grid-cols-2 gap-2 @xl/settings:grid-cols-4">
        {CHANNEL_KINDS.map((option) => (
          <label
            className={cn(
              "flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border px-2 py-2 text-xs transition-colors hover:bg-muted/50",
              "has-[:checked]:border-foreground/60 has-[:checked]:bg-muted",
              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
            )}
            htmlFor={`${idPrefix}-kind-${option}`}
            key={option}
          >
            <input
              checked={value === option}
              className="sr-only"
              id={`${idPrefix}-kind-${option}`}
              name={`${idPrefix}-kind`}
              onChange={() => onPick(option)}
              type="radio"
              value={option}
            />
            <IntegrationIcon className="size-4" integration={option} />
            {CHANNEL_LABEL[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function WhenToUse({
  id,
  value,
  disabled,
  fixed,
  onChange,
}: {
  id: string;
  value: FailureAlertChannelRole;
  disabled: boolean;
  /** Email: always used, shown the same way but not changeable. */
  fixed?: boolean;
  onChange?: (role: FailureAlertChannelRole) => void;
}): React.ReactElement {
  let hint: string | null = null;
  if (fixed) {
    hint = "Email gets every alert.";
  } else if (value === "backup") {
    hint =
      "Gets an alert only when email or another method could not deliver it, with a note saying which one failed.";
  }
  return (
    <Field htmlFor={id} label="When to use">
      <Select
        disabled={disabled || fixed}
        onValueChange={(next) => onChange?.(next as FailureAlertChannelRole)}
        value={value}
      >
        <SelectTrigger className="h-9 w-full @xl/settings:w-56" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="always">Always</SelectItem>
          <SelectItem value="backup">Only as a backup</SelectItem>
        </SelectContent>
      </Select>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </Field>
  );
}

function ChannelHealth({
  draft,
  saved,
}: {
  draft: DraftChannel;
  saved: ChannelView | undefined;
}): React.ReactElement {
  if (!saved) {
    return (
      <span className="text-muted-foreground">
        Not saved yet. Saving checks that it can receive notifications.
      </span>
    );
  }
  if (!sameTarget(draft, saved)) {
    return (
      <span className="text-muted-foreground">
        Changed, not saved yet. Saving checks the new target.
      </span>
    );
  }
  if (saved.pausedAt && draft.testedOk === true) {
    return (
      <span className="text-muted-foreground">Test passed: it is back on.</span>
    );
  }
  if (saved.pausedAt) {
    return (
      <span className="text-destructive">
        Paused {timeAgo(saved.pausedAt)}:{" "}
        {(saved.pausedReason ?? "").replace(TRAILING_DOTS, "")}. Test it to turn
        it back on.
      </span>
    );
  }
  const failedLast =
    saved.lastFailedAt &&
    (!saved.lastDeliveredAt || saved.lastFailedAt > saved.lastDeliveredAt);
  if (failedLast && saved.lastFailedAt) {
    return (
      <span className="text-destructive">
        Last delivery failed {timeAgo(saved.lastFailedAt)}: {saved.lastError}
      </span>
    );
  }
  if (saved.lastDeliveredAt) {
    return (
      <span className="text-muted-foreground">
        Last delivered {timeAgo(saved.lastDeliveredAt)}
      </span>
    );
  }
  return <span className="text-muted-foreground">Never used yet</span>;
}

function ConnectionField({
  id,
  draft,
  connections,
  unsharedConnections,
  disabled,
  canManage,
  onPick,
  onConnectionsChanged,
}: {
  id: string;
  draft: DraftChannel;
  connections: ConnectionView[];
  unsharedConnections: ConnectionView[];
  disabled: boolean;
  canManage: boolean;
  onPick: (integrationId: string) => void;
  onConnectionsChanged: () => Promise<void> | void;
}): React.ReactElement {
  const { push } = useOverlay();
  const setIntegrationsVersion = useSetAtom(integrationsVersionAtom);
  const ofKind = connections.filter((c) => c.kind === draft.kind);
  const unsharedOfKind = unsharedConnections.filter(
    (c) => c.kind === draft.kind
  );
  const kindLabel = CHANNEL_LABEL[draft.kind];

  const newConnection = (): void => {
    push(ConfigureConnectionOverlay, {
      type: draft.kind,
      onSuccess: async (newId: string) => {
        // Connection pickers open elsewhere refetch on this.
        setIntegrationsVersion((v) => v + 1);
        await onConnectionsChanged();
        onPick(newId);
      },
    });
  };

  return (
    <Field htmlFor={id} label="Connection">
      {ofKind.length > 0 || unsharedOfKind.length > 0 ? (
        <Select
          disabled={disabled}
          onValueChange={onPick}
          value={draft.integrationId || undefined}
        >
          <SelectTrigger className="h-9 w-full" id={id}>
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
      ) : (
        <p className="text-muted-foreground text-xs">
          No {kindLabel} connection shared with the organization yet.
        </p>
      )}
      {canManage && (
        <Button
          className="h-auto max-w-full justify-start whitespace-normal px-0 text-left text-xs"
          onClick={newConnection}
          type="button"
          variant="link"
        >
          <Plus className="size-3" />
          New {kindLabel} connection
        </Button>
      )}
    </Field>
  );
}

function DestinationField({
  id,
  draft,
  disabled,
  onChange,
}: {
  id: string;
  draft: DraftChannel;
  disabled: boolean;
  onChange: (destination: string) => void;
}): React.ReactElement {
  if (draft.kind === "slack") {
    return (
      <Field htmlFor={id} label="Slack channel">
        <Input
          className="h-9"
          disabled={disabled}
          id={id}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#alerts"
          value={draft.destination}
        />
      </Field>
    );
  }
  if (draft.kind === "telegram") {
    return (
      <Field htmlFor={id} label="Chat ID">
        <Input
          className="h-9 font-mono"
          disabled={disabled}
          id={id}
          onChange={(e) => onChange(e.target.value)}
          placeholder="-1001234567890"
          value={draft.destination}
        />
        <p className="text-muted-foreground text-xs">
          A group number such as -1001234567890, or @name for a public channel.
          Add your bot to the group first.{" "}
          <a
            className="underline"
            href="https://docs.keeperhub.com/plugins/telegram"
            rel="noopener"
            target="_blank"
          >
            How to find the chat ID
          </a>
        </p>
      </Field>
    );
  }
  if (draft.kind === "pagerduty") {
    // The service picker's trigger takes no id, so the legend names it.
    return (
      <fieldset className="min-w-0 space-y-1.5">
        <legend className="font-medium text-xs leading-none">
          Service to page
        </legend>
        <PagerDutyServiceField
          disabled={disabled}
          integrationId={draft.integrationId || undefined}
          onChange={onChange}
          value={draft.destination}
        />
      </fieldset>
    );
  }
  return (
    <Field label="Where">
      <p className="text-muted-foreground text-xs">
        The connection holds the Discord webhook, so there is nothing else to
        fill in.
      </p>
    </Field>
  );
}

/**
 * A Slack, Discord, Telegram or PagerDuty method. With onSave it saves on its
 * own (Settings); without, the list's owner saves it (a workflow's panel).
 */
export function ChannelMethodCard({
  organizationId,
  draft,
  saved,
  connections,
  unsharedConnections = [],
  canManage,
  onChange,
  onSave,
  onRemove,
  onTested,
  onConnectionsChanged,
}: {
  organizationId: string;
  draft: DraftChannel;
  /** The stored row this card edits; none for a new card. */
  saved: ChannelView | undefined;
  connections: ConnectionView[];
  unsharedConnections?: ConnectionView[];
  canManage: boolean;
  onChange: (next: DraftChannel) => void;
  onSave?: SaveAction;
  onRemove?: (label: string) => void;
  /** A saved channel was tested: its stored health changed. */
  onTested?: () => void;
  onConnectionsChanged: () => Promise<void> | void;
}): React.ReactElement {
  const idPrefix = useId();
  const save = useSaveState();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [pdMode, setPdMode] = useState<PagerDutyMode>("change");
  const [choosingPdMode, setChoosingPdMode] = useState(false);

  const isNew = Boolean(draft.fresh) && !(draft.id || saved);
  const dirty = isChannelDirty(draft, saved);
  const status = channelStatus(draft, saved);
  const connection = connections.find((c) => c.id === draft.integrationId);
  const label = channelLabel(
    draft.kind,
    draft.destination,
    connection?.name ?? saved?.connectionName
  );
  const ready =
    Boolean(draft.integrationId) &&
    (!needsDestination(draft.kind) || draft.destination.trim() !== "");
  const disabled = !canManage;

  const edit = (patch: Partial<DraftChannel>): void => {
    save.reset();
    const next = { ...draft, ...patch };
    // A test only vouches for the target it was run against.
    if (!sameTarget(next, draft)) {
      next.testedOk = undefined;
      setResult(null);
    }
    onChange(next);
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    const storedTarget = saved && sameTarget(draft, saved);
    const outcome = await sendFailureAlertTest(organizationId, {
      channel: draft.kind,
      integrationId: draft.integrationId,
      destination: draft.destination.trim(),
      channelId: storedTarget ? saved.id : undefined,
      pagerDutyMode: pdMode,
    });
    setTesting(false);
    setChoosingPdMode(false);
    setResult(outcome);
    onChange({ ...draft, testedOk: outcome.delivered });
    if (storedTarget) {
      onTested?.();
    }
  };

  const testButton = (
    <Button
      aria-expanded={draft.kind === "pagerduty" ? choosingPdMode : undefined}
      aria-label={`Test ${label}`}
      disabled={testing || !ready}
      onClick={() =>
        draft.kind === "pagerduty"
          ? setChoosingPdMode((open) => !open)
          : runTest()
      }
      size="sm"
      type="button"
      variant="outline"
    >
      {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
      Test
    </Button>
  );

  const removeButton = onRemove ? (
    <Button
      aria-label={`${isNew ? "Cancel" : "Remove"} ${label}`}
      onClick={() => onRemove(label)}
      size="sm"
      type="button"
      variant="ghost"
    >
      {isNew ? "Cancel" : "Remove"}
    </Button>
  ) : undefined;

  return (
    <MethodCardFrame
      actions={
        canManage ? (
          <ActionsRow
            remove={removeButton}
            save={
              onSave ? (
                <SaveButton
                  dirty={dirty}
                  label={label}
                  onSave={onSave}
                  ready={ready}
                  save={save}
                />
              ) : undefined
            }
            test={testButton}
          />
        ) : undefined
      }
      dirty={dirty}
      health={<ChannelHealth draft={draft} saved={saved} />}
      icon={<IntegrationIcon className="size-4" integration={draft.kind} />}
      kind={draft.kind}
      name={CHANNEL_LABEL[draft.kind]}
      notices={
        <>
          {draft.integrationId && !connection && (
            <Notice tone="danger">
              Its connection was deleted or is no longer shared with the
              organization.
            </Notice>
          )}
          {choosingPdMode && (
            <div className="space-y-3 rounded-md border p-3">
              <PagerDutyModeChoice
                idPrefix={`${idPrefix}-pd`}
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
                  {testing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Send test
                </Button>
              </div>
            </div>
          )}
          {result && <TestResultLine result={result} />}
          <SaveError error={save.error} />
        </>
      }
      picker={
        isNew && canManage ? (
          <MethodPicker
            idPrefix={idPrefix}
            onPick={(kind) =>
              edit({
                kind,
                integrationId:
                  connections.find((c) => c.kind === kind)?.id ?? "",
                destination: "",
              })
            }
            value={draft.kind}
          />
        ) : undefined
      }
      status={status}
      target={
        <div className="grid grid-cols-1 gap-4 @xl/settings:grid-cols-2">
          <ConnectionField
            canManage={canManage}
            connections={connections}
            disabled={disabled}
            draft={draft}
            id={`${idPrefix}-connection`}
            onConnectionsChanged={onConnectionsChanged}
            onPick={(integrationId) => edit({ integrationId })}
            unsharedConnections={unsharedConnections}
          />
          <DestinationField
            disabled={disabled}
            draft={draft}
            id={`${idPrefix}-destination`}
            onChange={(destination) => edit({ destination })}
          />
        </div>
      }
      whenToUse={
        <WhenToUse
          disabled={disabled}
          id={`${idPrefix}-role`}
          onChange={(role) => edit({ role })}
          value={draft.role}
        />
      }
    />
  );
}

/** Email: the people who get it. Always used; cannot be removed. */
export function EmailMethodCard({
  organizationId,
  members,
  recipients,
  savedRecipients,
  canManage,
  emailUsage,
  onChange,
  onSave,
}: {
  organizationId: string;
  members: MemberView[];
  recipients: string[];
  savedRecipients: string[];
  canManage: boolean;
  emailUsage: { used: number; limit: number } | null;
  onChange: (recipients: string[]) => void;
  onSave: SaveAction;
}): React.ReactElement {
  const idPrefix = useId();
  const save = useSaveState();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const dirty =
    recipients.length !== savedRecipients.length ||
    recipients.some((id) => !savedRecipients.includes(id));
  const reachable = members.filter(
    (m) => m.reachable && recipients.includes(m.userId)
  );
  let status: MethodStatus = reachable.length > 0 ? "working" : "unreachable";
  if (status === "working" && result && !result.delivered) {
    status = "failed";
  }
  const onlyOne = recipients.length === 1;

  const toggle = (userId: string, checked: boolean): void => {
    save.reset();
    onChange(
      checked
        ? [...new Set([...recipients, userId])]
        : recipients.filter((id) => id !== userId)
    );
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    setResult(
      await sendFailureAlertTest(organizationId, { channel: "email", to: "me" })
    );
    setTesting(false);
  };

  return (
    <MethodCardFrame
      actions={
        canManage ? (
          <ActionsRow
            save={
              <SaveButton
                dirty={dirty}
                label="Email"
                onSave={onSave}
                ready={recipients.length > 0}
                save={save}
              />
            }
            test={
              <Button
                aria-label="Test Email"
                disabled={testing}
                onClick={runTest}
                size="sm"
                title="Sends one test email to you"
                type="button"
                variant="outline"
              >
                {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Test
              </Button>
            }
          />
        ) : undefined
      }
      dirty={dirty}
      health={
        <span
          className={
            reachable.length > 0 ? "text-muted-foreground" : "text-destructive"
          }
        >
          {reachable.length > 0
            ? `Goes to ${reachable.length === 1 ? "1 person" : `${reachable.length} people`}. Test sends one email to you.`
            : "Nobody ticked below has an email KeeperHub can reach."}
        </span>
      }
      icon={<Mail aria-hidden="true" className="size-4 text-foreground" />}
      kind="email"
      name="Email"
      notices={
        <>
          {emailUsage && (
            <p className="text-muted-foreground text-xs">
              {emailUsage.used >= emailUsage.limit
                ? `All ${emailUsage.limit} alert emails for this month are used. Until the 1st, alerts go to your other methods and show in KeeperHub.`
                : `Free plan: ${emailUsage.limit} alert emails a month, ${emailUsage.used} used. Chat and PagerDuty are not counted.`}
            </p>
          )}
          {result && <TestResultLine result={result} />}
          <SaveError error={save.error} />
        </>
      }
      status={status}
      target={
        <fieldset className="min-w-0 space-y-2">
          <legend className="mb-1.5 font-medium text-xs">Recipients</legend>
          <ul className="space-y-2">
            {members.map((m) => {
              const checked = recipients.includes(m.userId);
              const isLast = checked && onlyOne;
              const id = `${idPrefix}-recipient-${m.userId}`;
              return (
                <li
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                  key={m.userId}
                >
                  <Checkbox
                    checked={checked}
                    disabled={!canManage || isLast || !(m.reachable || checked)}
                    id={id}
                    onCheckedChange={(next) => toggle(m.userId, next === true)}
                    title={
                      isLast
                        ? "At least one person has to get the email"
                        : undefined
                    }
                  />
                  <Label
                    className={cn(
                      "min-w-0 cursor-pointer break-all font-normal",
                      // Unreachable, not unimportant: keep the name readable.
                      !m.reachable &&
                        "text-muted-foreground peer-disabled:opacity-100"
                    )}
                    htmlFor={id}
                  >
                    {memberLabel(m)}
                  </Label>
                  <span className="text-muted-foreground text-xs">
                    ({roleLabel(m.role)})
                  </span>
                  {!m.reachable && (
                    <span className="basis-full pl-6 text-muted-foreground text-xs @xl/settings:basis-auto @xl/settings:pl-0">
                      No email yet. They can add one in{" "}
                      <Link className="underline" href="/settings/security">
                        Account security
                      </Link>
                      .
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {onlyOne && canManage && (
            <p className="text-muted-foreground text-xs">
              At least one person has to get the email: tick someone else before
              unticking the last one.
            </p>
          )}
        </fieldset>
      }
      whenToUse={
        <WhenToUse disabled fixed id={`${idPrefix}-role`} value="always" />
      }
    />
  );
}
