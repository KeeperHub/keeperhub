import { invalidateNotificationStatus } from "@/lib/hooks/use-notifications";
import type {
  TestRequest,
  TestResult,
} from "@/lib/notifications/failure-alerts/view-types";

/**
 * Send a test. Never throws: a refused request (rate limit, bad input) comes
 * back as a failed result with the server's message.
 */
export async function sendFailureAlertTest(
  organizationId: string,
  body: TestRequest
): Promise<TestResult> {
  const started = Date.now();
  try {
    const response = await fetch(
      `/api/organizations/${encodeURIComponent(organizationId)}/failure-alerts/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = (await response.json().catch(() => ({}))) as Partial<
      TestResult & { error: string }
    >;
    if (!response.ok) {
      return {
        delivered: false,
        classification: response.status === 429 ? "transient" : "permanent",
        message: data.error ?? "The test could not be sent.",
        durationMs: Date.now() - started,
      };
    }
    // A test can mark a method working or paused, which the banner reflects.
    invalidateNotificationStatus(organizationId);
    return data as TestResult;
  } catch {
    return {
      delivered: false,
      classification: "transient",
      message:
        "Could not reach KeeperHub. Check your connection and try again.",
      durationMs: Date.now() - started,
    };
  }
}

/** A non-OK answer to a settings GET, with its HTTP status. */
export class ViewError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** GET a settings view; throws on a network error or a non-OK answer. */
export async function fetchView<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ViewError(response.status);
  }
  return (await response.json()) as T;
}
