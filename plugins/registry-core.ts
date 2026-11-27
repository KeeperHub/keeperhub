import type { IntegrationType } from "@/lib/types/integration";
import { withRpcSelectionField } from "@/lib/workflow/rpc-selection-field";
import type { IntegrationPlugin, PluginAction } from "./registry";

// Lives in its own module so plugins/registry.ts can statically
// `import "@/plugins"` without a TDZ on this Map during circular module
// resolution. Individual plugin index files import registerIntegration
// from here directly to keep the load graph linear.
export const integrationRegistry = new Map<
  IntegrationType,
  IntegrationPlugin
>();

export function registerIntegration(plugin: IntegrationPlugin): void {
  integrationRegistry.set(plugin.type, plugin);
}

const derivedActions = new WeakSet<PluginAction>();

// Fields derived from an action's own are added on read, once per action, so
// an action added to an integration after it registered gets them too.
function withDerivedFields(plugin: IntegrationPlugin): IntegrationPlugin {
  for (const action of plugin.actions) {
    if (!derivedActions.has(action)) {
      action.configFields = withRpcSelectionField(action.configFields);
      derivedActions.add(action);
    }
  }
  return plugin;
}

export function registeredIntegration(
  type: IntegrationType
): IntegrationPlugin | undefined {
  const plugin = integrationRegistry.get(type);
  return plugin && withDerivedFields(plugin);
}

export function registeredIntegrations(): IntegrationPlugin[] {
  return Array.from(integrationRegistry.values(), withDerivedFields);
}
