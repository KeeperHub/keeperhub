import crypto from "node:crypto";

export type KhAdminAuthResult = {
  authenticated: boolean;
  error?: string;
};

function secureCompare(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Authenticates requests from KeeperHub platform operators.
// Uses KH_ADMIN_SECRET — a dedicated env var separate from INTERNAL_SERVICE_KEY
// (used by the scheduler/executor services) so that a service credential
// compromise does not grant admin deactivation powers.
//
// Deactivation capability matrix:
//   Org deactivation:      KH admin only  POST /api/admin/orgs/:id/deactivate
//   User deactivation:     KH admin only  POST /api/admin/users/:id/deactivate
//   Workflow deactivation: KH admin only  POST /api/admin/workflows/:id/deactivate
export function authenticateKhAdmin(request: Request): KhAdminAuthResult {
  const adminSecret = process.env.KH_ADMIN_SECRET;
  if (!adminSecret) {
    return { authenticated: false, error: "KH admin not configured" };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      authenticated: false,
      error: "Missing or invalid Authorization header",
    };
  }

  const token = authHeader.slice(7);
  if (!secureCompare(token, adminSecret)) {
    return { authenticated: false, error: "Invalid KH admin secret" };
  }

  return { authenticated: true };
}
