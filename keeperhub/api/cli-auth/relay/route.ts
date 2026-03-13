import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

const PORT_PATTERN = /^\d+$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;

/**
 * GET /api/cli-auth/relay?port=PORT
 *
 * Server-side relay for CLI OAuth login. Better Auth redirects here after
 * successful social sign-in (callbackURL). This route reads the session
 * token from the HttpOnly cookie (same domain) and redirects to the CLI's
 * local callback server with the token as a query parameter.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const port = req.nextUrl.searchParams.get("port") ?? "";
  const nonce = req.nextUrl.searchParams.get("nonce") ?? "";
  if (!(PORT_PATTERN.test(port) && NONCE_PATTERN.test(nonce))) {
    return NextResponse.json(
      { error: "Missing or invalid parameters" },
      { status: 400 }
    );
  }

  const cookieStore = await cookies();
  const useSecure = process.env.NODE_ENV === "production";
  const cookieName = useSecure
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  const sessionToken = cookieStore.get(cookieName)?.value;

  if (!sessionToken) {
    return NextResponse.json(
      { error: "No session token found" },
      { status: 401 }
    );
  }

  const callbackURL = new URL(`http://127.0.0.1:${port}/callback`);
  callbackURL.searchParams.set("token", sessionToken);
  callbackURL.searchParams.set("nonce", nonce);

  return NextResponse.redirect(callbackURL.toString());
}
