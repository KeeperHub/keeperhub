import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isViewerExemptMutation,
  orgIdFromPath,
  requiresViewerCheck,
} from "@/lib/security/viewer-policy";

const API_DIR = join(process.cwd(), "app/api");
const ROUTE_FILE = /^route(\.[a-z]+)?\.ts$/;
const MUTATING_EXPORT =
  /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/g;

function listRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRouteFiles(full));
    } else if (ROUTE_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// app/api/workflows/[workflowId]/route.ts -> /api/workflows/x
function routeUrl(file: string): string {
  const segments = relative(join(process.cwd(), "app"), file)
    .split(sep)
    .slice(0, -1)
    .map((segment) => {
      if (segment.startsWith("[...")) {
        return "a/b";
      }
      return segment.startsWith("[") ? "x" : segment;
    });
  return `/${segments.join("/")}`;
}

const mutatingRoutes = listRouteFiles(API_DIR)
  .map((file) => ({
    file: relative(process.cwd(), file).split(sep).join("/"),
    url: routeUrl(file),
    methods: [...readFileSync(file, "utf8").matchAll(MUTATING_EXPORT)].map(
      (m) => m[1]
    ),
  }))
  .filter((route) => route.methods.length > 0);

// Every mutating route a viewer session may call. Anything not listed here is
// denied to viewers by the proxy, so a new route is read-only for them until
// it is added on purpose.
const EXPECTED_VIEWER_EXEMPT = [
  "app/api/admin/orgs/[orgId]/activate/route.ts",
  "app/api/admin/orgs/[orgId]/deactivate/route.ts",
  "app/api/admin/test/cleanup/route.staging.ts",
  "app/api/admin/test/enable-workflow/route.staging.ts",
  "app/api/admin/users/[userId]/activate/route.ts",
  "app/api/admin/users/[userId]/deactivate/route.ts",
  "app/api/admin/workflows/[workflowId]/activate/route.ts",
  "app/api/admin/workflows/[workflowId]/deactivate/route.ts",
  "app/api/api-keys/[keyId]/route.ts",
  "app/api/auth/[...all]/route.ts",
  "app/api/auth/finish-credential-signup/route.ts",
  "app/api/auth/oauth-mfa-finalize/route.ts",
  "app/api/auth/scan-intent/route.ts",
  "app/api/auth/signup-conflict/route.ts",
  "app/api/auth/strict-signin/route.ts",
  "app/api/auth/strict-signin/start/route.ts",
  "app/api/auth/template-intent/route.ts",
  "app/api/billing/webhooks/stripe/route.ts",
  "app/api/feedback/route.ts",
  "app/api/gas/estimate/route.ts",
  "app/api/hub/view/route.ts",
  "app/api/internal/executions/[executionId]/route.ts",
  "app/api/internal/executions/route.ts",
  "app/api/internal/pyth-triggers/route.ts",
  "app/api/internal/schedules/[scheduleId]/route.ts",
  "app/api/internal/wallet-unlock/route.ts",
  "app/api/mcp/workflows/[slug]/call/route.ts",
  "app/api/oauth/register/route.ts",
  "app/api/oauth/token/route.ts",
  "app/api/organizations/[organizationId]/leave/route.ts",
  "app/api/organizations/invitations/[invitationId]/wallet-accept/route.ts",
  "app/api/user/delete/route.ts",
  "app/api/user/display-name/route.ts",
  "app/api/user/forgot-password/route.ts",
  "app/api/user/onboarding/complete/route.ts",
  "app/api/user/password/route.ts",
  "app/api/user/route.ts",
  "app/api/user/rpc-preferences/[chainId]/route.ts",
  "app/api/user/sessions/[sessionId]/revoke/route.ts",
  "app/api/user/step-up/email/route.ts",
  "app/api/user/totp/backup-codes/route.ts",
  "app/api/user/totp/disable/route.ts",
  "app/api/user/totp/enroll/route.ts",
  "app/api/user/totp/setup/route.ts",
  "app/api/user/totp/verify-stepup/route.ts",
  "app/api/user/verify-ip/route.ts",
  "app/api/user/wallet/prices/route.ts",
  "app/api/web3/fetch-abi/route.ts",
  "app/api/workflows/[workflowId]/rate/route.ts",
  "app/api/workflows/[workflowId]/webhook/route.ts",
];

describe("viewer policy: every mutating API route", () => {
  it("discovers the mutating routes", () => {
    expect(mutatingRoutes.length).toBeGreaterThan(100);
  });

  it("exempts exactly the expected routes and denies the rest", () => {
    const exempt = mutatingRoutes
      .filter((route) => isViewerExemptMutation(route.url))
      .map((route) => route.file)
      .sort();
    expect(exempt).toEqual([...EXPECTED_VIEWER_EXEMPT].sort());
  });

  it("checks the viewer role on every org-changing route", () => {
    const orgChanging = [
      "/api/workflows/create",
      "/api/workflows/x",
      "/api/workflow/x/execute",
      "/api/projects",
      "/api/tags/x",
      "/api/address-book",
      "/api/integrations/x",
      "/api/keys",
      "/api/api-keys",
      "/api/user/wallet/withdraw",
      "/api/user/safe",
      "/api/agentic-wallet/x/approve",
      "/api/mcp/policy",
      "/api/organizations/x",
    ];
    for (const path of orgChanging) {
      expect(requiresViewerCheck("POST", path)).toBe(true);
    }
  });
});

describe("viewer policy: request classification", () => {
  it("never checks reads", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(requiresViewerCheck(method, "/api/workflows/create")).toBe(false);
    }
  });

  it("ignores non-API paths", () => {
    expect(requiresViewerCheck("POST", "/workflows/x")).toBe(false);
  });

  it("blocks CLI device approval although it sits under /api/auth/", () => {
    expect(requiresViewerCheck("POST", "/api/auth/device/approve")).toBe(true);
    expect(requiresViewerCheck("POST", "/api/auth/device/approve/")).toBe(true);
    expect(requiresViewerCheck("POST", "/api/auth/sign-out")).toBe(false);
  });

  it("accepts method case variations", () => {
    expect(requiresViewerCheck("post", "/api/projects")).toBe(true);
  });
});

describe("orgIdFromPath", () => {
  it("reads the organization id segment", () => {
    expect(orgIdFromPath("/api/organizations/org-1/mfa-enforcement")).toBe(
      "org-1"
    );
    expect(orgIdFromPath("/api/organizations/org-1")).toBe("org-1");
  });

  it("skips the static segments that are not organization ids", () => {
    expect(orgIdFromPath("/api/organizations/invitations/inv-1/x")).toBeNull();
    expect(
      orgIdFromPath("/api/organizations/circuit-breaker/reset")
    ).toBeNull();
  });

  it("returns null for a malformed escape instead of throwing", () => {
    expect(orgIdFromPath("/api/organizations/%E0%A4%A/x")).toBeNull();
  });

  it("returns null outside /api/organizations", () => {
    expect(orgIdFromPath("/api/workflows/x")).toBeNull();
  });
});
