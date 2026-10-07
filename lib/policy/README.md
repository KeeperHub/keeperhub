# Organization policies

Rules that bound what workflows, agents and members may do. Two halves that
ship together: a **grant** says what a subject can reach at all, a **policy**
says what may be done with it.

## The decision

```
0. Resolve the grant   no grant  -> DENY, unreachable (not "refused")
1. Governing set       none      -> ALLOW, unmanaged, recorded only
2. Any matching deny             -> DENY, deny overrides everything
4. Any matching allow            -> reserve limits, then ALLOW
5. Otherwise                     -> DENY, managed but nothing permits it
```

Step 1 is what makes this safe to introduce. A capability no policy claims is
untouched, so an organization with no policy behaves exactly as before.

Step 5 is the allowlist behaviour, and it is the most common authoring mistake:
claim a scope, forget to allow anything back inside it, and every action in
that scope stops. The compiler emits a warning for it and the simulator shows
it before anything depends on it.

## Two invariants, enforced when a policy is saved

**Monotonicity.** A condition on a `signal.*` key may appear only in `deny` and
a `deny`. A probabilistic input may tighten a decision, never grant
one. The compiler rejects a document that breaks this, so it is a property of
the document rather than a hope about how it is used.

**Provenance.** Every fact is tagged authoritative or workflow-derived. A
workflow-derived fact cannot satisfy an allow. Without it, a limit checked
against an amount that arrived from an upstream HTTP response is a limit
controlled by whoever controls that response.

The grant is what makes the second rule survivable. Alone it would refuse every
templated workflow. A grant promotes a resolved value to authoritative, so a
template stops being a way to *name* a target and becomes a way to *select*
among granted ones.

## Identifiers

```
cap:<dotted.path>                      what is being done
kh:<type>/<id>[/<type>/<id>...]        what it is done to

kh:chain/8453/contract/0xa238.../fn/0x617ba037
```

Functions are keyed by **selector, not signature**. The selector is what is on
the wire, the signing-time check has no ABI, and signature strings differ by
parameter names and whitespace in ways that silently stop a rule matching.
Signatures are an authoring form only, converted when a policy is compiled.

`*` matches one segment, `**` matches recursively, `fn/none` is empty calldata.

## Fail closed

The guard denies when the organization is unknown, the store cannot be read
beyond its stale window, a needed fact cannot be determined, or **the engine
itself throws**. That last one carries the most weight: any unexpected
exception inside a policy check becomes a denial, so a bug in the engine can
never become an authorization bypass.

A store that returns null means "could not read", never "no policies".

## Where the checks are

| Point | File | Covers |
|---|---|---|
| Workflow node | `lib/workflow/executor/policy-check.step.ts` | every node, after its templates resolve |
| Direct execution | `lib/policy/direct-execution.ts` | the API an agent calls, which never reaches the engine |
| Control plane | `lib/policy/control-plane.ts` | mutating routes, after their role check |

The node check is a wrapper around dispatch rather than code inside each
action. An omission at one site is visible; an omission across 437 step files
is not.

## Adding a capability

One entry in `CAPABILITIES` (`lib/policy/capabilities.ts`), and a mapping in
`ACTION_CAPABILITY` or the verb patterns (`lib/policy/facts.ts`).
`tests/unit/policy-coverage.test.ts` fails the build if a write-capable action
has no mapping, which is what stops the engine quietly losing coverage as
plugins are added.

## Layout

```
constants.ts    every enum, as const objects with derived types
capabilities.ts the capability tree and guard dimensions
arn.ts          identifier grammar: parse, build, match
types.ts        shared interfaces, no runtime values
compile.ts      document -> compiled form, where the invariants are enforced
engine.ts       the pure evaluator
store.ts        loading, caching, grant resolution
guard.ts        the server-side entry point every check calls
facts.ts        action + config -> facts
coverage.ts     which guard dimensions a policy binds
errors.ts       PolicyDeniedError
```
