<!--
Title format:  <type>: #<issue> <description>
    fix: #1978 return 403 with a body on public /api/chains
    feat(cli): #2014 add --require-verified to execute status

The issue must carry the `accepted` label before you open this. See ISSUES.md.
Exempt: docs / chore / style changes from the "no issue required" list.
-->

## Issue

Closes #

<!-- If this needs no issue, say which exemption applies and delete the line above. -->

## What this changes

<!--
What the diff does and why. The diff already shows how.
Name anything a reader would not predict from the title: touched CI or config,
a new dependency, a changed default, an altered auth or validation path.
-->

## Scope

<!--
Confirm this is one change: could any part of it ship, deploy, and be correct
with the rest reverted? If yes, split it. If the parts are interdependent, say
why in one line - "the migration cannot deploy without the backfill".
-->

## How it was verified

<!--
Tests added or updated, and what they would catch. Commands you ran.
For a bug fix, the test that fails without the fix.
-->

## Screenshots

<!--
Required for anything that renders. Before and after, each state the change
touches (empty, loading, error), and both themes if colour or contrast moved.
Delete this section if the change renders nothing.
-->

---

- [ ] Targets `staging`
- [ ] Title carries the issue number, or an exemption applies
- [ ] `pnpm check` and `pnpm type-check` pass
- [ ] No secrets, `.env` files, or credentials committed
