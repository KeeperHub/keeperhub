// The versioning and deprecation contract the REST surface publishes under
// `x-api-versioning` in app/api/openapi/route.ts.
//
// The constants live here rather than in that route so the endpoints that have
// to *honour* the contract can import them without pulling the whole OpenAPI
// document into their bundle. The route publishes what this module defines;
// neither half can drift from the other.

/** Current major version of the REST surface. */
export const API_VERSION = "1";

/**
 * Minimum notice, in days, between an endpoint gaining a `Deprecation` header
 * and the `Sunset` date it carries. Published so a caller can plan against the
 * guarantee rather than discovering it when something stops answering.
 */
export const DEPRECATION_NOTICE_DAYS = 180;

const MS_PER_DAY = 86_400_000;

function startOfUtcDay(isoDay: string): Date {
  const parsed = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO day for a deprecation date: "${isoDay}"`);
  }
  return parsed;
}

/**
 * RFC 9745 gives `Deprecation` a Structured Fields Date value (RFC 9651
 * section 3.3.7): an `@` sigil followed by integer seconds since the Unix
 * epoch, e.g. `@1788393600`.
 *
 * An HTTP-date is not a lenient variant of the same thing. A conforming
 * parser rejects the field and treats it as absent, which is exactly the
 * silent drop the header exists to prevent -- so getting this wrong is worse
 * than sending nothing, because the sender believes the notice was delivered.
 */
export function toStructuredFieldDate(isoDay: string): string {
  return `@${Math.floor(startOfUtcDay(isoDay).getTime() / 1000)}`;
}

/** The sunset date a deprecation effective on `isoDay` carries. */
export function sunsetFor(isoDay: string): Date {
  return new Date(
    startOfUtcDay(isoDay).getTime() + DEPRECATION_NOTICE_DAYS * MS_PER_DAY
  );
}

export type DeprecationNotice = {
  /** ISO day (YYYY-MM-DD) on which the deprecation took, or takes, effect. */
  effective: string;
  /** Absolute URL of the migration note. */
  link: string;
};

/**
 * The `Deprecation` / `Sunset` / `Link` triple announcing one deprecation.
 *
 * `Sunset` is derived from `effective` rather than passed in, so the published
 * DEPRECATION_NOTICE_DAYS minimum holds by construction: a caller of this
 * function cannot state a notice window shorter than the guarantee, and a
 * change to the guarantee moves every emitter at once.
 *
 * RFC 8594 gives `Sunset` an HTTP-date, unlike `Deprecation` above. The two
 * headers genuinely disagree on format; that is not a bug here.
 */
export function deprecationHeaders(
  notice: DeprecationNotice
): [string, string][] {
  return [
    ["Deprecation", toStructuredFieldDate(notice.effective)],
    ["Sunset", sunsetFor(notice.effective).toUTCString()],
    ["Link", `<${notice.link}>; rel="deprecation"`],
  ];
}
