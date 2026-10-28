"use client";

import { AlertTriangle, Gem, Info, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { OrgSettingsView } from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { sendFailureAlertTest, type TestResult } from "./api";
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

type Form = {
  threshold: string;
  timeLimit: string;
  remindDaily: boolean;
  notifyRecovery: boolean;
  recipients: string[];
  channels: DraftChannel[];
};

function formFrom(data: Loaded): Form {
  return {
    threshold: String(data.threshold),
    timeLimit: data.timeLimitMinutes ? String(data.timeLimitMinutes) : "off",
    remindDaily: data.remindDaily,
    notifyRecovery: data.notifyRecovery,
    recipients: [...data.recipientUserIds].sort(),
    channels: draftsFromViews(data.channels),
  };
}

function serialise(form: Form): string {
  return JSON.stringify({
    ...form,
    recipients: [...form.recipients].sort(),
    channels: channelsPayload(form.channels),
  });
}

export function OrgFailureAlertsSection({
  organizationId,
}: {
  organizationId: string;
}): React.ReactElement {
  const [data, setData] = useState<Loaded | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testTarget, setTestTarget] = useState<"me" | "recipients">("me");
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailResult, setEmailResult] = useState<TestResult | null>(null);
  const url = `/api/organizations/${encodeURIComponent(organizationId)}/failure-alerts`;

  const apply = useCallback((next: Loaded) => {
    const nextForm = formFrom(next);
    setData(next);
    setForm(nextForm);
    setSaved(serialise(nextForm));
  }, []);

  useEffect(() => {
    let active = true;
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: Loaded | null) => {
        if (active && body) {
          apply(body);
        }
      })
      .catch(() => {
        if (active) {
          toast.error("Could not load failure notification settings");
        }
      });
    return () => {
      active = false;
    };
  }, [apply, url]);

  /** A connection made from the Add form: refresh the list, keep the form. */
  const refreshConnections = useCallback(async () => {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as Loaded;
      setData((prev) =>
        prev ? { ...prev, connections: body.connections } : prev
      );
    }
  }, [url]);

  const dirty = form !== null && saved !== null && serialise(form) !== saved;

  const reachableChosen = useMemo(() => {
    if (!(data && form)) {
      return false;
    }
    return data.members.some(
      (m) => m.reachable && form.recipients.includes(m.userId)
    );
  }, [data, form]);

  if (!(data && form)) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading
      </div>
    );
  }

  const canManage = data.canManage;
  const disabled = !canManage || saving;
  const update = (patch: Partial<Form>): void =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  const liveChannels = form.channels.filter((c) => !c.view?.pausedAt);
  const unreachable = !reachableChosen && liveChannels.length === 0;
  const untested = form.channels.filter(
    (c) => !(c.testedOk || c.view?.lastTestOk || c.view?.lastDeliveredAt)
  ).length;

  const toggleRecipient = (userId: string, checked: boolean): void => {
    const next = checked
      ? [...new Set([...form.recipients, userId])]
      : form.recipients.filter((id) => id !== userId);
    update({ recipients: next });
  };

  const save = async (): Promise<void> => {
    const threshold = Number(form.threshold);
    if (
      !Number.isInteger(threshold) ||
      threshold < MIN_THRESHOLD ||
      threshold > MAX_THRESHOLD
    ) {
      toast.error(
        `Failed runs in a row must be a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}.`
      );
      return;
    }
    if (form.recipients.length === 0) {
      toast.error("Choose at least one person to email.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threshold,
          timeLimitMinutes:
            form.timeLimit === "off" ? null : Number(form.timeLimit),
          remindDaily: form.remindDaily,
          notifyRecovery: form.notifyRecovery,
          recipientUserIds: form.recipients,
          channels: channelsPayload(form.channels),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Loaded & {
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? "Could not save settings");
        return;
      }
      apply(body);
      toast.success("Failure notification settings saved");
    } catch {
      toast.error("Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  const testEmail = async (): Promise<void> => {
    setEmailTesting(true);
    setEmailResult(null);
    setEmailResult(
      await sendFailureAlertTest(organizationId, {
        channel: "email",
        to: testTarget,
        recipientUserIds: form.recipients,
      })
    );
    setEmailTesting(false);
  };

  return (
    <div className="space-y-6" data-testid="failure-alerts-settings">
      {!data.enabled && (
        <Callout tone="info">
          Failure notifications are being switched on for organizations in
          stages and have not reached this one yet. You can set them up now;
          they start working when they do.
        </Callout>
      )}
      {!canManage && (
        <p className="text-muted-foreground text-xs">
          Only owners and admins can change these settings.
        </p>
      )}

      <section className="space-y-3">
        <h3 className="font-medium text-sm">When to alert</h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Label htmlFor="failure-threshold">Alert after</Label>
          <Input
            className="h-8 w-16"
            disabled={disabled}
            id="failure-threshold"
            inputMode="numeric"
            max={MAX_THRESHOLD}
            min={MIN_THRESHOLD}
            onChange={(e) => update({ threshold: e.target.value })}
            type="number"
            value={form.threshold}
          />
          <span>failed runs in a row</span>
          <span className="text-muted-foreground">or after failing for</span>
          <Select
            disabled={disabled}
            onValueChange={(timeLimit) => update({ timeLimit })}
            value={form.timeLimit}
          >
            <SelectTrigger
              aria-label="Time limit"
              className="h-8 w-28"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              {TIME_LIMIT_OPTIONS_MINUTES.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {TIME_LIMIT_LABEL[minutes]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground text-xs">
          Counts workflows that run on their own: schedules, events, blocks and
          webhooks. Runs started by hand never count. The time limit catches
          slow schedules: a workflow every 4 hours needs 20 hours to fail 5
          times.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2" htmlFor="failure-remind">
            <Checkbox
              checked={form.remindDaily}
              disabled={disabled}
              id="failure-remind"
              onCheckedChange={(checked) =>
                update({ remindDaily: checked === true })
              }
            />
            Remind once a day while it keeps failing
          </label>
          <label className="flex items-center gap-2" htmlFor="failure-recovery">
            <Checkbox
              checked={form.notifyRecovery}
              disabled={disabled}
              id="failure-recovery"
              onCheckedChange={(checked) =>
                update({ notifyRecovery: checked === true })
              }
            />
            Tell us when it recovers
          </label>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-medium text-sm">Email</h3>
        <p className="text-muted-foreground text-xs">
          {data.recipientsAreDefault
            ? "The owners get it until you choose otherwise. "
            : null}
          Email always reaches at least one person, so a failing workflow is
          never silent.
        </p>
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
                  !m.reachable && "text-muted-foreground"
                )}
                htmlFor={`failure-recipient-${m.userId}`}
              >
                {memberLabel(m)}
              </Label>
              <span className="text-muted-foreground text-xs">({m.role})</span>
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
          <div className="flex flex-wrap items-center gap-2">
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
              Send test email
            </Button>
            <Select
              onValueChange={(v) => setTestTarget(v as "me" | "recipients")}
              value={testTarget}
            >
              <SelectTrigger
                aria-label="Who gets the test email"
                className="h-8 w-48"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">To me</SelectItem>
                <SelectItem value="recipients">To everyone ticked</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {emailResult && <TestResultLine result={emailResult} />}
      </section>

      <section className="space-y-3">
        <h3 className="font-medium text-sm">Also send to</h3>
        <ChannelListEditor
          canManage={canManage}
          channels={form.channels}
          connections={data.connections}
          onChange={(channels) => update({ channels })}
          onConnectionsChanged={refreshConnections}
          organizationId={organizationId}
        />
        <p className="text-muted-foreground text-xs">
          Only connections shared with the whole organization can be used, so an
          alert never depends on one person's account.
        </p>
      </section>

      <Callout tone="info">
        <span className="font-medium text-foreground">
          If something can't be delivered:
        </span>{" "}
        email and chat are retried for 15 minutes and PagerDuty for 2, then the
        alert goes to the backup channels and to email with a note saying what
        failed. Retries continue for 24 hours. A channel that stops working is
        paused and you are told once. Every channel is also checked silently
        once a week, without sending anything.
      </Callout>

      {unreachable && (
        <Callout tone="danger">
          Nobody here would be told about a failing workflow: nobody ticked has
          an email KeeperHub can reach and there is no working channel. Add an
          email in Account security, or add a Telegram, Discord, Slack or
          PagerDuty channel.
        </Callout>
      )}
      {!unreachable && liveChannels.length === 0 && (
        <p className="text-muted-foreground text-xs">
          You have no backup. Add a second channel so an email outage does not
          hide failures.
        </p>
      )}
      {untested > 0 && (
        <Callout tone="warning">
          {untested === 1 ? "1 channel is" : `${untested} channels are`}{" "}
          untested. Send a test so you know it works.
        </Callout>
      )}

      {data.emailUsage && (
        <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3 text-sm">
          <Gem className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
          <p className="flex-1 text-muted-foreground">
            {data.emailUsage.used >= data.emailUsage.limit
              ? `All ${data.emailUsage.limit} alert emails for this month are used. Until the 1st, alerts go to your chat and PagerDuty channels and show in KeeperHub.`
              : `Free plan: up to ${data.emailUsage.limit} alert emails a month, ${data.emailUsage.used} used so far. Chat and PagerDuty alerts are not counted.`}
          </p>
        </div>
      )}

      {data.customWorkflows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <span>
            {data.customWorkflows.length === 1
              ? "1 workflow uses its own settings"
              : `${data.customWorkflows.length} workflows use their own settings`}
          </span>
          <span className="flex flex-wrap gap-3 text-xs">
            {data.customWorkflows.map((w) => (
              <Link
                className="underline underline-offset-4"
                href={`/workflows/${w.id}`}
                key={w.id}
              >
                {w.name}
              </Link>
            ))}
          </span>
        </div>
      )}

      {canManage && (
        <div className="flex items-center justify-end gap-2">
          {dirty && !saving && (
            <span className="mr-auto text-muted-foreground text-xs">
              Unsaved changes
            </span>
          )}
          <Button
            disabled={!dirty || saving}
            onClick={() => saved && data && setForm(formFrom(data))}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={!dirty || saving}
            onClick={save}
            size="sm"
            type="button"
          >
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Callout({
  tone,
  children,
}: {
  tone: "info" | "warning" | "danger";
  children: React.ReactNode;
}): React.ReactElement {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-xs",
        tone === "info" && "bg-muted/30 text-muted-foreground",
        tone === "warning" &&
          "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
        tone === "danger" &&
          "border-destructive/50 bg-destructive/15 text-foreground"
      )}
      role={tone === "danger" ? "alert" : undefined}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "danger" && "text-destructive"
        )}
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
