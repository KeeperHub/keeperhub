import type { OpenClawCredentials } from "./credentials";

type TestResult = { status: "success" } | { status: "error"; message: string };

/**
 * Connection check for an OpenClaw instance.
 *
 * This one validates configuration and stops - it makes no network call, and
 * that is a deliberate choice rather than an omission.
 *
 * The only endpoint this plugin talks to is `POST /hooks/agent`, which
 * admits an agent turn. There is no read-only counterpart to probe instead:
 * `GET` on that path answers 405 (Allow: POST), and any successful call
 * creates real work on the instance - a model run with the agent's tools and
 * whatever that agent can reach. A Test Connection button that quietly
 * spends an agent turn is worse than one that checks less.
 *
 * Shape and SSRF validation on OPENCLAW_BASE_URL already happen before this
 * function is called, because the field is declared `type: "url"`
 * (lib/db/test-connection.ts asserts the URL is public first). So this only
 * has to catch the configuration that shape-checking cannot: a missing field.
 *
 * Six of the sixteen shipped plugins make no network call in their test. This
 * is the first that does so on purpose, hence the note.
 */
export async function testOpenClawConnection(
  credentials: OpenClawCredentials
): Promise<TestResult> {
  const baseUrl = credentials?.OPENCLAW_BASE_URL?.trim();
  if (!baseUrl) {
    return {
      status: "error",
      message:
        "OPENCLAW_BASE_URL is not set. Enter the public base URL of your OpenClaw instance.",
    };
  }

  const hookToken = credentials?.OPENCLAW_HOOK_TOKEN?.trim();
  if (!hookToken) {
    return {
      status: "error",
      message:
        "OPENCLAW_HOOK_TOKEN is not set. Enter the dedicated hook token for this instance.",
    };
  }

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        status: "error",
        message: "OPENCLAW_BASE_URL must be an http or https URL.",
      };
    }
  } catch {
    return {
      status: "error",
      message: "OPENCLAW_BASE_URL is not a valid URL.",
    };
  }

  return { status: "success" };
}
