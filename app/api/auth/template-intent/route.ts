import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { HttpStatus } from "@/lib/http-status";

const COOKIE_NAME = "pending_template";
const MAX_WORKFLOW_ID_LENGTH = 128;

/**
 * POST /api/auth/template-intent
 * Body: { workflowId: string }
 *
 * Sets a short-lived HttpOnly cookie capturing the user's intent to
 * use a workflow template. Survives the OAuth round-trip; consumed
 * by GET (atomic clear). HUB-04 / 43-CONTEXT.md.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "Invalid JSON body",
      requestHeaders: request.headers,
    });
  }

  const workflowId =
    body && typeof body === "object" && "workflowId" in body
      ? (body as { workflowId: unknown }).workflowId
      : undefined;

  if (typeof workflowId !== "string" || workflowId.length === 0) {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "workflowId is required",
      requestHeaders: request.headers,
    });
  }
  if (workflowId.length > MAX_WORKFLOW_ID_LENGTH) {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "workflowId too long",
      requestHeaders: request.headers,
    });
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: COOKIE_NAME,
    value: workflowId,
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 600, // 10 minutes (CONTEXT.md HUB-04)
  });

  return NextResponse.json({ ok: true });
}

/**
 * GET /api/auth/template-intent
 *
 * Returns { workflowId: string | null } and atomically clears the
 * cookie by writing Max-Age=0. HUB-04 / 43-CONTEXT.md.
 */
export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME);
  const workflowId = existing?.value ?? null;

  if (existing) {
    cookieStore.set({
      name: COOKIE_NAME,
      value: "",
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 0,
    });
  }

  return NextResponse.json({ workflowId });
}
