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

## When an issue is required

**Required** for anything that changes behaviour:

- Application, API, or CLI behaviour, including response shapes and status codes
- Database schema or migrations
- Authentication, permissions, validation, or rate limiting
- Dependencies added, removed, or upgraded
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
observed that `parseNativeValueWei` parses with `ethers.parseEther`, and
proposed denominating `value` in wei. The observation was right; the plan would
have silently changed every existing caller's amount by a factor of 1e18,
because the API's documented unit is ether and the misleading thing is the
internal function name. That was caught by reading the plan. Unwritten, it would
have been caught by reading the pull request.

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

1. **Reference the issue in the pull request title**, after the conventional
   commit type:

   ```
   fix: #1978 return 403 with a body on public /api/chains
   feat(cli): #2014 add --require-verified to execute status
   ```

   This mirrors the internal `fix: KEEP-1234 description` convention. The
   `pr-title-check` workflow already accepts this shape; a separate check
   resolves the issue number and confirms the issue carries `accepted`.

2. Fill in the pull request template. The description explains what and why -
   the diff already shows how.

3. Target `staging`.

Pull requests that need no issue (the list above) are exempt from the check
automatically when their type is `docs`, `chore`, or `style`. Anything else
without a reference is failed by CI with instructions. A maintainer can apply
`no-issue-required` to exempt a pull request the rules did not anticipate.

## Continuing an existing issue

Someone may have filed it already. Search open **and** closed issues first - a
closed one often carries the reason, and reopening that thread with new evidence
is more useful than a fresh report.

If an issue is `accepted` and unclaimed, say you are taking it before you start,
so two people do not build the same thing.

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
