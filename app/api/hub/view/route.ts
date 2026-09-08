import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE_NAME = "hub_view";
const COOKIE_MAX_AGE_SECONDS = 31_536_000; // 1 year (CONTEXT.md HUB-19)

type View = "cards" | "list";

function isValidView(value: unknown): value is View {
  return value === "cards" || value === "list";
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const view =
    body && typeof body === "object" && "view" in body
      ? (body as { view: unknown }).view
      : undefined;

  if (!isValidView(view)) {
    return NextResponse.json(
      { error: "view must be 'cards' or 'list'" },
      { status: 400 }
    );
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: COOKIE_NAME,
    value: view,
    path: "/",
    sameSite: "lax",
    httpOnly: false, // CONTEXT.md HUB-19: NOT HttpOnly so client can read for fallback
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  return NextResponse.json({ ok: true, view });
}
