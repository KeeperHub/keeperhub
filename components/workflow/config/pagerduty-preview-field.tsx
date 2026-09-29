"use client";

import { AlertTriangle, Check, Copy } from "lucide-react";
import { useState } from "react";
import {
  buildTriggerEvent,
  FIELD_LIMITS,
  normaliseSeverity,
  parseLinks,
} from "@/plugins/pagerduty/event-payload";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePagerDutyServices } from "./pagerduty-resource-field";

const ROUTING_KEY_PLACEHOLDER = "resolved from the service at run time";
const DEDUP_KEY_PLACEHOLDER = "keeperhub/<workflow>/<node>";
const EVENTS_HOST = "https://events.pagerduty.com";
const EVENTS_HOST_EU = "https://events.eu.pagerduty.com";

type Tab = "payload" | "incident";

type PreviewConfig = Record<string, unknown>;

function text(config: PreviewConfig, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

/**
 * Parse the custom-details field the way the step does, so the preview shows
 * what will actually be sent rather than the raw string. Unparseable text is
 * kept under `details` here too.
 */
function previewDetails(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Left as free text below.
  }
  return { details: raw };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-border/40 border-b py-1.5 text-xs last:border-b-0">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

/**
 * Two views of the same node config: the exact JSON that leaves KeeperHub, and
 * the alert PagerDuty will hold once it has it.
 *
 * Templates are left unrendered on purpose - the point is to check the shape
 * and the routing before anyone is woken up, and a half-rendered template
 * reads worse than the template itself.
 */
export function PagerDutyPreviewField({
  config,
  disabled,
  siblingDedupKeys = [],
}: {
  config: PreviewConfig;
  disabled?: boolean;
  /**
   * Explicit dedup keys set on every Trigger Incident node on this canvas,
   * this node included - the config here carries no node id to exclude itself
   * by, so a key counts as shared once it appears twice.
   */
  siblingDedupKeys?: string[];
}) {
  const [tab, setTab] = useState<Tab>("payload");
  const [copied, setCopied] = useState(false);

  const integrationId = text(config, "integrationId") || undefined;
  const serviceId = text(config, "pagerdutyServiceId");
  const { items, accountSubdomain, euRegion } =
    usePagerDutyServices(integrationId);
  const service = items.find((candidate) => candidate.id === serviceId);

  const summary = text(config, "summary");
  const dedupKey = text(config, "dedupKey") || DEDUP_KEY_PLACEHOLDER;
  const severity = normaliseSeverity(text(config, "severity"));
  const source = text(config, "source") || "<node name>";

  // Parsed the way the step parses them, so a line that is not an https url
  // is missing from the payload here rather than missing from the incident.
  // Only an explicit key can collide. The default is derived from the node id,
  // so two untouched nodes never share one.
  const explicitKey = text(config, "dedupKey").trim();
  const sharedWith = explicitKey
    ? Math.max(
        0,
        siblingDedupKeys.filter((key) => key === explicitKey).length - 1
      )
    : 0;

  const links = parseLinks(text(config, "links"));
  const { body, detailsDropped, trims } = buildTriggerEvent({
    routingKey: ROUTING_KEY_PLACEHOLDER,
    dedupKey,
    timestamp: "<sent at run time>",
    input: {
      summary: summary || "<summary is required>",
      severity,
      source,
      component: text(config, "component"),
      group: text(config, "group"),
      class: text(config, "class"),
      customDetails: previewDetails(text(config, "customDetails")),
      links: links.links,
      client: "KeeperHub",
      clientUrl: "<link to this workflow>",
    },
  });

  const json = JSON.stringify(body, null, 2);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the JSON is on screen and selectable anyway.
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Tabs onValueChange={(value) => setTab(value as Tab)} value={tab}>
          <TabsList>
            <TabsTrigger disabled={disabled} value="payload">
              Payload
            </TabsTrigger>
            <TabsTrigger disabled={disabled} value="incident">
              Incident
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "payload" && (
          <Button
            className="ml-auto"
            onClick={copy}
            size="sm"
            type="button"
            variant="ghost"
          >
            {copied ? (
              <Check className="size-3" />
            ) : (
              <Copy className="size-3" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>

      {sharedWith > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <p>
              {sharedWith === 1
                ? "Another Trigger Incident node"
                : `${sharedWith} other Trigger Incident nodes`}{" "}
              on this canvas use this dedup key. PagerDuty folds events sharing
              a key into one alert, so these nodes share a single alert between
              them - and a Resolve on any of them closes it for all. Give each
              one its own key unless that is what you want.
            </p>
          </div>
        </div>
      )}

      {trims.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            {trims.map((trim) => (
              <p key={trim.field}>
                <span className="font-medium">{trim.field}</span> is{" "}
                {trim.from.toLocaleString()} characters. PagerDuty takes{" "}
                {trim.to.toLocaleString()}, so the rest will not reach the
                incident.
              </p>
            ))}
          </div>
        </div>
      )}

      {tab === "payload" ? (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">
            POST {euRegion ? EVENTS_HOST_EU : EVENTS_HOST}/v2/enqueue
          </p>
          <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[0.6875rem] leading-relaxed">
            {json}
          </pre>
        </div>
      ) : (
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-border border-b bg-muted/30 px-3 py-2">
            <span className="rounded bg-destructive/20 px-1.5 py-0.5 font-semibold text-[0.625rem] text-destructive uppercase tracking-wide">
              Triggered
            </span>
            <span className="text-muted-foreground text-xs">
              severity {severity}
            </span>
          </div>
          <div className="space-y-1 p-3">
            <p className="font-medium text-sm">
              {summary || "Summary is required"}
            </p>
            <div className="pt-1">
              <Row
                label="Account"
                value={
                  accountSubdomain ? (
                    <span className="font-mono">
                      {accountSubdomain}
                      {euRegion ? ".eu" : ""}.pagerduty.com
                    </span>
                  ) : (
                    "Read from PagerDuty once a connection is selected"
                  )
                }
              />
              <Row
                label="Service"
                value={
                  service ? (
                    <>
                      {service.name}{" "}
                      <span className="font-mono text-muted-foreground">
                        {service.id}
                      </span>
                    </>
                  ) : (
                    (serviceId ?? "Not selected")
                  )
                }
              />
              <Row
                label="Escalation policy"
                value={
                  service?.escalationPolicyName ??
                  "Read from PagerDuty once a service is selected"
                }
              />
              <Row label="Source" value={source} />
              <Row
                label="Dedup key"
                value={
                  <>
                    {dedupKey}
                    {[...dedupKey].length > FIELD_LIMITS["Dedup key"] ? (
                      <span className="ml-1 text-yellow-700 dark:text-yellow-300">
                        (over {FIELD_LIMITS["Dedup key"]} characters)
                      </span>
                    ) : null}
                  </>
                }
              />
              <Row label="Created by" value="KeeperHub" />
            </div>
          </div>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Templates render when the node runs, so a field that is short here can
        still be over the limit once a variable fills it in - the node reports
        that in its `fieldsTrimmed` output when it happens. The routing key is
        never shown here or stored in the workflow: it is read from the service
        each time the node runs.
        {detailsDropped
          ? " Custom details are over PagerDuty's size limit and would be replaced by a note."
          : ""}
        {links.dropped > 0
          ? ` ${links.dropped} ${links.dropped === 1 ? "line" : "lines"} of the links field ${links.dropped === 1 ? "is" : "are"} not an https url, so ${links.dropped === 1 ? "it is" : "they are"} not sent.`
          : ""}
      </p>
    </div>
  );
}
