import type { FailureAlertChannelKind } from "@/lib/db/schema-failure-alerts";

/** What the test endpoint answers. */
export type TestResult = {
  delivered: boolean;
  classification: "ok" | "transient" | "permanent";
  status?: number;
  message: string;
  durationMs: number;
  recipients?: string[];
};

export type TestBody =
  | { channel: "email"; to: "me" | "recipients"; recipientUserIds?: string[] }
  | {
      channel: FailureAlertChannelKind;
      integrationId: string;
      destination: string;
      channelId?: string;
      pagerDutyMode?: "change" | "page";
    };

/**
 * Send a test. Never throws: a refused request (rate limit, bad input) comes
 * back as a failed result with the server's message.
 */
export async function sendFailureAlertTest(
  organizationId: string,
  body: TestBody
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

export const CHANNEL_LABEL: Record<FailureAlertChannelKind | "email", string> =
  {
    email: "Email",
    slack: "Slack",
    discord: "Discord",
    telegram: "Telegram",
    pagerduty: "PagerDuty",
  };
