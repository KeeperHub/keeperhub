import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "kha_test-admin-secret-12345";
const TEST_USER_ID = "user-abc123";
const TEST_EMAIL = "blocked@example.com";
const TEST_NAME = "Blocked User";

type MockUser =
  | {
      id: string;
      name: string | null;
      email: string;
      deactivatedAt: Date | null;
    }
  | undefined;

let mockUserForSelect: MockUser;
let mockShouldThrow = false;

vi.mock("@/lib/db", () => {
  const txMock = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() =>
            Promise.resolve(mockUserForSelect ? [mockUserForSelect] : [])
          ),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  };

  return {
    db: {
      transaction: vi.fn((fn: (tx: typeof txMock) => Promise<unknown>) => {
        if (mockShouldThrow) {
          throw new Error("DB error");
        }
        return fn(txMock);
      }),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  users: {
    id: "id",
    name: "name",
    email: "email",
    deactivatedAt: "deactivated_at",
    updatedAt: "updated_at",
  },
  sessions: { userId: "user_id" },
  organizationApiKeys: { createdBy: "created_by", revokedAt: "revoked_at" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database", EXTERNAL_SERVICE: "external_service" },
  logSystemError: vi.fn(),
}));

const sendAccountDeactivatedEmail = vi.fn(
  (_data: { email: string; name?: string | null }) => Promise.resolve(true)
);
vi.mock("@/lib/email", () => ({
  sendAccountDeactivatedEmail: (data: {
    email: string;
    name?: string | null;
  }) => sendAccountDeactivatedEmail(data),
}));

import { POST } from "@/app/api/admin/users/[userId]/deactivate/route";

function makeRequest(token?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(
    "http://localhost/api/admin/users/user-abc123/deactivate",
    {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  );
}

function makeContext(userId = TEST_USER_ID) {
  return { params: Promise.resolve({ userId }) };
}

describe("POST /api/admin/users/:userId/deactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserForSelect = undefined;
    mockShouldThrow = false;
    vi.stubEnv("KH_ADMIN_SECRET", TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("authentication", () => {
    it("returns 401 when KH_ADMIN_SECRET is not configured", async () => {
      vi.stubEnv("KH_ADMIN_SECRET", "");
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header is missing", async () => {
      const res = await POST(makeRequest(), makeContext());
      expect(res.status).toBe(401);
    });

    it("returns 401 when secret is wrong", async () => {
      const res = await POST(makeRequest("wrong-secret"), makeContext());
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Invalid KH admin secret");
    });
  });

  describe("happy path", () => {
    it("deactivates the user and returns userId and deactivatedAt", async () => {
      mockUserForSelect = {
        id: TEST_USER_ID,
        name: TEST_NAME,
        email: TEST_EMAIL,
        deactivatedAt: null,
      };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.userId).toBe(TEST_USER_ID);
      expect(data.deactivatedAt).toBeDefined();
      expect(data.email).toBeUndefined();
    });
  });

  describe("deactivation email", () => {
    it("emails the user once on a successful deactivation", async () => {
      mockUserForSelect = {
        id: TEST_USER_ID,
        name: TEST_NAME,
        email: TEST_EMAIL,
        deactivatedAt: null,
      };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(200);
      expect(sendAccountDeactivatedEmail).toHaveBeenCalledTimes(1);
      expect(sendAccountDeactivatedEmail).toHaveBeenCalledWith({
        email: TEST_EMAIL,
        name: TEST_NAME,
      });
    });

    it("does not email when notifyUser is false", async () => {
      mockUserForSelect = {
        id: TEST_USER_ID,
        name: TEST_NAME,
        email: TEST_EMAIL,
        deactivatedAt: null,
      };

      const res = await POST(
        makeRequest(TEST_SECRET, { notifyUser: false }),
        makeContext()
      );
      expect(res.status).toBe(200);
      expect(sendAccountDeactivatedEmail).not.toHaveBeenCalled();
    });

    it("does not email on a 404", async () => {
      mockUserForSelect = undefined;
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(404);
      expect(sendAccountDeactivatedEmail).not.toHaveBeenCalled();
    });

    it("does not email on a 409", async () => {
      mockUserForSelect = {
        id: TEST_USER_ID,
        name: TEST_NAME,
        email: TEST_EMAIL,
        deactivatedAt: new Date(),
      };
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(409);
      expect(sendAccountDeactivatedEmail).not.toHaveBeenCalled();
    });

    it("still returns 200 when the email send throws", async () => {
      mockUserForSelect = {
        id: TEST_USER_ID,
        name: TEST_NAME,
        email: TEST_EMAIL,
        deactivatedAt: null,
      };
      sendAccountDeactivatedEmail.mockRejectedValueOnce(
        new Error("sendgrid down")
      );

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.userId).toBe(TEST_USER_ID);
    });
  });

  describe("error cases", () => {
    it("returns 404 when user does not exist", async () => {
      mockUserForSelect = undefined;

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("User not found");
    });

    it("returns 409 when user is already deactivated", async () => {
      mockUserForSelect = {
        id: TEST_USER_ID,
        name: TEST_NAME,
        email: TEST_EMAIL,
        deactivatedAt: new Date(),
      };

      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe("User is already deactivated");
    });

    it("returns 500 on database error", async () => {
      mockShouldThrow = true;
      const res = await POST(makeRequest(TEST_SECRET), makeContext());
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Internal server error");
    });
  });
});
