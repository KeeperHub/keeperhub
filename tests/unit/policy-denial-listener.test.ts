import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

/**
 * The refusal envelope the server actually sends: `error` carries the code and
 * `detail` carries the sentence a person reads. A denial that reaches the
 * browser has to say so on screen, because the alternative is what happened
 * before this existed -- the action does nothing and the only evidence is a 403
 * in devtools.
 */
const DENIAL = {
  error: "policy_denied",
  detail:
    "Blocked by an organization policy. Review your organization's policies at https://app.example.com/settings/org-1/policies",
  request_id: "req-1",
};

function respond(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let underlying: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  toastError.mockClear();
  underlying = vi.fn();
  // The listener wraps whatever fetch it finds, once per page load. Its
  // "already installed" flag and its repeat window are module state, so the
  // module is reloaded per test -- otherwise every test after the first would
  // call the unwrapped mock and pass without exercising anything.
  vi.resetModules();
  Object.defineProperty(globalThis, "window", {
    value: {
      fetch: underlying,
      location: { origin: "https://app.example.com", href: "" },
    },
    configurable: true,
    writable: true,
  });
  const { installPolicyDenialListener } = await import(
    "@/lib/policy/ui/policy-denial-listener"
  );
  installPolicyDenialListener();
});

describe("the policy denial listener", () => {
  it("announces a refusal raised by any request", async () => {
    underlying.mockResolvedValue(respond(DENIAL, 403));

    await window.fetch("/api/workflows", { method: "POST" });

    expect(toastError).toHaveBeenCalledTimes(1);
    const [message, options] = toastError.mock.calls[0] as [
      string,
      { action?: { label: string } },
    ];
    expect(message).toContain("Blocked by an organization policy");
    // The link the server put in the sentence becomes somewhere to go.
    expect(options.action?.label).toBe("View policies");
  });

  it("hands the response back untouched, body still readable", async () => {
    underlying.mockResolvedValue(respond(DENIAL, 403));

    const response = await window.fetch("/api/workflows", { method: "POST" });

    // The caller reads the body after the listener has already read it. A
    // consumed body here would break every error path in the app.
    expect(await response.json()).toEqual(DENIAL);
    expect(response.status).toBe(403);
  });

  it("says nothing about a 403 that is not a policy refusal", async () => {
    underlying.mockResolvedValue(
      respond({ error: "unauthorized", detail: "Sign in" }, 403)
    );

    await window.fetch("/api/workflows", { method: "POST" });

    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing about a successful request", async () => {
    underlying.mockResolvedValue(respond({ id: "wf_1" }, 200));

    await window.fetch("/api/workflows", { method: "POST" });

    expect(toastError).not.toHaveBeenCalled();
  });

  it("leaves requests to other origins alone", async () => {
    underlying.mockResolvedValue(respond(DENIAL, 403));

    await window.fetch("https://elsewhere.example.com/api/workflows");

    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows one toast when an action fans out into several requests", async () => {
    underlying.mockResolvedValue(respond(DENIAL, 403));

    await window.fetch("/api/workflows", { method: "POST" });
    await window.fetch("/api/workflows", { method: "POST" });
    await window.fetch("/api/workflows", { method: "POST" });

    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("survives a refusal whose body is not JSON", async () => {
    underlying.mockResolvedValue(
      new Response("gateway timeout", { status: 403 })
    );

    const response = await window.fetch("/api/workflows", { method: "POST" });

    expect(response.status).toBe(403);
    expect(toastError).not.toHaveBeenCalled();
  });
});
