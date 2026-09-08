<overview>
Custom workflow plugins provide integrations with external services and internal infrastructure for the KeeperHub workflow builder.

- All custom plugins go in `plugins/`
- Each plugin has a directory: `plugins/[plugin-name]/`
- `pnpm discover-plugins` auto-generates `plugins/index.ts`, `lib/step-registry.ts`, `lib/codegen-registry.ts`
- Three plugin variants: credential-based (external API), system plugin (pure logic), infrastructure plugin (uses internal infra)
</overview>

<directory_structure>
Exact file layout for a plugin:

```
plugins/[plugin-name]/
  index.ts          # Plugin definition + registerIntegration()
  icon.tsx          # SVG icon component
  credentials.ts    # Credential type (skip if requiresCredentials: false)
  test.ts           # Connection test function
  steps/
    [action-slug].ts  # One file per action
```
</directory_structure>

<file_templates>

INDEX.TS TEMPLATE:
```typescript
import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry";
import { PluginNameIcon } from "./icon";

const pluginNamePlugin: IntegrationPlugin = {
  type: "plugin-name",           // kebab-case, matches folder name
  label: "Plugin Name",          // Display name
  description: "Brief description",
  icon: PluginNameIcon,
  requiresCredentials: true,     // false if no credentials needed
  formFields: [
    {
      id: "apiKey",
      label: "API Key",
      type: "password",           // "password" | "text" | "url" | "checkbox"
      placeholder: "...",
      configKey: "apiKey",
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
      slug: "action-slug",
      label: "Action Label",
      description: "What it does",
      category: "Plugin Name",
      stepFunction: "actionSlugStep",
      stepImportPath: "action-slug",
      requiresCredentials: true,
      outputFields: [
        { field: "success", description: "Whether the action succeeded" },
        { field: "result", description: "The action result" },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "inputField",
          label: "Input Field",
          type: "template-input",
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

STEP FILE TEMPLATE (CREDENTIAL-BASED):
```typescript
import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { safeFetch } from "@/lib/safe-fetch";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { PluginNameCredentials } from "../credentials";

type ActionSlugResult =
  | { success: true; result: string }
  | { success: false; error: string };

export type ActionSlugCoreInput = {
  inputField: string;
};

export type ActionSlugInput = StepInput &
  ActionSlugCoreInput & {
    integrationId?: string;
  };

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
    // Use safeFetch. NO SDK dependencies, and egress goes through the SSRF guard
    const response = await safeFetch("https://api.example.com/endpoint", {
      plugin: "plugin-name",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ field: input.inputField }),
    });

    if (!response.ok) {
      return { success: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    return { success: true, result: JSON.stringify(data) };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function actionSlugStep(input: ActionSlugInput): Promise<ActionSlugResult> {
  "use step";

  const credentials = await fetchCredentials<PluginNameCredentials>(input);

  return await withPluginMetrics(
    "plugin-name",
    "action-slug",
    async () => await withStepLogging("action-slug", input, () => stepHandler(input, credentials))
  );
}

export const _integrationType = "plugin-name";
```

STEP FILE TEMPLATE (SYSTEM PLUGIN -- no credentials):
```typescript
import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

type ActionSlugResult =
  | { success: true; result: string }
  | { success: false; error: string };

export type ActionSlugCoreInput = {
  inputField: string;
};

export type ActionSlugInput = StepInput & ActionSlugCoreInput;

async function stepHandler(input: ActionSlugCoreInput): Promise<ActionSlugResult> {
  try {
    // Pure logic -- no credentials needed
    return { success: true, result: input.inputField };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function actionSlugStep(input: ActionSlugInput): Promise<ActionSlugResult> {
  "use step";

  return await withPluginMetrics(
    "plugin-name",
    "action-slug",
    async () => await withStepLogging("action-slug", input, () => stepHandler(input))
  );
}

export const _integrationType = "plugin-name";
```

CREDENTIALS.TS TEMPLATE:
```typescript
export type PluginNameCredentials = {
  PLUGIN_NAME_API_KEY?: string;
};
```

TEST.TS TEMPLATE:
```typescript
import type { PluginNameCredentials } from "./credentials";

export async function testPluginName(
  credentials: PluginNameCredentials
): Promise<{ success: boolean; error?: string }> {
  const apiKey = credentials.PLUGIN_NAME_API_KEY;

  if (!apiKey) {
    return { success: false, error: "API key is required" };
  }

  try {
    // Connection-test files (test.ts) are reachable from the client-bundled
    // plugin registry and cannot import the server-only safe-fetch.ts, so use
    // the raw fetch global here. Step files use safeFetch.
    const response = await fetch("https://api.example.com/me", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      return { success: false, error: `API returned ${response.status}` };
    }

    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: String(error) };
  }
}
```

ICON.TSX TEMPLATE:
```tsx
export function PluginNameIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-label="Plugin Name"
    >
      <title>Plugin Name</title>
      {/* SVG paths */}
    </svg>
  );
}
```
</file_templates>

<config_field_types>
All available config field types:

- `template-input`: Single-line, supports `{{NodeName.field}}` variables
- `template-textarea`: Multi-line, supports `{{NodeName.field}}` variables
- `text`: Plain text input
- `number`: Numeric input (supports min)
- `select`: Dropdown (needs options array)
- `chain-select`: Dynamic chain selector (chainTypeFilter: "evm" for EVM chains)
- `abi-with-auto-fetch`: ABI textarea with Etherscan auto-fetch (needs contractAddressField, networkField, contractInteractionType)
- `abi-function-select`: Function picker from ABI (needs abiField, optional functionFilter: "read"|"write")
- `abi-function-args`: Dynamic args based on selected function (needs abiField, abiFunctionField)
- `token-select`: Token selector (needs networkField)
- `abi-event-select`: Event picker from ABI (needs abiField)
- `schema-builder`: Structured output schema builder
- Conditional fields: `{ key: "field", showWhen: { field: "otherField", equals: "value" } }`
- Field groups (collapsible): `{ type: "group", label: "Advanced", defaultExpanded: false, fields: [...] }`
</config_field_types>

<naming_conventions>
Exact naming rules:

- Plugin folder/type: kebab-case (`my-plugin`)
- Plugin variable: camelCase (`myPluginPlugin`)
- Step function: camelCaseStep (`myActionStep`)
- Credential type: PascalCaseCredentials (`MyPluginCredentials`)
- Test function: testPascalCase (`testMyPlugin`)
- Icon component: PascalCaseIcon (`MyPluginIcon`)
- Env vars: SCREAMING_SNAKE_CASE (`MY_PLUGIN_API_KEY`)
</naming_conventions>

<plugin_variants>
Three variants with their characteristics:

1. CREDENTIAL-BASED PLUGIN (external API) -- pattern: discord, sendgrid
   - requiresCredentials: true, formFields with envVar mappings, credentials.ts, test.ts
   - stepHandler receives credentials as second parameter

2. SYSTEM PLUGIN (pure logic) -- pattern: loop/iterate
   - requiresCredentials: false, formFields: [], no credentials.ts
   - stepHandler takes only input, no credentials

3. INFRASTRUCTURE PLUGIN (uses internal infra) -- pattern: web3
   - requiresCredentials: false at plugin level, true per write-action
   - Uses RPC/ethers.js for blockchain interaction
</plugin_variants>

<bundler_constraints>
CRITICAL "use step" bundler rules (violations break production builds):

1. NEVER EXPORT FUNCTIONS from files containing "use step"
   - Only safe exports: the step function itself, `export const _integrationType`, type exports
   - Exporting any other function/value causes bundler to pull ALL transitive deps into runtime

2. SHARING LOGIC BETWEEN STEP FILES: extract to `*-core.ts` file WITHOUT "use step", both step files import from it

3. NO NODE.JS-ONLY DEPENDENCIES: no Vercel AI SDK, use `safeFetch` from `@/lib/safe-fetch` (pass `{ plugin }`) instead. Raw `fetch`/`axios`/`http.request` under `plugins/` fails the CI egress guard

4. Security-critical steps: set `stepFunction.maxRetries = 0` after function definition (fail-safe, not fail-open)
</bundler_constraints>

<registration>
Post-creation steps:

1. `pnpm discover-plugins` -- auto-generates plugins/index.ts, lib/step-registry.ts
2. `pnpm check` -- lint check
3. `pnpm type-check` -- TypeScript validation
</registration>

<critical_rules>
Production rules (violations break the build):

1. Use `safeFetch` (from `@/lib/safe-fetch`, with `{ plugin }`) not SDKs or raw `fetch`. Routes egress through the SSRF guard and avoids Node.js-only transitive deps
2. All step files must start with `import "server-only";`
3. Entry point must have `"use step";` directive
4. Must export `_integrationType` constant matching plugin type
5. Wrap with `withPluginMetrics` AND `withStepLogging` (see discord/steps/send-message.ts as reference)
6. No emojis in code or comments
7. Plugins in plugins/, protocols in protocols/
8. Security-critical steps must set `maxRetries = 0`
</critical_rules>

<documentation_structure>
ALWAYS create documentation when adding a new plugin or feature. This is a required step in the creation workflow.

Format for `docs/plugins/[plugin-name].md`:

- Frontmatter with title and description
- H1, brief description paragraph
- Actions table (Action, Description)
- Setup section (if credentials needed)
- Per-action H2 sections with Inputs, Outputs, When to use, Example workflow

Also update:
- `docs/plugins/_meta.json` -- add plugin entry in alphabetical order
- `docs/plugins/overview.md` -- add row to Available Plugins table
</documentation_structure>
