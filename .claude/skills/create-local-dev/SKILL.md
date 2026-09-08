---
name: create-local-dev
description: Bring a fresh KeeperHub worktree to a signed-in Chromium window against the shared local Docker Postgres in one command, without going through the signup UI. Use when starting work in a new worktree, when "I'm not signed in to localhost:3000", or any time you need an authenticated browser session for local manual testing. Avoids the ~30 tool-call signup -> OTP -> MFA -> TOTP loop by reusing in-codebase session helpers, then auto-opens a Chromium window with the cookie already loaded.
---

# Local-dev one-command sign-in

This skill is the fast path from a fresh worktree to a signed-in browser.

It does not touch any production auth code: it composes Drizzle inserts
and the existing `signSessionCookieValue` / `hashSessionToken` helpers from
`lib/auth-session-token-hash.ts`, then loads the cookie into a Playwright
Chromium profile and launches it detached.

Hostname guard refuses to run unless `DATABASE_URL` resolves to a local
Postgres host. The standalone `dev:mint-cookie` additionally requires
`KEEPERHUB_DEV_MINT=1`; `dev:login` sets that env var for its mint child
because invoking `dev:login` is itself the explicit acknowledgement.

## When to invoke

- You opened a new worktree and the app at `localhost:3000` is anonymous.
- The user asks to "log in locally" / "sign in for testing".
- A manual-test task needs a real authenticated session (workflow list,
  org-scoped endpoints, anything that goes through `getDualAuthContext`).

Do NOT invoke this skill against staging or prod. The script will refuse
on hostname grounds. Do not try to defeat that guard.

## The one command

```bash
pnpm dev:login
```

Optional override: `pnpm dev:login some-other@email`. Default is
`dev@keeperhub.local`.

What it does, in order:
1. Asserts the local-DB hostname guard.
2. Runs `pnpm dev:bootstrap` (idempotent): backfills the drizzle journal
   only if the schema was bootstrapped via `db:push`, runs `pnpm db:migrate`,
   seeds the persistent e2e users plus a dev user/org/membership, pre-trusts
   `127.0.0.1` + `::1` in `user_trusted_ips`, marks the dev user
   `twoFactorEnabled=true` so the proxy MFA gate lets them through,
   binds the local `kh` CLI token from `~/.config/kh/hosts.yml`, and
   upserts 8 workflow fixtures (Manual / Schedule / Webhook / Event,
   on+off, plus a soft-deleted row).
3. Mints a Better Auth session row (matches the shape of
   `app/api/auth/oauth-mfa-finalize/route.ts`) and writes the signed cookie
   to `.claude/.dev-session-cookie-LOCAL`.
4. Seeds that cookie into a Playwright-managed Chromium persistent profile
   under `.claude/.dev-chrome-profile/` (gitignored).
5. Spawns Chromium detached against `http://localhost:3000` with that
   profile. The terminal returns. The Chromium window is independent from
   the user's normal Chrome (separate user-data-dir).

Re-running `pnpm dev:login` just refreshes the cookie inside the same
profile, so the user can keep the window open across sessions.

## Lower-level commands (rarely needed)

- `pnpm dev:bootstrap` -- DB setup only, no cookie or browser. Use for CI
  or when scripting against the seeded fixtures via the kh CLI.
- `KEEPERHUB_DEV_MINT=1 pnpm dev:mint-cookie <email>` -- mint a cookie file
  only, no browser. Use when you want the signed value for manual paste
  into another browser, or for headless cookie-driven scripts.

## Boundaries

- Do NOT modify `lib/auth.ts`, `lib/auth-session-token-hash.ts`, or any
  `app/api/**` route to weaken the auth flow for local convenience. This
  whole skill exists precisely so we never need to.
- Do NOT commit `.claude/.dev-session-cookie-LOCAL` or
  `.claude/.dev-chrome-profile/` (gitignored already).
- Do NOT add an env override that lets the mint script run against a
  non-local DB. There is no legitimate reason to forge a session against
  staging or prod.
- Chromium is launched detached. The script exits as soon as the browser
  is up; closing the script does not close the browser.
