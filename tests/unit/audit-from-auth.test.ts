import { describe, expect, it } from "vitest";

import {
  auditFromAuth,
  type DualAuthContext,
  UNAUTHENTICATED_AUDIT,
} from "@/lib/middleware/auth-helpers";

const sessionCtx: DualAuthContext = {
  userId: "user-1",
  organizationId: "org-1",
  authMethod: "session",
  apiKeyId: null,
  isAnonymous: false,
};

const apiKeyCtx: DualAuthContext = {
  userId: "user-1",
  organizationId: "org-1",
  authMethod: "api-key",
  apiKeyId: "key-abc",
  isAnonymous: false,
};

const apiKeyCtxNoCreator: DualAuthContext = {
  userId: null,
  organizationId: "org-1",
  authMethod: "api-key",
  apiKeyId: "key-legacy",
  isAnonymous: false,
};

const oauthCtx: DualAuthContext = {
  userId: "user-1",
  organizationId: "org-1",
  authMethod: "oauth",
  apiKeyId: null,
  isAnonymous: false,
};

const errorCtx: DualAuthContext = {
  error: "Unauthorized",
  code: "unauthorized",
  status: 401,
};

describe("auditFromAuth", () => {
  it("emits authMethod=session and omits apiKeyId for session auth", () => {
    expect(auditFromAuth(sessionCtx)).toEqual({ authMethod: "session" });
  });

  it("emits authMethod=api-key with apiKeyId for API-key auth", () => {
    expect(auditFromAuth(apiKeyCtx)).toEqual({
      authMethod: "api-key",
      apiKeyId: "key-abc",
    });
  });

  it("emits authMethod=api-key with apiKeyId even when userId is null (legacy keys)", () => {
    expect(auditFromAuth(apiKeyCtxNoCreator)).toEqual({
      authMethod: "api-key",
      apiKeyId: "key-legacy",
    });
  });

  it("emits authMethod=oauth and omits apiKeyId for OAuth auth", () => {
    expect(auditFromAuth(oauthCtx)).toEqual({ authMethod: "oauth" });
  });

  it("falls back to UNAUTHENTICATED_AUDIT when the context resolved to an error", () => {
    expect(auditFromAuth(errorCtx)).toEqual(UNAUTHENTICATED_AUDIT);
    expect(UNAUTHENTICATED_AUDIT).toEqual({ authMethod: "unknown" });
  });

  it("falls back to UNAUTHENTICATED_AUDIT for null / undefined contexts", () => {
    expect(auditFromAuth(null)).toEqual(UNAUTHENTICATED_AUDIT);
    expect(auditFromAuth(undefined)).toEqual(UNAUTHENTICATED_AUDIT);
  });

  it("never returns an apiKeyId of empty string or 'none' (sentinels would collide with real key ids)", () => {
    const labels = auditFromAuth(sessionCtx);
    expect(labels.apiKeyId).toBeUndefined();
    expect(Object.keys(labels)).not.toContain("apiKeyId");
  });
});
