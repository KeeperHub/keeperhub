import {
  describeCron,
  formatTime,
  parseCronToSimple,
  parseIntervalSeconds,
  validateCronExpression,
} from "@/lib/cron-utils";
import {
  getTriggerTypeFromConfig,
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

export type TriggerStatusCounts = Record<TriggerStatus, number>;

// The statuses, in the order the filter menu and messages list them.
export const TRIGGER_STATUS_OPTIONS: readonly {
  value: TriggerStatus;
  label: string;
}[] = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "manual", label: "Manual" },
];

const HOURLY_STEP_PATTERN = /^\*\/(\d+)$/;
const WHITESPACE_PATTERN = /\s+/;
const NUMERIC_PATTERN = /^\d+$/;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const WEEKDAYS = [1, 2, 3, 4, 5];
const DAYS_PER_WEEK = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MAX_MINUTE = 59;

// A trigger that fires on its own and so has an enabled switch; Manual and
// "no trigger yet" do not. Also narrows away undefined for callers.
function hasEnableSwitch(
  triggerType: WorkflowTriggerType | null | undefined
): triggerType is WorkflowTriggerType {
  return shouldShowEnableSwitch(triggerType ?? undefined);
}

// "Scheduled" is a legacy spelling of Schedule still saved in some trigger
// nodes. The schedule service accepts only "Schedule", so a "Scheduled"
// trigger never gets a schedule and never runs on its own. The picker shows
// it as a Schedule trigger that is off, never as a live one.
const LEGACY_SCHEDULE = "Scheduled";
const LEGACY_SCHEDULE_DETAIL =
  "Old format, does not run. Open the trigger and pick Schedule again";

function isLegacySchedule(workflow: {
  triggerConfig?: Record<string, unknown> | null;
}): boolean {
  return workflow.triggerConfig?.triggerType === LEGACY_SCHEDULE;
}

/** The trigger type a picker row shows for this trigger config. */
export function getPickerTriggerType(
  config: Record<string, unknown> | undefined
): WorkflowTriggerType | undefined {
  return config?.triggerType === LEGACY_SCHEDULE
    ? WorkflowTriggerEnum.SCHEDULE
    : getTriggerTypeFromConfig(config);
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
  triggerConfig?: Record<string, unknown> | null;
}): TriggerStatus {
  if (workflow.deactivatedAt || isLegacySchedule(workflow)) {
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

// A cron read once into the shape both the row label and the tooltip
// describe, so the two never disagree. Undefined when the cron is not valid.
type CronShape =
  | { kind: "minutes"; step: number }
  | { kind: "hourly"; minute: number }
  | { kind: "hours"; step: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; days: number[] }
  // `M */N * * *` where N does not divide the day: it runs at these hours
  // and then again at midnight, so it is not "every N hours".
  | { kind: "hoursAt"; hours: number[]; minute: number }
  | { kind: "custom" };

// `M */N * * *` is not a SimpleSchedule shape, but it is a common one.
function readEveryNHours(cron: string): CronShape | undefined {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = cron
    .trim()
    .split(WHITESPACE_PATTERN);
  if (
    rest.length > 0 ||
    !NUMERIC_PATTERN.test(minute ?? "") ||
    Number(minute) > MAX_MINUTE ||
    dayOfMonth !== "*" ||
    month !== "*" ||
    dayOfWeek !== "*"
  ) {
    return;
  }
  const step = Number.parseInt(hour?.match(HOURLY_STEP_PATTERN)?.[1] ?? "", 10);
  if (!(step >= 1)) {
    return;
  }
  if (step === 1) {
    return { kind: "hourly", minute: Number(minute) };
  }
  if (step < HOURS_PER_DAY && HOURS_PER_DAY % step === 0) {
    return { kind: "hours", step };
  }
  const hours: number[] = [];
  for (let h = 0; h < HOURS_PER_DAY; h += step) {
    hours.push(h);
  }
  return { kind: "hoursAt", hours, minute: Number(minute) };
}

function readCron(cron: string): CronShape | undefined {
  if (!validateCronExpression(cron).valid) {
    return;
  }
  const simple = parseCronToSimple(cron);
  switch (simple?.frequency) {
    case "every-minute":
      return { kind: "minutes", step: 1 };
    case "every-n-minutes": {
      // `*/N` minutes keeps even gaps only when N divides the hour (`*/7`
      // runs at :56 and then :00); `*/60` and over runs on the hour only.
      const step = simple.interval ?? 0;
      if (step >= MINUTES_PER_HOUR) {
        return { kind: "hourly", minute: 0 };
      }
      return step >= 1 && MINUTES_PER_HOUR % step === 0
        ? { kind: "minutes", step }
        : { kind: "custom" };
    }
    case "hourly":
      return { kind: "hourly", minute: simple.minute ?? 0 };
    case "daily":
      return {
        kind: "daily",
        hour: simple.hour ?? 0,
        minute: simple.minute ?? 0,
      };
    case "weekly": {
      const days = [...new Set(simple.daysOfWeek ?? [])];
      return days.length === DAYS_PER_WEEK
        ? { kind: "daily", hour: simple.hour ?? 0, minute: simple.minute ?? 0 }
        : { kind: "weekly", days };
    }
    default:
      return readEveryNHours(cron) ?? { kind: "custom" };
  }
}

function describeWeekly(days: number[]): string {
  if (days.length === 1) {
    return "Weekly";
  }
  if (
    days.length === WEEKDAYS.length &&
    WEEKDAYS.every((d) => days.includes(d))
  ) {
    return "Weekdays";
  }
  return `${days.length}x a week`;
}

function describeCronShort(shape: CronShape): string {
  switch (shape.kind) {
    case "minutes":
      return `${shape.step} min`;
    case "hourly":
      return "Hourly";
    case "hours":
      return `${shape.step} h`;
    case "daily":
      return "Daily";
    case "weekly":
      return describeWeekly(shape.days);
    default:
      // A valid cron with no short name ("0 9 1 * *", uneven gaps).
      return "Custom";
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
  // A cron that does not parse has nothing to show.
  const shape = readCron(cron);
  return shape ? describeCronShort(shape) : "";
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
  if (isLegacySchedule(workflow)) {
    return "";
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

// In the viewer's own timezone, so the date matches their calendar.
const DEACTIVATED_DATE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

/**
 * What the Deactivated label's tooltip says: who turned it off, when, and
 * what to do, e.g. "Turned off by KeeperHub on Oct 6, 2026. Contact support
 * to turn it back on."
 */
export function describeDeactivation(deactivatedAt: string): string {
  const date = new Date(deactivatedAt);
  const when = Number.isNaN(date.getTime())
    ? ""
    : ` on ${DEACTIVATED_DATE.format(date)}`;
  return `Turned off by KeeperHub${when}. Contact support to turn it back on.`;
}

/**
 * The row's status for screen readers, read after the name in place of the
 * visible label (which is hidden from them, so nothing is said twice):
 * "Enabled, Schedule trigger, Every 5 minutes", "Disabled, Event trigger,
 * Paused", "Manual trigger, Runs when you click Run Workflow", and for a
 * deactivated one who turned it off.
 * Commas only, so no reader says "middle dot".
 */
export function getTriggerAccessibleStatus(workflow: {
  triggerType?: WorkflowTriggerType | null;
  enabled?: boolean | null;
  deactivatedAt?: string | null;
  triggerConfig?: Record<string, unknown> | null;
}): string {
  const text = getTriggerSummaryParts(workflow).join(", ");
  return workflow.deactivatedAt
    ? `${text}. ${describeDeactivation(workflow.deactivatedAt)}`
    : text;
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

// The picked trigger types; empty means every type.
export type TriggerTypeFilter = ReadonlySet<WorkflowTriggerType>;

// The order trigger types are listed in the filter menu. Pyth Price sits
// behind a feature flag, so the menu shows it only when a workflow uses it.
const TRIGGER_TYPE_FILTER_ORDER: readonly WorkflowTriggerType[] = [
  WorkflowTriggerEnum.SCHEDULE,
  WorkflowTriggerEnum.EVENT,
  WorkflowTriggerEnum.BLOCK,
  WorkflowTriggerEnum.WEBHOOK,
  WorkflowTriggerEnum.TEMPO_PAYMENT,
  WorkflowTriggerEnum.PYTH_PRICE,
  WorkflowTriggerEnum.MANUAL,
];

/**
 * The trigger types the filter menu offers: every type, except Pyth Price
 * when no workflow here uses it (it is behind a feature flag) and it is not
 * picked. A picked type always stays listed, so a filter never hides where
 * the menu cannot show it.
 */
export function listedTriggerTypes(
  workflows: Array<{ triggerType?: WorkflowTriggerType | null }>,
  picked: TriggerTypeFilter = new Set()
): WorkflowTriggerType[] {
  const hasPyth =
    picked.has(WorkflowTriggerEnum.PYTH_PRICE) ||
    workflows.some(
      (workflow) => workflow.triggerType === WorkflowTriggerEnum.PYTH_PRICE
    );
  return TRIGGER_TYPE_FILTER_ORDER.filter(
    (type) => type !== WorkflowTriggerEnum.PYTH_PRICE || hasPyth
  );
}

// The type a workflow is filed under: one with no trigger yet runs only when
// clicked, so it is Manual, as its icon shows.
function getFilterTriggerType(workflow: {
  triggerType?: WorkflowTriggerType | null;
}): WorkflowTriggerType {
  const type = workflow.triggerType;
  // An unknown type (bad data) is filed as Manual too, as its icon shows.
  return type && TRIGGER_TYPE_FILTER_ORDER.includes(type)
    ? type
    : WorkflowTriggerEnum.MANUAL;
}

export function countTriggerTypes(
  workflows: Array<{ triggerType?: WorkflowTriggerType | null }>
): Record<WorkflowTriggerType, number> {
  const counts = Object.fromEntries(
    TRIGGER_TYPE_FILTER_ORDER.map((type) => [type, 0])
  ) as Record<WorkflowTriggerType, number>;
  for (const workflow of workflows) {
    counts[getFilterTriggerType(workflow)] += 1;
  }
  return counts;
}

export function matchesTriggerTypeFilter(
  workflow: { triggerType?: WorkflowTriggerType | null },
  filter: TriggerTypeFilter
): boolean {
  return filter.size === 0 || filter.has(getFilterTriggerType(workflow));
}

/** What the row icon's tooltip says, e.g. "Block trigger". */
export function getTriggerTypeLabel(
  triggerType: WorkflowTriggerType | null | undefined
): string {
  return `${triggerType ?? WorkflowTriggerEnum.MANUAL} trigger`;
}

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

// The scheduler runs a schedule saved without a timezone in UTC.
function scheduleTimezone(config: Record<string, unknown>): string {
  const timezone = config.scheduleTimezone;
  return typeof timezone === "string" && timezone !== "" ? timezone : "UTC";
}

function listTimes(hours: number[], minute: number): string {
  const times = hours.map((hour) => formatTime(hour, minute));
  return times.length === 1
    ? times[0]
    : `${times.slice(0, -1).join(", ")} and ${times.at(-1)}`;
}

// The schedule in words. The timezone is named wherever the text names a
// minute, a time, a day or the raw cron: each of those depends on it, even
// the minute (a zone such as Asia/Kolkata is offset by half an hour). Only
// "every N minutes" and "every N hours" read the same everywhere.
function describeCronInFull(
  cron: string,
  shape: CronShape | undefined,
  timezone: string
): string {
  switch (shape?.kind) {
    case "minutes":
      return every(shape.step, "minute");
    case "hours":
      return every(shape.step, "hour");
    case "hourly":
      return shape.minute === 0
        ? `Every hour on the hour (${timezone})`
        : `Every hour at minute ${shape.minute} (${timezone})`;
    case "daily":
      return `Every day at ${formatTime(shape.hour, shape.minute)} (${timezone})`;
    case "weekly":
      return `${describeCron(cron)} (${timezone})`;
    case "hoursAt":
      return `Every day at ${listTimes(shape.hours, shape.minute)} (${timezone})`;
    case "custom": {
      // describeCron words uneven minute steps, ending "(uneven gaps)";
      // anything else shows as is.
      const text = describeCron(cron);
      if (text === "" || text === "Custom schedule") {
        return `Cron ${cron.trim()} (${timezone})`;
      }
      return text.endsWith(")")
        ? `${text.slice(0, -1)}, ${timezone})`
        : `${text} (${timezone})`;
    }
    default:
      // An invalid cron never runs, but it still reads as the others do.
      return `Cron ${cron.trim()} (${timezone})`;
  }
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
  return describeCronInFull(cron, readCron(cron), scheduleTimezone(config));
}

function describeBlockInFull(
  config: Record<string, unknown>
): string | undefined {
  const interval = blockInterval(config);
  return interval === undefined ? undefined : every(interval, "block");
}

// The status word a tooltip or screen reader leads with; Manual has none,
// its detail says how it runs instead.
function getStatusWord(workflow: {
  triggerType?: WorkflowTriggerType | null;
  enabled?: boolean | null;
  deactivatedAt?: string | null;
  triggerConfig?: Record<string, unknown> | null;
}): string | undefined {
  if (workflow.deactivatedAt) {
    return "Deactivated";
  }
  // Its detail says what state it is in; "Disabled" would not be true.
  if (isLegacySchedule(workflow)) {
    return;
  }
  switch (getTriggerStatus(workflow)) {
    case "enabled":
      return "Enabled";
    case "disabled":
      return "Disabled";
    default:
      return;
  }
}

// Status, type and detail, the parts both the tooltip and the screen-reader
// text are made of.
function getTriggerSummaryParts(workflow: {
  triggerType?: WorkflowTriggerType | null;
  enabled?: boolean | null;
  deactivatedAt?: string | null;
  triggerConfig?: Record<string, unknown> | null;
}): string[] {
  const status = getStatusWord(workflow);
  // Deactivation stops every trigger, Manual included, so a deactivated
  // workflow is never said to run when Run Workflow is clicked.
  const detail =
    workflow.deactivatedAt && !hasEnableSwitch(workflow.triggerType)
      ? undefined
      : getTriggerDetail(workflow);
  return [
    ...(status ? [status] : []),
    getTriggerTypeLabel(workflow.triggerType),
    ...(detail ? [detail] : []),
  ];
}

/**
 * The trigger icon's tooltip: the status in words (the row shows it only by
 * colour), the type, then what the 64px label has no room for, e.g.
 * "Disabled · Schedule trigger · Every 5 minutes", "Manual trigger · Runs
 * when you click Run Workflow".
 */
export function getTriggerTooltip(workflow: {
  triggerType?: WorkflowTriggerType | null;
  enabled?: boolean | null;
  deactivatedAt?: string | null;
  triggerConfig?: Record<string, unknown> | null;
}): string {
  return getTriggerSummaryParts(workflow).join(" \u00b7 ");
}

// What the 64px label has no room for: the schedule in full, the event name,
// the block interval. Undefined when there is nothing to add to the type.
function getTriggerDetail(workflow: {
  triggerType?: WorkflowTriggerType | null;
  triggerConfig?: Record<string, unknown> | null;
}): string | undefined {
  if (isLegacySchedule(workflow)) {
    return LEGACY_SCHEDULE_DETAIL;
  }
  const config = workflow.triggerConfig ?? {};
  switch (workflow.triggerType) {
    case WorkflowTriggerEnum.SCHEDULE:
      return describeScheduleInFull(config);
    case WorkflowTriggerEnum.EVENT:
      return describeEvent(config) || undefined;
    case WorkflowTriggerEnum.BLOCK:
      return describeBlockInFull(config);
    case WorkflowTriggerEnum.MANUAL:
    case undefined:
    case null:
      return MANUAL_DETAIL;
    default:
      return;
  }
}

// Manual has no status, so its detail says what starts it. No trigger at all
// runs the same way.
const MANUAL_DETAIL = "Runs when you click Run Workflow";

/**
 * The empty-list message when the filters hide every workflow, naming both,
 * e.g. "No disabled workflows with an Event or Block trigger".
 */
export function describeEmptyFilterResult(
  filter: TriggerFilter,
  types: TriggerTypeFilter
): string {
  const statuses = TRIGGER_STATUS_OPTIONS.map((option) => option.value).filter(
    (status) => filter.has(status)
  );
  const subject =
    statuses.length === 0 ? "workflows" : `${statuses.join(" or ")} workflows`;
  const picked = TRIGGER_TYPE_FILTER_ORDER.filter((type) => types.has(type));
  if (picked.length === 0) {
    return `No ${subject}`;
  }
  const article = picked[0] === WorkflowTriggerEnum.EVENT ? "an" : "a";
  return `No ${subject} with ${article} ${picked.join(" or ")} trigger`;
}
