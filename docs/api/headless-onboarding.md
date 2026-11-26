---
title: "Headless and Agent Onboarding"
description: "From an organization API key to a first executed transaction without a browser - creating the key, funding the right wallet, and gas."
---

# Headless and Agent Onboarding

Agents, CI jobs and scripts run without a browser. Account creation takes one,
once: email sign-up, wallet sign-in and guest sessions all carry a Cloudflare
Turnstile check. Create the account and an organization API key in the
dashboard, and every step after that is reachable over HTTP with the `kh_` key.

| Step | Call |
|---|---|
| Create an account and a key | Once, in the dashboard: Settings > Developer > API keys > Organisation keys |
| Find the wallet to fund | `GET /api/user` -> `walletAddress` |
| Execute | `POST /api/execute/transfer` with `simulate: true`, then without |

Send the key as `Authorization: Bearer kh_...` on every call. A client that
authenticates purely with a `kh_` bearer key sends no cookies, so it needs no
`Origin` header either.

## 1. Create the account and the key in the dashboard

Sign in at [app.keeperhub.com](https://app.keeperhub.com) with an email address
or a wallet. The first sign-in creates:

- A user. For a wallet account the email is synthetic,
  `<address>@wallet.keeperhub.com`, and is never delivered to, so wallet accounts
  receive no verification mail and no signup notifications.
- An organization with that user as owner, and an organization wallet (step 3).

Then create an organization key under Settings > Developer > API keys >
Organisation keys. The full `kh_` key is shown once; store it as a secret. The
script at the bottom of this page reads it from `KH_API_KEY`.

The account-creating routes (`/api/auth/sign-up/email`, `/api/auth/siwe/verify`
and `/api/auth/sign-in/anonymous`) answer a request without a Turnstile token
with `400`:

```json
{ "message": "Missing CAPTCHA response", "code": "MISSING_RESPONSE" }
```

## 2. Manage keys over the API

To create or revoke keys from code rather than the dashboard, call
`POST /api/keys` from a signed-in session: a `kh_` key cannot mint another key,
and the route is additionally step-up gated. Session calls carry the session
cookie and an `Origin` header. On `/api/auth/*` a missing `Origin` is rejected
with `403` and `MISSING_OR_NULL_ORIGIN`; elsewhere a `POST`, `PATCH`, `PUT` or
`DELETE` that carries a session cookie without it answers `403`
`{"error":"Invalid origin"}`, and `Referer` is accepted when `Origin` is absent.

The first call returns `401`:

```json
{
  "error": "Confirm this action to continue.",
  "code": "signature_required",
  "challenge": "KeeperHub action confirmation\n\nAction: org_api_key_manage\nNonce: 1a45b746114d0bdf9a5bec04335fd78b",
  "required": ["wallet"]
}
```

Sign `challenge` verbatim with `personal_sign` (EIP-191), using the account you
signed in with, and repeat the request with the signature added to the JSON
body:

```ts
const first = await post("/api/keys", { name: "my-agent" });
// first.code === "signature_required"

const key = await post("/api/keys", {
  name: "my-agent",
  signature: await account.signMessage({ message: first.challenge }),
});
// key.key is the full kh_ key, returned once and never again
```

Details that otherwise cost debugging time:

- The extra fields go in the **request body**, not in headers.
- The nonce is single-use, expires after five minutes, and **a fresh one is
  minted whenever a factor is missing** - that is, on a `401` carrying
  `signature_required` or `factors_required`. Sign the challenge from that
  response. A `401` carrying `wallet_signature_invalid` means the signature you
  sent did not verify: it mints nothing and carries no `challenge`, so a client
  that blindly reads `challenge` off every `401` will sign `undefined`. Retry by
  re-requesting the challenge, not by reusing the old one. A client that caches
  the first challenge does not fail forever on `wallet_signature_invalid`; it
  fails about ten times and is then locked out - see the budget below.
- **The retry budget is ten requests per fifteen minutes**, counted per user and
  per action on a sliding window. Every request to a gated route consumes one,
  including the one that only mints the challenge, so the two-step create above
  costs two. Exceeding it returns `429` with `"code": "rate_limited"` and a
  `Retry-After` header. A step-up that succeeds resets the counter to zero, so
  the ten is a budget for consecutive failures, not a daily quota: a client that
  gets the protocol right never approaches it, and a client that caches the
  challenge burns it without a single success.
- The signature must be recoverable to the wallet KeeperHub has on file, which
  is the user's primary linked wallet. For a wallet-only account that is the
  address you signed in with; for an account with several linked wallets it is
  the primary one, which need not be the one this session used.
- `required` lists every factor the action needs. A wallet account that has
  additionally enrolled TOTP or a step-up email must satisfy all of them in the
  same retry, as `signature`, `code` (TOTP) and `emailOtp`. When only the
  non-wallet factors are missing the code is `factors_required` rather than
  `signature_required`.

`DELETE /api/keys/{keyId}` is gated by the same `org_api_key_manage` action, so
a headless client has to answer the challenge to clean up after itself too. The
same challenge-and-retry protocol guards the other step-up actions, including
wallet withdrawal, private-key export, session revocation, account
deactivation, email and password changes, agentic-wallet approvals, TOTP removal
and audit-log export.

Key creation and revocation additionally require an organization role of admin
or owner. The role is checked before the step-up, so a member gets `403` with
`"code": "not_admin_or_owner"` and never sees a challenge - a signature is not
the missing piece, and no amount of retrying will produce one. The account that
created an organization is its owner, so it always clears this.

## 3. The wallet to fund is not the wallet you signed in with

Execution is organization-scoped. Transactions are signed by the organization's
wallet, which is provisioned for you and is a **different address** from the one
you authenticated with. Reading it from `GET /api/user` is the fastest way:

```json
{
  "id": "QB3PWiFqBLcr2NmuTHULLllvpwaLaBZM",
  "email": "0x90ee...4ac@wallet.keeperhub.com",
  "providerId": "siwe",
  "walletAddress": "0x0bdf..."
}
```

`walletAddress` on this response is the **active organization's** wallet, not the
caller's login address. See [User API](/api/user).

The other way is to simulate the write you intend and read `from`:

```json
{
  "success": true,
  "status": "simulated",
  "from": "0x0bdf...",
  "to": "0x90ee...",
  "value": "10000000000000",
  "gasEstimate": "21227",
  "wouldRevert": false
}
```

`from` is the address that would sign, so it is the address that has to hold the
funds.

## 4. Gas on the sponsored chains

The [Hackathon Quickstart](/platform-reference) says to fund the wallet with native gas
first. On the chains Turnkey's Gas Station covers, that is only true of the
value the transaction moves: Ethereum, Polygon, Base and Arbitrum, plus Ethereum
Sepolia, Polygon Amoy, Base Sepolia and Arbitrum Sepolia. The transaction is
signed and sponsored in a single Turnkey call and broadcast by a relayer that
pays the gas, and the organization wallet is debited only for what it sends.
Measured on Base: a 0.00001 ETH transfer left the organization wallet exactly
0.00001 ETH lighter, with the gas paid by the broadcasting relayer, and a
self-transfer from the same wallet left its balance unchanged to the wei.
Measured on Base Sepolia: an organization wallet holding zero wei landed the
zero-value transfer the script below sends, so a first run needs no funding.

Sponsorship is a preflight, not a guarantee. Being on the chain list is
necessary but not sufficient - several further conditions are checked, none of
them visible from the client, among them whether sponsorship is enabled on the
deployment, whether the organization's wallet has a Turnkey sub-organization,
whether gas credit remains for the billing period, whether the write is routed
through a Safe or a private mempool, and whether Turnkey accepts the activity.
[Gas Sponsorship](/wallet-management/gas) owns that list and the plan
allowances; treat it as the source of truth rather than this page.

When any condition fails, the runtime falls back to direct signing and the
wallet pays its own gas. The immediate execute response does not report which
path was taken, but the status response does - check the `sponsored` field, as
described in
[Direct Execution](/api/direct-execution). "The organization wallet does not
need gas at all" therefore holds only while every condition does, and on
Ethereum mainnet an allowance measured in dollars is measured in transactions.
On the testnets it holds for as long as sponsorship is on, which is why the
script below defaults to Base Sepolia. A small native balance remains the safe
default on mainnet.

Two consequences when reading the transaction back:

- The onchain `from` is the relayer, not your wallet, and the top-level
  `to`/`value` belong to the delegation wrapper - the transfer itself appears as
  an internal call. A block explorer's summary line showing `0 ETH` does not
  mean nothing moved. Treat the `transactionHash` and `transactionLink` from
  `GET /api/execute/{executionId}/status` as the authoritative record.
- The organization wallet is an EOA carrying an EIP-7702 delegation. The
  delegation is installed by a type-4 transaction the first time it is needed;
  later writes from the same wallet are ordinary type-2 transactions.

## 5. Simulate, execute, confirm

From here the normal [Direct Execution](/api/direct-execution) rules apply:
simulate with the same body you intend to send, then send it once with an
`Idempotency-Key` so an interrupted client can retry without double-executing,
then poll `GET /api/execute/{executionId}/status`.

### The IDs in the direct-execution flow

The identifiers in this flow are not interchangeable:

| Term | Where it comes from | What it identifies |
|---|---|---|
| Execution ID (`executionId`) | `POST /api/execute/transfer` (or any direct-execution route) | One attempt to run something: an opaque 21-character nanoid with no distinguishing prefix. Polled via `GET /api/execute/{executionId}/status`. |
| `transactionHash` | The status response once it is broadcast | The onchain transaction this execution sent. A direct execution that broadcasts has exactly one: the status response carries it in `transactionHash`, and `receipts` holds its verification result (status, block, gas) as of settle time - the chain may not have answered yet, in which case the entry records `timeout` or `not_found` and the execution stays non-terminal. An execution that never broadcasts leaves `receipts` as an empty array. |
| `transactionLink` | The same status response | A block-explorer URL for that `transactionHash` - a convenience, not a separate identifier. |

The rule that keeps them straight: an execution is **one attempt**, and a
transaction is **what actually landed onchain**. A queued execution (one the
server has accepted and is yet to run) does not mean a transaction exists yet.
See [Zero to a Verified Onchain Transaction](/guides/first-verified-transaction)
for the full walkthrough of confirming the transaction actually landed.

(Workflow executions are a separate surface: their ids come from the same
`generateId()` and are indistinguishable by shape from a direct-execution id -
what differs is the poll route, `/api/workflows/executions/{executionId}/status`
rather than the direct-execution route above.)

## 6. Your first transaction should move zero

A brand-new organization wallet holds nothing, so a first run with a non-zero
`amount` never reaches the chain. It fails inside the simulator as:

```
Simulation reverted: missing revert data (action="estimateGas", data=null,
reason=null, transaction={...}, invocation=null, revert=null,
code=CALL_EXCEPTION, version=6.16.0)
```

That message names neither the balance nor the wallet, so on a first run it
reads as a broken endpoint rather than an empty account - and the obvious next
moves, re-checking the API key or re-reading this page, are all wrong.

Send `amount: "0"` instead. A zero-value self-transfer is a real, mined,
independently verifiable transaction, and because the relayer pays the gas
(section 4) a wallet that has never held a wei can land one. That gets you a
transaction hash on the first attempt, with no faucet and no bridge, and proves
the whole path end to end before any value is at stake.

Once you do move value, read the balance first and say the real reason yourself:

```ts
const balance = await publicClient.getBalance({ address: user.walletAddress });
if (parseEther(amount) > balance) {
  throw new Error(
    `Fund ${user.walletAddress} on chain ${chainId} - it holds ${formatEther(balance)}`,
  );
}
```

## Full script

Finds the organization wallet and executes a transfer with an organization key.
No browser once the key exists. It defaults to Base Sepolia, where the run costs
nothing; raise it to a mainnet only once you mean to. Needs Node 18 or newer, or
Bun.

```ts
const BASE = "https://app.keeperhub.com";
// Base Sepolia. Sponsored exactly like the mainnets, and testnet gas is not
// metered against the credit allowance, so this run needs no funding at all.
// Base mainnet is 8453 - switch once the wallet printed below holds something.
const CHAIN_ID = 84_532;

const auth = { Authorization: `Bearer ${process.env.KH_API_KEY}` };

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...auth,
      ...(init.headers as Record<string, string>),
    },
  });
  // Not every response is JSON: a 429 or an edge error can be text or HTML,
  // and res.json() would throw over the status you actually need to read.
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { error: text.slice(0, 300) } };
  }
}

function must<T>(res: { status: number; body: T }, what: string): T {
  if (res.status >= 400) {
    throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// 1. The wallet that needs funding is the organization wallet.
// Provisioning is kicked off in the background on first sign-in, so
// walletAddress can still be null for a few seconds after the account exists.
// The route reports a pending or failed lookup as null rather than as an
// error, so poll rather than treating the first null as fatal.
let user = must(await api("/api/user"), "user");
for (let i = 0; !user.walletAddress && i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  user = must(await api("/api/user"), "user");
}
if (!user.walletAddress) {
  throw new Error("no organization wallet on this account yet - retry shortly");
}
console.log("fund this address:", user.walletAddress);

// 2. Simulate, then execute once with an idempotency key.
// amount "0" on purpose: a new organization wallet is empty, and a zero-value
// self-transfer still lands a real, verifiable transaction because the relayer
// pays the gas. Raise it only after the wallet above is funded (section 6).
const transfer = {
  chainId: CHAIN_ID,
  recipientAddress: user.walletAddress,
  amount: "0",
};
// Not wrapped in must(): a would-revert simulation is reported as HTTP 400, so
// must() would throw the raw response before this check could read it.
const sim = await api("/api/execute/transfer", {
  method: "POST",
  body: JSON.stringify({ ...transfer, simulate: true }),
});
if (sim.status >= 400 || !sim.body.success || sim.body.wouldRevert) {
  throw new Error(`simulation says this would fail: ${JSON.stringify(sim.body)}`);
}
const exec = must(
  await api("/api/execute/transfer", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(transfer),
  }),
  "execute"
);

// 3. The status response carries the authoritative onchain proof.
const status = must(await api(`/api/execute/${exec.executionId}/status`), "status");
console.log(status.status, status.transactionLink);
```
