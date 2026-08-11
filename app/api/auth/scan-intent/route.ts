import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { HttpStatus } from "@/lib/http-status";
import { recordScanIntent } from "@/lib/metrics/collectors/prometheus";

const COOKIE_NAME = "pending_scan";
const MAX_SCAN_INTENT_LENGTH = 2048;

/**
 * POST /api/auth/scan-intent
 * Body: { intent: string } — JSON-serialised SuggestionDescriptor + mode + address.
 *
 * Sets a short-lived pending_scan HttpOnly cookie that survives the OAuth
 * round-trip. Mirrors app/api/auth/template-intent/route.ts exactly.
 * FUNNEL-02 / 54-02.
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

  const intent =
    body && typeof body === "object" && "intent" in body
      ? (body as { intent: unknown }).intent
      : undefined;

  if (typeof intent !== "string" || intent.length === 0) {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "intent is required",
      requestHeaders: request.headers,
    });
  }

  if (intent.length > MAX_SCAN_INTENT_LENGTH) {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "intent too long",
      requestHeaders: request.headers,
    });
  }

  try {
    JSON.parse(intent);
  } catch {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCodes.INVALID_INPUT,
      detail: "intent must be valid JSON",
      requestHeaders: request.headers,
    });
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: COOKIE_NAME,
    value: intent,
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 600, // 10 minutes — matches template-intent (FUNNEL-02)
  });

  recordScanIntent("created");
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/auth/scan-intent
 *
 * Returns { intent: ScanIntent | null } and atomically clears the cookie
 * (maxAge=0). Mirrors template-intent GET. FUNNEL-02 / 54-02.
 */
export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME);
  const raw = existing?.value ?? null;

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

  if (!raw) {
    return NextResponse.json({ intent: null });
  }

  try {
    const intent = JSON.parse(raw) as unknown;
    recordScanIntent("consumed");
    return NextResponse.json({ intent });
  } catch {
    return NextResponse.json({ intent: null });
  }
}
