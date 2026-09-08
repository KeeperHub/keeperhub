import { downloadBlob } from "@/lib/client/download-file";

export type AuditExportRequest = {
  /** Recent-window preset in days (7/30/90); omit for all time. */
  days?: number;
  /** Activity-type categories to include; empty = all. */
  resourceTypes: string[];
  /** Dual-factor codes; omit on the first call to mint the email OTP. */
  code?: string;
  emailOtp?: string;
};

/**
 * POST the audit-export request. Returns the raw Response so the caller can
 * handle the dual-factor challenge (non-ok JSON) vs the CSV (ok blob). The MFA
 * codes ride in the body, never the URL.
 */
export function postAuditExport(req: AuditExportRequest): Promise<Response> {
  return fetch("/api/security/audit/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(req),
  });
}

/** Download filename stamped with the export date, e.g. audit-log-2026-06-15.csv. */
export function auditExportFilename(days?: number): string {
  const exportedOn = new Date().toISOString().slice(0, 10);
  const scope = days ? `-last-${days}d` : "";
  return `audit-log${scope}-${exportedOn}.csv`;
}

/** Read a successful export Response and trigger the CSV download. */
export async function downloadAuditExport(
  res: Response,
  days?: number
): Promise<void> {
  const blob = await res.blob();
  downloadBlob(blob, auditExportFilename(days));
}
