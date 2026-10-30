"use client";

import { useSetAtom } from "jotai";
import { Loader2, Mail, Plus } from "lucide-react";
import Link from "next/link";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ConfigureConnectionOverlay } from "@/components/overlays/add-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Label } from "@/components/ui/label";
import { WARNING_TEXT } from "@/components/ui/notice";
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
  type MemberView,
  methodName,
  methodText,
  type TestResult,
} from "@/lib/notifications/failure-alerts/view-types";
import { roleLabel } from "@/lib/organization/role-label";
import { cn } from "@/lib/utils";
import { sendFailureAlertTest } from "./api";
import { type ChoiceChip, ChoiceChips } from "./choice-chips";
import { memberLabel } from "./member-label";
import {
  BROKEN_STATUSES,
  CHANNEL_KINDS,
  channelStatus,
  type DraftChannel,
  destinationProblem,
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
const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), [role='combobox']:not([disabled])";
const RED = "border-destructive/50 text-destructive";

const STATUS_LABEL: Record<MethodStatus, string> = {
  working: "Working",
  untested: "Not tested",
  failed: "Test failed",
  delivery: "Not delivering",
  paused: "Paused",
  missing: "Connection missing",
  unsaved: "Not saved",
  refused: "Not saved",
  unreachable: "Nobody reachable",
};

function statusClass(status: MethodStatus, lastResort: boolean): string {
  if (status === "working") {
    return "border-keeperhub-green/40 text-keeperhub-green-dark";
  }
  if (status === "unsaved") {
    return "text-muted-foreground";
  }
  if (status === "untested" || (status === "paused" && !lastResort)) {
    return WARNING_TEXT;
  }
  return RED;
}

const ROLE_TEXT: Record<FailureAlertChannelRole, string> = {
  always: "Always",
  backup: "Backup only",
};

/** After a row is removed: the next row's first control, or the fallback. */
export function focusMethodAt(
  container: RefObject<HTMLElement | null>,
  position: number,
  fallback: RefObject<HTMLElement | null> | null
): void {
  requestAnimationFrame(() => {
    const rows = container.current?.querySelectorAll<HTMLElement>(
      '[data-testid="failure-alert-method"]'
    );
    const row = rows?.[position];
    const target =
      row?.querySelector<HTMLElement>("[data-method-toggle]") ??
      row?.querySelector<HTMLElement>(FOCUSABLE) ??
      fallback?.current;
    target?.focus();
  });
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

/** Every method's row: icon, name, target, status, Edit; opened, fields then actions. */
function MethodRow({
  kind,
  icon,
  name,
  target,
  roleText,
  status,
  lastResort,
  dirty,
  health,
  feedback,
  expanded,
  toggle,
  toggleRef,
  bodyRef,
  body,
  actions,
  bodyId,
}: {
  kind: string;
  icon: ReactNode;
  name: string;
  /** Where it sends, under the name. */
  target?: string;
  roleText: string;
  status: MethodStatus;
  lastResort: boolean;
  dirty: boolean;
  health: ReactNode;
  feedback?: ReactNode;
  expanded: boolean;
  toggle?: { label: string; onClick: () => void };
  toggleRef: RefObject<HTMLButtonElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  body: ReactNode;
  actions?: ReactNode;
  bodyId: string;
}): React.ReactElement {
  const nameId = `${bodyId}-name`;
  const alarming =
    status === "unreachable" ||
    status === "refused" ||
    (lastResort && BROKEN_STATUSES.includes(status));
  return (
    <li
      aria-labelledby={nameId}
      className={cn(
        "min-w-0 rounded-lg border bg-background/40",
        (status === "unsaved" || status === "refused") && "border-dashed",
        alarming && "border-destructive/50"
      )}
      data-dirty={dirty}
      data-expanded={expanded}
      data-kind={kind}
      data-status={status}
      data-testid="failure-alert-method"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 p-3 @xl/settings:px-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          {icon}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4
              className="min-w-0 max-w-full truncate font-medium text-sm"
              id={nameId}
              title={target ? `${name} (${target})` : name}
            >
              {name}
            </h4>
            <Badge
              className={statusClass(status, lastResort)}
              data-testid="failure-alert-method-status"
              variant="outline"
            >
              {STATUS_LABEL[status]}
            </Badge>
            {feedback}
          </div>
          <p className="break-words text-muted-foreground text-xs">
            {target ? `${target} · ${roleText}` : roleText}
          </p>
          <p className="mt-0.5 break-words text-xs">{health}</p>
        </div>
        {toggle && (
          <Button
            aria-controls={expanded ? bodyId : undefined}
            aria-expanded={expanded}
            aria-label={`${toggle.label} ${target ? `${name} (${target})` : name}`}
            className="w-full @xl/settings:w-auto"
            data-method-toggle=""
            onClick={toggle.onClick}
            ref={toggleRef}
            size="sm"
            type="button"
            variant="outline"
          >
            {toggle.label}
          </Button>
        )}
      </div>
      {expanded && (
        <div id={bodyId} ref={bodyRef}>
          <div className="space-y-4 border-t p-3 @xl/settings:px-4">{body}</div>
          {actions && (
            <div className="border-t p-3 @xl/settings:px-4">{actions}</div>
          )}
        </div>
      )}
    </li>
  );
}

/** Open, close and focus for a row; open by itself when it needs attention. */
function useRowState(startOpen: boolean): {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  openAndFocus: () => void;
  closeAndFocus: () => void;
} {
  const [open, setOpen] = useState(startOpen);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const focusBody = useRef(false);

  useEffect(() => {
    if (open && focusBody.current) {
      focusBody.current = false;
      bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
  }, [open]);

  return {
    open,
    setOpen,
    toggleRef,
    bodyRef,
    openAndFocus: () => {
      focusBody.current = true;
      setOpen(true);
    },
    closeAndFocus: () => {
      setOpen(false);
      requestAnimationFrame(() => toggleRef.current?.focus());
    },
  };
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
  saving,
  onClick,
}: {
  label: string;
  dirty: boolean;
  ready: boolean;
  saving: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <Button
      aria-label={`Save ${label}`}
      data-testid="failure-alert-method-save-button"
      disabled={!(dirty && ready) || saving}
      onClick={onClick}
      size="sm"
      type="button"
    >
      {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
      Save
    </Button>
  );
}

type PagerDutyMode = "change" | "page";

const PD_MODES: readonly ChoiceChip<PagerDutyMode>[] = [
  {
    value: "change",
    label: "Check the connection (recommended)",
    description: "Sends a change event. It never pages anyone.",
  },
  {
    value: "page",
    label: "Send a real test page",
    description:
      'Opens a "KeeperHub test" incident and resolves it straight away. Whoever is on call may be paged.',
  },
];

const KIND_CHOICES: readonly ChoiceChip<FailureAlertChannelKind>[] =
  CHANNEL_KINDS.map((kind) => ({
    value: kind,
    label: CHANNEL_LABEL[kind],
    icon: <IntegrationIcon className="size-4" integration={kind} />,
  }));

function WhenToUse({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: FailureAlertChannelRole;
  disabled: boolean;
  onChange: (role: FailureAlertChannelRole) => void;
}): React.ReactElement {
  return (
    <Field htmlFor={id} label="When to use">
      <Select
        disabled={disabled}
        onValueChange={(next) => onChange(next as FailureAlertChannelRole)}
        value={value}
      >
        <SelectTrigger className="h-9 w-full @xl/settings:w-48" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="always">Always</SelectItem>
          <SelectItem value="backup">Backup only</SelectItem>
        </SelectContent>
      </Select>
      {value === "backup" && (
        <p className="text-muted-foreground text-xs">
          Gets an alert only when another method could not deliver it.
        </p>
      )}
    </Field>
  );
}

/** "Checked 2 h ago. Last delivered 3 days ago." */
function healthTimes(view: ChannelView): string {
  const parts = [
    view.lastHealthCheckAt ? `Checked ${timeAgo(view.lastHealthCheckAt)}` : "",
    view.lastDeliveredAt
      ? `Last delivered ${timeAgo(view.lastDeliveredAt)}`
      : "No alert sent yet",
  ].filter(Boolean);
  return `${parts.join(". ")}.`;
}

const TARGET_WORD: Record<FailureAlertChannelKind, string> = {
  slack: "channel",
  discord: "connection",
  telegram: "chat",
  pagerduty: "service",
};

function ChannelHealth({
  draft,
  saved,
  status,
  savesHere,
}: {
  draft: DraftChannel;
  saved: ChannelView | undefined;
  status: MethodStatus;
  savesHere: boolean;
}): React.ReactElement {
  const savedWith = "Saved with this workflow's settings below.";
  if (status === "missing") {
    return (
      <span className="text-destructive">
        Its connection was deleted or is no longer shared with the organization.
        Pick another connection or remove this method.
      </span>
    );
  }
  if (!saved) {
    return (
      <span className="text-muted-foreground">
        {savesHere
          ? "Not saved yet. Save checks that it can receive alerts."
          : savedWith}
      </span>
    );
  }
  if (!sameTarget(draft, saved)) {
    return (
      <span className="text-muted-foreground">
        {savesHere
          ? `Changed, not saved. Save checks the new ${TARGET_WORD[draft.kind]}.`
          : savedWith}
      </span>
    );
  }
  if (status === "working" && saved.pausedAt) {
    return (
      <span className="text-muted-foreground">Test passed. It is back on.</span>
    );
  }
  if (status === "paused") {
    return (
      <span>
        Paused {timeAgo(saved.pausedAt ?? "")}:{" "}
        {(saved.pausedReason ?? "it stopped working").replace(
          TRAILING_DOTS,
          ""
        )}
        . It turns back on by itself when the daily check passes, or Test it
        now.
      </span>
    );
  }
  if (status === "delivery") {
    return (
      <span className="text-destructive">
        Last alert failed {timeAgo(saved.lastFailedAt ?? "")}
        {saved.lastError ? `: ${saved.lastError}` : "."}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-destructive">
        Last test failed
        {saved.lastTestedAt ? ` ${timeAgo(saved.lastTestedAt)}` : ""}. Fix it,
        then Test again.
      </span>
    );
  }
  if (status === "untested") {
    return (
      <span className="text-muted-foreground">
        Saved but not tested yet. Test sends one message marked [Test].
      </span>
    );
  }
  return <span className="text-muted-foreground">{healthTimes(saved)}</span>;
}

function ConnectionField({
  id,
  draft,
  connections,
  unsharedConnections,
  disabled,
  onPick,
  onConnectionsChanged,
}: {
  id: string;
  draft: DraftChannel;
  connections: ConnectionView[];
  unsharedConnections: ConnectionView[];
  disabled: boolean;
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
      {!disabled && (
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
  problem,
  onChange,
}: {
  id: string;
  draft: DraftChannel;
  disabled: boolean;
  problem: string | null;
  onChange: (destination: string) => void;
}): React.ReactElement | null {
  const errorId = `${id}-error`;
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
          aria-describedby={problem ? errorId : undefined}
          aria-invalid={Boolean(problem)}
          className="h-9 font-mono"
          disabled={disabled}
          id={id}
          onChange={(e) => onChange(e.target.value)}
          placeholder="-1001234567890"
          value={draft.destination}
        />
        {problem ? (
          <p
            className="text-destructive text-xs"
            data-testid="failure-alert-destination-error"
            id={errorId}
          >
            {problem}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            A group number such as -1001234567890, or @name. Add your bot to the
            group first.{" "}
            <a
              className="underline"
              href="https://docs.keeperhub.com/plugins/telegram"
              rel="noopener"
              target="_blank"
            >
              How to find it
            </a>
          </p>
        )}
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
  return null;
}

/** A chat or PagerDuty method; with onSave it saves itself, else its list's owner does. */
export function ChannelMethodCard({
  organizationId,
  draft,
  saved,
  connections,
  unsharedConnections = [],
  canManage,
  lastResort = false,
  onChange,
  onSave,
  onRemove,
  onTested,
  onReload,
  onConnectionsChanged,
}: {
  organizationId: string;
  draft: DraftChannel;
  /** The stored row this card edits; none for a new card. */
  saved: ChannelView | undefined;
  connections: ConnectionView[];
  unsharedConnections?: ConnectionView[];
  canManage: boolean;
  /** Nobody else can be told if this one is broken. */
  lastResort?: boolean;
  onChange: (next: DraftChannel) => void;
  onSave?: SaveAction;
  onRemove?: (label: string) => void;
  /** A saved channel was tested: its stored health changed. */
  onTested?: () => void;
  /** Refetch after someone else saved first. */
  onReload?: () => void;
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
  const connection = connections.find((c) => c.id === draft.integrationId);
  let status = channelStatus(draft, saved, Boolean(connection));
  if (save.error && status === "unsaved") {
    status = "refused";
  }
  const row = useRowState(BROKEN_STATUSES.includes(status));
  const expanded =
    canManage && (row.open || isNew || dirty || Boolean(save.error));
  // A row just added by "Add a method" takes focus, on its method picker.
  const { bodyRef } = row;
  useEffect(() => {
    if (isNew) {
      bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
  }, [isNew, bodyRef]);
  const connectionName = connection?.name ?? saved?.connectionName;
  const label = methodText(draft.kind, draft.destination, connectionName);
  const { title, target } = methodName(
    draft.kind,
    draft.destination,
    connectionName
  );
  const problem = destinationProblem(draft);
  const ready =
    Boolean(draft.integrationId) &&
    (!needsDestination(draft.kind) || draft.destination.trim() !== "") &&
    !problem;
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

  const runSave = async (): Promise<void> => {
    if (!onSave) {
      return;
    }
    if (await save.run(onSave)) {
      row.closeAndFocus();
    }
  };

  const discard = (): void => {
    save.reset();
    setResult(null);
    if (saved) {
      onChange({
        ...draft,
        integrationId: saved.integrationId,
        destination: saved.destination,
        role: saved.role,
        testedOk: undefined,
      });
    }
    row.closeAndFocus();
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

  let toggle: { label: string; onClick: () => void } | undefined;
  if (canManage && !isNew) {
    if (!expanded) {
      toggle = {
        label: BROKEN_STATUSES.includes(status) ? "Fix" : "Edit",
        onClick: row.openAndFocus,
      };
    } else if (dirty && saved) {
      toggle = { label: "Discard changes", onClick: discard };
    } else if (!(dirty || save.error)) {
      toggle = { label: "Close", onClick: row.closeAndFocus };
    }
  }

  const testButton = (
    <Button
      aria-busy={testing}
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
    <MethodRow
      actions={
        <ActionsRow
          remove={removeButton}
          save={
            onSave ? (
              <SaveButton
                dirty={dirty}
                label={label}
                onClick={runSave}
                ready={ready}
                saving={save.state === "saving"}
              />
            ) : undefined
          }
          test={testButton}
        />
      }
      body={
        <div className="space-y-4">
          {isNew && (
            <ChoiceChips
              className="@xl/settings:grid-cols-4"
              legend="Choose how to send"
              onChange={(kind) =>
                edit({
                  kind,
                  integrationId:
                    connections.find((c) => c.kind === kind)?.id ?? "",
                  destination: "",
                })
              }
              options={KIND_CHOICES}
              testId="failure-alert-method-picker"
              value={draft.kind}
            />
          )}
          <div className="grid grid-cols-1 gap-4 @xl/settings:grid-cols-2">
            <ConnectionField
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
              problem={problem}
            />
          </div>
          <WhenToUse
            disabled={disabled}
            id={`${idPrefix}-role`}
            onChange={(role) => edit({ role })}
            value={draft.role}
          />
          {choosingPdMode && (
            <div className="space-y-3 rounded-md border p-3">
              <ChoiceChips
                className="grid-cols-1 @xl/settings:grid-cols-2"
                hideLegend
                legend="How to test PagerDuty"
                onChange={setPdMode}
                options={PD_MODES}
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
          <SaveError
            error={save.error}
            onReload={
              onReload
                ? () => {
                    save.reset();
                    onReload();
                  }
                : undefined
            }
          />
        </div>
      }
      bodyId={`${idPrefix}-body`}
      bodyRef={row.bodyRef}
      dirty={dirty}
      expanded={expanded}
      feedback={
        onSave ? (
          <SaveFeedback
            dirty={dirty}
            state={save.state}
            testId="failure-alert-method-save"
          />
        ) : undefined
      }
      health={
        <ChannelHealth
          draft={draft}
          saved={saved}
          savesHere={Boolean(onSave)}
          status={status}
        />
      }
      icon={<IntegrationIcon className="size-4" integration={draft.kind} />}
      kind={draft.kind}
      lastResort={lastResort}
      name={title}
      roleText={ROLE_TEXT[draft.role]}
      status={status}
      target={target === title ? undefined : target}
      toggle={toggle}
      toggleRef={row.toggleRef}
    />
  );
}

function recipientsLine(reachable: MemberView[]): string {
  if (reachable.length === 0) {
    return "Nobody chosen has an email KeeperHub can reach.";
  }
  const names = reachable.map(memberLabel);
  const who =
    names.length <= 2 ? names.join(" and ") : `${names.length} people`;
  return `Goes to ${who}. Test sends one email to you.`;
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
  onReload,
}: {
  organizationId: string;
  members: MemberView[];
  recipients: string[];
  savedRecipients: string[];
  canManage: boolean;
  emailUsage: { used: number; limit: number } | null;
  onChange: (recipients: string[]) => void;
  onSave: SaveAction;
  onReload?: () => void;
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
  const row = useRowState(status === "unreachable");
  const expanded = canManage && (row.open || dirty || Boolean(save.error));
  const onlyOne = recipients.length === 1;

  const toggleRecipient = (userId: string, checked: boolean): void => {
    save.reset();
    onChange(
      checked
        ? [...new Set([...recipients, userId])]
        : recipients.filter((id) => id !== userId)
    );
  };

  const runSave = async (): Promise<void> => {
    if (await save.run(onSave)) {
      row.closeAndFocus();
    }
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    setResult(
      await sendFailureAlertTest(organizationId, { channel: "email", to: "me" })
    );
    setTesting(false);
  };

  let toggle: { label: string; onClick: () => void } | undefined;
  if (canManage) {
    if (!expanded) {
      toggle = {
        label: status === "unreachable" ? "Fix" : "Edit",
        onClick: row.openAndFocus,
      };
    } else if (dirty) {
      toggle = {
        label: "Discard changes",
        onClick: () => {
          save.reset();
          onChange([...savedRecipients]);
          row.closeAndFocus();
        },
      };
    } else if (!save.error) {
      toggle = { label: "Close", onClick: row.closeAndFocus };
    }
  }

  return (
    <MethodRow
      actions={
        <ActionsRow
          save={
            <SaveButton
              dirty={dirty}
              label="Email"
              onClick={runSave}
              ready={recipients.length > 0}
              saving={save.state === "saving"}
            />
          }
          test={
            <Button
              aria-busy={testing}
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
      }
      body={
        <div className="space-y-4">
          <fieldset className="min-w-0 space-y-2">
            <legend className="mb-1.5 font-medium text-xs">Recipients</legend>
            <ul className="space-y-2">
              {members.map((m) => {
                const checked = recipients.includes(m.userId);
                const isLast = checked && onlyOne;
                const id = `${idPrefix}-recipient-${m.userId}`;
                if (!(m.reachable || checked)) {
                  return (
                    <li
                      className="break-words pl-6 text-muted-foreground text-sm"
                      key={m.userId}
                    >
                      {memberLabel(m)} cannot get email yet. They can add one in{" "}
                      <Link className="underline" href="/settings/security">
                        Account security
                      </Link>
                      .
                    </li>
                  );
                }
                return (
                  <li
                    className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                    key={m.userId}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={isLast}
                      id={id}
                      onCheckedChange={(next) =>
                        toggleRecipient(m.userId, next === true)
                      }
                      title={
                        isLast
                          ? "Someone has to get the email. Tick another person first."
                          : undefined
                      }
                    />
                    <Label
                      className="min-w-0 cursor-pointer break-all font-normal"
                      htmlFor={id}
                    >
                      {memberLabel(m)}
                    </Label>
                    <span className="text-muted-foreground text-xs">
                      ({roleLabel(m.role)})
                    </span>
                    {!m.reachable && (
                      <span className="basis-full pl-6 text-destructive text-xs">
                        No email yet: this person cannot get alerts.
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {onlyOne && (
              <p className="text-muted-foreground text-xs">
                Someone has to get the email. Tick another person first.
              </p>
            )}
          </fieldset>
          <p className="text-muted-foreground text-xs">
            Email gets every alert.
          </p>
          {emailUsage && emailUsage.used < emailUsage.limit * 0.8 && (
            <p className="text-muted-foreground text-xs">
              Free plan: {emailUsage.used} of {emailUsage.limit} alert emails
              used this month. Chat and PagerDuty are not counted.
            </p>
          )}
          {result && <TestResultLine result={result} />}
          <SaveError
            error={save.error}
            onReload={
              onReload
                ? () => {
                    save.reset();
                    onReload();
                  }
                : undefined
            }
          />
        </div>
      }
      bodyId={`${idPrefix}-body`}
      bodyRef={row.bodyRef}
      dirty={dirty}
      expanded={expanded}
      feedback={
        <SaveFeedback
          dirty={dirty}
          state={save.state}
          testId="failure-alert-method-save"
        />
      }
      health={
        <span
          className={
            reachable.length > 0 ? "text-muted-foreground" : "text-destructive"
          }
        >
          {recipientsLine(reachable)}
        </span>
      }
      icon={<Mail aria-hidden="true" className="size-4 text-foreground" />}
      kind="email"
      lastResort
      name="Email"
      roleText="Always"
      status={status}
      toggle={toggle}
      toggleRef={row.toggleRef}
    />
  );
}
