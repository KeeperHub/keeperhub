import { NextResponse } from "next/server";

import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";

export function GET(): NextResponse {
  const protocols = getRegisteredProtocols();
  return NextResponse.json(protocols);
}
