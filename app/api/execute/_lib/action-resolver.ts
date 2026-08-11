import "server-only";

import {
  getActionLabel,
  getStepImporter,
  type StepImporter,
} from "@/lib/step-registry";
import { findActionById } from "@/plugins/registry";

export type ResolvedAction = {
  actionType: string;
  label: string;
  importer: StepImporter;
  isPluginAction: boolean;
};

// System actions that don't have plugins -- mirrors the map in workflow-executor
// but only used for the generic node executor (workflow executor has its own copy)
const SYSTEM_ACTIONS: Record<
  string,
  // biome-ignore lint/suspicious/noExplicitAny: Dynamic module import
  { importer: () => Promise<any>; stepFunction: string; label: string }
> = {
  "Database Query": {
    importer: () => import("@/lib/workflow/nodes/database-query/step"),
    stepFunction: "databaseQueryStep",
    label: "Database Query",
  },
  "HTTP Request": {
    importer: () => import("@/lib/workflow/nodes/http-request/step"),
    stepFunction: "httpRequestStep",
    label: "HTTP Request",
  },
  Condition: {
    importer: () => import("@/lib/workflow/nodes/condition/step"),
    stepFunction: "conditionStep",
    label: "Condition",
  },
};

/**
 * Resolve an action type to its step importer and metadata.
 * Checks system actions first, then the plugin registry.
 */
export function resolveAction(actionType: string): ResolvedAction | undefined {
  const systemAction = SYSTEM_ACTIONS[actionType];
  if (systemAction) {
    return {
      actionType,
      label: systemAction.label,
      importer: {
        importer: systemAction.importer,
        stepFunction: systemAction.stepFunction,
      },
      isPluginAction: false,
    };
  }

  const stepImporter = getStepImporter(actionType);
  if (stepImporter) {
    const label = getActionLabel(actionType) ?? actionType;
    return {
      actionType,
      label,
      importer: stepImporter,
      isPluginAction: true,
    };
  }

  // Check plugin registry directly for full action metadata
  const pluginAction = findActionById(actionType);
  if (pluginAction) {
    const resolvedImporter = getStepImporter(pluginAction.id);
    if (resolvedImporter) {
      return {
        actionType: pluginAction.id,
        label: pluginAction.label,
        importer: resolvedImporter,
        isPluginAction: true,
      };
    }
  }

  return undefined;
}
