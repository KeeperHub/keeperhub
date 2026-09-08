import { Counter, Histogram, Registry } from "prom-client";

export const registry = new Registry();

const PREFIX = "keeperhub_schedule_dispatcher";

// How long each dispatch pass takes, wall-clock, from stamp-now to last SQS
// send (or fetch failure). The primary latency signal. p95 > 10s indicates DB
// or SQS slowness severe enough to threaten the trigger window.
export const runDurationSeconds = new Histogram({
  name: `${PREFIX}_run_duration_seconds`,
  help: "Wall-clock seconds per dispatch pass (fetch + evaluate + enqueue).",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

// Monotonic total of dispatch passes completed. Use rate() to get passes/min.
export const runsTotal = new Counter({
  name: `${PREFIX}_runs_total`,
  help: "Total dispatch passes completed (fetch succeeded and loop ran).",
  registers: [registry],
});

// Monotonic total of SQS messages enqueued. A sustained zero over 90 minutes
// while schedules exist is the "missed hourly trigger" signal.
export const triggeredTotal = new Counter({
  name: `${PREFIX}_triggered_total`,
  help: "Total workflow trigger messages successfully enqueued to SQS.",
  registers: [registry],
});

// Occurrences the platform refused on plan grounds before anything was
// enqueued. Not an error: the trigger fired, the org may not run it. Rising
// here with triggered_total flat is an org sitting at its limit, not an outage.
export const refusedTotal = new Counter({
  name: `${PREFIX}_refused_total`,
  help: "Total occurrences refused at admission (over plan limit or gated action), skipped without enqueueing.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// Per-schedule errors (SQS failure, bad cron caught late, etc.). Distinct from
// fetch errors which abort the whole pass and are not counted here.
export const errorsTotal = new Counter({
  name: `${PREFIX}_errors_total`,
  help: "Total per-schedule errors during a dispatch pass.",
  registers: [registry],
});
