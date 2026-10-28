"use client";

import { Check, ChevronRight, Gem, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "@/lib/notifications/failure-alerts/constants";
import type {
  OrgSettingsView,
  TestResult,
} from "@/lib/notifications/failure-alerts/view-types";
import { roleLabel } from "@/lib/organization/role-label";
import { cn } from "@/lib/utils";
import { fetchView, sendFailureAlertTest } from "./api";
import {
  ChannelListEditor,
  channelsPayload,
  type DraftChannel,
  draftsFromViews,
} from "./channel-list-editor";
import { memberLabel } from "./member-label";
import { TestResultLine } from "./test-result-line";

type Loaded = OrgSettingsView & { canManage: boolean; viewerUserId: string };

const TIME_LIMIT_LABEL: Record<number, string> = {
  60: "1 hour",
  360: "6 hours",
  1440: "24 hours",
};
const DEFAULT_TIME_LIMIT = 360;

type Form = {
  threshold: number;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
  recipients: string[];
  channels: DraftChannel[];
};

function formFrom(data: Loaded): Form {
  return {
    threshold: data.threshold,
    timeLimitMinutes: data.timeLimitMinutes,
    remindDaily: data.remindDaily,
    notifyRecovery: data.notifyRecovery,
    recipients: [...data.recipientUserIds],
    channels: draftsFromViews(data.channels),
  };
}

type SaveState = "idle" | "saving" | "saved" | "error";

function isValidThreshold(value: string): boolean {
  const n = Number(value);
  return (
    value.trim() !== "" &&
    Number.isInteger(n) &&
    n >= MIN_THRESHOLD &&
    n <= MAX_THRESHOLD
  );
}

const THRESHOLD_ERROR = `Use a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}.`;

/** The tap targets below sm stay at least 44px tall. */
const SUMMARY_CLASS =
  "flex min-h-11 cursor-pointer list-none items-center gap-1 text-muted-foreground text-xs hover:text-foreground sm:min-h-0";

/**
 * The org-wide failure notification settings. Every change saves as it is
 * made: a channel someone added and tested is never lost to a Save button at
 * the bottom of the card.
 */
export function OrgFailureAlertsSection({
  organizationId,
}: {
  organizationId: string;
}): React.ReactElement {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [thresholdInput, setThresholdInput] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailResult, setEmailResult] = useState<TestResult | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // The last state the server accepted, to roll back to when a save fails.
  const savedRef = useRef<Form | null>(null);
  // Saves run one after another so an older one never lands last.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const url = `/api/organizations/${encodeURIComponent(organizationId)}/failure-alerts`;

  const apply = useCallback((next: Loaded) => {
    const nextForm = formFrom(next);
    setData(next);
    setForm(nextForm);
    setThresholdInput(String(nextForm.threshold));
    savedRef.current = nextForm;
  }, []);

  const load = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      setLoadFailed(false);
      try {
        const body = await fetchView<Loaded>(url);
        if (!isActive()) {
          return;
        }
        apply(body);
        // Open on load only when something in it is not the default; after
        // that it stays the way the person left it.
        setMoreOpen(
          body.timeLimitMinutes !== null ||
            !body.remindDaily ||
            !body.notifyRecovery
        );
      } catch {
        if (isActive()) {
          setLoadFailed(true);
        }
      }
    },
    [apply, url]
  );

  useEffect(() => {
    let active = true;
    load(() => active).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [load]);

  const persist = useCallback(
    (next: Form): void => {
      setForm(next);
      setSaveState("saving");
      queueRef.current = queueRef.current.then(async () => {
        try {
          const res = await fetch(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threshold: next.threshold,
              timeLimitMinutes: next.timeLimitMinutes,
              remindDaily: next.remindDaily,
              notifyRecovery: next.notifyRecovery,
              recipientUserIds: next.recipients,
              channels: channelsPayload(next.channels),
            }),
          });
          const body = (await res.json().catch(() => ({}))) as Loaded & {
            error?: string;
          };
          if (!res.ok) {
            throw new Error(body.error ?? "Could not save");
          }
          // Keep what the session knows about tests; the server adds ids and
          // health to new channels.
          const tested = new Map(
            next.channels.map((c) => [
              `${c.integrationId}|${c.destination}`,
              c.testedOk,
            ])
          );
          const merged = formFrom(body);
          merged.channels = merged.channels.map((c) => ({
            ...c,
            testedOk: tested.get(`${c.integrationId}|${c.destination}`),
          }));
          setData(body);
          setForm(merged);
          setThresholdInput(String(merged.threshold));
          savedRef.current = merged;
          setSaveState("saved");
        } catch (error) {
          const previous = savedRef.current;
          if (previous) {
            setForm(previous);
            setThresholdInput(String(previous.threshold));
          }
          setSaveState("error");
          toast.error(
            error instanceof Error ? error.message : "Could not save"
          );
        }
      });
    },
    [url]
  );

  /** A connection made from the Add form: refresh the list, keep the form. */
  const refreshConnections = useCallback(async () => {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as Loaded;
      setData((prev) =>
        prev
          ? {
              ...prev,
              connections: body.connections,
              unsharedConnections: body.unsharedConnections,
            }
          : prev
      );
    }
  }, [url]);

  if (!(data && form)) {
    if (loadFailed) {
      return (
        <Notice role="alert" tone="danger">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Could not load the failure notification settings.
            <Button
              className="h-auto px-0 text-xs"
              onClick={() => load()}
              type="button"
              variant="link"
            >
              Retry
            </Button>
          </span>
        </Notice>
      );
    }
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading
      </div>
    );
  }

  const canManage = data.canManage;
  const disabled = !canManage;
  const change = (patch: Partial<Form>): void => persist({ ...form, ...patch });

  const thresholdInvalid = !isValidThreshold(thresholdInput);

  // An invalid number stays in the box with the error under it, so it can be
  // corrected rather than silently swapped back.
  const commitThreshold = (): void => {
    const value = Number(thresholdInput);
    if (thresholdInvalid || value === form.threshold) {
      return;
    }
    change({ threshold: value });
  };

  const toggleRecipient = (userId: string, checked: boolean): void => {
    const next = checked
      ? [...new Set([...form.recipients, userId])]
      : form.recipients.filter((id) => id !== userId);
    if (next.length === 0) {
      toast.error("Someone has to get the email. Tick another person first.");
      return;
    }
    change({ recipients: next });
  };

  /** Save when the channel list itself changed, not when a test updated a row. */
  const changeChannels = (channels: DraftChannel[]): void => {
    const before = JSON.stringify(channelsPayload(form.channels));
    const after = JSON.stringify(channelsPayload(channels));
    if (before === after) {
      setForm({ ...form, channels });
      return;
    }
    persist({ ...form, channels });
  };

  const testEmail = async (): Promise<void> => {
    setEmailTesting(true);
    setEmailResult(null);
    setEmailResult(
      await sendFailureAlertTest(organizationId, { channel: "email", to: "me" })
    );
    setEmailTesting(false);
  };

  const reachableChosen = data.members.some(
    (m) => m.reachable && form.recipients.includes(m.userId)
  );
  const liveChannels = form.channels.filter((c) => !c.view?.pausedAt);
  const unreachable = !reachableChosen && liveChannels.length === 0;

  return (
    <div className="space-y-6" data-testid="failure-alerts-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {data.enabled ? (
          <p className="text-muted-foreground text-xs">
            On for every workflow that runs on its own. Runs started by hand
            never count.
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Being switched on for organizations in stages; not on here yet. What
            you set now applies when it is.
          </p>
        )}
        <SaveIndicator state={saveState} />
      </div>

      {!canManage && (
        <p className="text-muted-foreground text-xs">
          Only owners and admins can change these settings.
        </p>
      )}

      {unreachable && (
        <Notice className="p-3" role="alert" tone="danger">
          Nobody would be told about a failing workflow: nobody ticked below has
          an email KeeperHub can reach and there is no working channel. Add an
          email in{" "}
          <Link className="underline" href="/settings/security">
            Account security
          </Link>
          , or add a Telegram, Discord, Slack or PagerDuty channel.
        </Notice>
      )}

      {data.failingNow.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-medium text-sm">Failing now</h3>
          <ul className="divide-y rounded-md border">
            {data.failingNow.map((w) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
                key={w.workflowId}
              >
                <Link
                  className="min-w-0 break-words font-medium underline underline-offset-4"
                  href={`/workflows/${w.workflowId}?tab=runs`}
                >
                  {w.name}
                </Link>
                <span className="text-destructive text-xs">
                  {w.failureCount} failed run{w.failureCount === 1 ? "" : "s"}{" "}
                  in a row
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Label htmlFor="failure-threshold">Alert after</Label>
          <Input
            aria-describedby={
              thresholdInvalid ? "failure-threshold-error" : undefined
            }
            aria-invalid={thresholdInvalid}
            className="h-8 w-16"
            disabled={disabled}
            id="failure-threshold"
            inputMode="numeric"
            max={MAX_THRESHOLD}
            min={MIN_THRESHOLD}
            onBlur={commitThreshold}
            onChange={(e) => setThresholdInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitThreshold();
              }
            }}
            type="number"
            value={thresholdInput}
          />
          <span>failed runs in a row</span>
        </div>
        {thresholdInvalid && (
          <p className="text-destructive text-xs" id="failure-threshold-error">
            {THRESHOLD_ERROR}
          </p>
        )}

        <details
          className="group"
          onToggle={(e) => setMoreOpen(e.currentTarget.open)}
          open={moreOpen}
        >
          <summary className={SUMMARY_CLASS}>
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            More options
          </summary>
          <div className="mt-3 space-y-3 border-l pl-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                checked={form.timeLimitMinutes !== null}
                disabled={disabled}
                id="failure-time-limit"
                onCheckedChange={(checked) =>
                  change({
                    timeLimitMinutes:
                      checked === true ? DEFAULT_TIME_LIMIT : null,
                  })
                }
              />
              <Label className="font-normal" htmlFor="failure-time-limit">
                Also alert when a workflow keeps failing for
              </Label>
              <Select
                disabled={disabled || form.timeLimitMinutes === null}
                onValueChange={(v) => change({ timeLimitMinutes: Number(v) })}
                value={String(form.timeLimitMinutes ?? DEFAULT_TIME_LIMIT)}
              >
                <SelectTrigger
                  aria-label="How long"
                  className="h-8 w-28"
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_LIMIT_OPTIONS_MINUTES.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {TIME_LIMIT_LABEL[minutes]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-muted-foreground text-xs">
              For slow schedules: a workflow every 4 hours needs 20 hours to
              fail 5 times.
            </p>
            <label className="flex items-center gap-2" htmlFor="failure-remind">
              <Checkbox
                checked={form.remindDaily}
                disabled={disabled}
                id="failure-remind"
                onCheckedChange={(checked) =>
                  change({ remindDaily: checked === true })
                }
              />
              Remind once a day while it keeps failing
            </label>
            <label
              className="flex items-center gap-2"
              htmlFor="failure-recovery"
            >
              <Checkbox
                checked={form.notifyRecovery}
                disabled={disabled}
                id="failure-recovery"
                onCheckedChange={(checked) =>
                  change({ notifyRecovery: checked === true })
                }
              />
              Tell me when it works again
            </label>
          </div>
        </details>
      </section>

      <section className="space-y-3">
        <h3 className="font-medium text-sm">Email</h3>
        <ul className="space-y-2">
          {data.members.map((m) => (
            <li
              className="flex flex-wrap items-center gap-2 text-sm"
              key={m.userId}
            >
              <Checkbox
                checked={form.recipients.includes(m.userId)}
                disabled={disabled || !m.reachable}
                id={`failure-recipient-${m.userId}`}
                onCheckedChange={(checked) =>
                  toggleRecipient(m.userId, checked === true)
                }
              />
              <Label
                className={cn(
                  "min-w-0 cursor-pointer break-all font-normal",
                  // Disabled only because mail cannot reach them: the name
                  // still has to be readable, so skip the faded look.
                  !m.reachable &&
                    "text-muted-foreground peer-disabled:opacity-100"
                )}
                htmlFor={`failure-recipient-${m.userId}`}
              >
                {memberLabel(m)}
              </Label>
              <span className="text-muted-foreground text-xs">
                ({roleLabel(m.role)})
              </span>
              {!m.reachable && (
                <span className="text-muted-foreground text-xs">
                  No email yet. They can add one in{" "}
                  <Link className="underline" href="/settings/security">
                    Account security
                  </Link>
                  .
                </span>
              )}
            </li>
          ))}
        </ul>
        {canManage && (
          <Button
            disabled={emailTesting}
            onClick={testEmail}
            size="sm"
            type="button"
            variant="outline"
          >
            {emailTesting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Send me a test email
          </Button>
        )}
        {emailResult && <TestResultLine result={emailResult} />}
      </section>

      <section className="space-y-3">
        <h3 className="font-medium text-sm">Also send to</h3>
        <ChannelListEditor
          canManage={canManage}
          channels={form.channels}
          connections={data.connections}
          onChange={changeChannels}
          onConnectionsChanged={refreshConnections}
          organizationId={organizationId}
          unsharedConnections={data.unsharedConnections}
        />
        <details className="group text-xs">
          <summary className={SUMMARY_CLASS}>
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            How delivery works
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-8 text-muted-foreground">
            <li>
              Each alert goes out once per failing streak, not on every failed
              run.
            </li>
            <li>
              If email or chat cannot deliver for 15 minutes, or PagerDuty for
              2, the alert goes to your backup channels and to email, saying
              what failed. Retries continue for 24 hours.
            </li>
            <li>
              A channel that stops working is paused and you are told once.
              Every channel is also checked quietly once a week, without sending
              anything.
            </li>
            <li>
              Only connections shared with the whole organization can be used.
            </li>
          </ul>
        </details>
      </section>

      {data.emailUsage && (
        <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3 text-xs">
          <Gem className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <p className="flex-1 text-muted-foreground">
            {data.emailUsage.used >= data.emailUsage.limit
              ? `All ${data.emailUsage.limit} alert emails for this month are used. Until the 1st, alerts go to your channels and show in KeeperHub.`
              : `Free plan: ${data.emailUsage.limit} alert emails a month, ${data.emailUsage.used} used. Chat and PagerDuty are not counted.`}
          </p>
        </div>
      )}

      {data.customWorkflows.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {data.customWorkflows.length === 1
            ? "1 workflow has its own settings: "
            : `${data.customWorkflows.length} workflows have their own settings: `}
          {data.customWorkflows.map((w, i) => (
            <span key={w.id}>
              {i > 0 ? ", " : null}
              <Link
                className="underline underline-offset-4"
                href={`/workflows/${w.id}`}
              >
                {w.name}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }): React.ReactElement {
  return (
    <output
      aria-live="polite"
      className="flex items-center gap-1 text-muted-foreground text-xs"
      data-state={state}
      data-testid="failure-alerts-save-state"
    >
      {state === "saving" && (
        <>
          <Loader2 className="size-3 animate-spin" />
          Saving
        </>
      )}
      {state === "saved" && (
        <>
          <Check className="size-3 text-keeperhub-green-dark" />
          Saved
        </>
      )}
      {state === "error" && <span className="text-destructive">Not saved</span>}
      {state === "idle" && "Changes save automatically"}
    </output>
  );
}
