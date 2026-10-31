import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { organization: { create: mocks.create } },
}));
vi.mock("@/lib/hooks/use-organization", () => ({
  currentActiveOrgId: () => undefined,
}));

import { createOrganization } from "@/components/organization/create-organization";
import {
  resetOrgSwitchState,
  runOrgSwitch,
} from "@/components/organization/org-switch-runner";

// Whether a switcher's switch would run now (it does not while held).
async function switcherCanSwitch(): Promise<boolean> {
  return (
    (await runOrgSwitch({
      orgId: "org-x",
      name: "X",
      start: () => Promise.resolve(true),
      announce: false,
    })) !== null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOrgSwitchState();
});

describe("createOrganization", () => {
  it("creates the org (which the server makes active) under the switch lock", async () => {
    let switcherDuring: boolean | null = null;
    let answer: (value: unknown) => void = () => undefined;
    mocks.create.mockImplementationOnce(async () => {
      switcherDuring = await switcherCanSwitch();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    const creating = createOrganization({ name: "New", slug: "new" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Held until the create has answered, not just started.
    expect(await switcherCanSwitch()).toBe(false);
    answer({ data: { id: "org-new" }, error: null });
    expect((await creating).data).toEqual({ id: "org-new" });
    expect(switcherDuring).toBe(false);
    expect(mocks.create).toHaveBeenCalledWith({ name: "New", slug: "new" });
    // Let go after.
    expect(await switcherCanSwitch()).toBe(true);
  });
});
