/**
 * Client-side device authorization flow for the CLI login (`kh auth login`).
 *
 * Better Auth's device-authorization plugin splits browser approval into two
 * calls that must happen in order:
 *
 *   1. `GET /api/auth/device?user_code=...` binds the pending device code to
 *      the signed-in session (sets `deviceCode.userId`).
 *   2. `POST /api/auth/device/approve` verifies that binding - it rejects any
 *      record whose `userId` is unset, and rejects a record claimed by a
 *      different user.
 *
 * Approving without claiming first therefore always fails, regardless of the
 * code's validity.
 */

const DEVICE_CLAIM_PATH = "/api/auth/device";
const DEVICE_APPROVE_PATH = "/api/auth/device/approve";
const FALLBACK_ERROR_MESSAGE = "Verification failed.";

export type DeviceAuthorizationResult =
  | { ok: true }
  | { ok: false; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ErrorBody = {
  error?: string;
  error_description?: string;
  message?: string;
};

async function readErrorMessage(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as ErrorBody;
  return data.error_description ?? data.message ?? FALLBACK_ERROR_MESSAGE;
}

/**
 * Claims the user code for the current session, then approves it.
 *
 * A failed claim short-circuits: the claim endpoint reports the specific
 * cause (unknown code, expired code), whereas approve would only report the
 * generic "has not been claimed" message and hide it.
 *
 * `fetchImpl` is wrapped rather than defaulted to bare `fetch` because
 * browsers require `fetch` to be invoked with `window` as its receiver -
 * passing the unbound reference around throws "Illegal invocation".
 */
export async function claimAndApproveDevice(
  userCode: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<DeviceAuthorizationResult> {
  const claimResponse = await fetchImpl(
    `${DEVICE_CLAIM_PATH}?user_code=${encodeURIComponent(userCode)}`,
    { credentials: "include" }
  );

  if (!claimResponse.ok) {
    return { ok: false, message: await readErrorMessage(claimResponse) };
  }

  const approveResponse = await fetchImpl(DEVICE_APPROVE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ userCode }),
  });

  if (!approveResponse.ok) {
    return { ok: false, message: await readErrorMessage(approveResponse) };
  }

  return { ok: true };
}
