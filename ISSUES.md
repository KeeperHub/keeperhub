# Issues before pull requests

Open an issue before you write code. We answer it, and once the problem and the
shape of the fix are agreed, the pull request is a short step rather than a
negotiation.

This is not paperwork. Every item below is something that has cost a real
contributor real work on this repo:

- A pull request corrected two lines that `staging` had already corrected, by
  another route, days earlier. The whole change was dead on arrival.
- A pull request reversed a decision recorded in a comment in the code, for
  good reasons the author had no way to know were already weighed.
- A pull request bundled two unrelated fixes, so the simple one waited on the
  hard one.

None of those are review problems. They are all answerable in a sentence before
any code is written.

## Search before you open anything

Search open **and** closed issues, and open pull requests, before you file.
The pull request half is the one people skip (`is:pr is:open` plus your
keywords), and it is the one that catches work already in flight.

Three things you can find, none of which needs a new issue:

- **An open issue covers it.** Comment there, and add what it is missing - your
  reproduction, the surface you hit it on, the version you checked. A second
  issue for the same fault splits the evidence across two threads.
- **A closed issue covers it.** The reason is in the closing comment and often
  still applies. If you have evidence it no longer does, say so on that issue;
  reopening a thread with new evidence is more useful than a fresh report.
- **An open pull request already changes it.** Comment on it or review it. A
  competing pull request for the same lines wastes the other contributor's work
  as surely as it wastes yours.

**A disagreement with an existing issue belongs in a comment on that issue**,
not in an issue of your own. Whether the scope is right, whether the plan is
right, whether it should be fixed at all - that is what the thread is for, and
it is where triage reads it. A second issue arguing with the first is closed as
a duplicate, and the argument is lost with it.

Open a new issue when yours is genuinely a different problem - a different root
cause, or a different surface with its own reproduction - even where the symptom
looks the same. Say what you found in the search and why yours is separate; that
saves triage from repeating it.

If an issue is `accepted` and unclaimed, say you are taking it before you start,
so two people do not build the same thing.

## When an issue is required

**Required** for anything that changes behaviour:

- Application, API, or CLI behaviour, including response shapes and status codes
- Database schema or migrations
- Authentication, permissions, validation, or rate limiting
- Dependencies added, removed, or upgraded
- Protocol definitions, contract addresses, ABIs, or the chains a protocol is
  offered on
- CI, build, deployment, or environment configuration
- Pricing, limits, plans, or anything a user is charged for
- New features and new abstractions

**Not required** - open a pull request directly:

- Typos, broken links, and formatting
- Documentation that corrects a statement to match code that already behaves
  that way
- Comment and error-message wording
- Declaring a dependency the code already imports, at the version already
  resolved

If you are unsure, open the issue. A wrong guess in that direction costs you a
day; the other direction can cost you the whole change.

## Reason, scope, plan

Every issue carries three things. An issue missing any of them cannot be
answered, only discussed, and discussion is what this policy exists to replace.

**Reason** - why this matters, in evidence rather than assertion. For a bug that
is a runnable reproduction, what happened, what you expected, *what told you to
expect it*, and what it costs someone who hits it. For a change it is the task
you cannot accomplish and what the workaround costs.

The "what told you to expect it" part settles more issues than anything else. An
expectation comes from somewhere - a docs page, an error message, a type, a
function name. Naming that source tells us immediately whether the code is wrong
or the source is, and those have completely different fixes.

**Scope** - what this covers and, explicitly, what it does not. Which surfaces
you checked and found fine. Whether the same fault plausibly exists on sibling
routes or commands. A fix applied to one route and not its three siblings is a
recurring failure here, and scope is where it gets caught.

Scope is also where you confirm this is *one* issue. If any part could be fixed
and shipped while another part stays broken, those are separate issues. See
[Should this be one change](#should-this-be-one-change).

**Plan** - what should happen next. This is your proposal, not a commitment we
have made, and triage may replace it.

A plan does not require knowing the fix. If you cannot see the codebase, *"I do
not know the fix; here is what I would need to determine to choose one"* is a
complete and useful plan. What is not acceptable is leaving it blank: a problem
with no proposed next step puts the entire cost of thinking on whoever reads it,
which is exactly the load this policy is meant to move upstream.

What a plan buys you is a check nothing else provides. A proposal stated out
loud can be tested against the actual contract before any code exists - and a
well-evidenced issue can still carry a wrong plan. One report here correctly
observed that `parseNativeValueWei`, since renamed to
`parseNativeValueEther`, parses with `ethers.parseEther`, and
proposed denominating `value` in wei. The observation was right; the plan would
have silently changed every existing caller's amount by a factor of 1e18,
because the API's documented unit is ether and the misleading thing is the
internal function name. That was caught by reading the plan. Unwritten, it would
have been caught by reading the pull request.

### Contract addresses carry their evidence

An issue that adds a protocol, or adds a chain to one already here, is answered
from its addresses. So they have to be in it, each with the authoritative source
it came from - the protocol team's published addresses, their official
repository, or a verified contract on the block explorer - and each ABI with the
URL and the version it belongs to.

This is the same standard the rest of this page asks for - *what told you to
expect it* - applied to a claim about a chain. "Aave V3 is on Base" is an
assertion; Aave's own deployed-addresses page naming that Pool contract on Base
is the evidence. The two are not close to each other in value, because the first
one is sometimes true and reads identically when it is not.

An address is the one kind of mistake here that no reviewer catches by reading.
It is forty hex digits, it is correct or it is not, and a wrong one is
indistinguishable from a right one until it reverts on chain. A chain listed in
a protocol's `addresses` map is a chain users can select
(`lib/protocol-registry.ts:395`), so the failure is not latent - it belongs to
whoever picks that chain from the dropdown, in production, holding real funds.

Two specific things, because both have gone wrong here before:

- **A chain the protocol is not deployed on never goes in the map**, including
  to make local testing easier. If there is no testnet deployment, the tests
  fork mainnet instead.
- **Token decimals come from calling `decimals()` on the chain**, not from the
  symbol and not from the explorer's metadata field. USDC is 6.

The full requirements, including which ABI sources count and in what order, are
in [CONTRIBUTING.md](CONTRIBUTING.md#protocols-and-contract-addresses).

### Already filed an issue

Nothing here applies retroactively. Issues filed before this page existed are
triaged on what they contain, and you will never be asked to resubmit one to
match a template that did not exist when you wrote it.

More generally, and for new issues too: **you will not be asked to restate
something you have already said.** If triage needs one more fact, it asks for
that fact, on your issue. The forms exist so we can answer in one pass, not as a
standard you have to be measured against.

If an issue turns out to hold several problems, we split it and credit you on
each part. Finding several problems is the work; refiling them is not.

## What happens to your issue

| Label | Meaning |
|---|---|
| `needs-triage` | Received, not yet read. Applied automatically. |
| `confirmed` | Someone reproduced it. Says nothing yet about whether we will fix it. |
| `accepted` | Reason, scope and plan all stand. Write the pull request. |
| `needs-discussion` | Real, but the scope or the plan is not settled. Do not start yet. |
| `wontfix` / `duplicate` / `invalid` | Closed, with the reason in a comment. |

**`accepted` is the signal to start.** It is what the pull request gate checks
for. Nothing else on the issue means "go" - `confirmed` in particular does not,
because reproducing something is not the same as deciding to change it.

**`accepted` accepts a specific plan.** If triage takes your reason and scope but
replaces your plan, it says so in a comment before applying the label, and that
comment is the plan. Build against it, not against the one you filed. An
`accepted` label with no comment means your plan as written was accepted as
written.

We aim to triage within two working days. If an issue has sat longer than that,
comment on it - that is not nagging, it is the correct response, and it is the
fastest way to get it moving.

**Check it is still there.** `staging` moves quickly. Confirm the behaviour on
the current default branch before filing, and say which commit you checked.

## Should this be one change

Apply this to each seam you can see in what you are proposing:

> Can piece A ship, deploy, and be correct with piece B absent or reverted?

If yes for every pair, they are separate issues and separate pull requests, no
matter how small. If any piece is only correct in the presence of another - a
schema migration and the backfill that depends on it, an interface change and
all its callers - they are one unit, no matter how large.

Diff size is not the test. A large, genuinely coupled change is one pull
request. Two small independent fixes are two.

## Opening the pull request

Once your issue carries `accepted`:

1. **Reference the issue from the pull request.** The title is the place for
   it, after the conventional commit type:

   ```
   fix: #1978 return 403 with a body on public /api/chains
   feat(cli): #2014 add --require-verified to execute status
   ```

   `Closes #1978` in the description or an `issue-1978` branch name also
   satisfies the check; a bare number in a branch name does not. The
   `pr-title-check` workflow already accepts this title shape; a separate
   check, `check-issue-link`, resolves the issue number and confirms the issue
   carries `accepted`.

2. Fill in the pull request template. The description explains what and why -
   the diff already shows how.

3. Target `staging`.

Pull requests that need no issue (the list above) are exempt from the check
automatically when their type is `docs`, `chore`, or `style`. Anything else
without an accepted reference is failed by CI, which leaves a comment on the
pull request saying what it found and what to do. The check reruns on every
push and edit, but not when the issue's labels change: once `accepted` lands,
edit the title or re-run the job. A maintainer can apply `no-issue-required` to
exempt a pull request the rules did not anticipate.

## Security

Do not open an issue for a vulnerability, and do not open a pull request that
fixes one in public. Use [GitHub Private Vulnerability
Reporting](https://github.com/KeeperHub/keeperhub/security) or the email address
in [.github/SECURITY.md](.github/SECURITY.md), which also states what is in and
out of scope.

## Related

- [CONTRIBUTING.md](CONTRIBUTING.md) - setup, workflow, testing, plugin
  development
- [docs.keeperhub.com](https://docs.keeperhub.com) - product and API reference
