import type { IntegrationType } from "@/lib/types/integration";
import type { IntegrationPlugin } from "./registry";

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
