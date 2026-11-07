import { invalidateNotificationStatus } from "@/lib/hooks/use-notifications";
import type {
  TestRequest,
  TestResult,
  WorkflowAlertView,
} from "@/lib/notifications/failure-alerts/view-types";
import { channelsPayload, draftsFromViews } from "./method-drafts";

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
    // A test can mark a method working or stopped, which the banner reflects.
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

/** Resumes a workflow from Overview, sending its saved setup back unchanged; null when done, else why not. */
export async function resumeWorkflow(
  workflowId: string
): Promise<string | null> {
  const url = `/api/workflows/${encodeURIComponent(workflowId)}/failure-alerts`;
  try {
    const current = await fetch(url);
    if (!current.ok) {
      return "Could not read this workflow's alerts. Open them and resume there.";
    }
    const view = (await current.json()) as WorkflowAlertView;
    const o = view.override;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threshold: o.threshold,
        timeLimitMinutes: o.timeLimitMinutes,
        recipientUserIds: o.recipientUserIds,
        customChannels: o.customChannels,
        channels: channelsPayload(draftsFromViews(o.channels)),
        disableWorkflow: o.disableWorkflow,
        pausedUntil: null,
        pauseUntilSuccess: false,
        version: view.version,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error ?? "Could not resume. Open its Alerts and try there.";
    }
    return null;
  } catch {
    return "Could not reach KeeperHub. Check your connection and try again.";
  }
}
