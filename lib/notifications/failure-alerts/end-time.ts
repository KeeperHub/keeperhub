// An ISO date-time; with no zone it is read as UTC, not the server's local time.
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/** An end time from a request, or null when it is not an ISO date-time. */
export function parseEndTime(raw: string): Date | null {
  if (!ISO_TIME.test(raw)) {
    return null;
  }
  const at = new Date(HAS_ZONE.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}
