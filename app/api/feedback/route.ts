import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

const FEEDBACK_SERVICE_URL = process.env.FEEDBACK_SERVICE_URL || "";
const FEEDBACK_API_KEY = process.env.FEEDBACK_API_KEY || "";

// Feedback widget is disabled by default. Re-enable by setting
// NEXT_PUBLIC_FEEDBACK_ENABLED=true (the sidebar button gates on the same
// flag). When disabled, the route short-circuits and never proxies to the
// external feedback service.
const FEEDBACK_ENABLED = process.env.NEXT_PUBLIC_FEEDBACK_ENABLED === "true";

export async function POST(request: Request): Promise<NextResponse> {
  if (!FEEDBACK_ENABLED) {
    return NextResponse.json(
      { error: "Feedback service is disabled" },
      { status: 503 }
    );
  }

  try {
    // Validate configuration
    if (!FEEDBACK_SERVICE_URL) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Feedback] FEEDBACK_SERVICE_URL not configured",
        new Error(
          "FEEDBACK_SERVICE_URL environment variable is not configured"
        ),
        {
          endpoint: "/api/feedback",
          component: "feedback-service",
        }
      );
      return NextResponse.json(
        { error: "Feedback service not configured" },
        { status: 500 }
      );
    }

    if (!FEEDBACK_API_KEY) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[Feedback] FEEDBACK_API_KEY not configured",
        new Error("FEEDBACK_API_KEY environment variable is not configured"),
        {
          endpoint: "/api/feedback",
          component: "feedback-service",
        }
      );
      return NextResponse.json(
        { error: "Feedback service not configured" },
        { status: 500 }
      );
    }

    // Session-only with optional auth: feedback submitted while logged in
    // attaches the caller's email/name for support routing; anonymous
    // callers still go through. API keys are intentionally not accepted --
    // org credentials carry no user-specific support context. See KEEP-354.
    const session = await auth.api.getSession({ headers: request.headers });

    const formData = await request.formData();
    const message = formData.get("message") as string;
    const categories = formData.get("categories") as string;
    const screenshot = formData.get("screenshot") as File | null;

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    const serviceFormData = new FormData();
    serviceFormData.append("message", message.trim());

    if (categories) {
      serviceFormData.append("categories", categories);
    }

    if (screenshot) {
      serviceFormData.append("screenshot", screenshot);
    }

    if (session?.user) {
      serviceFormData.append("userEmail", session.user.email ?? "");
      serviceFormData.append("userName", session.user.name ?? "");
    }

    // Forward to feedback service
    const response = await fetch(FEEDBACK_SERVICE_URL, {
      method: "POST",
      headers: {
        "X-API-Key": FEEDBACK_API_KEY,
      },
      body: serviceFormData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Feedback] Service error",
        new Error(JSON.stringify(errorData)),
        { endpoint: "/api/feedback", operation: "post" }
      );
      return NextResponse.json(
        { error: errorData.error || "Failed to submit feedback" },
        { status: response.status }
      );
    }

    const result = await response.json();
    return NextResponse.json(result);
  } catch (error) {
    logSystemError(ErrorCategory.EXTERNAL_SERVICE, "[Feedback] Error", error, {
      endpoint: "/api/feedback",
      operation: "post",
    });
    return NextResponse.json(
      { error: "Failed to submit feedback" },
      { status: 500 }
    );
  }
}
