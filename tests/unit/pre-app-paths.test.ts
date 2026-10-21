import { describe, expect, it } from "vitest";
import {
  isLinkedSignInPath,
  isPreAppPath,
  isSignInGatePath,
  isUnderRoute,
  isWelcomePath,
} from "@/lib/pre-app-paths";

describe("isUnderRoute", () => {
  it("matches the route and pages under it, not look-alikes", () => {
    expect(isUnderRoute("/executions", "/executions")).toBe(true);
    expect(isUnderRoute("/executions/abc", "/executions")).toBe(true);
    expect(isUnderRoute("/executions-history", "/executions")).toBe(false);
    expect(isUnderRoute("/", "/executions")).toBe(false);
  });
});

describe("pre-app paths", () => {
  it.each([
    "/welcome",
    "/welcome/create-org",
    "/verify-mfa",
    "/enroll-mfa",
    "/enforce-mfa",
    "/verify-ip",
    "/accept-invite/inv_123",
    "/device",
    "/oauth/authorize",
  ])("%s is before the app", (pathname) => {
    expect(isPreAppPath(pathname)).toBe(true);
  });

  it.each(["/", "/hub", "/workflows/abc", "/welcome-back", "/devices"])(
    "%s is in the app",
    (pathname) => {
      expect(isPreAppPath(pathname)).toBe(false);
    }
  );

  it("tells the welcome pages, sign-in gates and linked pages apart", () => {
    expect(isWelcomePath("/welcome/connect-agent")).toBe(true);
    expect(isSignInGatePath("/verify-ip")).toBe(true);
    expect(isSignInGatePath("/accept-invite/inv_123")).toBe(false);
    expect(isLinkedSignInPath("/accept-invite/inv_123")).toBe(true);
    expect(isLinkedSignInPath("/verify-mfa")).toBe(false);
  });
});
