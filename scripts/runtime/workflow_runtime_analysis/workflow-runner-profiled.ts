#!/usr/bin/env tsx

/**
 * Profiled Workflow Runner
 *
 * Executes a workflow with V8 CPU profiling to count JavaScript operations.
 * Outputs detailed metrics about function calls, execution time, and operation counts.
 *
 * Usage:
 *   # Profile a workflow execution (sampling mode - statistical)
 *   WORKFLOW_ID=xxx EXECUTION_ID=yyy pnpm tsx scripts/runtime/workflow_runtime_analysis/workflow-runner-profiled.ts
 *
 *   # Profile with PRECISE coverage (exact call counts)
 *   PRECISE_COVERAGE=true WORKFLOW_ID=xxx EXECUTION_ID=yyy pnpm tsx scripts/runtime/workflow_runtime_analysis/workflow-runner-profiled.ts
 *
 *   # Profile with detailed output
 *   PROFILE_DETAIL=true WORKFLOW_ID=xxx EXECUTION_ID=yyy pnpm tsx scripts/runtime/workflow_runtime_analysis/workflow-runner-profiled.ts
 *
 *   # Output profile to JSON file
 *   PROFILE_OUTPUT=/tmp/profile.json WORKFLOW_ID=xxx EXECUTION_ID=yyy pnpm tsx scripts/runtime/workflow_runtime_analysis/workflow-runner-profiled.ts
 *
 * Environment variables:
 *   WORKFLOW_ID - ID of the workflow to execute
 *   EXECUTION_ID - ID of the execution record
 *   DATABASE_URL - PostgreSQL connection string
 *   PRECISE_COVERAGE - Use precise coverage for exact call counts (default: false)
 *   PROFILE_DETAIL - Show detailed function breakdown (default: false)
 *   PROFILE_OUTPUT - Path to write JSON profile output
 *   PROFILE_TOP_N - Number of top functions to show (default: 20)
 */

import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { CronExpressionParser } from "cron-parser";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { validateWorkflowIntegrations } from "../../../lib/db/integrations";
import {
  organization,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "../../../lib/db/schema";
import { executeWorkflow } from "../../../lib/workflow/executor/executor.workflow";
import { calculateTotalSteps } from "../../../lib/workflow/executor/progress";
import type { WorkflowEdge, WorkflowNode } from "../../../lib/workflow/store";

// ============================================================================
// Profiler Types
// ============================================================================

type ProfileNode = {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount: number;
  children?: number[];
  positionTicks?: Array<{ line: number; ticks: number }>;
};

type CPUProfile = {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

// Precise coverage types (from V8 inspector protocol)
type CoverageRange = {
  startOffset: number;
  endOffset: number;
  count: number;
};

type FunctionCoverage = {
  functionName: string;
  ranges: CoverageRange[];
  isBlockCoverage: boolean;
};

type ScriptCoverage = {
  scriptId: string;
  url: string;
  functions: FunctionCoverage[];
};

type PreciseCoverageResult = {
  result: ScriptCoverage[];
};

type FunctionStats = {
  name: string;
  file: string;
  line: number;
  hitCount: number; // Statistical hits (sampling) or exact calls (precise)
  selfTime: number;
  totalTime: number;
  callCount: number;
};

type ProfileSummary = {
  mode: "sampling" | "precise";
  totalOperations: number; // Sampling: sum of hits, Precise: sum of calls
  totalFunctionCalls: number;
  totalSamples: number;
  durationMs: number;
  topFunctions: FunctionStats[];
  byCategory: Record<string, CategoryStats>;
  stepMetrics: StepMetrics[];
};

type CategoryStats = {
  hitCount: number;
  functionCount: number;
  functions: string[];
};

type StepMetrics = {
  stepName: string;
  operations: number;
  timeMs: number;
};

// ============================================================================
// Profiler Class
// ============================================================================

class WorkflowProfiler {
  private readonly session: Session;
  private readonly preciseMode: boolean;
  private profile: CPUProfile | null = null;
  private preciseCoverage: PreciseCoverageResult | null = null;
  private readonly stepTimings: Map<string, { start: number; end?: number }> =
    new Map();

  constructor(preciseMode = false) {
    this.session = new Session();
    this.preciseMode = preciseMode;
  }

  async start(): Promise<void> {
    this.session.connect();
    await this.session.post("Profiler.enable");

    if (this.preciseMode) {
      await this.session.post("Profiler.startPreciseCoverage", {
        callCount: true,
        detailed: true,
      });
      console.log("[Profiler] Started PRECISE coverage (exact call counts)");
    } else {
      await this.session.post("Profiler.start");
      console.log("[Profiler] Started CPU profiling (sampling mode)");
    }
  }

  async stop(): Promise<CPUProfile | null> {
    if (this.preciseMode) {
      this.preciseCoverage = (await this.session.post(
        "Profiler.takePreciseCoverage"
      )) as PreciseCoverageResult;
      await this.session.post("Profiler.stopPreciseCoverage");
      console.log("[Profiler] Stopped PRECISE coverage");
    } else {
      const result = await this.session.post("Profiler.stop");
      this.profile = result.profile as CPUProfile;
      console.log("[Profiler] Stopped CPU profiling");
    }

    await this.session.post("Profiler.disable");
    this.session.disconnect();
    return this.profile;
  }

  markStepStart(stepName: string): void {
    this.stepTimings.set(stepName, { start: Date.now() });
  }

  markStepEnd(stepName: string): void {
    const timing = this.stepTimings.get(stepName);
    if (timing) {
      timing.end = Date.now();
    }
  }

  isPreciseMode(): boolean {
    return this.preciseMode;
  }

  analyze(): ProfileSummary {
    if (this.preciseMode) {
      return this.analyzePrecise();
    }
    return this.analyzeSampling();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Profile analysis requires categorization logic
  private analyzePrecise(): ProfileSummary {
    if (!this.preciseCoverage) {
      throw new Error("No precise coverage data available");
    }

    const functionStats = new Map<string, FunctionStats>();
    const categories: Record<string, CategoryStats> = {
      "step-functions": { hitCount: 0, functionCount: 0, functions: [] },
      "workflow-executor": { hitCount: 0, functionCount: 0, functions: [] },
      database: { hitCount: 0, functionCount: 0, functions: [] },
      "external-api": { hitCount: 0, functionCount: 0, functions: [] },
      "node-internals": { hitCount: 0, functionCount: 0, functions: [] },
      other: { hitCount: 0, functionCount: 0, functions: [] },
    };

    let totalOperations = 0;
    let totalFunctionCalls = 0;

    for (const script of this.preciseCoverage.result) {
      const url = script.url;

      for (const fn of script.functions) {
        const callCount = fn.ranges[0]?.count || 0;
        const functionName = fn.functionName || "(anonymous)";

        if (callCount > 0) {
          totalOperations += callCount;
          totalFunctionCalls += 1;

          // Categorize the function
          let category = "other";
          if (url.includes("/steps/") || functionName.includes("Step")) {
            category = "step-functions";
          } else if (
            url.includes("workflow-executor") ||
            url.includes("workflow-runner")
          ) {
            category = "workflow-executor";
          } else if (
            url.includes("drizzle") ||
            url.includes("postgres") ||
            functionName.includes("query")
          ) {
            category = "database";
          } else if (
            functionName.includes("fetch") ||
            url.includes("node:http") ||
            url.includes("node:https")
          ) {
            category = "external-api";
          } else if (url.startsWith("node:") || url.includes("node_modules")) {
            category = "node-internals";
          }

          categories[category].hitCount += callCount;
          if (!categories[category].functions.includes(functionName)) {
            categories[category].functions.push(functionName);
            categories[category].functionCount += 1;
          }

          // Aggregate function stats (only track user code or high-call functions)
          const isUserCode =
            url &&
            !url.startsWith("node:") &&
            !url.includes("node_modules") &&
            url.length > 0;

          if (isUserCode || callCount > 10) {
            const key = `${functionName}@${url}`;
            const existing = functionStats.get(key);
            if (existing) {
              existing.hitCount += callCount;
              existing.callCount += 1;
            } else {
              functionStats.set(key, {
                name: functionName,
                file: url,
                line: 0,
                hitCount: callCount,
                selfTime: 0,
                totalTime: 0,
                callCount: 1,
              });
            }
          }
        }
      }
    }

    const sortedFunctions = Array.from(functionStats.values())
      .filter((f) => f.hitCount > 0)
      .sort((a, b) => b.hitCount - a.hitCount);

    const stepMetrics: StepMetrics[] = [];
    for (const [stepName, timing] of this.stepTimings) {
      if (timing.end) {
        stepMetrics.push({
          stepName,
          operations: 0,
          timeMs: timing.end - timing.start,
        });
      }
    }

    return {
      mode: "precise",
      totalOperations,
      totalFunctionCalls,
      totalSamples: 0,
      durationMs: 0,
      topFunctions: sortedFunctions.slice(
        0,
        Number.parseInt(process.env.PROFILE_TOP_N || "20", 10)
      ),
      byCategory: categories,
      stepMetrics,
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Profile analysis requires categorization logic
  private analyzeSampling(): ProfileSummary {
    if (!this.profile) {
      throw new Error("No profile data available");
    }

    const nodeMap = new Map<number, ProfileNode>();
    for (const node of this.profile.nodes) {
      nodeMap.set(node.id, node);
    }

    // Calculate hit counts and categorize
    const functionStats = new Map<string, FunctionStats>();
    const categories: Record<string, CategoryStats> = {
      "step-functions": { hitCount: 0, functionCount: 0, functions: [] },
      "workflow-executor": { hitCount: 0, functionCount: 0, functions: [] },
      database: { hitCount: 0, functionCount: 0, functions: [] },
      "external-api": { hitCount: 0, functionCount: 0, functions: [] },
      "node-internals": { hitCount: 0, functionCount: 0, functions: [] },
      other: { hitCount: 0, functionCount: 0, functions: [] },
    };

    let totalOperations = 0;
    let totalFunctionCalls = 0;

    for (const node of this.profile.nodes) {
      const { functionName, url, lineNumber } = node.callFrame;

      // Skip empty/anonymous at root level
      if (!functionName && node.id === 1) {
        continue;
      }

      const key = `${functionName || "(anonymous)"}@${url}:${lineNumber}`;
      const hitCount = node.hitCount || 0;

      totalOperations += hitCount;
      if (hitCount > 0) {
        totalFunctionCalls += 1;
      }

      // Categorize the function
      let category = "other";
      if (url.includes("/steps/") || functionName.includes("Step")) {
        category = "step-functions";
      } else if (
        url.includes("workflow-executor") ||
        url.includes("workflow-runner")
      ) {
        category = "workflow-executor";
      } else if (
        url.includes("drizzle") ||
        url.includes("postgres") ||
        functionName.includes("query")
      ) {
        category = "database";
      } else if (
        functionName.includes("fetch") ||
        url.includes("node:http") ||
        url.includes("node:https")
      ) {
        category = "external-api";
      } else if (url.startsWith("node:") || url.includes("node_modules")) {
        category = "node-internals";
      }

      categories[category].hitCount += hitCount;
      if (
        hitCount > 0 &&
        !categories[category].functions.includes(functionName || "(anonymous)")
      ) {
        categories[category].functions.push(functionName || "(anonymous)");
        categories[category].functionCount += 1;
      }

      // Aggregate function stats
      const existing = functionStats.get(key);
      if (existing) {
        existing.hitCount += hitCount;
        existing.callCount += 1;
      } else {
        functionStats.set(key, {
          name: functionName || "(anonymous)",
          file: url,
          line: lineNumber,
          hitCount,
          selfTime: 0,
          totalTime: 0,
          callCount: 1,
        });
      }
    }

    // Calculate timing from samples
    const samples = this.profile.samples || [];
    const timeDeltas = this.profile.timeDeltas || [];
    const sampleTimes = new Map<number, number>();

    for (let i = 0; i < samples.length; i++) {
      const nodeId = samples[i];
      const delta = timeDeltas[i] || 0;
      sampleTimes.set(nodeId, (sampleTimes.get(nodeId) || 0) + delta);
    }

    // Update function stats with timing
    for (const node of this.profile.nodes) {
      const key = `${node.callFrame.functionName || "(anonymous)"}@${node.callFrame.url}:${node.callFrame.lineNumber}`;
      const stats = functionStats.get(key);
      if (stats) {
        stats.selfTime = (sampleTimes.get(node.id) || 0) / 1000; // Convert to ms
      }
    }

    // Sort by hit count
    const sortedFunctions = Array.from(functionStats.values())
      .filter((f) => f.hitCount > 0)
      .sort((a, b) => b.hitCount - a.hitCount);

    // Calculate step metrics from timing marks
    const stepMetrics: StepMetrics[] = [];
    for (const [stepName, timing] of this.stepTimings) {
      if (timing.end) {
        stepMetrics.push({
          stepName,
          operations: 0, // Would need more granular profiling per step
          timeMs: timing.end - timing.start,
        });
      }
    }

    const durationMs = (this.profile.endTime - this.profile.startTime) / 1000;

    return {
      mode: "sampling",
      totalOperations,
      totalFunctionCalls,
      totalSamples: samples.length,
      durationMs,
      topFunctions: sortedFunctions.slice(
        0,
        Number.parseInt(process.env.PROFILE_TOP_N || "20", 10)
      ),
      byCategory: categories,
      stepMetrics,
    };
  }

  getProfile(): CPUProfile | null {
    return this.profile;
  }
}

// ============================================================================
// Workflow Runner (same as original with profiler hooks)
// ============================================================================

function validateEnv(): {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  scheduleId?: string;
} {
  const workflowId = process.env.WORKFLOW_ID;
  const executionId = process.env.EXECUTION_ID;

  if (!workflowId) {
    console.error("[Runner] WORKFLOW_ID environment variable is required");
    process.exit(1);
  }

  if (!executionId) {
    console.error("[Runner] EXECUTION_ID environment variable is required");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("[Runner] DATABASE_URL environment variable is required");
    process.exit(1);
  }

  let input: Record<string, unknown> = {};
  if (process.env.WORKFLOW_INPUT) {
    try {
      input = JSON.parse(process.env.WORKFLOW_INPUT);
    } catch (error) {
      console.error("[Runner] Failed to parse WORKFLOW_INPUT:", error);
      process.exit(1);
    }
  }

  return {
    workflowId,
    executionId,
    input,
    scheduleId: process.env.SCHEDULE_ID,
  };
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}
const queryClient = postgres(connectionString);
const db = drizzle(queryClient, {
  schema: { workflows, workflowExecutions, workflowSchedules },
});

async function updateExecutionStatus(
  executionId: string,
  status: "running" | "success" | "error",
  result?: { output?: unknown; error?: string }
): Promise<void> {
  const updateData: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };

  if (status === "success" || status === "error") {
    updateData.completedAt = new Date();
  }

  if (result?.output !== undefined) {
    updateData.output = result.output;
  }

  if (result?.error) {
    updateData.error = result.error;
  }

  await db
    .update(workflowExecutions)
    .set(updateData)
    .where(eq(workflowExecutions.id, executionId));
}

function computeNextRunTime(
  cronExpression: string,
  timezone: string
): Date | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(),
      tz: timezone,
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

async function initializeExecutionProgress(
  executionId: string,
  totalSteps: number
): Promise<void> {
  await db
    .update(workflowExecutions)
    .set({
      totalSteps: totalSteps.toString(),
      completedSteps: "0",
      executionTrace: [],
      currentNodeId: null,
      currentNodeName: null,
      lastSuccessfulNodeId: null,
      lastSuccessfulNodeName: null,
    })
    .where(eq(workflowExecutions.id, executionId));
}

async function updateScheduleStatus(
  scheduleId: string,
  status: "success" | "error",
  error?: string
): Promise<void> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    return;
  }

  // KEEP-581: skip interval-mode rows. This profiling script computes
  // nextRunAt by parsing cron_expression, but interval-mode rows hold a
  // fixed `0 0 1 1 *` sentinel there -- parsing it would set
  // next_run_at to "Jan 1 next year", visibly wrong for an "every N
  // minutes" schedule. The production updateScheduleStatus path in
  // lib/schedule-service.ts has the correct interval math; that's what
  // real scheduled runs hit. This profiling runner is invoked manually
  // and isn't on the critical path for schedule timing, so simply log
  // and skip instead of pulling the interval helpers in.
  if (schedule.intervalSeconds !== null) {
    console.warn(
      `[Runner] Schedule ${scheduleId} is in interval mode; ` +
        "skipping nextRunAt update (profiling runner only handles cron-mode rows)"
    );
    return;
  }

  const nextRunAt = computeNextRunTime(
    schedule.cronExpression,
    schedule.timezone
  );
  const runCount =
    status === "success"
      ? String(Number(schedule.runCount || "0") + 1)
      : schedule.runCount;

  await db
    .update(workflowSchedules)
    .set({
      lastRunAt: new Date(),
      lastStatus: status,
      lastError: status === "error" ? error : null,
      nextRunAt,
      runCount,
      updatedAt: new Date(),
    })
    .where(eq(workflowSchedules.id, scheduleId));
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatProfileSummary(summary: ProfileSummary): string {
  const lines: string[] = [];

  const modeLabel = summary.mode === "precise" ? "PRECISE" : "SAMPLING";
  const countLabel = summary.mode === "precise" ? "calls" : "hits";

  lines.push(`\n${"=".repeat(60)}`);
  lines.push(`WORKFLOW EXECUTION PROFILE [${modeLabel}]`);
  lines.push(`${"=".repeat(60)}`);

  lines.push("\n📊 SUMMARY");

  if (summary.mode === "precise") {
    lines.push(
      `   Total function calls:    ${summary.totalOperations.toLocaleString()} (exact)`
    );
    lines.push(
      `   Unique functions:        ${summary.totalFunctionCalls.toLocaleString()}`
    );
  } else {
    lines.push(
      `   Total samples:           ${summary.totalSamples.toLocaleString()}`
    );
    lines.push(
      `   Total function hits:     ${summary.totalOperations.toLocaleString()} (statistical)`
    );
    lines.push(
      `   Unique functions:        ${summary.totalFunctionCalls.toLocaleString()}`
    );
    lines.push(
      `   Duration:                ${summary.durationMs.toFixed(2)}ms`
    );
  }

  lines.push(`\n📁 BY CATEGORY (${countLabel})`);
  for (const [category, stats] of Object.entries(summary.byCategory)) {
    if (stats.hitCount > 0) {
      const pct = ((stats.hitCount / summary.totalOperations) * 100).toFixed(1);
      lines.push(
        `   ${category.padEnd(20)} ${stats.hitCount.toLocaleString().padStart(10)} ${countLabel} (${pct}%) - ${stats.functionCount} functions`
      );
    }
  }

  if (process.env.PROFILE_DETAIL === "true") {
    lines.push(`\n🔥 TOP FUNCTIONS BY ${countLabel.toUpperCase()}`);
    for (let i = 0; i < summary.topFunctions.length; i++) {
      const fn = summary.topFunctions[i];
      const shortFile = fn.file.split("/").slice(-2).join("/") || "(native)";
      lines.push(
        `   ${(i + 1).toString().padStart(2)}. ${fn.name.padEnd(40)} ${fn.hitCount.toLocaleString().padStart(8)} ${countLabel}  ${shortFile}:${fn.line}`
      );
    }
  }

  if (summary.stepMetrics.length > 0) {
    lines.push("\n⏱️  STEP TIMINGS");
    for (const step of summary.stepMetrics) {
      lines.push(`   ${step.stepName.padEnd(40)} ${step.timeMs.toFixed(2)}ms`);
    }
  }

  lines.push(`\n${"=".repeat(60)}`);

  return lines.join("\n");
}

// ============================================================================
// Main
// ============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Workflow execution requires sequential setup and error handling
async function main(): Promise<void> {
  const preciseMode = process.env.PRECISE_COVERAGE === "true";
  const profiler = new WorkflowProfiler(preciseMode);
  const startTime = Date.now();
  const { workflowId, executionId, input, scheduleId } = validateEnv();

  const modeLabel = preciseMode ? "PRECISE" : "SAMPLING";
  console.log(`[Runner] Starting profiled workflow execution [${modeLabel}]`);
  console.log(`[Runner] Workflow ID: ${workflowId}`);
  console.log(`[Runner] Execution ID: ${executionId}`);

  // Start profiling
  await profiler.start();

  try {
    await updateExecutionStatus(executionId, "running");

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    console.log(`[Runner] Loaded workflow: ${workflow.name || workflowId}`);

    // Resolve organization name for log filtering
    let organizationName: string | undefined;
    if (workflow.organizationId) {
      const [org] = await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, workflow.organizationId))
        .limit(1);
      organizationName = org?.name;
    }

    const nodes = workflow.nodes as WorkflowNode[];
    const edges = workflow.edges as WorkflowEdge[];
    const validation = await validateWorkflowIntegrations(
      nodes,
      workflow.userId
    );

    if (!validation.valid) {
      throw new Error(
        `Workflow contains invalid integration references: ${validation.invalidIds?.join(", ")}`
      );
    }

    const totalSteps = calculateTotalSteps(nodes, edges);
    console.log(`[Runner] Total steps: ${totalSteps}`);
    await initializeExecutionProgress(executionId, totalSteps);

    // Mark workflow execution start
    profiler.markStepStart("workflow-execution");

    console.log("[Runner] Executing workflow...");
    const result = await executeWorkflow({
      nodes,
      edges: workflow.edges as WorkflowEdge[],
      triggerInput: input,
      executionId,
      workflowId,
      organizationId: workflow.organizationId ?? undefined,
      organizationName,
    });

    profiler.markStepEnd("workflow-execution");

    const duration = Date.now() - startTime;
    console.log(`[Runner] Workflow completed in ${duration}ms`);
    console.log(`[Runner] Success: ${result.success}`);

    if (result.success) {
      await updateExecutionStatus(executionId, "success", {
        output: result.outputs,
      });
      if (scheduleId) {
        await updateScheduleStatus(scheduleId, "success");
      }
      console.log("[Runner] Execution completed successfully");
    } else {
      const errorMessage =
        result.error ||
        Object.values(result.results || {}).find((r) => !r.success)?.error ||
        "Unknown error";

      await updateExecutionStatus(executionId, "error", {
        error: errorMessage,
        output: result.outputs,
      });

      if (scheduleId) {
        await updateScheduleStatus(scheduleId, "error", errorMessage);
      }

      console.error("[Runner] Execution failed:", errorMessage);
      process.exitCode = 1;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    console.error(`[Runner] Fatal error after ${duration}ms:`, errorMessage);

    try {
      await updateExecutionStatus(executionId, "error", {
        error: errorMessage,
      });
      if (scheduleId) {
        await updateScheduleStatus(scheduleId, "error", errorMessage);
      }
    } catch (updateError) {
      console.error("[Runner] Failed to update execution status:", updateError);
    }

    process.exitCode = 1;
  } finally {
    // Stop profiling and analyze
    await profiler.stop();
    const summary = profiler.analyze();

    // Output summary
    console.log(formatProfileSummary(summary));

    // Optionally write to file
    if (process.env.PROFILE_OUTPUT) {
      const profileData = {
        summary,
        rawProfile: profiler.getProfile(),
      };
      writeFileSync(
        process.env.PROFILE_OUTPUT,
        JSON.stringify(profileData, null, 2)
      );
      console.log(`[Profiler] Profile saved to ${process.env.PROFILE_OUTPUT}`);
    }

    await queryClient.end();
    console.log("[Runner] Database connection closed");
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error("[Runner] Unhandled error:", error);
    process.exit(1);
  });
