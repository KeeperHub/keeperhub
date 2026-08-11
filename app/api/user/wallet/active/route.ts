import { NextResponse } from "next/server";

// Switching the active wallet is disabled. Every organization signs with its
// Turnkey wallet. Kept as a 410 so old clients get a clear, non-generic error
// instead of a silent 404.
export function POST(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Switching the active wallet is no longer supported. Turnkey is the only signer.",
    },
    { status: 410 }
  );
}
