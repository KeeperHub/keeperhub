/**
 * Session lifetime used when minting a session outside better-auth's own
 * sign-in flow: the OAuth MFA finalize route, TOTP enrolment, IP verification
 * and the dev session minting script each re-derived this, so four independent
 * copies decided how long a stepped-up session lived.
 */

import { WEEK_MS } from "@/lib/utils/duration";

export const DEFAULT_SESSION_TTL_MS = WEEK_MS;
