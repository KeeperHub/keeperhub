/**
 * Host an MPP challenge is issued for.
 *
 * router.ts and mpp/server.ts both mint challenges and each computed this
 * inline from NEXT_PUBLIC_APP_URL, stripping the protocol and a trailing
 * slash with their own private copies of both regexes. A realm that
 * disagreed between the two would produce challenges the server will not
 * verify, so it has to be one function.
 *
 * It lives here rather than in mpp/server.ts because the challenge builder in
 * router.ts is not otherwise a client of the MPP server, and tests that mock
 * that module should not have to know how a realm is derived.
 */

import { stripTrailingSlashes } from "@/lib/utils/url";

const RE_PROTOCOL = /^https?:\/\//;

export function resolveRealm(): string {
  return stripTrailingSlashes(
    (process.env.NEXT_PUBLIC_APP_URL ?? "app.keeperhub.com").replace(
      RE_PROTOCOL,
      ""
    )
  );
}
