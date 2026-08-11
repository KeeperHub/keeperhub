import { NextResponse } from "next/server";

// Claiming is retired: every workflow is org-owned from creation and
// is_anonymous is normalized to false. Remove together with the client
// claim dialog.
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "Workflow claiming is no longer supported" },
    { status: 410 }
  );
}
