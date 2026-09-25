import type { IntegrationType } from "@/lib/types/integration";
import {
  evaluateShowWhen,
  type ShowWhen,
} from "@/lib/workflow/editor/show-when";
import { LEGACY_ACTION_MAPPINGS } from "./legacy-mappings";
import { integrationRegistry, registerIntegration } from "./registry-core";

// Side-effect import: forces every plugin's index.ts to evaluate (and call
// registerIntegration) before any reader of this module runs. The Map and
// register function live in registry-core to avoid a TDZ during the
// circular load (registry → @/plugins → plugins/* → registry-core).
import "@/plugins";

export { registerIntegration };

/**
 * Select Option
 * Used for select/dropdown fields
 */
export type SelectOption = {
  value: string;
  label: string;
};

/**
 * Base Action Config Field
 * Declarative definition of a config field for an action
 */
export type ActionConfigFieldBase = {
  // Unique key for this field in the config object
  key: string;

  // Human-readable label
  label: string;

  // Field type
  type:
    | "template-input" // TemplateBadgeInput - supports {{variable}}
    | "template-textarea" // TemplateBadgeTextarea - supports {{variable}}
    | "text" // Regular text input
    | "number" // Number input
    | "fail-on-error-switch" // "Fail workflow on error" toggle, shares HTTP Request's default-on resolution; not a generic boolean switch, ignores defaultValue in the renderer
    | "gas-sponsorship-switch" // "Sponsor gas" toggle on a write action; default-on, skips the sponsored route entirely when off
    | "datetime" // Native date + time picker (stores an ISO 8601 string)
    | "select" // Dropdown select
    | "chain-select" // Dynamic chain selector that fetches from /api/chains
    | "schema-builder" // Schema builder for structured output
    | "abi-function-select" // Dynamic dropdown that parses ABI and shows functions
    | "abi-function-args" // Dynamic inputs for function arguments based on selected ABI function
    | "abi-with-auto-fetch" // ABI textarea with automatic fetch from Etherscan
    | "token-select" // Token selector with supported/custom toggle
    | "abi-event-select" // Dynamic dropdown that parses ABI and shows events
    | "abi-event-args" // One input per indexed parameter of the selected event
    | "gas-limit-multiplier" // Gas limit multiplier with chain default display
    | "code-editor" // Monaco-based JavaScript code editor
    | "json-editor" // Monaco-based JSON editor
    | "call-list-builder" // Dynamic list of contract calls for batch operations
    | "args-list-builder" // Dynamic list of argument sets for batch uniform mode
    | "protocol-address" // Address input with checksum validation
    | "protocol-uint" // Unsigned integer input with range validation
    | "protocol-int" // Signed integer input with range validation
    | "protocol-bool" // Boolean select (true/false) with template variable support
    | "protocol-bytes" // Hex input with 0x-prefix validation
    | "protocol-eth-value" // Decimal ETH value input (e.g. 0.1, 1.5)
    | "protocol-array" // Structured scalar array (e.g. uint256[])
    | "protocol-tuple-array" // Structured array of tuple items (e.g. tokenAmounts)
    | "pagerduty-service-select" // Services read live from the node's PagerDuty connection
    | "pagerduty-escalation-policy-select" // Escalation policies read live from that connection
    | "pagerduty-preview" // Read-only payload and incident preview for a PagerDuty node
    | "pagerduty-test-node" // Sends one real alert through the selected service and takes it back
    | "pagerduty-backup-connection-select" // Existing Discord/Slack/Telegram connection used when a page fails
    | "pagerduty-priority-select" // Account incident priorities, read live (REST only)
    | "pagerduty-trigger-node-select" // A Trigger Incident node in this workflow, for the dedup key
    | "pagerduty-from-email-notice"; // Warns when neither the node nor its connection carries a From email

  // For chain-select: filter by chain type - one ("evm") or several (["evm", "solana"])
  chainTypeFilter?: string | string[];

  // For chain-select: restrict to specific chain IDs (e.g., ["1", "8453"])
  allowedChainIds?: string[];

  // Placeholder text
  placeholder?: string;

  // Default value
  defaultValue?: string;

  // For chain-select on write actions: also render private mempool variants
  // (e.g., "Ethereum Mainnet (Flashbots)") for chains with usePrivateMempoolRpc=true.
  // On selection, sets both the network field AND config.usePrivateMempool.
  showPrivateVariants?: boolean;

  // Example value for AI prompt generation
  example?: string;

  /**
   * For a `select`: accept a `{{template}}` in place of one of the options.
   *
   * Off by default, and deliberately so. A select's options are a promise to
   * the step that the value is one of them, and several steps lean on it:
   * robinhood's `side` treats anything that is not "buy" as a sell, tempo's
   * `broadcastMode` turns an unrecognised value into a hold that never fires.
   * Only set this where the step resolves an unknown value to a documented
   * default, and say so in the field's help text.
   */
  allowTemplate?: boolean;

  // For select fields: list of options
  options?: SelectOption[];

  // Number of rows (for textarea)
  rows?: number;

  // For a template-textarea field whose value is JSON: offers a Beautify
  // action in a strip along the top of the field. Named valueFormat rather
  // than format because a plugin's own config can carry a field keyed
  // "format" (data/encode does), and the two would read as the same thing.
  //
  // Set it only where the value is always JSON. On a message body or a
  // line-oriented format there is nothing to reformat and the action would
  // report a parse error; on a field that takes either a bare reference or
  // JSON it is worse than that, because a lone `{{ref}}` formats to itself
  // and the button appears to do nothing at all.
  valueFormat?: "json";

  // Min value (for number fields)
  min?: number;

  max?: number;
  step?: number;
  actionSlug?: string;

  // Whether this field is required (defaults to false)
  required?: boolean;

  // Conditional rendering: only show if another field has a specific value.
  // Use `equals` for single value match, `oneOf` for multiple value match.
  // Use `computed` to gate on a value derived from other config fields at
  // render time (no persistence). Currently supported computations:
  //   - "abiFunctionMutability": parses `abiField` (ABI JSON) and looks up
  //     the stateMutability of the function named by `functionField`.
  // Use `all` to require several predicates at once. A hidden field keeps
  // its stored value, so a field gated on a sibling that is itself hidden
  // needs to gate on the sibling's own condition too.
  showWhen?: ShowWhen;

  // For abi-function-select and abi-event-select: which field contains the ABI JSON
  abiField?: string;

  // For abi-function-select and call-list-builder: filter functions by type ("read" or "write")
  functionFilter?: "read" | "write";

  // For abi-function-args: which field contains the ABI JSON and selected function
  abiFunctionField?: string;

  // For abi-event-args: which field holds the selected event name
  abiEventField?: string;

  // For abi-with-auto-fetch: which field contains the contract address
  contractAddressField?: string;

  // For abi-with-auto-fetch: which field contains the network
  networkField?: string;

  // For abi-with-auto-fetch: "read" or "write" so the node shows the right proxy option label (Read as Proxy / Write as Proxy)
  contractInteractionType?: "read" | "write";

  // For call-list-builder: hide the per-row Network selector (a write batch
  // is single-chain, one signed tx can't span chains, so the field would be
  // visually present but silently ignored)
  hideNetworkColumn?: boolean;

  // Tooltip text shown next to the label via an info icon
  helpTip?: string;

  // Short explanation rendered in muted text below the input, the way the
  // HTTP Request node explains its timeout and retry fields. Prefer this over
  // helpTip when the user should read it without hovering.
  helpText?: string;

  // Whether this field represents an Ethereum address (enables address book support)
  isAddressField?: boolean;

  // External documentation URL shown as "Docs" link in the field tooltip
  docUrl?: string;

  // For protocol-tuple-array: ABI component definitions for the tuple items.
  // Supports 2 levels of nesting (tuple containing tuple) which covers all
  // current protocols. Extend to recursive type if deeper nesting is needed.
  tupleComponents?: Array<{ name: string; type: string; components?: Array<{ name: string; type: string }> }>;

  // For protocol field types: the underlying Solidity type (e.g. "uint256", "tuple[]")
  solidityType?: string;

  // When true, the field is never rendered in the form. Its defaultValue
  // still flows through node-config-panel's default-application logic, so
  // hidden fields can carry config the runtime needs without surfacing to
  // the user (e.g. _protocolMeta).
  hidden?: boolean;
};

/**
 * Config Field Group
 * Groups related fields together in a collapsible section
 */
export type ActionConfigFieldGroup = {
  // Human-readable label for the group
  label: string;

  // Field type (always "group" for groups)
  type: "group";

  // Nested fields within this group
  fields: ActionConfigFieldBase[];

  // Whether the group is expanded by default (defaults to false)
  defaultExpanded?: boolean;
};

/**
 * Action Config Field
 * Can be either a regular field or a group of fields
 */
export type ActionConfigField = ActionConfigFieldBase | ActionConfigFieldGroup;

/**
 * Output Field Definition
 * Describes an output field available for template autocomplete
 */
export type OutputField = {
  field: string;
  description: string;
};

/**
 * Output Display Config
 * Specifies how to render step output in the workflow runs panel
 */
export type OutputDisplayConfig = {
  // Type of display: image renders as img, video renders as video element, url renders in iframe
  type: "image" | "video" | "url";
  // Field name in the step output that contains the displayable value
  field: string;
};

/**
 * Network egress classification for plan gating and SSRF posture.
 *
 *   "user-destination" - user-supplied input (action config or a connection
 *     `url` formField) can determine the host/origin the runner connects to.
 *     This is the generic "make an arbitrary request" capability: it is plan
 *     gated (paid) and its step must route through the SSRF guard.
 *   "fixed-host" - egresses only to a constant origin (a branded third-party
 *     API). User input may flow into the path/query/body but never the host.
 *     Free; still routed through `safeFetch` per the plugin egress CI check.
 *   "none" - performs no outbound network request.
 *
 * Gating keys solely on host control; a fixed-host action that incorporates
 * user input stays free and relies on `safeFetch` for SSRF safety. A
 * misclassification therefore fails safe: the worst case is under-gating
 * (revenue), never an unguarded egress.
 */
export type EgressTier = "user-destination" | "fixed-host" | "none";

/**
 * Action Definition
 * Describes a single action provided by a plugin
 */
export type PluginAction = {
  // Unique slug for this action (e.g., "send-email")
  // Full action ID will be computed as `{integration}/{slug}` (e.g., "resend/send-email")
  slug: string;

  // Per-action override of the plugin-level `egress` classification. Set this
  // only when an action's network reach differs from its plugin's default
  // (e.g. a read-only action in an otherwise fixed-host plugin). When omitted,
  // the action inherits the plugin's `egress`.
  egress?: EgressTier;

  // Human-readable label (e.g., "Send Email")
  label: string;

  // Description of what this action does
  description: string;

  // Category for grouping in UI
  category: string;

  // Step configuration
  stepFunction: string; // Name of the exported function in the step file
  stepImportPath: string; // Path to import from, relative to plugins/[plugin-name]/steps/

  // Config fields for the action (declarative definition)
  configFields: ActionConfigField[];

  // Output fields for template autocomplete (what this action returns)
  outputFields?: OutputField[];

  // Optional JSON-Schema description of the action output. When omitted,
  // list_action_schemas synthesizes one from `outputFields`. Declare this on
  // actions whose output shape is richer than a flat key/description map.
  outputSchema?: Record<string, unknown>;

  // Output display configuration (how to render output in workflow runs panel)
  outputConfig?: OutputDisplayConfig;

  // Whether this specific action requires credentials/integration setup
  // Overrides the plugin-level requiresCredentials if set
  // Useful for plugins with mixed read/write actions (e.g., web3)
  requiresCredentials?: boolean;

  // Override the integration type used for credential/connection checks
  // Useful for protocol actions that use web3 wallet instead of their own credentials
  credentialIntegrationType?: string;

  // Code generation template (the actual template string, not a path)
  // Optional - if not provided, will fall back to auto-generated template
  // from steps that export _exportCore
  codegenTemplate?: string;

  // External documentation URL rendered as a "Docs" link in the action
  // config panel header. Optional; if absent, no link is shown.
  docUrl?: string;
};

/**
 * Integration Plugin Definition
 * All information needed to register a new integration in one place
 */
export type IntegrationPlugin = {
  // Basic info
  type: IntegrationType;
  label: string;
  description: string;

  // Default network egress classification for this plugin's actions. Required
  // so every plugin (and every future one) must declare whether it lets users
  // reach a host of their choosing. Drives plan gating: "user-destination"
  // plugins are paid-gated. Individual actions may override via `egress`.
  egress: EgressTier;

  // Icon component (should be exported from plugins/[name]/icon.tsx)
  icon: React.ComponentType<{ className?: string }>;

  // Whether this plugin requires credentials/integration setup
  // Set to false for plugins that don't need authentication (e.g., webhook)
  // Defaults to true for backward compatibility
  requiresCredentials?: boolean;

  // Whether only one connection is allowed per user
  // Set to true for integrations with unique constraints (e.g., web3 wallet)
  // When true, the "+" button to add more connections will be hidden
  singleConnection?: boolean;

  // Form fields for the integration dialog
  formFields: Array<{
    id: string;
    label: string;
    type: "text" | "password" | "url" | "checkbox";
    placeholder?: string;
    helpText?: string;
    helpLink?: { text: string; url: string };
    configKey: string; // Which key in IntegrationConfig to store the value
    envVar?: string; // Environment variable this field maps to (e.g., "RESEND_API_KEY")
    defaultValue?: string | boolean; // Default value for the field (for checkboxes, use boolean)
    /**
     * Marks this field as part of one of several alternative credentials, only
     * one of which is used. The connection form holds the others shut once one
     * is filled in, so "either this or that" is visible rather than implied.
     */
    exclusiveGroup?: string;
    /** Shown on the divider that opens the group, on its first field. */
    exclusiveGroupLabel?: string;
  }>;

  // Testing configuration (lazy-loaded to avoid bundling Node.js packages in client)
  testConfig?: {
    // Returns a promise that resolves to the test function
    // This allows the test module to be loaded only on the server when needed
    getTestFunction: () => Promise<
      (
        credentials: Record<string, string>
      ) => Promise<{ success: boolean; error?: string }>
    >;
  };

  // Avoid using this field. Plugins should use safeFetch() instead of SDK deps
  // to reduce supply chain attack surface. Only use for codegen if absolutely necessary.
  dependencies?: Record<string, string>;

  // Actions provided by this integration
  actions: PluginAction[];
};

/**
 * Action with full ID
 * Includes the computed full action ID (integration/slug)
 */
export type ActionWithFullId = PluginAction & {
  id: string; // Full action ID: {integration}/{slug}
  integration: IntegrationType;
};

/**
 * Compute full action ID from integration type and action slug
 */
export function computeActionId(
  integrationType: IntegrationType,
  actionSlug: string
): string {
  return `${integrationType}/${actionSlug}`;
}

/**
 * Parse a full action ID into integration type and action slug
 */
export function parseActionId(actionId: string | undefined | null): {
  integration: string;
  slug: string;
} | null {
  if (!actionId || typeof actionId !== "string") {
    return null;
  }
  const parts = actionId.split("/");
  if (parts.length !== 2) {
    return null;
  }
  return { integration: parts[0], slug: parts[1] };
}

/**
 * Get an integration plugin
 */
export function getIntegration(
  type: IntegrationType
): IntegrationPlugin | undefined {
  return integrationRegistry.get(type);
}

/**
 * Get all registered integrations
 */
export function getAllIntegrations(): IntegrationPlugin[] {
  return Array.from(integrationRegistry.values());
}

/**
 * Get all integration types
 */
export function getIntegrationTypes(): IntegrationType[] {
  return Array.from(integrationRegistry.keys());
}

/**
 * Get all actions across all integrations with full IDs
 */
export function getAllActions(): ActionWithFullId[] {
  const actions: ActionWithFullId[] = [];

  for (const plugin of integrationRegistry.values()) {
    for (const action of plugin.actions) {
      actions.push({
        ...action,
        id: computeActionId(plugin.type, action.slug),
        integration: plugin.type,
      });
    }
  }

  return actions;
}

/**
 * Get actions by category
 */
export function getActionsByCategory(): Record<string, ActionWithFullId[]> {
  const categories: Record<string, ActionWithFullId[]> = {};

  for (const plugin of integrationRegistry.values()) {
    for (const action of plugin.actions) {
      if (!categories[action.category]) {
        categories[action.category] = [];
      }
      categories[action.category].push({
        ...action,
        id: computeActionId(plugin.type, action.slug),
        integration: plugin.type,
      });
    }
  }

  return categories;
}

/**
 * Find an action by full ID (e.g., "resend/send-email")
 * Also supports legacy IDs (e.g., "Send Email") for backward compatibility
 */
export function findActionById(
  actionId: string | undefined | null
): ActionWithFullId | undefined {
  if (!actionId) {
    return undefined;
  }

  // First try parsing as a namespaced ID
  const parsed = parseActionId(actionId);
  if (parsed) {
    const plugin = integrationRegistry.get(parsed.integration as IntegrationType);
    if (plugin) {
      const action = plugin.actions.find((a) => a.slug === parsed.slug);
      if (action) {
        return {
          ...action,
          id: actionId,
          integration: plugin.type,
        };
      }
    }
  }

  // Check legacy mappings for backward compatibility
  const mappedId = LEGACY_ACTION_MAPPINGS[actionId];
  if (mappedId) {
    // Recursively look up the mapped ID
    return findActionById(mappedId);
  }

  // Fall back to legacy label-based lookup (exact label match)
  for (const plugin of integrationRegistry.values()) {
    const action = plugin.actions.find((a) => a.label === actionId);
    if (action) {
      return {
        ...action,
        id: computeActionId(plugin.type, action.slug),
        integration: plugin.type,
      };
    }
  }

  return undefined;
}

/**
 * Get integration labels map
 */
export function getIntegrationLabels(): Record<IntegrationType, string> {
  const labels: Record<string, string> = {};
  for (const plugin of integrationRegistry.values()) {
    labels[plugin.type] = plugin.label;
  }
  return labels as Record<IntegrationType, string>;
}

/**
 * Get integration descriptions map
 */
export function getIntegrationDescriptions(): Record<IntegrationType, string> {
  const descriptions: Record<string, string> = {};
  for (const plugin of integrationRegistry.values()) {
    descriptions[plugin.type] = plugin.description;
  }
  return descriptions as Record<IntegrationType, string>;
}

/**
 * Get sorted integration types for dropdowns
 */
export function getSortedIntegrationTypes(): IntegrationType[] {
  return Array.from(integrationRegistry.keys()).sort();
}

/**
 * Get all NPM dependencies across all integrations
 */
export function getAllDependencies(): Record<string, string> {
  const deps: Record<string, string> = {};

  for (const plugin of integrationRegistry.values()) {
    if (plugin.dependencies) {
      Object.assign(deps, plugin.dependencies);
    }
  }

  return deps;
}

/**
 * Get credential mapping for a plugin (auto-generated from formFields)
 */
export function getCredentialMapping(
  plugin: IntegrationPlugin,
  config: Record<string, unknown>
): Record<string, string> {
  const creds: Record<string, string> = {};

  for (const field of plugin.formFields) {
    if (field.envVar && config[field.configKey]) {
      creds[field.envVar] = String(config[field.configKey]);
    }
  }

  return creds;
}

/**
 * Type guard to check if a field is a group
 */
export function isFieldGroup(
  field: ActionConfigField
): field is ActionConfigFieldGroup {
  return field.type === "group";
}

/**
 * Flatten config fields, extracting fields from groups
 * Useful for validation and AI prompt generation
 */
export function flattenConfigFields(
  fields: ActionConfigField[]
): ActionConfigFieldBase[] {
  const result: ActionConfigFieldBase[] = [];

  for (const field of fields) {
    if (isFieldGroup(field)) {
      result.push(...field.fields);
    } else {
      result.push(field);
    }
  }

  return result;
}

/**
 * Field types that render something rather than collect a value.
 *
 * They still belong in `configFields`, because that is what puts them on the
 * node in the right place, but they have no value to seed into an example
 * config and the step never reads their key.
 */
const DISPLAY_ONLY_FIELD_SUFFIXES = [
  "-preview",
  "-test-node",
  "-notice",
] as const;

export function isDisplayOnlyField(type: string | undefined): boolean {
  return (
    type !== undefined &&
    DISPLAY_ONLY_FIELD_SUFFIXES.some((suffix) => type.endsWith(suffix))
  );
}

/**
 * The example config one action contributes to the generation prompt.
 *
 * Exported so a test can assert on what a generated node carries without
 * copying this ladder. A copy cannot fail when the ladder changes, which is
 * the one thing such a test is for.
 */
export function buildExampleConfig(
  actionType: string,
  configFields: ActionConfigField[] | undefined
): Record<string, string | number> {
  const exampleConfig: Record<string, string | number> = { actionType };

  for (const field of flattenConfigFields(configFields ?? [])) {
    // A field that renders a panel rather than collecting a value has
    // nothing to seed. Without this it falls through to the string branch
    // below and the prompt tells the model to emit
    // `"pagerdutyPreview":"Your preview"` - a key the step never reads,
    // in every generated node, and in the system prompt on every call.
    if (isDisplayOnlyField(field.type)) continue;

    // Include a conditional field when its condition holds for the
    // example assembled so far. Fields are visited in declaration order,
    // so a field's dependencies are already in the example.
    if (!evaluateShowWhen(field.showWhen, exampleConfig)) continue;

    // Use example, defaultValue, or a sensible default based on type
    if (field.example !== undefined) {
      exampleConfig[field.key] = field.example;
    } else if (field.defaultValue !== undefined) {
      exampleConfig[field.key] = field.defaultValue;
    } else if (field.type === "number") {
      exampleConfig[field.key] = 10;
    } else if (field.type === "select" && field.options?.[0]) {
      exampleConfig[field.key] = field.options[0].value;
    } else {
      exampleConfig[field.key] = `Your ${field.label.toLowerCase()}`;
    }
  }

  return exampleConfig;
}

/**
 * Generate AI prompt section for all available actions
 * This dynamically builds the action types documentation for the AI
 */
export function generateAIActionPrompts(): string {
  const lines: string[] = [];

  for (const plugin of integrationRegistry.values()) {
    for (const action of plugin.actions) {
      const fullId = computeActionId(plugin.type, action.slug);
      const exampleConfig = buildExampleConfig(fullId, action.configFields);

      lines.push(
        `- ${action.label} (${fullId}): ${JSON.stringify(exampleConfig)}`
      );
    }
  }

  return lines.join("\n");
}
