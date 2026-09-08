import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMemberLimit } = vi.hoisted(() => ({
  mockMemberLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: mockMemberLimit,
          })),
        })),
        where: vi.fn(() => ({
          limit: mockMemberLimit,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  member: {
    id: "id",
    organizationId: "organizationId",
    userId: "userId",
  },
  users: {
    id: "id",
    deactivatedAt: "deactivated_at",
  },
}));

import { getWorkflowAccess } from "@/lib/workflow/access";

const ORG_WORKFLOW = {
  id: "wf-org",
  userId: "creator",
  organizationId: "org-1",
  isAnonymous: false,
  visibility: "private",
};

describe("getWorkflowAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not grant full access to an org workflow creator whose subject org is null (no same-org context, no membership query)", async () => {
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: null,
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isCreatorWithCurrentAccess).toBe(false);
    // The org context does not match the workflow's org, so the membership
    // query is never made -- the creator confers no authority on its own.
    expect(mockMemberLimit).not.toHaveBeenCalled();
  });

  it("grants full access to a creator acting in the workflow's org who is still a member", async () => {
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: "org-1",
    });

    expect(access.hasFullAccess).toBe(true);
    expect(access.isCreatorWithCurrentAccess).toBe(true);
    expect(mockMemberLimit).toHaveBeenCalledOnce();
  });

  it("does not grant API-key same-org access when the key creator is no longer an org member", async () => {
    mockMemberLimit.mockResolvedValue([]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: "org-1",
      authMethod: "api-key",
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isSameOrg).toBe(false);
    expect(mockMemberLimit).toHaveBeenCalledOnce();
  });

  it("grants API-key same-org access when the key creator is still an org member", async () => {
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: "org-1",
      authMethod: "api-key",
    });

    expect(access.hasFullAccess).toBe(true);
    expect(access.isSameOrg).toBe(true);
  });

  it("does not grant session same-org access when the active org context is stale", async () => {
    mockMemberLimit.mockResolvedValue([]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "member-user",
      organizationId: "org-1",
      authMethod: "session",
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isSameOrg).toBe(false);
    expect(mockMemberLimit).toHaveBeenCalledOnce();
  });

  it("does not grant OAuth same-org access when the token org context is stale", async () => {
    mockMemberLimit.mockResolvedValue([]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "member-user",
      organizationId: "org-1",
      authMethod: "oauth",
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isSameOrg).toBe(false);
    expect(mockMemberLimit).toHaveBeenCalledOnce();
  });

  it("grants session same-org access when the user is still an org member", async () => {
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "member-user",
      organizationId: "org-1",
      authMethod: "session",
    });

    expect(access.hasFullAccess).toBe(true);
    expect(access.isSameOrg).toBe(true);
  });

  it("does not grant legacy creatorless API-key access without a user to prove membership", async () => {
    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: null,
      organizationId: "org-1",
      authMethod: "api-key",
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isSameOrg).toBe(false);
    expect(mockMemberLimit).not.toHaveBeenCalled();
  });

  it("does not grant internal execution access when the subject org does not match the workflow's org", async () => {
    mockMemberLimit.mockResolvedValue([{ id: "member-1" }]);

    const access = await getWorkflowAccess(ORG_WORKFLOW, {
      userId: "creator",
      organizationId: null,
      authMethod: "internal",
    });

    expect(access.hasFullAccess).toBe(false);
    expect(access.isCreatorWithCurrentAccess).toBe(false);
    // Org context mismatch -- no membership query, no access.
    expect(mockMemberLimit).not.toHaveBeenCalled();
  });

  it("denies access to an anonymous (null-org) workflow even for its creator", async () => {
    const access = await getWorkflowAccess(
      {
        ...ORG_WORKFLOW,
        id: "wf-anon",
        organizationId: null,
        isAnonymous: true,
      },
      {
        userId: "creator",
        organizationId: null,
      }
    );

    // A null-org workflow has no owning org, so the org-membership rule can
    // never be satisfied -- the creator gets no authority on its own.
    expect(access.hasFullAccess).toBe(false);
    expect(access.isSameOrg).toBe(false);
    expect(access.isCreatorWithCurrentAccess).toBe(false);
    expect(mockMemberLimit).not.toHaveBeenCalled();
  });
});
