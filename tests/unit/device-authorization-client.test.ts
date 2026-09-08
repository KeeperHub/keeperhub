// Regression guard: the /device page used to approve a user code without first
// claiming it, so `POST /api/auth/device/approve` always rejected with
// DEVICE_CODE_NOT_CLAIMED and `kh auth login` could never complete. The
// ordering assertions below pin the claim GET before the approve POST.

import { describe, expect, it } from "vitest";

import { claimAndApproveDevice } from "@/lib/device-authorization-client";

const USER_CODE = "ABCD-1234";
const CLAIM_URL = `/api/auth/device?user_code=${encodeURIComponent(USER_CODE)}`;
const APPROVE_URL = "/api/auth/device/approve";

type RecordedCall = { input: string; init?: RequestInit };

/**
 * Builds a fetch double that replays `responses` in call order and records
 * every request, so tests can assert on the sequence rather than just the
 * fact that a call happened.
 */
function createFetchSpy(responses: Response[]): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;

  return {
    calls,
    fetchImpl: (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error(`Unexpected fetch call to ${input}`);
      }
      return Promise.resolve(response);
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okClaim(): Response {
  return jsonResponse({ user_code: USER_CODE, status: "pending" }, 200);
}

describe("claimAndApproveDevice", () => {
  it("claims the user code before approving it", async () => {
    const { fetchImpl, calls } = createFetchSpy([
      okClaim(),
      jsonResponse({ success: true }, 200),
    ]);

    const result = await claimAndApproveDevice(USER_CODE, fetchImpl);

    expect(result).toEqual({ ok: true });
    expect(calls.map((call) => call.input)).toEqual([CLAIM_URL, APPROVE_URL]);
  });

  it("sends the claim as a credentialed GET carrying the user code", async () => {
    const { fetchImpl, calls } = createFetchSpy([
      okClaim(),
      jsonResponse({ success: true }, 200),
    ]);

    await claimAndApproveDevice(USER_CODE, fetchImpl);

    const claimCall = calls[0];
    expect(claimCall.input).toBe(CLAIM_URL);
    expect(claimCall.init?.credentials).toBe("include");
    // The claim binds the code to the session cookie, so it must not be a POST
    // and must not carry a body - better-auth reads `user_code` from the query.
    expect(claimCall.init?.method).toBeUndefined();
    expect(claimCall.init?.body).toBeUndefined();
  });

  it("sends the approval as a credentialed POST with the user code body", async () => {
    const { fetchImpl, calls } = createFetchSpy([
      okClaim(),
      jsonResponse({ success: true }, 200),
    ]);

    await claimAndApproveDevice(USER_CODE, fetchImpl);

    const approveCall = calls[1];
    expect(approveCall.input).toBe(APPROVE_URL);
    expect(approveCall.init?.method).toBe("POST");
    expect(approveCall.init?.credentials).toBe("include");
    expect(approveCall.init?.body).toBe(
      JSON.stringify({ userCode: USER_CODE })
    );
  });

  it("percent-encodes a user code containing URL-significant characters", async () => {
    const { fetchImpl, calls } = createFetchSpy([
      okClaim(),
      jsonResponse({ success: true }, 200),
    ]);

    await claimAndApproveDevice("A B&C=D", fetchImpl);

    expect(calls[0].input).toBe("/api/auth/device?user_code=A%20B%26C%3DD");
  });

  it("does not approve when the claim fails, and surfaces the claim error", async () => {
    const { fetchImpl, calls } = createFetchSpy([
      jsonResponse(
        {
          error: "expired_token",
          error_description: "User code has expired",
        },
        400
      ),
    ]);

    const result = await claimAndApproveDevice(USER_CODE, fetchImpl);

    expect(result).toEqual({ ok: false, message: "User code has expired" });
    // Short-circuiting matters: approve would mask the real cause behind the
    // generic "has not been claimed" message.
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(CLAIM_URL);
  });

  it("surfaces the approve error when the claim succeeds but approval is rejected", async () => {
    const { fetchImpl } = createFetchSpy([
      okClaim(),
      jsonResponse(
        {
          error: "access_denied",
          error_description:
            "You are not authorized to approve this device authorization",
        },
        403
      ),
    ]);

    const result = await claimAndApproveDevice(USER_CODE, fetchImpl);

    expect(result).toEqual({
      ok: false,
      message: "You are not authorized to approve this device authorization",
    });
  });

  it("falls back to `message` when the error body has no error_description", async () => {
    const { fetchImpl } = createFetchSpy([
      okClaim(),
      jsonResponse({ message: "Something went wrong" }, 500),
    ]);

    const result = await claimAndApproveDevice(USER_CODE, fetchImpl);

    expect(result).toEqual({ ok: false, message: "Something went wrong" });
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    const { fetchImpl } = createFetchSpy([
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ]);

    const result = await claimAndApproveDevice(USER_CODE, fetchImpl);

    expect(result).toEqual({ ok: false, message: "Verification failed." });
  });
});
