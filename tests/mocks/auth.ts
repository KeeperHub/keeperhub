import { vi } from "vitest";

export type MockSession = {
  user: {
    id: string;
    email: string;
    name: string;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
};

export function createMockSession(
  overrides: Partial<MockSession> = {}
): MockSession {
  return {
    user: {
      id: "user_test456",
      email: "test@example.com",
      name: "Test User",
      ...overrides.user,
    },
    session: {
      id: "session_test789",
      userId: "user_test456",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ...overrides.session,
    },
  };
}

export function createMockAuth() {
  return {
    api: {
      getSession: vi.fn<() => Promise<MockSession | null>>(),
    },
  };
}
