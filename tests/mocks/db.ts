import { vi } from "vitest";

export type MockWorkflow = {
  id: string;
  userId: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  createdAt: Date;
  updatedAt: Date;
};

export type MockWorkflowSchedule = {
  id: string;
  workflowId: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  nextRunAt: Date | null;
  runCount: string;
  createdAt: Date;
  updatedAt: Date;
};

export type MockWorkflowExecution = {
  id: string;
  workflowId: string;
  userId: string;
  status: "running" | "completed" | "error";
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
};

export function createMockDb() {
  const mockDb = {
    query: {
      workflows: {
        findFirst: vi.fn<() => Promise<MockWorkflow | undefined>>(),
        findMany: vi.fn<() => Promise<MockWorkflow[]>>(),
      },
      workflowSchedules: {
        findFirst: vi.fn<() => Promise<MockWorkflowSchedule | undefined>>(),
        findMany: vi.fn<() => Promise<MockWorkflowSchedule[]>>(),
      },
      workflowExecutions: {
        findFirst: vi.fn<() => Promise<MockWorkflowExecution | undefined>>(),
        findMany: vi.fn<() => Promise<MockWorkflowExecution[]>>(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  };

  return mockDb;
}

export function createMockWorkflow(
  overrides: Partial<MockWorkflow> = {}
): MockWorkflow {
  return {
    id: "wf_test123",
    userId: "user_test456",
    name: "Test Workflow",
    nodes: [],
    edges: [],
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

export function createMockSchedule(
  overrides: Partial<MockWorkflowSchedule> = {}
): MockWorkflowSchedule {
  return {
    id: "sched_test789",
    workflowId: "wf_test123",
    cronExpression: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    nextRunAt: new Date("2024-01-02T09:00:00Z"),
    runCount: "0",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

export function createMockExecution(
  overrides: Partial<MockWorkflowExecution> = {}
): MockWorkflowExecution {
  return {
    id: "exec_testabc",
    workflowId: "wf_test123",
    userId: "user_test456",
    status: "running",
    input: {},
    output: null,
    error: null,
    startedAt: new Date("2024-01-01T09:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}
