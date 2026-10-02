/**
 * Pure Events API v2 payload helpers - no network, no server-only imports.
 *
 * Split out of the step core so the node's payload preview can build exactly
 * the body the step will send, in the browser, without pulling the SSRF guard
 * into a client bundle. One builder, one set of limits, one place to change
 * them.
 */

import { stripControlChars as removeControlChars } from "@/lib/utils/control-chars";

/**
 * Everything both the steps and the client-bundled connection test need.
 *
 * `test.ts` cannot import `pagerduty-core.ts`, which is server-only, and used
 * to answer that by keeping its own copies of these. Copies are how Test
 * Connection starts disagreeing with the steps as soon as one side moves,
 * which is the exact class of problem that file exists to catch before a run
 * does. This module already has the constraint in its own header - no network,
 * no server-only imports - so it is the one definition both can read.
 */
export const PAGERDUTY_API_HOST = "https://api.pagerduty.com";
export const PAGERDUTY_API_HOST_EU = "https://api.eu.pagerduty.com";
export const PAGERDUTY_EVENTS_HOST = "https://events.pagerduty.com";
export const PAGERDUTY_EVENTS_HOST_EU = "https://events.eu.pagerduty.com";
export const PAGERDUTY_IDENTITY_TOKEN_URL =
  "https://identity.pagerduty.com/oauth/token";
export const PAGERDUTY_ACCEPT_V2 = "application/vnd.pagerduty+json;version=2";
export const PAGERDUTY_REQUEST_TIMEOUT_MS = 10_000;

/** Printable ASCII only: anything else cannot be sent as a header value. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]{1,256}$/;

export function isHeaderSafeToken(token: string): boolean {
  return HEADER_SAFE_TOKEN.test(token);
}

/**
 * The region flag reaches the runtime as a string from the connection
 * checkbox, from an environment variable on a self-hosted install, and from an
 * MCP caller. Only the checkbox is guaranteed to write "true".
 */
const TRUTHY_REGION_FLAGS: ReadonlySet<string> = new Set([
  "true",
  "1",
  "yes",
  "eu",
  "on",
]);

export function isEuRegionFlag(raw: string | undefined): boolean {
  return TRUTHY_REGION_FLAGS.has(raw?.trim().toLowerCase() ?? "");
}

/**
 * The two scopes every action needs: reading services, which includes their
 * integrations and so the routing key, and reading escalation policies.
 *
 * Every scope request is built by appending to this pair, and Test Connection
 * asks for it as-is - so a copy of it elsewhere would let the check pass for
 * a connection the nodes cannot use.
 */
export const PAGERDUTY_OAUTH_SCOPES_MINIMAL =
  "services.read escalation_policies.read";

/** The scope string PagerDuty's client-credentials grant expects. */
export function pagerDutyOAuthScope(
  euRegion: boolean,
  subdomain: string,
  scopes: string
): string {
  return `as_account-${euRegion ? "eu" : "us"}.${subdomain} ${scopes}`;
}

/**
 * Where a PagerDuty object lives in PagerDuty's own UI.
 *
 * Here rather than in the picker so the test that pins the path encoding and
 * the region placement exercises the function the link is built from.
 */
export function pagerDutyServiceUrl(
  subdomain: string,
  euRegion: boolean | undefined,
  serviceId: string
): string {
  return `https://${subdomain}${euRegion ? ".eu" : ""}.pagerduty.com/services/${encodeURIComponent(serviceId)}`;
}

export type PagerDutySeverity = "critical" | "error" | "warning" | "info";

/** PagerDuty truncates a longer summary itself; doing it here keeps the alert title readable. */
export const MAX_SUMMARY_CHARS = 1024;
/** Documented dedup key limit. */
export const MAX_DEDUP_KEY_CHARS = 255;
/** Documented Events API v2 size limit for one event. */
export const MAX_EVENT_BYTES = 512_000;

const SEVERITIES: ReadonlySet<string> = new Set([
  "critical",
  "error",
  "warning",
  "info",
]);

/** Trim to a rune count, so a multi-byte summary is not cut mid-character. */
/**
 * UTF-8 byte length without Buffer: this module is imported by the node's
 * preview, which runs in the browser.
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function truncateRunes(value: string, max: number): string {
  const runes = [...value];
  return runes.length <= max ? value : runes.slice(0, max).join("");
}

/**
 * The documented ceiling for each field, by the name a user sees on the node.
 *
 * Only the first two are PagerDuty's own: it documents 1024 characters for an
 * alert summary and 255 for a dedup key, and rejects an event over 512 KB
 * whole. The rest carry the summary's ceiling as a house rule, because
 * PagerDuty documents none and an unbounded templated value is how an event
 * reaches the size limit with nothing left to drop.
 */
export const FIELD_LIMITS: Readonly<Record<string, number>> = {
  Summary: MAX_SUMMARY_CHARS,
  "Dedup key": MAX_DEDUP_KEY_CHARS,
  Source: MAX_SUMMARY_CHARS,
  Component: MAX_SUMMARY_CHARS,
  Group: MAX_SUMMARY_CHARS,
  Class: MAX_SUMMARY_CHARS,
  Title: MAX_SUMMARY_CHARS,
  "Incident key": MAX_DEDUP_KEY_CHARS,
};

/** What a value was changed by, for the node to report and the preview to warn about. */
export type Trim = {
  field: string;
  from: number;
  to: number;
  /** Shortened to fit, or had characters removed that must not reach an alert. */
  kind?: "limit" | "control";
};

/**
 * Characters removed from anything that reaches an alert.
 *
 * A templated value carries whatever the upstream step produced. A bidi
 * override reorders the text it sits in, so a summary can render in
 * PagerDuty and on a phone as something other than what it says; zero-width
 * characters hide differences between two values that look identical. Tab,
 * newline and carriage return are kept - a description is allowed to have
 * lines in it.
 *
 * The class itself is `lib/utils/control-chars.ts`, shared with the node
 * label validator, which strips the same characters for the same reason and
 * differs only in keeping no whitespace and leaving a space behind.
 *
 * Removing them is recorded so the node can say so. Silently is the one way
 * this must not happen: a summary that renders differently from what the
 * author wrote is exactly the thing they need told.
 */
export function stripControlChars(
  value: string,
  field: string,
  into: Trim[]
): string {
  const cleaned = removeControlChars(value, { keepLineBreaks: true });
  if (cleaned.length !== value.length) {
    into.push({
      field,
      from: [...value].length,
      to: [...cleaned].length,
      kind: "control",
    });
  }
  return cleaned;
}

/**
 * Trim to the field's limit and record it if anything was lost.
 *
 * Trimming rather than rejecting is deliberate - an alert with a shortened
 * title still wakes the right person, and refusing to page over a long
 * template would be the worse failure. But it is never silent: every caller
 * collects these and reports them, because a title cut in half is something
 * the author has to know about, and they will not be reading the incident.
 */
export function trimToLimit(
  value: string,
  field: string,
  into: Trim[]
): string {
  const max = FIELD_LIMITS[field] ?? MAX_SUMMARY_CHARS;
  const length = [...value].length;
  if (length <= max) {
    return value;
  }
  into.push({ field, from: length, to: max, kind: "limit" });
  return truncateRunes(value, max);
}

/**
 * What an alert displays: stripped of what must not reach it, then trimmed to
 * the limit so the count is of characters that survive.
 *
 * The dedup key deliberately does not go through this. It is matched by
 * equality between a trigger and the resolve that closes it, so changing how
 * it is derived would orphan every alert already open under the old value.
 */
export function cleanDisplayField(
  value: string,
  field: string,
  into: Trim[]
): string {
  return trimToLimit(stripControlChars(value, field, into), field, into);
}

// Deep enough for anything a step produces, and a bound rather than trust: a
// structure past it is left alone rather than recursed into.
const MAX_DETAILS_DEPTH = 20;

type StripCount = { from: number; to: number };

function stripCounted(value: string, counts: StripCount): string {
  const cleaned = removeControlChars(value, { keepLineBreaks: true });
  counts.from += [...value].length;
  counts.to += [...cleaned].length;
  return cleaned;
}

function stripDeep(value: unknown, depth: number, counts: StripCount): unknown {
  if (typeof value === "string") {
    return stripCounted(value, counts);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    depth >= MAX_DETAILS_DEPTH
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripDeep(entry, depth + 1, counts));
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // Two keys that differed only by a zero-width character collapse into one
    // here, last write winning. That is the point: they were being rendered as
    // the same key already, and now they are it.
    cleaned[stripCounted(key, counts)] = stripDeep(entry, depth + 1, counts);
  }
  return cleaned;
}

/**
 * Custom details, the first of the two display fields that are not one
 * string.
 *
 * Details land in the alert body and in the notification, the same places the
 * summary does, so they carry the same risk and get the same treatment. They
 * cannot be a `cleanDisplayField` call because they are not a single value:
 * an arbitrary object whose keys are rendered beside its values, so the walk
 * covers both.
 *
 * Not trimmed to a character limit - PagerDuty documents none for details,
 * and the byte ceiling in `buildTriggerEvent` is what keeps the event
 * sendable.
 */
export function cleanCustomDetails(
  details: Record<string, unknown> | undefined,
  field: string,
  into: Trim[]
): Record<string, unknown> | undefined {
  if (!details) {
    return details;
  }
  const counts: StripCount = { from: 0, to: 0 };
  const cleaned = stripDeep(details, 0, counts) as Record<string, unknown>;
  if (counts.to !== counts.from) {
    into.push({ field, from: counts.from, to: counts.to, kind: "control" });
  }
  return cleaned;
}

/**
 * Link labels, the other one. A label's whole job is to describe the href
 * beside it, so a reordering character there makes a link read as pointing
 * somewhere it does not - one field away from the summary already protected
 * against exactly that.
 *
 * The href is cleaned as well as the label: a link is only checked for its
 * https scheme, and a reordering character after that spoofs the rest of the
 * host it appears to point at.
 */
export function cleanLinks(
  links: { href: string; text: string }[] | undefined,
  field: string,
  into: Trim[]
): { href: string; text: string }[] | undefined {
  if (!links?.length) {
    return;
  }
  const counts: StripCount = { from: 0, to: 0 };
  const cleaned = links.map((link) => ({
    href: stripCounted(link.href, counts),
    text: stripCounted(link.text, counts),
  }));
  if (counts.to !== counts.from) {
    into.push({ field, from: counts.from, to: counts.to, kind: "control" });
  }
  return cleaned;
}

/** One sentence naming what was shortened, for a log line or a node output. */
export function describeTrims(trims: Trim[]): string | undefined {
  if (trims.length === 0) {
    return;
  }
  return trims
    .map((trim) =>
      trim.kind === "control"
        ? `${trim.field} carried ${trim.from - trim.to} character(s) that cannot go in an alert - invisible or text-reordering - and they were removed`
        : `${trim.field} was ${trim.from} characters and PagerDuty takes ${trim.to}, so it was shortened`
    )
    .join("; ");
}

export function normaliseSeverity(raw: unknown): PagerDutySeverity {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SEVERITIES.has(value) ? (value as PagerDutySeverity) : "error";
}

/**
 * A dedup key that is stable for the node across runs, so a check that keeps
 * failing updates one alert instead of paging on every run. A node-scoped
 * default is the monitoring convention: the alert represents the condition,
 * not the run that noticed it.
 */
export function deriveDedupKey(
  configured: string | undefined,
  context: { workflowId?: string; nodeId?: string },
  trims: Trim[] = []
): string {
  const explicit = configured?.trim();
  if (explicit) {
    // Worth reporting rather than trimming quietly: a key over the limit is
    // trimmed identically everywhere, so the trigger and the resolve still
    // agree - but an author who set two keys differing only after character
    // 255 has two nodes that now share one alert, and nothing else would say
    // so.
    return trimToLimit(explicit, "Dedup key", trims);
  }
  const workflowId = context.workflowId ?? "workflow";
  const nodeId = context.nodeId ?? "node";
  return truncateRunes(
    `keeperhub/${workflowId}/${nodeId}`,
    MAX_DEDUP_KEY_CHARS
  );
}

const LINK_SEPARATOR = /\s*\|\s*/;

/**
 * Parse the links field: one per line, "text | url" or a bare url.
 *
 * Lives here rather than in the step so the node's preview parses them the
 * same way, which is the only place a dropped line is visible before an
 * incident. https is required because PagerDuty renders these as clickable
 * links on the alert and a plaintext one is a downgrade a responder cannot
 * see coming; a line that does not qualify is skipped rather than failing the
 * page, and the count of skipped lines is reported.
 */
export function parseLinks(raw: string | undefined): {
  links: { href: string; text: string }[];
  dropped: number;
} {
  if (!raw?.trim()) {
    return { links: [], dropped: 0 };
  }
  const links: { href: string; text: string }[] = [];
  let dropped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    // The url is the last field, not the second: a label is free text and
    // "Vault A | liquidation risk | https://..." is a reasonable thing to
    // write. Taking the second field dropped the url and kept the middle of
    // the label, which then failed the https check and lost the line.
    const parts = trimmed.split(LINK_SEPARATOR);
    const href = (parts.at(-1) ?? "").trim();
    if (!href.startsWith("https://")) {
      dropped += 1;
      continue;
    }
    const label = parts.slice(0, -1).join(" | ").trim();
    links.push({ href, text: label || href });
  }
  return { links, dropped };
}

export type EventPayloadInput = {
  summary: string;
  severity: unknown;
  source: string;
  component?: string;
  group?: string;
  class?: string;
  customDetails?: Record<string, unknown>;
  links?: { href: string; text: string }[];
  client?: string;
  clientUrl?: string;
};

export type PagerDutyEventBody = {
  routing_key: string;
  event_action: "trigger" | "acknowledge" | "resolve";
  dedup_key: string;
  client?: string;
  client_url?: string;
  links?: { href: string; text: string }[];
  payload?: {
    summary: string;
    severity: PagerDutySeverity;
    source: string;
    timestamp: string;
    component?: string;
    group?: string;
    class?: string;
    custom_details?: Record<string, unknown>;
  };
};

function omitEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build a trigger body, then make it fit. An event over the documented 512 KB
 * limit is rejected outright by PagerDuty, so the custom details are dropped
 * and replaced by a note rather than losing the page - the same trade
 * Alertmanager and Grafana make.
 */
export function buildTriggerEvent(params: {
  routingKey: string;
  dedupKey: string;
  timestamp: string;
  input: EventPayloadInput;
}): { body: PagerDutyEventBody; detailsDropped: boolean; trims: Trim[] } {
  const { input } = params;
  const trims: Trim[] = [];
  const body: PagerDutyEventBody = {
    routing_key: params.routingKey,
    event_action: "trigger",
    dedup_key: params.dedupKey,
    client: omitEmpty(input.client),
    client_url: omitEmpty(input.clientUrl),
    links: cleanLinks(input.links, "Links", trims),
    payload: {
      summary: cleanDisplayField(input.summary, "Summary", trims),
      severity: normaliseSeverity(input.severity),
      // PagerDuty documents no limit on source, but an unbounded templated
      // value is how an event ends up over the size limit with nothing left
      // to drop.
      source: cleanDisplayField(input.source, "Source", trims),
      timestamp: params.timestamp,
      // Bounded for the same reason as source. These three were the last
      // templated fields with no ceiling, and the size guard below can only
      // drop custom details and links - so a component that rendered to
      // something enormous produced a 400 nothing could mitigate, and the
      // page was lost to a field nobody thinks of as risky.
      component: omitEmpty(
        cleanDisplayField(input.component ?? "", "Component", trims)
      ),
      group: omitEmpty(cleanDisplayField(input.group ?? "", "Group", trims)),
      class: omitEmpty(cleanDisplayField(input.class ?? "", "Class", trims)),
      custom_details: cleanCustomDetails(input.customDetails, "Details", trims),
    },
  };

  if (byteLength(JSON.stringify(body)) <= MAX_EVENT_BYTES) {
    return { body, detailsDropped: false, trims };
  }

  if (body.payload) {
    body.payload.custom_details = {
      error: `Custom details were removed because the event exceeded PagerDuty's ${MAX_EVENT_BYTES} byte limit.`,
    };
  }
  // Dropping the details is the only lever here; if the event is still too
  // large, the links are the remaining unbounded field and they go too. The
  // alert itself - summary, severity, routing - is never sacrificed.
  if (byteLength(JSON.stringify(body)) > MAX_EVENT_BYTES) {
    body.links = undefined;
  }
  return { body, detailsDropped: true, trims };
}

export function buildUpdateEvent(params: {
  routingKey: string;
  dedupKey: string;
  action: "acknowledge" | "resolve";
}): PagerDutyEventBody {
  return {
    routing_key: params.routingKey,
    event_action: params.action,
    dedup_key: params.dedupKey,
  };
}
