# Plugin Development Standards

This file supplements the root CLAUDE.md with plugin-specific rules. All root CLAUDE.md rules still apply (lint, type-check, no emojis, etc.).

## Plugin Structure

Every plugin follows this layout. Reference `web3/` as the canonical example.

```
plugins/{plugin-name}/
  index.ts          # Plugin definition (IntegrationPlugin), registers actions
  icon.tsx          # Plugin icon component
  steps/            # Step files (one per action)
    {action}.ts     # Step file with "use step" directive
    {action}-core.ts  # (optional) Shared logic without "use step"
  credentials.ts    # (optional) Credential configuration
  test.ts           # (optional) Integration connection test
```

The `index.ts` file exports an `IntegrationPlugin` object with `type`, `label`, `description`, `icon`, `actions[]`, and calls `registerIntegration()`.

Each action in `actions[]` defines: `slug`, `label`, `description`, `category`, `stepFunction`, `stepImportPath`, `configFields[]`, `outputFields[]`.

## Step File Rules (CRITICAL)

The `"use step"` directive marks a file for workflow bundler processing. Violating these rules breaks the production build.

1. **NEVER export functions from step files** -- only the step function itself, `_integrationType`, and type exports are allowed. Exporting a helper function causes the bundler to pull ALL transitive dependencies into the workflow runtime, breaking the build.

2. **To share logic between step files**: extract into a `*-core.ts` file (no `"use step"` directive), then import from both step files. See `read-contract-core.ts`, `decode-calldata-core.ts`, `transfer-funds-core.ts` as examples.

3. **No Node.js-only SDKs** in step files (AI SDK, etc.); use `safeFetch` from `@/lib/safe-fetch` for HTTP calls. Pass `{ plugin: "<name>" }` so the SSRF guard sees every outbound request; raw `fetch`/`axios`/`http.request` under `plugins/` is rejected by the `Forbid raw network egress in plugins` CI check.

4. **The core-file pattern**:
   - `{action}.ts` -- contains `"use step"`, exports the step function + `_integrationType` + types
   - `{action}-core.ts` -- contains shared logic, exports functions freely, NO `"use step"`

## Step File Anatomy

Standard structure of a step file:

```typescript
import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

// Type definitions (exported)
export type MyActionInput = StepInput & {
  network: string;
  address: string;
};

type MyActionResult =
  | { success: true; data: string }
  | { success: false; error: string };

// Helper functions (module-scoped, NOT exported)
async function internalHelper(id: string): Promise<string | undefined> {
  // ...
}

// Internal handler (NOT exported)
async function stepHandler(input: MyActionInput): Promise<MyActionResult> {
  // Validation, RPC calls, business logic
}

// Main step function (exported)
export async function myActionStep(
  input: MyActionInput
): Promise<MyActionResult> {
  "use step";

  return runPluginStep(
    { pluginName: "my-plugin", actionName: "my-action" },
    input,
    stepHandler
  );
}

export const _integrationType = "my-plugin";
```

Key points:
- `import "server-only"` at the top
- Types are exported, helper functions are NOT exported
- Step function uses `"use step"` directive inside the function body
- Wrapped in `runPluginStep` (the standard epilogue: `withPluginMetrics` wrapping `withStepLogging`, with `executionId` read from `input._context`)
- Security-critical steps: set `stepFunction.maxRetries = 0` on the action definition

Two deliberate exceptions to `runPluginStep`:

- **Value-cap steps** (write-contract, transfer-funds, and the other steps that use `withStepValueCap`) compose `withPluginMetrics` / `withStepLogging` / `withStepValueCap` manually because the cap's reserve/settle ordering relative to logging matters. Follow the comments in those files; do not convert them to `runPluginStep` without preserving that ordering.
- **Some older steps** call `withStepLogging` alone and report no plugin metrics. That is a gap, not a pattern to copy - new steps use `runPluginStep`.

## Signer Routing + RPC Failover

Write steps (anything calling `signer.sendTransaction` / `contract.method({...})`) MUST route through `resolveSignerMode(organizationId, chainId)` and dispatch the three branches: `safe-role` → `executeContractCallAsRole`, `safe` → `executeContractCallAsSafe`, `eoa` → adapter direct. Gate ERC-4337 sponsorship to `eoa` only — bundlers swap `msg.sender`. Canonical example: `transfer-token-core.ts:308+`.

Reads MUST NOT call `resolveSignerMode` but SHOULD route every chain call through `rpcManager.executeWithFailover((p) => ...)` so primary-RPC blips fail over to the chain's fallback.

## Plugin Registration

After adding or modifying plugins, run:

```bash
pnpm discover-plugins
```

This generates auto-generated registry files (`lib/step-registry.ts`, `lib/codegen-registry.ts`) which are gitignored.

## Testing

Unit tests go in `tests/unit/{step-name}.test.ts`. See `tests/unit/batch-read-contract.test.ts` as the canonical test example.

Required mocks (must appear BEFORE importing the step file):

```typescript
vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  runPluginStep: (
    _options: unknown,
    input: unknown,
    fn: (input: unknown) => unknown
  ) => fn(input),
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

// Only needed for steps that compose metrics manually (value-cap steps).
vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", NETWORK_RPC: "network_rpc", EXTERNAL_SERVICE: "external_service" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
  explorerConfigs: { id: "id", chainId: "chainId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
}));
```

Add dependency-specific mocks as needed (e.g., `@/lib/rpc`, `ethers`, `@/lib/credential-fetcher`).

Run tests:

```bash
pnpm test:unit tests/unit/{step-name}.test.ts
```

## Lint Rules

These Biome rules apply to all plugin code:

- Use block statements (no single-line `if (x) return y;`)
- Cognitive complexity max is 15 -- extract helper functions to reduce
- Regex literals inside functions trigger `useTopLevelRegex` -- use module-level constants
- Async functions must use `await` somewhere
- Use `for...of` instead of `.forEach()`
- Use explicit types for function parameters and return values
- Remove `console.log` from production code (existing console.log in step files is legacy)

Run before committing:

```bash
pnpm check      # Lint check
pnpm type-check # TypeScript validation
pnpm fix        # Auto-fix lint issues
```
