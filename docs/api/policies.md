---
title: "Policies"
description: "KeeperHub Policies - organization rules that bound what workflows, agents and members may do."
---

# Policies

A policy is a rule your organization writes once that binds every path into the
platform. The same rule applies to a workflow node, a direct API call, the MCP
server and the CLI, because the check sits at the points where work happens
rather than at each entry point.

Every way of starting a workflow reaches the same executor, so a rule applies
the same whether a person pressed Run or a schedule, a webhook, a chain event,
a new block or a transfer started it. Every way of signing reaches the same
check, so a rule about an address holds whether the transaction was assembled
by a workflow, by a direct call, or by a payment path that builds its own.

Reading policy requires the admin or owner role. Changing policy requires the
owner role.

## How a policy is built

A policy has two halves.

**`manages`** names what the policy claims authority over. Anything no policy
claims is unmanaged and passes through untouched.

**`statements`** are the rules. Inside a claimed scope the default is refusal,
and you grant activity back with `allow` statements.

That split is what makes policy safe to introduce. An organization that writes
one policy about lending has not changed how its notifications work.

```json
{
  "schemaVersion": "2026-08",
  "name": "Treasury bounds",
  "enforcement": "enforce",
  "manages": ["kh:chain/8453/contract/*/**"],
  "statements": [
    {
      "sid": "transfers-under-a-daily-budget",
      "effect": "allow",
      "capability": ["asset.transfer.native"],
      "resource": ["kh:chain/8453/contract/*/fn/*"],
      "limit": [
        { "metric": "usd", "window": "1d", "max": "1000", "scope": "organization" }
      ]
    }
  ]
}
```

## Which rule wins

Every governed action produces one decision, in this order:

1. **Is anything managing this?** No, and the action is allowed and recorded as
   unmanaged.
2. **Does any `deny` match?** Yes, and the action is refused. A deny cannot be
   overridden by anything.
3. **Does any `allow` match?** Yes, and its limits are reserved. The action
   proceeds if the reservation succeeds.
4. **Otherwise the action is refused**, because the scope is managed and
   nothing permits this.

Two consequences are worth knowing before you write your first policy.

**Allows combine across policies.** If two policies both manage transfers and
each allows a different recipient, both recipients are permitted. Adding a
policy can therefore widen what is permitted.

**A deny is the only rule that cannot be widened.** If you want a ceiling that
no other policy can raise, write it as a deny.

**Claiming a scope without granting anything back stops all activity in it.**
This is the most common authoring mistake. Claim lending, write only a deny for
borrowing, and supplying stops too, because it is managed and nothing permits
it. The simulator shows this before anything depends on it.

## Exceptions

There is no `except` keyword. An exception is expressed in one of three ways,
and which one you want depends on whether the exception must survive other
policies.

**A deny with a narrower allow.** The deny wins wherever it matches, so scope
it to what you actually want refused and let a separate allow cover the rest.

```json
"statements": [
  { "sid": "no-approvals-to-anyone-else", "effect": "deny",
    "capability": ["asset.approve"],
    "condition": { "spender": { "notIn": ["kh:addressbook/*"] } } },
  { "sid": "approvals-to-the-address-book-are-fine", "effect": "allow",
    "capability": ["asset.approve"] }
]
```

**A negative operator.** `notIn`, `neq`, `notInCidr` and `notInDomain` carve a
case out of a single rule without needing a second statement.

**A narrower resource.** Naming one function rather than a whole contract is an
exception expressed in the identifier, and it is the clearest form when the
exception is about which functions may be called.

Prefer the deny form when the exception must hold no matter what other policies
say. Prefer the operator form when the rule is genuinely one rule.

## Identifiers

Two namespaces. Your organization is implicit, so it never appears.

```
capability      what is being done, as a dotted path
kh:...          what it is done to, as a path of type and id pairs
```

The canonical form for an onchain call:

```
kh:chain/8453/contract/0xa238dd80c259a72e81d7e4664a9801593f98d1c5/fn/0x617ba037
```

`*` matches one segment. `**` matches the rest. `fn/none` matches a bare native
transfer, which carries no function selector.

Functions are identified by their four byte selector, not their signature,
because the selector is what appears on the wire and is what the check at
signing time can see. Signatures are an authoring convenience and are converted
when the policy is saved.

Addresses are matched case-insensitively on EVM chains and exactly on Solana,
where base58 encodes no case information to normalise.

Control plane objects use the same grammar with a flat shape:

```
kh:workflow/*        kh:integration/*      kh:policy/*
kh:apikey/*          kh:addressbook/*      kh:member/*
```

## Capabilities

A capability is the verb. A statement matches only when **both** its capability
and its resource match, so a rule naming the right contract and the wrong verb
never applies.

Onchain: `asset.transfer.native`, `asset.transfer.token`, `asset.approve`,
`asset.permit`, `contract.read`, `contract.write`,
`protocol.lending.supply`, `protocol.lending.withdraw`,
`protocol.lending.borrow`, `protocol.lending.repay`, `protocol.dex.swap`,
`protocol.staking.stake`, `protocol.staking.unstake`.

Offchain: `offchain.http`, `offchain.notify`, `data.query`.

Administrative: `workflow.create`, `workflow.update`, `workflow.delete`,
`workflow.publish`, `integration.create`, `integration.update`,
`integration.delete`, `wallet.create`, `wallet.update`, `wallet.delete`,
`wallet.role.update`, `addressbook.create`, `addressbook.update`,
`addressbook.delete`, `member.invite`, `member.update`, `member.remove`,
`apikey.create`, `apikey.delete`, `policy.update`.

Capabilities accept the same wildcards, so `protocol.lending.**` claims all
lending and keeps working when a new lending protocol is added.

Policy can only subtract. It never grants a member something their role
refuses, and a deny overrides even an owner's role.

## Conditions

Conditions in a statement are combined with AND, which is what most rules want.

| Key | Matches on |
|---|---|
| `usdValue`, `amount`, `asset` | value moved and in what |
| `counterparty`, `spender`, `recipient` | who receives, with the role they play |
| `chainId`, `selector`, `unbounded` | the call itself |
| `gasPriceGwei`, `gasLimit` | execution cost |
| `triggerType` | how the run started: `manual`, `scheduled`, `webhook`, `event`, `block`, `transfer` |
| `actor`, `actorRole`, `actorId`, `authMethod` | who is acting |
| `signerMode` | how it is signed |
| `timeWindow`, `dayOfWeek` | when, in UTC |
| `workflowId`, `workflowTag`, `projectId`, `resourceId` | what it belongs to |
| `sourceIp`, `httpHost`, `httpUrl`, `httpMethod` | outbound calls and request origin |

Operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `notIn`, `matches`,
`inCidr`, `notInCidr`, `inDomain`, `notInDomain`.

### Either-or

For a genuine either-or, group the alternatives with `anyOf` rather than
splitting the rule into two statements that then drift apart.

```json
"condition": {
  "asset": { "in": ["kh:asset/class/stablecoin"] },
  "anyOf": [
    { "chainId": { "eq": 1 } },
    { "chainId": { "eq": 8453 } }
  ]
}
```

Everything outside the group still applies, so this reads as "a stablecoin, on
either of these chains". `allOf` groups conditions that must all hold, which is
only useful nested inside an `anyOf`. Groups may contain groups, up to five
deep.

A group follows the same fail-closed rule as anything else. An `anyOf` matches
when a branch definitely matches; if none does and any branch could not be
determined, the group is undetermined, which an `allow` cannot be satisfied by
and a `deny` treats as a hit.

For negation use the operators, `neq`, `notIn`, `notInCidr` and `notInDomain`,
rather than a group.

A fact is known, absent, or undetermined. When a condition cannot be
determined, an `allow` does not match and a `deny` does. You cannot permit
something you could not establish, and something you cannot rule out is
refused.

Conditions on a `signal.` key may appear only in a `deny`. A probabilistic
input may tighten a decision, never grant one, and this is checked when the
policy is saved.

## Limits

Limits are reserved before the action and settled when it succeeds, so two
simultaneous actions each see the other's reservation and cannot both slip
under a cap.

```json
{ "metric": "usd", "window": "1d", "max": "50000", "scope": "organization" }
```

`metric` is `usd`, `token` or `count`. A `token` limit also names its `asset`.
`window` is `1h`, `1d`, `7d` or `30d`. `scope` is `organization`, `workflow` or
`principal`.

Use `count` alongside a value limit to catch a loop making many small actions.

## Monitor and enforce

`enforcement` is `monitor` or `enforce`. A policy in monitor mode records what
it would have decided and lets the action proceed. Use it to see what a new
policy would do against real activity before it starts refusing anything.

Set `changeDelayHours` when creating or updating a policy to defer when the new
version takes effect. The row updates immediately and the previous version
keeps being served until the delay elapses, which gives an organization time to
notice a change nobody intended before it starts permitting anything. The delay
applies to any edit, including one that tightens a rule, so use it where being
able to review a change matters more than applying it at once.

A policy marked `protected` cannot be relaxed or deleted through the API.
Relaxing means disabling it, moving it out of enforcement, or replacing its
document. The flag can only be set directly in the database at present: no
endpoint accepts it, so a policy created through the API is never protected,
and one that is protected cannot be unprotected through the API either. The
second approver the refusal message points at is not built yet.

## Endpoints

All paths are relative to your organization.

### List policies

```http
GET /api/organizations/{organizationId}/policies
```

Returns each policy with its document, enforcement mode, version, effective
date, and a computed coverage score naming which guard dimensions it binds.
Coverage is computed on read, so it can never be stale against a document that
changed.

### Create a policy

```http
POST /api/organizations/{organizationId}/policies
```

```json
{
  "document": { "schemaVersion": "2026-08", "name": "...", "enforcement": "enforce", "manages": [], "statements": [] },
  "changeDelayHours": 0
}
```

A document that does not compile is refused with `policy_invalid` and a
`violations` array naming each problem and where it is.

A statement granting authority over the policy system itself, meaning rules
about API keys, members, the address book or policy, is refused until the
document sets `acknowledgeSelfReferential` to true. Those rules govern the
footing every other rule stands on, so the intent has to be stated.

### Update or delete a policy

```http
PATCH  /api/organizations/{organizationId}/policies/{policyId}
DELETE /api/organizations/{organizationId}/policies/{policyId}
```

### Simulate

```http
POST /api/organizations/{organizationId}/policies/simulate
```

Runs a described action against your current policies and returns the verdict
with the statement that produced it. Nothing is submitted and no chain state is
read. An implicit refusal, meaning nothing matched, is reported differently
from an explicit deny, because the two need different fixes.

### Catalog

```http
GET /api/organizations/{organizationId}/policies/catalog
```

The vocabulary available to your organization: capabilities, the contracts and
protocols it knows, and which conditions are meaningful for each. This is what
the policy builder is generated from.

### Decisions

```http
GET /api/organizations/{organizationId}/policy-decisions?outcome=deny&limit=50
```

Governed decisions, with the facts each was made from and the statements that
matched. Unmanaged decisions are not recorded, because an organization with no
policy would otherwise write a row for every node of every run.

## When policy refuses

A refused action fails that step. Work downstream of it does not run, and the
rest of the workflow continues under normal rules.

A refusal is a normal outcome, not a failure. It carries its own error category
and type, so a guardrail doing its job is distinguishable from a workflow that
broke or a platform fault.

Over the API a refusal is `403` with `code: "policy_denied"`. The message names
why in general terms and does not name the rule, because the person who sees it
may not be permitted to read policy. The `reason` field carries the machine
readable form:

| Reason | Meaning |
|---|---|
| `explicit_deny` | a deny statement matched |
| `no_matching_allow` | the scope is managed and nothing permitted this |
| `limit_exceeded` | a limit had no room left |
| `fact_unresolved` | something the rule needed could not be determined |
| `store_unavailable` | policy could not be read, so the action was refused |

The last two are refusals by design. Policy fails closed, including on its own
errors, so a fault can never become permission.

## Grants

A policy says what may be done. A grant says what a workflow can reach at all,
which is a different question: without one there is nothing to call, so there
is no check to forget.

Grants are derived from what a workflow is built out of and issued per
workflow. A workflow holding no grants is unconstrained, which is what lets an
organization adopt them gradually, and a workflow holding grants is confined to
them.

A refusal for want of a grant reports `not_granted` and is not a policy
refusal. The fix is to issue the grant, not to edit a rule.

A workflow whose target is written as a reference to another node's output
cannot be pinned in advance, so it is left ungranted rather than given a guess.

## Not yet supported

- Postconditions can be written into a document but are not yet checked after
  an action completes.
- A workflow simulation reads contracts without consulting policy. It moves no
  value, but a rule refusing reads of a contract does not stop a simulation
  reading it.
- An agentic wallet is governed only once it is linked, because linking is what
  records the organization answerable for it. One provisioned and never linked
  belongs to nobody, so no rule reaches it.
