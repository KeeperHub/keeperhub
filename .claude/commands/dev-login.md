---
description: Bootstrap the local DB, mint a session cookie, and open a signed-in Chromium window at localhost:3000 -- one command, no manual paste.
---

Run one command. It does the bootstrap, the mint, ensures the dev server
is serving `localhost:3000` (starting `pnpm dev` detached if nothing is
listening yet), the cookie injection, and opens a detached Chromium window
already signed in as `$1` (default `dev@keeperhub.local`):

```bash
pnpm dev:login "${1:-dev@keeperhub.local}"
```

The window is a separate Chromium instance (its own user-data-dir under
`.claude/.dev-chrome-profile/`), so it does not touch the user's normal
Chrome. The terminal returns as soon as the browser launches.

Hard refusals to respect:
- The script refuses to run if `DATABASE_URL` host is not local. Do not
  edit that guard, and do not run this against staging or prod.
- Do not commit `.claude/.dev-session-cookie-LOCAL` or
  `.claude/.dev-chrome-profile/` (gitignored).

If the user wants only the cookie file (no browser) for a manual paste
into their normal Chrome, run instead:
```bash
KEEPERHUB_DEV_MINT=1 pnpm dev:mint-cookie "${1:-dev@keeperhub.local}"
```

If they only need the DB set up (no cookie, kh CLI only), run:
```bash
pnpm dev:bootstrap
```
