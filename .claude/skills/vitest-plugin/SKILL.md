---
name: vitest-plugin
description: >-
  Generate Vitest unit tests for KeeperHub plugin step files. Use when asked to
  "write tests for", "test this step", "generate tests", or "add unit tests"
  for any file in plugins/*/steps/.
version: 0.1.0
---

# Vitest Plugin Step Test Generator

Generate a complete, passing Vitest unit test for a KeeperHub plugin step file.

## Workflow

### Step 1: Identify the step file

Accept a path argument or find the step file from conversation context. The step file lives at `plugins/{plugin}/steps/{step-name}.ts`.

If a corresponding `-core.ts` file exists (e.g., `read-contract-core.ts` for `read-contract.ts`), read both files -- the core file contains shared logic that the step file imports.

### Step 2: Analyze the step file

Read the step file and extract:

- **Exported step function name** (e.g., `checkBalanceStep`)
- **Exported input/output types** (e.g., `CheckBalanceInput`, `CheckBalanceResult`)
- **External dependencies** -- imports from `@/lib/`, `ethers`, `drizzle-orm`, third-party packages
- **Internal helper functions** -- module-scoped functions called by the step handler
- **Wrappers** -- whether it uses `withStepLogging`, `withPluginMetrics`
- **Database usage** -- whether it queries `db` (select, query, insert, update)
- **Plugin name and action name** -- from `withPluginMetrics` call or `_integrationType` export

### Step 3: Generate the test file

Create `tests/unit/{step-name}.test.ts` with the following structure:

#### a) Standard mock boilerplate (MUST appear before any imports of the step file)

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    query: {
      explorerConfigs: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
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

#### b) Dependency-specific mocks

For each external dependency found in step 2, add a targeted mock. Common patterns:

**RPC resolution (`@/lib/rpc`):**
```typescript
const mockGetChainIdFromNetwork = vi.fn();
const mockResolveRpcConfig = vi.fn();

vi.mock("@/lib/rpc", () => ({
  getChainIdFromNetwork: (...args: unknown[]) => mockGetChainIdFromNetwork(...args),
  resolveRpcConfig: (...args: unknown[]) => mockResolveRpcConfig(...args),
}));
```

**Ethers (`ethers`):**
```typescript
vi.mock("ethers", () => ({
  ethers: {
    isAddress: vi.fn().mockReturnValue(true),
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getBalance: vi.fn().mockResolvedValue(BigInt("1000000000000000000")),
    })),
    formatEther: vi.fn().mockReturnValue("1.0"),
    Contract: vi.fn().mockImplementation(() => ({})),
  },
}));
```

**Credential fetcher (`@/lib/credential-fetcher`):**
```typescript
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
}));
```

**Explorer (`@/lib/explorer`):**
```typescript
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: vi.fn().mockReturnValue("https://etherscan.io/address/0x..."),
  getTxUrl: vi.fn().mockReturnValue("https://etherscan.io/tx/0x..."),
}));
```

**Utils (`@/lib/utils`):**
```typescript
vi.mock("@/lib/utils", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
```

#### c) Import the SUT (system under test) after all mocks

```typescript
import { stepFunctionName } from "@/plugins/{plugin}/steps/{step-name}";
import type { InputType } from "@/plugins/{plugin}/steps/{step-name}";
```

#### d) Test helper functions

```typescript
function makeInput(overrides: Partial<InputType> = {}): InputType {
  return {
    // Default valid values for all required fields
    network: "ethereum",
    address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    _context: { executionId: "test-exec-id" },
    _nodeId: "test-node",
    ...overrides,
  };
}

async function runStep(overrides: Partial<InputType> = {}) {
  return stepFunctionName(makeInput(overrides));
}

async function expectSuccess(overrides: Partial<InputType> = {}) {
  const result = await runStep(overrides);
  expect(result.success).toBe(true);
  return result as Extract<typeof result, { success: true }>;
}

async function expectFailure(overrides: Partial<InputType> = {}) {
  const result = await runStep(overrides);
  expect(result.success).toBe(false);
  return result as Extract<typeof result, { success: false }>;
}
```

#### e) Test groups (nested describe blocks)

```typescript
describe("{stepFunctionName}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset common mocks to default happy-path values
    mockGetChainIdFromNetwork.mockReturnValue(1);
    mockResolveRpcConfig.mockResolvedValue({
      primaryRpcUrl: "https://rpc.example.com",
      source: "default",
    });
  });

  describe("validation", () => {
    it("should reject missing required field", async () => {
      // ...
    });

    it("should reject invalid address format", async () => {
      // ...
    });
  });

  describe("execution", () => {
    it("should succeed with valid input", async () => {
      const result = await expectSuccess();
      expect(result.someField).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should handle RPC failure gracefully", async () => {
      mockResolveRpcConfig.mockRejectedValue(new Error("RPC unavailable"));
      const result = await expectFailure();
      expect(result.error).toContain("RPC unavailable");
    });
  });
});
```

### Step 4: Run the tests

```bash
pnpm test:unit tests/unit/{step-name}.test.ts
```

Verify all tests pass.

### Step 5: Fix any failures

If tests fail, read the error output and fix. Common issues:

- **Mock not matching actual import path** -- check exact import in step file
- **Step function returning different shape** -- re-read step file return types
- **Missing mock for transitive dependency** -- the step file imports a module that imports another; mock the leaf dependency
- **`vi.mock` order** -- all `vi.mock()` calls must appear before importing the step file
- **Global setup conflict** -- `tests/setup.ts` provides some default mocks for `@/lib/db`; your file-level mock overrides it, but ensure they are compatible

## Rules

- NEVER import the step file before `vi.mock()` calls -- Vitest hoists mocks but import order matters for clarity and correctness
- ALWAYS mock `server-only` -- step files import it and it throws in test environment
- ALWAYS mock `withStepLogging` as a pass-through -- it wraps the step function
- ALWAYS mock `withPluginMetrics` as a pass-through -- it wraps the step function
- Use `vi.fn()` for functions you need to spy on or configure per-test; use plain mock objects for static data
- Test file location: `tests/unit/` directory, NOT co-located with the step file
- Follow the project lint rules: block statements, no `.forEach()`, explicit types, `for...of` loops
- Do NOT add lint ignore comments unless absolutely necessary
- Each test should follow Arrange-Act-Assert pattern
- One concept per `it()` block
- Descriptive test names: "should reject empty address" not "test validation"

## Reference Files

Read these files for patterns and context:

- `tests/unit/batch-read-contract.test.ts` -- canonical example of a comprehensive step test
- `plugins/web3/steps/check-balance.ts` -- simple step to understand anatomy
- `plugins/web3/steps/batch-read-contract.ts` -- complex step with multiple modes
- `plugins/web3/steps/read-contract-core.ts` -- core-file pattern example
- `vitest.config.mts` -- test configuration (aliases, setup file, exclusions)
- `tests/setup.ts` -- global test setup (provides some default mocks for `@/lib/db`)
