import { NextResponse } from "next/server";

/**
 * GET /api/health
 * Health check endpoint for monitoring and load balancers
 */
export function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
