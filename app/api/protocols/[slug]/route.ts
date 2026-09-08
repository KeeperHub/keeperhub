import { NextResponse } from "next/server";
import "@/protocols";
import { getProtocol } from "@/lib/protocol-registry";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await context.params;
  const protocol = getProtocol(slug);

  if (!protocol) {
    return NextResponse.json({ error: "Protocol not found" }, { status: 404 });
  }

  return NextResponse.json(protocol);
}
