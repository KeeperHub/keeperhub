import {
  describeCron,
  parseCronToSimple,
  parseIntervalSeconds,
  validateCronExpression,
} from "@/lib/cron-utils";
import {
  shouldShowEnableSwitch,
  WorkflowTriggerEnum,
  type WorkflowTriggerType,
} from "@/lib/workflow/store";

// What the sidebar picker shows for a workflow's trigger. "enabled" is the
// only status that fires on its own; a manual trigger has no enable switch,
// so it is neither enabled nor disabled.
export type TriggerStatus = "enabled" | "disabled" | "manual";

// The statuses a user picked in the filter; empty means show everything.
export type TriggerFilter = ReadonlySet<TriggerStatus>;

export type TriggerStatusCounts = Record<"all" | TriggerStatus, number>;

// The order statuses are listed in, in chips and in messages.
const FILTER_ORDER: readonly TriggerStatus[] = [
  "enabled",
  "disabled",
  "manual",
];

type TriggerNodeLike = {
  data?: { type?: string; config?: Record<string, unknown> };
};

const HOURLY_STEP_PATTERN = /^\*\/(\d+)$/;
const WHITESPACE_PATTERN = /\s+/;
const NUMERIC_PATTERN = /^\d+$/;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const WEEKDAYS = [1, 2, 3, 4, 5];
const NO_CONFIG: Record<string, unknown> = Object.freeze({});

/**
 * The trigger node's config, or undefined when there is no trigger node. A
 * trigger node saved without a config gets one shared empty object, so it
 * still counts as "has a trigger" (a Manual one) and compares equal from
 * call to call.
 */
// A trigger that fires on its own and so has an enabled switch; Manual and
// "no trigger yet" do not. Also narrows away undefined for callers.
function hasEnableSwitch(
  triggerType: WorkflowTriggerType | null | undefined
): triggerType is WorkflowTriggerType {
  return shouldShowEnableSwitch(triggerType ?? undefined);
}

export function getTriggerConfig(
  nodes: TriggerNodeLike[]
): Record<string, unknown> | undefined {
  const triggerNode = nodes.find((node) => node.data?.type === "trigger");
  if (!triggerNode) {
    return;
  }
  return triggerNode.data?.config ?? NO_CONFIG;
}

/**
 * A workflow with no trigger node yet, or a Manual one, can only run when
 * someone clicks Run, so it is "manual" whatever the enabled column says --
 * manual workflows persist enabled = false by default. A workflow ops
 * deactivated through the admin API stops every trigger, manual included,
 * so it counts as disabled (its label still says Deactivated).
 */
export function getTriggerStatus(workflow: {
  triggerType?: WorkflowTriggerType | null;
  enabled?: boolean | null;
  deactivatedAt?: string | null;
}): TriggerStatus {
  if (workflow.deactivatedAt) {
    return "disabled";
  }
  if (!hasEnableSwitch(workflow.triggerType)) {
    return "manual";
  }
  return workflow.enabled === true ? "enabled" : "disabled";
}

function formatIntervalShort(seconds: number): string {
  // Same words as the cron forms, so one cadence never gets two labels.
  if (seconds === SECONDS_PER_DAY) {
    return "Daily";
  }
  if (seconds === SECONDS_PER_DAY * 7) {
    return "Weekly";
  }
  if (seconds === SECONDS_PER_HOUR) {
    return "Hourly";
  }
  if (seconds % SECONDS_PER_DAY === 0) {
    return `${seconds / SECONDS_PER_DAY} d`;
  }
  if (seconds % SECONDS_PER_HOUR === 0) {
    return `${seconds / SECONDS_PER_HOUR} h`;
  }
  if (seconds % SECONDS_PER_MINUTE === 0) {
    return `${seconds / SECONDS_PER_MINUTE} min`;
  }
  return `${seconds} s`;
}

function describeIntervalSeconds(raw: unknown): string | undefined {
  try {
    const seconds = parseIntervalSeconds(raw);
    return seconds === null ? undefined : formatIntervalShort(seconds);
  } catch {
    // Sub-minute values are rejected by the API; a legacy row that holds one
    // still reads as a schedule rather than breaking the picker.
    return undefined;
  }
}

// `M */N * * *` (every N hours) is not a SimpleSchedule shape, but it is a
// common one, so name it here instead of falling back to "Schedule".
function describeEveryNHours(cron: string): string | undefined {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = cron
    .trim()
    .split(WHITESPACE_PATTERN);
  if (
    rest.length > 0 ||
    !NUMERIC_PATTERN.test(minute ?? "") ||
    dayOfMonth !== "*" ||
    month !== "*" ||
    dayOfWeek !== "*"
  ) {
    return undefined;
  }
  const step = Number.parseInt(hour?.match(HOURLY_STEP_PATTERN)?.[1] ?? "", 10);
  if (step === 1) {
    return "Hourly";
  }
  return step > 1 ? `${step} h` : undefined;
}

function describeWeekly(days: number[]): string {
  const unique = new Set(days);
  if (unique.size === 1) {
    return "Weekly";
  }
  if (unique.size === WEEKDAYS.length && WEEKDAYS.every((d) => unique.has(d))) {
    return "Weekdays";
  }
  return `${unique.size}x a week`;
}

function describeCronShort(cron: string): string | undefined {
  const simple = parseCronToSimple(cron);
  switch (simple?.frequency) {
    case "every-minute":
      return "1 min";
    case "every-n-minutes":
      return `${simple.interval} min`;
    case "hourly":
      return "Hourly";
    case "daily":
      return "Daily";
    case "weekly":
      return describeWeekly(simple.daysOfWeek ?? []);
    default:
      return describeEveryNHours(cron);
  }
}

function describeSchedule(config: Record<string, unknown>): string {
  const interval = describeIntervalSeconds(config.scheduleIntervalSeconds);
  if (interval) {
    return interval;
  }
  const cron = config.scheduleCron;
  if (typeof cron !== "string" || cron.trim() === "") {
    return "";
  }
  // A valid cron with no short name ("0 9 1 * *") is "Custom"; one that does
  // not parse has nothing to show.
  const short = describeCronShort(cron);
  if (short) {
    return short;
  }
  return validateCronExpression(cron).valid ? "Custom" : "";
}

function blockInterval(config: Record<string, unknown>): number | undefined {
  const interval = Number(config.blockInterval);
  return Number.isInteger(interval) && interval >= 1 ? interval : undefined;
}

function describeBlock(config: Record<string, unknown>): string {
  const interval = blockInterval(config);
  if (interval === undefined) {
    return "";
  }
  return interval === 1 ? "Every block" : `${interval} blocks`;
}

function describeEvent(config: Record<string, unknown>): string {
  const name = config.eventName;
  return typeof name === "string" ? name.trim() : "";
}

/**
 * The short text at the right of a picker row. It always answers one
 * question, "how or when does it fire?": "5 min", "Daily", the event name,
 * "10 blocks", whether the workflow is enabled or not (the row shows that
 * through its icon and dimmed name). Empty when the icon already says it all
 * (Webhook, Transfer, Manual) or nothing is configured yet. The one status
 * word is "Deactivated": KeeperHub ops switched it off and the user cannot
 * switch it back on.
 */
export function getTriggerLabel(workflow: {
  triggerType?: WorkflowTriggerType | null;
  deactivatedAt?: string | null;
  triggerConfig?: Record<string, unknown> | null;
}): string {
  if (workflow.deactivatedAt) {
    return "Deactivated";
  }
  const config = workflow.triggerConfig ?? {};
  switch (workflow.triggerType) {
    case WorkflowTriggerEnum.SCHEDULE:
      return describeSchedule(config);
    case WorkflowTriggerEnum.EVENT:
      return describeEvent(config);
    case WorkflowTriggerEnum.BLOCK:
      return describeBlock(config);
    default:
      return "";
  }
}

/** What the Deactivated label's tooltip says. */
export const DEACTIVATED_EXPLANATION =
  "Turned off by KeeperHub. Contact support to turn it back on.";

/**
 * The row's status for screen readers, read after the name in place of the
 * visible label (which is hidden from them, so nothing is said twice):
 * "Enabled, Schedule trigger, Every 5 minutes", "Disabled, Event trigger,
 * Paused", "Manual trigger", and for a deactivated one who turned it off.
 * Commas only, so no reader says "middle dot".
 */
export function getTriggerAccessibleStatus(workflow: {
  triggerType?: WorkflowTriggerType | null;
  enabled?: boolean | null;
  deactivatedAt?: string | null;
  triggerConfig?: Record<string, unknown> | null;
}): string {
  const status = getTriggerStatus(workflow);
  const detail = getTriggerDetail(workflow);
  const parts = [
    ...(workflow.deactivatedAt ? ["Deactivated"] : []),
    ...(!workflow.deactivatedAt && status === "enabled" ? ["Enabled"] : []),
    ...(!workflow.deactivatedAt && status === "disabled" ? ["Disabled"] : []),
    getTriggerTypeLabel(workflow.triggerType),
    ...(detail ? [detail] : []),
  ];
  const text = parts.join(", ");
  return workflow.deactivatedAt ? `${text}. ${DEACTIVATED_EXPLANATION}` : text;
}

/** How many of these were switched off by KeeperHub ops. */
export function countDeactivated(
  workflows: Array<{ deactivatedAt?: string | null }>
): number {
  return workflows.filter((workflow) => workflow.deactivatedAt).length;
}

type TriggerStatusInput = Parameters<typeof getTriggerStatus>[0];

export function countTriggerStatuses(
  workflows: TriggerStatusInput[]
): TriggerStatusCounts {
  const counts: TriggerStatusCounts = {
    all: workflows.length,
    enabled: 0,
    disabled: 0,
    manual: 0,
  };
  for (const workflow of workflows) {
    counts[getTriggerStatus(workflow)] += 1;
  }
  return counts;
}

export function matchesTriggerFilter(
  workflow: TriggerStatusInput,
  filter: TriggerFilter
): boolean {
  return filter.size === 0 || filter.has(getTriggerStatus(workflow));
}

/**
 * Adds the status to the filter, or takes it out if it is already there.
 * Picking the last remaining status turns the filter back into All.
 */
export function toggleTriggerFilter(
  filter: TriggerFilter,
  status: TriggerStatus
): TriggerFilter {
  const next = new Set(filter);
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  // Every status picked shows everything, so it is All.
  return next.size === FILTER_ORDER.length ? new Set() : next;
}

/** What the row icon's tooltip says, e.g. "Block trigger". */
export function getTriggerTypeLabel(
  triggerType: WorkflowTriggerType | null | undefined
): string {
  return `${triggerType ?? WorkflowTriggerEnum.MANUAL} trigger`;
}

// The trigger config fields the picker row reads; edits to any other field
// (an ABI, a webhook schema) leave the row as it is.
const DISPLAYED_CONFIG_KEYS = [
  "triggerType",
  "scheduleCron",
  "scheduleIntervalSeconds",
  "eventName",
  "blockInterval",
  "scheduleTimezone",
] as const;

export function isSameTriggerDisplay(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  if (a === b) {
    return true;
  }
  if (!(a && b)) {
    return false;
  }
  return DISPLAYED_CONFIG_KEYS.every((key) => a[key] === b[key]);
}

// "Every hour", "Every 6 hours": one of a unit reads without the number.
function every(count: number, unit: string): string {
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

function describeEvery(seconds: number): string {
  if (seconds % SECONDS_PER_DAY === 0) {
    return every(seconds / SECONDS_PER_DAY, "day");
  }
  if (seconds % SECONDS_PER_HOUR === 0) {
    return every(seconds / SECONDS_PER_HOUR, "hour");
  }
  if (seconds % SECONDS_PER_MINUTE === 0) {
    return every(seconds / SECONDS_PER_MINUTE, "minute");
  }
  return every(seconds, "second");
}

function describeScheduleInFull(
  config: Record<string, unknown>
): string | undefined {
  try {
    const seconds = parseIntervalSeconds(config.scheduleIntervalSeconds);
    if (seconds !== null) {
      return describeEvery(seconds);
    }
  } catch {
    // A sub-minute legacy interval falls through to the cron, as the label does.
  }
  const cron = config.scheduleCron;
  if (typeof cron !== "string" || cron.trim() === "") {
    return;
  }
  const hours = describeEveryNHours(cron);
  if (hours) {
    return hours === "Hourly"
      ? every(1, "hour")
      : every(Number.parseInt(hours, 10), "hour");
  }
  const text = describeCron(cron);
  if (text === "" || text === "Custom schedule") {
    return `Cron ${cron.trim()}`;
  }
  const timezone = config.scheduleTimezone;
  return typeof timezone === "string" &&
    timezone !== "" &&
    text.includes(" at ")
    ? `${text} (${timezone})`
    : text;
}

function describeBlockInFull(
  config: Record<string, unknown>
): string | undefined {
  const interval = blockInterval(config);
  return interval === undefined ? undefined : every(interval, "block");
}

/**
 * The trigger icon's tooltip: the type, then what the 64px label has no room
 * for, e.g. "Schedule trigger · Every 5 minutes", "Event trigger · Lift".
 */
export function getTriggerTooltip(workflow: {
  triggerType?: WorkflowTriggerType | null;
  triggerConfig?: Record<string, unknown> | null;
}): string {
  const type = getTriggerTypeLabel(workflow.triggerType);
  const detail = getTriggerDetail(workflow);
  return detail ? `${type} · ${detail}` : type;
}

// What the 64px label has no room for: the schedule in full, the event name,
// the block interval. Undefined when there is nothing to add to the type.
function getTriggerDetail(workflow: {
  triggerType?: WorkflowTriggerType | null;
  triggerConfig?: Record<string, unknown> | null;
}): string | undefined {
  const config = workflow.triggerConfig ?? {};
  switch (workflow.triggerType) {
    case WorkflowTriggerEnum.SCHEDULE:
      return describeScheduleInFull(config);
    case WorkflowTriggerEnum.EVENT:
      return describeEvent(config) || undefined;
    case WorkflowTriggerEnum.BLOCK:
      return describeBlockInFull(config);
    default:
      return;
  }
}

/**
 * The empty-list message when a filter or search hides every workflow,
 * naming both, e.g. 'No disabled workflows match "lift"'.
 */
export function describeEmptyFilterResult(
  filter: TriggerFilter,
  query: string
): string {
  const statuses = FILTER_ORDER.filter((status) => filter.has(status));
  const subject =
    statuses.length === 0 ? "workflows" : `${statuses.join(" or ")} workflows`;
  const search = query.trim();
  return search === ""
    ? `No ${subject}`
    : `No ${subject} match \u201c${search}\u201d`;
}
