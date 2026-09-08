/**
 * F-022 / KEEP-747: the OAuth consent page renders and shows the user a
 * specific organization, and the approve form carries that org id back as a
 * hidden field. The access code is scoped to the org resolved from the
 * cookie-derived active session at submit time -- which can differ from the one
 * the user saw if they switched their active org in another tab between viewing
 * the page and clicking Approve. There is no UI signal for the org, so such a
 * switch would silently mint a token for an unintended org.
 *
 * Returns true when the org resolved at submit time no longer matches the org
 * the user consented to; the caller must refuse the authorization rather than
 * scope the token to a different org. A missing bound id (e.g. an older form)
 * is treated as no mismatch so the guard never breaks a legitimate flow.
 */
export function isConsentOrgMismatch(
  consentedOrgId: string | null | undefined,
  currentOrgId: string
): boolean {
  return Boolean(consentedOrgId) && consentedOrgId !== currentOrgId;
}
