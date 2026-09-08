/**
 * Plugin Metrics Instrumentation
 *
 * Helper functions to instrument plugin actions with golden signal metrics.
 */

import { createTimer, getMetricsCollector } from "../index";
import { LabelKeys, MetricNames } from "../types";

/**
 * Plugin action context for metrics
 */
export type PluginMetricsContext = {
  pluginName: string;
  actionName: string;
  executionId?: string;
};

/**
 * Record plugin action invocation and completion
 */
export function recordPluginMetrics(options: {
  pluginName: string;
  actionName: string;
  executionId?: string;
  durationMs: number;
  success: boolean;
  error?: string;
}): void {
  const metrics = getMetricsCollector();

  const labels: Record<string, string> = {
    [LabelKeys.PLUGIN_NAME]: options.pluginName,
    [LabelKeys.ACTION_NAME]: options.actionName,
    [LabelKeys.STATUS]: options.success ? "success" : "failure",
  };

  // Record plugin action duration
  metrics.recordLatency(
    MetricNames.PLUGIN_ACTION_DURATION,
    options.durationMs,
    labels
  );

  // Record error if failed
  if (!options.success && options.error) {
    metrics.recordError(
      MetricNames.PLUGIN_ACTION_ERRORS,
      { message: options.error },
      labels
    );
  }
}

/**
 * Wrap a plugin step handler with metrics tracking
 *
 * @example
 * ```typescript
 * export async function sendDiscordMessageStep(input: SendDiscordMessageInput) {
 *   "use step";
 *   return withPluginMetrics(
 *     { pluginName: "discord", actionName: "send-message" },
 *     () => withStepLogging(input, () => stepHandler(input, credentials))
 *   );
 * }
 * ```
 */
export async function withPluginMetrics<T>(
  context: PluginMetricsContext,
  fn: () => Promise<T>
): Promise<T> {
  const metrics = getMetricsCollector();
  const timer = createTimer();

  // Base labels for invocation counter (only plugin_name, action_name)
  const invocationLabels: Record<string, string> = {
    [LabelKeys.PLUGIN_NAME]: context.pluginName,
    [LabelKeys.ACTION_NAME]: context.actionName,
  };

  // Labels for latency/error metrics
  const labels: Record<string, string> = {
    ...invocationLabels,
  };

  // Increment invocation counter (only uses plugin_name, action_name)
  metrics.incrementCounter(
    MetricNames.PLUGIN_INVOCATIONS_TOTAL,
    invocationLabels
  );

  try {
    const result = await fn();

    // Check if result indicates an error (plugin convention)
    const isErrorResult =
      result &&
      typeof result === "object" &&
      "success" in result &&
      (result as { success: boolean }).success === false;

    if (isErrorResult) {
      const errorResult = result as { success: false; error?: string };
      metrics.recordLatency(MetricNames.PLUGIN_ACTION_DURATION, timer(), {
        ...labels,
        [LabelKeys.STATUS]: "failure",
      });
      metrics.recordError(
        MetricNames.PLUGIN_ACTION_ERRORS,
        { message: errorResult.error || "Plugin action failed" },
        labels
      );
    } else {
      metrics.recordLatency(MetricNames.PLUGIN_ACTION_DURATION, timer(), {
        ...labels,
        [LabelKeys.STATUS]: "success",
      });
    }

    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    metrics.recordLatency(MetricNames.PLUGIN_ACTION_DURATION, timer(), {
      ...labels,
      [LabelKeys.STATUS]: "failure",
    });
    metrics.recordError(
      MetricNames.PLUGIN_ACTION_ERRORS,
      error instanceof Error ? error : { message: errorMessage },
      labels
    );

    throw error;
  }
}
