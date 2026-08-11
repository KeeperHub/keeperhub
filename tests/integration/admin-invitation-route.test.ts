import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEY = "kha_test-secret-key-12345";
const TEST_EMAIL = "test@techops.services";

let mockResult: unknown[] = [];
let mockShouldThrow = false;

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => {
              if (mockShouldThrow) {
                return Promise.reject(new Error("DB connection failed"));
              }
              return Promise.resolve(mockResult);
            }),
          })),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  invitation: {
    id: "id",
    email: "email",
    status: "status",
    expiresAt: "expiresAt",
  },
}));

import { GET } from "@/app/api/admin/test/invitation/route.staging";

function createRequest(email?: string, token?: string): Request {
  const url = new URL("http://localhost:3000/api/admin/test/invitation");
  if (email) {
    url.searchParams.set("email", email);
  }
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(url.toString(), { headers });
}

describe("GET /api/admin/test/invitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResult = [];
    mockShouldThrow = false;
    process.env.TEST_API_KEY = TEST_KEY;
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("authentication", () => {
    it("should return 401 when Bearer token is missing", async () => {
      const response = await GET(createRequest(TEST_EMAIL));
      expect(response.status).toBe(401);
    });

    it("should return 401 when Bearer token is wrong", async () => {
      const response = await GET(createRequest(TEST_EMAIL, "wrong-key"));
      expect(response.status).toBe(401);
    });
  });

  describe("input validation", () => {
    it("should return 400 when email param is missing", async () => {
      const response = await GET(createRequest(undefined, TEST_KEY));
      expect(response.status).toBe(400);
    });

    it("should return 403 for non-techops email", async () => {
      const response = await GET(createRequest("user@gmail.com", TEST_KEY));
      expect(response.status).toBe(403);
    });
  });

  describe("invitation lookup", () => {
    it("should return invitation ID when found", async () => {
      mockResult = [{ id: "inv-uuid-123" }];
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.invitationId).toBe("inv-uuid-123");
    });

    it("should return 404 when no pending invitation exists", async () => {
      mockResult = [];
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("No pending invitation found");
    });

    it("should return 500 on database error", async () => {
      mockShouldThrow = true;
      const response = await GET(createRequest(TEST_EMAIL, TEST_KEY));
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Internal server error");
    });
  });
});
