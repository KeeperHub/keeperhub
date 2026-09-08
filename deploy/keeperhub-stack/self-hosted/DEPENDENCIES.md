# What KeeperHub talks to

This lists every network destination a KeeperHub install reaches, so you can decide what to
allow. It is a description of the software, not a policy: your network is yours to configure.

Read it in four parts, because the answer differs by phase. Building the images reaches one set
of hosts, installing reaches another, and the running product reaches a third. A fourth set is
reached only because one of your users configured a workflow step that does so.

Wherever something can be switched off or pointed elsewhere, the exact variable is named. Where
it cannot, this says so instead of leaving it out.

## The short version

KeeperHub operates almost nothing you depend on. In the whole install path there is exactly one
host we run:

| What | Host | Avoidable |
| --- | --- | --- |
| The Helm chart repository | `techops-services.github.io`, `github.com` | Yes. Set `CHART_REPO_URL` to a mirror, or `CHART_DIR` to install from a local copy |

There is no license server, no update check, no usage reporting, and no telemetry. No analytics
SDK is present among the project's 110 dependencies, and no analytics host appears in the source.
`better-auth` bundles a telemetry module, but it stays inert unless you set both
`BETTER_AUTH_TELEMETRY_ENDPOINT` and `BETTER_AUTH_TELEMETRY=true`, and the app sets neither.

Everything else in this document is third-party infrastructure that you configure and pay for, or
public blockchain endpoints.

## 1. Building the images

You only need this section if you build from source. The chart requires you to supply
`global.image.repository`, and there is no default, so building your own is the normal path.

| Host | Why | Avoidable |
| --- | --- | --- |
| `registry.npmjs.org` | package install | Point npm at your own mirror |
| Docker Hub | `node:24-alpine` base image | Retag through your own registry |
| `gcr.io` | distroless base for the sandbox image only | Same |
| `dl-cdn.alpinelinux.org` | Alpine packages | Alpine mirror |
| `fonts.googleapis.com`, `fonts.gstatic.com` | `next/font/google` fetches at build, then self-hosts the result. An offline build fails here | No, without changing the font setup |
| `truststore.pki.rds.amazonaws.com` | CA bundle for TLS to Amazon RDS | Yes. Build with `--build-arg RDS_CA_BUNDLE_URL=` to skip it. Only an RDS database needs it |
| `downloads.sentry-cdn.com` | `@sentry/cli` downloads a binary in its postinstall | Not without dropping the dev dependency |
| `sentry.io` | source-map upload | Already skipped unless `SENTRY_AUTH_TOKEN` is set |

### Values baked into the image

Next.js compiles `NEXT_PUBLIC_*` variables into the JavaScript it produces, so they are fixed
when the image is built and cannot be changed by configuration afterwards. Four of them identify
a specific KeeperHub account:

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
- `NEXT_PUBLIC_GITHUB_CLIENT_ID`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
- `NEXT_PUBLIC_SENTRY_DSN`

Build with your own values, or with none. If you ever receive a prebuilt KeeperHub image, check
these first: a Sentry DSN baked in that way sends your users' browser errors to whoever owns it,
and because the app proxies those events through its own `/monitoring` path, the request leaves
from your server rather than from the browser.

## 2. Installing

| Host | Why | Required |
| --- | --- | --- |
| `techops-services.github.io` and `github.com` | the Helm chart and its tarball | Only if you install from our repository. `CHART_REPO_URL` repoints it, `CHART_DIR` skips it |
| `raw.githubusercontent.com` | the CloudNativePG operator manifest, which you apply yourself | Only when the database is bundled. Not needed with `DB_MODE=byo` |
| `ghcr.io` | `cloudnative-pg/postgresql`, the bundled database image | Only with the bundled database |
| Docker Hub | `softwaremill/elasticmq-native`, the bundled queue | Only with the bundled queue |
| your own registry | the five KeeperHub images | Always. You choose the host |

The install itself contacts nothing else. Database migration and chain seeding run entirely
against your database: the seed scripts import only a Postgres driver and local modules, and make
no network calls. They do write third-party endpoint addresses into your `chains` table, which the
running product later calls - see the RPC entry below.

The chart assumes an ingress controller and, for TLS, a cert-manager `ClusterIssuer`. It does not
install either. It does not use External Secrets, and needs no AWS credentials.

## 3. What the running product contacts

### Needed for the product to work

| Service | Host | What it carries | Configuration |
| --- | --- | --- | --- |
| Blockchain RPC | ~17 public endpoints, e.g. `ethereum-rpc.publicnode.com`, `mainnet.base.org`, `api.mainnet-beta.solana.com` | wallet and contract addresses, calldata, signed transactions | `CHAIN_RPC_CONFIG`, or per-chain `CHAIN_<NAME>_PRIMARY_RPC`. None of the defaults is a host KeeperHub operates, and a test enforces that |
| Queue | `sqs.<region>.amazonaws.com` | workflow and execution ids, trigger payloads | Set `AWS_ENDPOINT_URL` to use the bundled in-cluster queue instead, which is what the bundled mode does |
| Cloudflare Turnstile | `challenges.cloudflare.com` | a captcha token and the client IP, on signup | See below |
| Email delivery | `api.sendgrid.com` | recipient address, signup codes, invite links | Required. Supply `SENDGRID_API_KEY` from your own SendGrid account and `FROM_ADDRESS` as a sender verified in it. The installer refuses without both. `SENDGRID_API_URL` points at any relay accepting SendGrid's v3 `mail/send` shape |
| Wallet signing | `api.turnkey.com` | wallet addresses and the payloads to be signed | `TURNKEY_API_BASE_URL`. Only used when wallets are configured |

**About Turnstile.** The server refuses to start without `TURNSTILE_SECRET_KEY`. That check runs
against a value compiled into the build, so declaring the environment non-production does not
avoid it. If you cannot use Cloudflare, set `TURNSTILE_DISABLED=true`. That is a real decision:
your signup endpoint then accepts automated requests, and the server logs a warning at every boot
saying so. Cloudflare publishes always-pass test keys, but those still contact Cloudflare on every
signup while verifying nothing, so the opt-out is usually the better answer.

### Optional, and how to stop each

| Service | Host | When | Off by |
| --- | --- | --- | --- |
| Location lookup | `ipapi.co`, `ipwho.is`, `freeipapi.com`, `ipinfo.io` | every sign-in | `GEOIP_ENABLED=false`. **Read this one.** These providers need no credential, so configuring nothing does not mean sending nothing - by default every signing-in user's IP address goes to them. Sessions show no location when it is off |
| Error reporting | whichever host your Sentry DSN names | any error | leave `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` unset. Note it reports personal data when enabled |
| Status page script | whatever you point it at | every page load | `STATUS_EMBED_SRC`, already unset by default |
| Marketing list | `connect.mailerlite.com` | every signup, sending the user's email | leave `MAILERLITE_API_KEY` unset. The group ids are KeeperHub's own, so this is not useful to you as-is |
| Signup notifications | `discord.com` | every signup, sending name and email | leave `DISCORD_WEBHOOK_SIGNUPS` unset |
| Billing | `api.stripe.com` | organisation billing details | leave `STRIPE_SECRET_KEY` unset |
| Paid workflows | `api.cdp.coinbase.com`, `rpc.tempo.xyz` | payer address, amount, signed authorisation | leave `X402_FACILITATOR_URL` and `MPP_SECRET_KEY` unset. `X402_FACILITATOR_URL` also accepts your own facilitator |
| AI workflow generation | `api.openai.com`, `api.anthropic.com`, or `ai-gateway.vercel.sh` | the user's prompt and their workflow graph | off unless `NEXT_PUBLIC_AI_PROMPT_ENABLED=true` |
| Contract ABI lookup | `api.etherscan.io`, Blockscout instances | contract addresses you inspect in the editor | endpoints come from your `explorer_configs` table, so edit the rows |
| Feedback | whatever you point it at | user submits feedback | `FEEDBACK_SERVICE_URL`, unset by default |
| Sign-in with GitHub or Google | `github.com`, `accounts.google.com` | OAuth exchange | leave the client id and secret unset |
| Token logos, email logo | `raw.githubusercontent.com` | rendering a token list; opening an email | `EMAIL_LOGO_URL` for the email one - set it empty to send no logo. Token logo addresses live in your database |
| Docs redirect | `docs.keeperhub.com` | someone requests `/llms.txt` | **Already off** in an image built by the self-hosted harness, which passes `DOCS_BASE_URL=` so the redirect is not compiled in. Build a different image and you inherit it: `next.config.ts` bakes redirects into the build, so no Helm value can remove it afterwards |

### Only because a user configured it

Workflow steps reach whatever the person who built the workflow told them to. That includes
arbitrary URLs through the Webhook and HTTP Request steps and the Code step, and fixed services
such as Discord, Telegram, Slack, SendGrid, Hyperliquid, Safe and Blockscout when a user adds
those steps with their own credentials.

Which of these exist at all is controlled by `plugins/plugin-allowlist.json`, applied when the
image is built. Trim it to the set you want to offer. Outbound URLs from the generic steps are
checked against private address ranges before the request is made.

## 4. What still says KeeperHub

Some things are deliberately left as constants, and you should know about them rather than
discover them.

- The support address in the help dialog, and the community and documentation links, are
  KeeperHub's. They are read by browser code, so making them configurable would mean baking them
  into the image at build time, which does not help anyone running a prebuilt image. A seam that
  cannot be used is worse than an honest constant.
- Wallet-only accounts get a synthetic address at `wallet.keeperhub.com`. It never receives mail
  and exists only as a marker. It is not configurable because the same check runs in the browser
  and on the server, and a value that differed between them would make the two disagree about
  which accounts are wallet accounts.
- Some API error messages point at `docs.keeperhub.com` for the request format.

## Known limitations

- **No sandbox is deployed.** The Code step needs one and fails with a connection error without
  it. Everything else works.
- **Signup needs working email, so SendGrid is required.** Verification codes, invitations,
  password resets and MFA step-up all go through the mail path, so an install with no working mail
  cannot complete a signup. `install.sh` therefore refuses to install without `SENDGRID_API_KEY`
  and `FROM_ADDRESS`. SendGrid is the only supported sender and there is no SMTP option.
- **A failed invitation send is invisible to the sender.** `sendInvitationEmail` returns false on
  failure rather than throwing, and the caller ignores that return value, so the only trace is a
  log line at warning level. The invitation row is written either way, so the inviter sees a sent
  invitation that nobody received. A revoked or wrong key looks the same as a working one on that
  path. Signup and MFA step-up do surface the failure, and the forgot-password route ignores it on
  purpose so it cannot be used to enumerate accounts. This is application behaviour and this
  profile does not change it.

## About this document

Written against this branch by reading the source. Counts here come from reading the matches, not
from counting search hits. `keeperhub-metrics-collector/` is not covered; it is disabled in this
profile.

If you find something reaching a host that is not listed, that is a bug in this document. Please
report it.
