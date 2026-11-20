import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getOrgContext: vi.fn(),
  getOAuthClient: vi.fn(),
  storeAuthCode: vi.fn(),
  getScopePolicyForMint: vi.fn(),
  policyCeiling: vi.fn(),
}));

class RedirectSignal extends Error {
  readonly url: string;
  constructor(url: string) {
    super("NEXT_REDIRECT");
    this.url = url;
  }
}

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: (): Promise<Headers> => Promise.resolve(new Headers()),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new RedirectSignal(url);
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("@/lib/auth-anonymous-guard", () => ({
  isAnonymousUserShape: (): boolean => false,
  logAnonymousExecutionBlock: vi.fn(),
}));

vi.mock("@/lib/mcp/oauth-store", () => ({
  AUTH_CODE_TTL_MS: 60_000,
  getOAuthClient: mocks.getOAuthClient,
  storeAuthCode: mocks.storeAuthCode,
}));

vi.mock("@/lib/mcp/scope-policy", () => ({
  getScopePolicyForMint: mocks.getScopePolicyForMint,
  policyCeiling: mocks.policyCeiling,
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: mocks.getOrgContext,
}));

import AuthorizePage from "@/app/oauth/authorize/page";

const CLIENT_ID = "client-1";
const REDIRECT_URI = "http://localhost:4000/callback";
const ORG_ID = "org-1";
const USER_ID = "user-1";
const STATE = "state-xyz";

type ApproveAction = (formData: FormData) => Promise<void>;

function orgContextWithRole(role: string): Record<string, unknown> {
  return {
    user: { id: USER_ID, email: "user@example.com" },
    organization: { id: ORG_ID, name: "Acme" },
    member: { id: "m-1", organizationId: ORG_ID, userId: USER_ID, role },
  };
}

function renderPage(): Promise<ReactElement> {
  return AuthorizePage({
    searchParams: Promise.resolve({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "mcp:read mcp:write",
      state: STATE,
      code_challenge: "challenge",
      code_challenge_method: "S256",
    }),
  });
}

function collectText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as ReactElement<{ children?: ReactNode }>).props;
    return collectText(props.children);
  }
  return "";
}

function findApproveAction(node: ReactNode): ApproveAction | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findApproveAction(child);
      if (found) {
        return found;
      }
    }
    return;
  }
  if (!(node && typeof node === "object" && "props" in node)) {
    return;
  }
  const props = (
    node as ReactElement<{
      approveAction?: ApproveAction;
      children?: ReactNode;
    }>
  ).props;
  return props.approveAction ?? findApproveAction(props.children);
}

function approveForm(): FormData {
  const form = new FormData();
  form.set("client_id", CLIENT_ID);
  form.set("redirect_uri", REDIRECT_URI);
  form.append("scope", "mcp:read");
  form.append("scope", "mcp:write");
  form.set("state", STATE);
  form.set("code_challenge", "challenge");
  form.set("code_challenge_method", "S256");
  form.set("organization_id", ORG_ID);
  return form;
}

async function captureRedirect(run: () => Promise<unknown>): Promise<URL> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof RedirectSignal) {
      return new URL(error.url);
    }
    throw error;
  }
  throw new Error("expected a redirect");
}

async function approveActionFromMemberRender(): Promise<ApproveAction> {
  mocks.getOrgContext.mockResolvedValueOnce(orgContextWithRole("member"));
  const tree = await renderPage();
  const action = findApproveAction(tree);
  if (!action) {
    throw new Error("consent form approve action not rendered");
  }
  return action;
}

describe("OAuth authorize consent page for viewers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOAuthClient.mockResolvedValue({
      clientId: CLIENT_ID,
      clientName: "Test Agent",
      redirectUris: [REDIRECT_URI],
    });
    mocks.getSession.mockResolvedValue({
      user: { id: USER_ID, email: "user@example.com", name: "User" },
    });
    mocks.getScopePolicyForMint.mockResolvedValue({});
    mocks.policyCeiling.mockReturnValue(null);
    mocks.storeAuthCode.mockResolvedValue(undefined);
  });

  it("renders the view-only state without a consent form for a viewer", async () => {
    mocks.getOrgContext.mockResolvedValue(orgContextWithRole("viewer"));

    const tree = await renderPage();

    expect(collectText(tree)).toContain("View-only access");
    expect(collectText(tree)).toContain("You are a viewer in Acme");
    expect(findApproveAction(tree)).toBeUndefined();
  });

  it("renders the consent form for a member", async () => {
    mocks.getOrgContext.mockResolvedValue(orgContextWithRole("member"));

    const tree = await renderPage();

    expect(collectText(tree)).not.toContain("View-only access");
    expect(findApproveAction(tree)).toBeTypeOf("function");
  });

  it("approve redirects a viewer with access_denied and stores no auth code", async () => {
    const approve = await approveActionFromMemberRender();
    mocks.getOrgContext.mockResolvedValue(orgContextWithRole("viewer"));

    const target = await captureRedirect(() => approve(approveForm()));

    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT_URI);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe(STATE);
    expect(target.searchParams.has("code")).toBe(false);
    expect(mocks.storeAuthCode).not.toHaveBeenCalled();
  });

  it("approve issues an auth code for a member", async () => {
    const approve = await approveActionFromMemberRender();
    mocks.getOrgContext.mockResolvedValue(orgContextWithRole("member"));

    const target = await captureRedirect(() => approve(approveForm()));

    expect(target.searchParams.get("error")).toBeNull();
    expect(target.searchParams.get("code")).toBeTruthy();
    expect(mocks.storeAuthCode).toHaveBeenCalledTimes(1);
    expect(mocks.storeAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        userId: USER_ID,
        organizationId: ORG_ID,
      })
    );
  });
});
