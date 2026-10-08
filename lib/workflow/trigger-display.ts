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

// The statuses, in the order the filter menu and messages list them.
export const TRIGGER_STATUS_OPTIONS: readonly {
  value: TriggerStatus;
  label: string;
}[] = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "manual", label: "Manual" },
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

// A trigger that fires on its own and so has an enabled switch; Manual and
// "no trigger yet" do not. Also narrows away undefined for callers.
function hasEnableSwitch(
  triggerType: WorkflowTriggerType | null | undefined
): triggerType is WorkflowTriggerType {
  return shouldShowEnableSwitch(triggerType ?? undefined);
}

/**
 * The trigger node's config, or undefined when there is no trigger node. A
 * trigger node saved without a config gets one shared empty object, so it
 * still counts as "has a trigger" (a Manual one) and compares equal from
 * call to call.
 */
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
function everyNHours(cron: string): number | undefined {
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
  return step >= 1 ? step : undefined;
}

function describeEveryNHours(cron: string): string | undefined {
  const step = everyNHours(cron);
  if (step === undefined) {
    return;
  }
  return step === 1 ? "Hourly" : `${step} h`;
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

const DEACTIVATED_DATE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
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
  const hours = everyNHours(cron);
  if (hours !== undefined) {
    return every(hours, "hour");
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

// The status word a tooltip or screen reader leads with; Manual has none,
// its detail says how it runs instead.
function getStatusWord(workflow: {
  triggerType?: WorkflowTriggerType | null;
  enabled?: boolean | null;
  deactivatedAt?: string | null;
}): string | undefined {
  if (workflow.deactivatedAt) {
    return "Deactivated";
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
