---
description: Create a new KeeperHub workflow plugin with full architecture knowledge. Builds production-ready plugins following exact codebase conventions.
argument-hint: [plugin-name] [description]
---

<objective>
Create a new KeeperHub workflow plugin. If arguments provided, use $1 as plugin name and $2 as description. Otherwise, ask what plugin to build.

This command has deep knowledge of the KeeperHub plugin architecture and creates plugins that follow every convention exactly -- correct imports, file structure, type patterns, metrics wrapping, and registration.
</objective>

<context>
Existing keeperhub plugins: !`ls plugins/`
Available integration types: @lib/types/integration.ts
Current plugin index: @plugins/index.ts
Plugin registry: @plugins/registry.ts
CLAUDE.md rules: @CLAUDE.md
Plugin development guide: @plugins/AGENTS.md
</context>

<architecture>
CRITICAL: Follow these conventions EXACTLY. All custom plugins go in `plugins/`.

DIRECTORY STRUCTURE for each plugin:
```
plugins/[plugin-name]/
  index.ts          # Plugin definition + registerIntegration()
  icon.tsx          # SVG icon component
  credentials.ts    # Credential type (skip if requiresCredentials: false)
  test.ts           # Connection test function
  steps/
    [action-slug].ts  # One file per action
```

FILE 1 - index.ts:
```typescript
import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry";
import { PluginNameIcon } from "./icon";

const pluginNamePlugin: IntegrationPlugin = {
  type: "plugin-name",           // kebab-case, matches folder name
  label: "Plugin Name",          // Display name
  description: "Brief description",

  icon: PluginNameIcon,

  // Set false if plugin works without credentials (e.g., web3 read-only)
  requiresCredentials: true,

  // Set true if only one connection per user (e.g., web3 wallet)
  // singleConnection: true,

  formFields: [
    {
      id: "apiKey",
      label: "API Key",
      type: "password",           // "password" | "text" | "url" | "checkbox"
      placeholder: "...",
      configKey: "apiKey",        // Key stored in database
      envVar: "PLUGIN_NAME_API_KEY",
      helpText: "Description",
      helpLink: { text: "Get key", url: "https://..." },
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testPluginName } = await import("./test");
      return testPluginName;
    },
  },

  actions: [
    {
      slug: "action-slug",       // kebab-case
      label: "Action Label",
      description: "What it does",
      category: "Plugin Name",   // Groups in UI
      stepFunction: "actionSlugStep",    // camelCase + "Step"
      stepImportPath: "action-slug",     // matches filename in steps/
      requiresCredentials: true,         // Override plugin-level per action
      outputFields: [
        { field: "success", description: "Whether the action succeeded" },
        { field: "result", description: "The action result" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "inputField",
          label: "Input Field",
          type: "template-input",  // Supports {{NodeName.field}} syntax
          placeholder: "Value or {{NodeName.field}}",
          example: "example value",
          required: true,
        },
      ],
    },
  ],
};

registerIntegration(pluginNamePlugin);
export default pluginNamePlugin;
```

FILE 2 - steps/[action-slug].ts (TWO-LAYER PATTERN):
```typescript
import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { PluginNameCredentials } from "../credentials";

// Result type - ALWAYS use discriminated union
type ActionSlugResult =
  | { success: true; result: string }
  | { success: false; error: string };

// Core input - matches configFields keys
export type ActionSlugCoreInput = {
  inputField: string;
};

// Full input - extends StepInput, adds integrationId
export type ActionSlugInput = StepInput &
  ActionSlugCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - receives credentials as parameter
 * Separation enables code export / reuse
 */
async function stepHandler(
  input: ActionSlugCoreInput,
  credentials: PluginNameCredentials
): Promise<ActionSlugResult> {
  const apiKey = credentials.PLUGIN_NAME_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: "PLUGIN_NAME_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  try {
    // Use safeFetch - NO SDK dependencies, and egress goes through the SSRF guard
    const response = await safeFetch("https://api.example.com/endpoint", {
      plugin: "plugin-name",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ field: input.inputField }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.message || `HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    return { success: true, result: data.id };
  } catch (error) {
    return {
      success: false,
      error: `Failed: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Entry point - fetches credentials, wraps with logging + metrics
 */
export async function actionSlugStep(
  input: ActionSlugInput
): Promise<ActionSlugResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withPluginMetrics(
    {
      pluginName: "plugin-name",
      actionName: "action-slug",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input, credentials))
  );
}

export const _integrationType = "plugin-name";
```

FILE 2b - steps/[action-slug].ts (SYSTEM PLUGIN VARIANT -- no credentials):
Use this pattern for system/utility plugins that don't call external APIs.
```typescript
import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

// Result type - ALWAYS use discriminated union
type ActionSlugResult =
  | { success: true; result: string }
  | { success: false; error: string };

// Core input - matches configFields keys
export type ActionSlugCoreInput = {
  inputField: string;
};

// Full input - extends StepInput (no integrationId needed)
export type ActionSlugInput = StepInput & ActionSlugCoreInput;

/**
 * Core logic - no credentials parameter
 */
async function stepHandler(
  input: ActionSlugCoreInput
): Promise<ActionSlugResult> {
  try {
    // Pure computation, no external API call
    const result = processInput(input.inputField);
    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: `Failed: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Entry point - NO fetchCredentials, just logging + metrics
 */
export async function actionSlugStep(
  input: ActionSlugInput
): Promise<ActionSlugResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "plugin-name",
      actionName: "action-slug",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}
// Set maxRetries = 0 for security-critical steps (fail-safe, not fail-open)
// actionSlugStep.maxRetries = 0;

export const _integrationType = "plugin-name";
```

FILE 3 - credentials.ts:
```typescript
export type PluginNameCredentials = {
  PLUGIN_NAME_API_KEY?: string;
};
```

FILE 4 - test.ts:
```typescript
export function testPluginName(
  _credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  return Promise.resolve({ success: true });
}
```

FILE 5 - icon.tsx:
```typescript
export function PluginNameIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Plugin Name logo"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Plugin Name</title>
      <path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z" />
    </svg>
  );
}
```

CONFIG FIELD TYPES:
- template-input: Single-line, supports {{NodeName.field}} variables
- template-textarea: Multi-line, supports {{NodeName.field}} variables
- text: Plain text input
- number: Numeric input (supports min)
- select: Dropdown (needs options array)
- chain-select: Dynamic chain selector (use chainTypeFilter: "evm" for EVM chains)
- abi-with-auto-fetch: ABI textarea with Etherscan auto-fetch (needs contractAddressField, networkField, contractInteractionType)
- abi-function-select: Function picker from ABI (needs abiField, optional functionFilter: "read"|"write")
- abi-function-args: Dynamic args based on selected function (needs abiField, abiFunctionField)
- token-select: Token selector (needs networkField)
- abi-event-select: Event picker from ABI (needs abiField)
- schema-builder: Structured output schema builder

CONDITIONAL FIELDS:
```typescript
{ key: "field", showWhen: { field: "otherField", equals: "value" } }
```

FIELD GROUPS (collapsible):
```typescript
{ type: "group", label: "Advanced", defaultExpanded: false, fields: [...] }
```

NAMING CONVENTIONS:
- Plugin folder/type: kebab-case (my-plugin)
- Plugin variable: camelCase (myPluginPlugin)
- Step function: camelCaseStep (myActionStep)
- Credential type: PascalCaseCredentials (MyPluginCredentials)
- Test function: testPascalCase (testMyPlugin)
- Icon component: PascalCaseIcon (MyPluginIcon)
- Env vars: SCREAMING_SNAKE_CASE (MY_PLUGIN_API_KEY)

PLUGIN VARIANTS:

1. CREDENTIAL-BASED PLUGIN (external API):
   Pattern: discord, sendgrid, telegram
   - requiresCredentials: true (or per-action)
   - formFields with envVar mappings
   - credentials.ts with typed credential interface
   - test.ts validates API key
   - Step handler receives credentials parameter

2. SYSTEM PLUGIN (no credentials, pure logic):
   Pattern: loop/iterate (from marketplace)
   - requiresCredentials: false
   - formFields: [] (empty)
   - No credentials.ts needed
   - Step handler takes only input, no credentials
   - Good for: decode-calldata, state/store, math/delta, block-context

3. INFRASTRUCTURE PLUGIN (uses existing infra, no external credentials):
   Pattern: web3 (read-only actions like check-balance)
   - requiresCredentials: false at plugin level, true per write-action
   - Uses internal infrastructure (RPC, chain config, ethers.js)
   - Credentials fetched from user's wallet, not API keys

PER-ACTION CREDENTIAL OVERRIDE:
requiresCredentials can be set at plugin level AND overridden per action.
Example: web3 plugin has requiresCredentials: false but transfer-funds action
has requiresCredentials: true (needs wallet). Read-only actions skip credentials.

RETRY BEHAVIOR:
- Default: steps retry on failure
- Security/guard steps: Set `stepFunction.maxRetries = 0` after the function definition
  This ensures fail-safe behavior (block on error, don't silently retry)
  Example:
  ```typescript
  export async function decodeCalldataStep(input: DecodeCalldataInput): Promise<DecodeCalldataResult> {
    "use step";
    // ... implementation
  }
  decodeCalldataStep.maxRetries = 0;
  ```
- Use maxRetries = 0 for: security assessment, guard/gate steps, calldata decoding,
  risk scoring, approval gates -- any step where a retry could mask a real threat

CRITICAL RULES:
1. Use safeFetch (from @/lib/safe-fetch, with { plugin }) not SDKs or raw fetch - routes
   egress through the SSRF guard, reduces supply chain attack surface, and avoids Node.js-only
   transitive deps that break the workflow bundler (see WORKFLOW BUNDLER below). Raw
   fetch/axios/http.request under plugins/ fails the CI egress guard.
2. All step files must start with `import "server-only";`
3. Entry point must have `"use step";` directive
4. Must export `_integrationType` constant matching plugin type
5. Wrap with withPluginMetrics AND withStepLogging (see discord/steps/send-message.ts)
6. No emojis in code or comments
7. Plugins in plugins/, protocols in protocols/
8. Security-critical steps must set maxRetries = 0 (fail-safe, not fail-open)

WORKFLOW BUNDLER CONSTRAINTS ("use step"):
The "use step" directive tells the Workflow DevKit bundler to compile the function for a
restricted runtime (similar to Cloudflare Workers). This has hard constraints:

1. NEVER EXPORT FUNCTIONS from files containing "use step"
   - Exporting a non-step function from a "use step" file causes the bundler to pull ALL
     transitive dependencies into the workflow runtime bundle
   - This breaks the build if any transitive dep uses Node.js modules (@solana/web3.js,
     nanoid, etc.) or has incompatible package.json export conditions
   - Type exports are fine (erased at compile time), only function/value exports break things
   - The step function itself and `_integrationType` are the only valid exports

2. SHARING LOGIC BETWEEN STEP FILES
   If two steps need shared logic (e.g., assess-risk calls decode-calldata internally):
   - Extract shared logic into a separate `*-core.ts` file WITHOUT "use step"
   - Both step files import from the core file
   - Example: `decode-calldata-core.ts` exports `decodeCalldata()`, imported by both
     `decode-calldata.ts` and `assess-risk.ts`
   - NEVER import a function from one step file into another step file

3. NO NODE.JS-ONLY DEPENDENCIES in step files
   - The Vercel AI SDK (`ai`, `@ai-sdk/*`) has Node.js transitive deps; use safeFetch instead
   - Heavy libraries like ethers.js work IF used only internally (not re-exported)
   - When in doubt, use safeFetch calls to external APIs
   - If a library works in Cloudflare Workers, it works in "use step" context

4. CORRECT EXPORT PATTERN for step files:
   ```typescript
   // ONLY these exports are safe in a "use step" file:
   export type { SomeType } from "./some-core";     // Type re-exports: OK
   export type MyInput = StepInput & MyCoreInput;    // Type definitions: OK
   export async function myStep(input) { ... }       // The step function: OK
   export const _integrationType = "plugin-name";    // Integration type: OK

   // NEVER export these from a "use step" file:
   // export function helperFunction() { ... }       // BREAKS BUILD
   // export const someUtil = ...                     // BREAKS BUILD (if non-trivial)
   ```
</architecture>

<workflow_plugin_proposals>
These are the plugin categories identified for KeeperHub's roadmap. Reference these when building plugins:

SECURITY PLUGINS:
- security/parse-advisory: Parse vulnerability advisories into structured data
- security/decode-calldata: Decode transaction calldata against known ABIs
- security/match-contracts: Match vulnerability patterns against contract addresses
- security/contract-risk-score: Evaluate contract risk (age, verification, audit, TVL)
- security/strategy-validator: Compare actions against allowed strategy

AI PLUGINS:
- ai/assess-risk: LLM-powered risk assessment with confidence scores

WEB3 EXTENSIONS:
- web3/simulate-tx: Fork-simulate transactions to see state changes
- web3/flashbots-submit: Submit defensive transactions via Flashbots Protect
- web3/batch-read: Call same function across dynamic list of addresses
- web3/is-contract: Check if address is contract or EOA
- web3/iterate-mapping: Read sequential mapping entries until revert

SYSTEM PLUGINS:
- state/store + state/recall: Persist data between workflow runs
- state/merge + state/remove: Atomic array operations on persisted state
- system/block-context: Expose current block number, timestamp, base fee
- iterator/for-each: Execute sub-workflow for each item in list
- approval-gate: Human approval step in workflow

UTILITY PLUGINS:
- math/max: Find max/min/sum/avg across array
- math/delta: Calculate percentage change between values
- delay/next-block: Wait for next block(s)
</workflow_plugin_proposals>

<process>
1. DETERMINE PLUGIN DETAILS
   - If $1 and $2 provided, use them as plugin name and description
   - If only $1 provided, use as name and ask for description
   - If neither provided, ask the user what plugin they want to build
   - Convert name to kebab-case for folder/type
   - Decide: NEW plugin or NEW ACTION on existing plugin?
     - If the action shares infrastructure with an existing plugin (e.g., web3 chain config,
       RPC, ethers.js), add it as a new action on that plugin instead of creating a new one
     - Example: decode-calldata is a web3 action, not a new "security" plugin

2. DETERMINE PLUGIN VARIANT
   - Credential-based (external API): needs formFields, credentials.ts, test.ts
   - System plugin (pure logic): no credentials, formFields: [], skip credentials.ts
   - Infrastructure plugin (uses internal infra): like web3 read actions
   - Determine if security-critical (maxRetries = 0)

3. DETERMINE ACTIONS
   - Ask the user what actions this plugin should have
   - For each action, determine: slug, label, description, config fields, output fields
   - Check if the plugin needs credentials or is credential-free
   - For web3 plugins, use chain-select, abi-with-auto-fetch, etc.
   - For security steps, plan for maxRetries = 0

4. CREATE PLUGIN FILES
   If NEW PLUGIN:
   - Create directory: `plugins/[name]/`
   - Create `plugins/[name]/steps/` directory
   - Write index.ts following the exact pattern above
   - Write icon.tsx (use a Lucide icon or placeholder SVG)
   - Write credentials.ts (if requiresCredentials: true, skip for system plugins)
   - Write test.ts
   - Write steps/[action-slug].ts for each action
   If ADDING ACTION TO EXISTING PLUGIN:
   - Read existing plugin's index.ts to understand current patterns
   - Add new action entry to the actions array in index.ts
   - Create new step file: steps/[action-slug].ts
   - Follow the same patterns as sibling steps in that plugin

5. REGISTER PLUGIN
   - Run: `pnpm discover-plugins`
   - This auto-generates: plugins/index.ts, lib/types/integration.ts, lib/step-registry.ts

6. VALIDATE
   - Run: `pnpm type-check`
   - Run: `pnpm check`
   - If errors, run `pnpm fix` for auto-fixable issues, then fix remaining manually
   - Re-run checks until clean

7. DOCUMENT PLUGIN
   Every plugin/action MUST be documented in the docs site at `docs/plugins/`.

   If NEW PLUGIN:
   - Create `docs/plugins/[plugin-name].md` following this template:
     ```markdown
     ---
     title: "[Plugin Name] Plugin"
     description: "One-line description of what this plugin does."
     ---

     # [Plugin Name] Plugin

     Brief description (1-2 sentences).

     ## Actions

     | Action | Description |
     |--------|-------------|
     | Action Name | What it does |

     ## Setup

     (Connection/credential setup steps, skip if no credentials needed)

     ## [Action Name]

     What this action does (1-2 sentences).

     **Inputs:** List of inputs

     **Outputs:** `field1`, `field2`, `error`

     **When to use:** 2-3 concrete use cases.

     **Example workflow:**
     ```
     Trigger
       -> Action 1
       -> Condition
       -> Action 2: "message with {{variables}}"
     ```
     ```
   - Add the plugin to `docs/plugins/_meta.json` (maintains sidebar order)
   - Add the route to `docs-site/middleware.ts` VALID_ROUTES if it is a new top-level route

   If ADDING ACTION TO EXISTING PLUGIN:
   - Read the existing `docs/plugins/[plugin-name].md`
   - Add the new action section following the same pattern as sibling actions
   - Add it to the Actions table at the top
   - Include: description, inputs, outputs, when to use, example workflow

   Documentation rules:
   - Keep descriptions concise (no walls of text)
   - Example workflows use pseudo-code (not full JSON), showing the flow visually
   - "When to use" should list concrete scenarios, not abstract capabilities
   - Include `{{NodeName.field}}` variable syntax in examples to show data flow
   - Security actions should note fail-safe behavior (maxRetries = 0)

8. REPORT
   - Show the user what was created
   - List all files (created or modified)
   - Show the action IDs (e.g., "my-plugin/my-action")
   - Note the docs page URL (e.g., /plugins/my-plugin)
   - Suggest next steps (implement API logic, test in UI)
</process>

<verification>
Before completing, verify:
- All plugin files exist in plugins/[name]/
- `pnpm discover-plugins` ran successfully (plugin appears in plugins/index.ts)
- `pnpm type-check` passes with no errors
- `pnpm check` passes with no lint errors
- Plugin type appears in lib/types/integration.ts
- Step functions appear in lib/step-registry.ts
- Documentation exists at docs/plugins/[plugin-name].md (or action added to existing doc)
- Plugin appears in docs/plugins/_meta.json
</verification>

<success_criteria>
- Plugin directory created at plugins/[name]/
- All required files present: index.ts, icon.tsx, test.ts, steps/*.ts
- credentials.ts present if plugin requires credentials
- Plugin registered via pnpm discover-plugins
- TypeScript compilation passes
- Lint checks pass
- Plugin follows all naming conventions
- Step functions use two-layer pattern with withPluginMetrics + withStepLogging
- All imports use correct paths (@/plugins/registry, @/lib/metrics/...)
- No SDK dependencies - uses safeFetch (from @/lib/safe-fetch) for all egress
- No emojis in any files
- Documentation page created/updated at docs/plugins/ with actions table, inputs, outputs, example workflows, and when-to-use guidance
</success_criteria>
