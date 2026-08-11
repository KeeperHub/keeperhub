import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let mockRunningCount = 0;

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ count: mockRunningCount }])),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: {
    status: "status",
  },
  directExecutions: {
    status: "status",
    organizationId: "organization_id",
    network: "network",
    createdAt: "created_at",
  },
}));

import {
  checkConcurrencyLimit,
  checkDirectExecutionConcurrency,
} from "@/app/api/execute/_lib/concurrency-limit";

describe("checkConcurrencyLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunningCount = 0;
    Reflect.deleteProperty(process.env, "MAX_CONCURRENT_WORKFLOW_EXECUTIONS");
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "MAX_CONCURRENT_WORKFLOW_EXECUTIONS");
  });

  it("allows execution when running count is below default limit", async () => {
    mockRunningCount = 100;

    const result = await checkConcurrencyLimit();

    expect(result).toEqual({ allowed: true });
  });

  it("rejects execution when running count meets default limit", async () => {
    mockRunningCount = 500;

    const result = await checkConcurrencyLimit();

    expect(result).toEqual({ allowed: false, running: 500, limit: 500 });
  });

  it("rejects execution when running count exceeds default limit", async () => {
    mockRunningCount = 600;

    const result = await checkConcurrencyLimit();

    expect(result).toEqual({ allowed: false, running: 600, limit: 500 });
  });

  it("allows execution when count is zero", async () => {
    mockRunningCount = 0;

    const result = await checkConcurrencyLimit();

    expect(result).toEqual({ allowed: true });
  });

  it("uses custom limit from env var", async () => {
    process.env.MAX_CONCURRENT_WORKFLOW_EXECUTIONS = "10";
    vi.resetModules();
    const { checkConcurrencyLimit: freshCheck } = await import(
      "@/app/api/execute/_lib/concurrency-limit"
    );
    mockRunningCount = 10;

    const result = await freshCheck();

    expect(result).toEqual({ allowed: false, running: 10, limit: 10 });
  });

  it("allows when below custom limit", async () => {
    process.env.MAX_CONCURRENT_WORKFLOW_EXECUTIONS = "10";
    vi.resetModules();
    const { checkConcurrencyLimit: freshCheck } = await import(
      "@/app/api/execute/_lib/concurrency-limit"
    );
    mockRunningCount = 9;

    const result = await freshCheck();

    expect(result).toEqual({ allowed: true });
  });

  it("falls back to default when env var is not a number", async () => {
    process.env.MAX_CONCURRENT_WORKFLOW_EXECUTIONS = "abc";
    vi.resetModules();
    const { checkConcurrencyLimit: freshCheck } = await import(
      "@/app/api/execute/_lib/concurrency-limit"
    );
    mockRunningCount = 499;

    const result = await freshCheck();

    expect(result).toEqual({ allowed: true });
  });
});

describe("checkDirectExecutionConcurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunningCount = 0;
    Reflect.deleteProperty(process.env, "MAX_CONCURRENT_DIRECT_EXECUTIONS");
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "MAX_CONCURRENT_DIRECT_EXECUTIONS");
  });

  it("allows when the org's in-flight count is below the default limit", async () => {
    mockRunningCount = 99;

    const result = await checkDirectExecutionConcurrency("org_1");

    expect(result).toEqual({ allowed: true });
  });

  it("rejects when the org's in-flight count meets the default limit", async () => {
    mockRunningCount = 100;

    const result = await checkDirectExecutionConcurrency("org_1");

    expect(result).toEqual({ allowed: false, running: 100, limit: 100 });
  });

  it("uses a custom limit from MAX_CONCURRENT_DIRECT_EXECUTIONS", async () => {
    process.env.MAX_CONCURRENT_DIRECT_EXECUTIONS = "5";
    vi.resetModules();
    const { checkDirectExecutionConcurrency: freshCheck } = await import(
      "@/app/api/execute/_lib/concurrency-limit"
    );
    mockRunningCount = 5;

    const result = await freshCheck("org_1");

    expect(result).toEqual({ allowed: false, running: 5, limit: 5 });
  });
});
