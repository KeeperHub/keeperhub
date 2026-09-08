/**
 * Compiles an authored policy document into the form the evaluator runs on.
 *
 * Compilation is where the two soundness invariants are enforced, so an unsound
 * document fails when it is SAVED rather than when it fails to protect
 * something. That timing is the whole point: a rule that silently never matches
 * is worse than a rule that was rejected, because nobody finds out.
 *
 * Pure: no I/O, no database. The ontology expansion it needs is passed in.
 */

import { parseArn } from "./arn";
import {
  type Capability,
  expandCapabilityPattern,
  isCapability,
} from "./capabilities";
import {
  isSignalConditionKey,
  POLICY_SCHEMA_VERSION,
  PolicyConditionKey,
  PolicyEffect,
  PolicyLimitMetric,
  PolicyLimitScope,
  PolicyLimitWindow,
  PolicyOperator,
} from "./constants";
import type {
  CompiledPolicy,
  CompiledStatement,
  OrganizationPolicy,
  PolicyCompileError,
  PolicyConditionMap,
  PolicyDocument,
  PolicyStatement,
} from "./types";
import { CONDITION_GROUP } from "./types";

const CONDITION_KEYS: ReadonlySet<string> = new Set(
  Object.values(PolicyConditionKey)
);
const OPERATORS: ReadonlySet<string> = new Set(Object.values(PolicyOperator));
const LIMIT_METRICS: ReadonlySet<string> = new Set(
  Object.values(PolicyLimitMetric)
);
const LIMIT_WINDOWS: ReadonlySet<string> = new Set(
  Object.values(PolicyLimitWindow)
);
const LIMIT_SCOPES: ReadonlySet<string> = new Set(
  Object.values(PolicyLimitScope)
);
const EFFECTS: ReadonlySet<string> = new Set(Object.values(PolicyEffect));

/**
 * Capabilities that grant authority over the policy system itself.
 *
 * Uniform treatment is the trap here: if every capability is handled the same,
 * a statement permitting "organization changes" quietly permits rewriting the
 * rules that constrain the person making the change. Granting one of these
 * requires an explicit acknowledgement on the document.
 */
const SELF_REFERENTIAL_PREFIXES: readonly string[] = [
  "policy.",
  "member.",
  "apikey.",
  "addressbook.",
  "wallet.role.",
];

function isSelfReferential(capability: string): boolean {
  return SELF_REFERENTIAL_PREFIXES.some((p) => capability.startsWith(p));
}

type Ctx = {
  policyId: string;
  errors: PolicyCompileError[];
};

function fail(ctx: Ctx, message: string, sid?: string): void {
  ctx.errors.push({ policyId: ctx.policyId, sid, message });
}

/** Expand a capability pattern, reporting one that matches nothing. */
function expandCapabilities(
  ctx: Ctx,
  patterns: readonly string[],
  sid: string
): Capability[] {
  const out = new Set<Capability>();
  for (const pattern of patterns) {
    if (isCapability(pattern)) {
      out.add(pattern);
      continue;
    }
    const expanded = expandCapabilityPattern(pattern);
    if (expanded.length === 0) {
      fail(
        ctx,
        `Capability pattern "${pattern}" matches no known capability. A pattern that matches nothing silently never applies.`,
        sid
      );
      continue;
    }
    for (const c of expanded) {
      out.add(c);
    }
  }
  return [...out];
}

/**
 * The monotonicity and provenance invariants.
 *
 * A signal is a guess, so it may tighten a decision but never produce one that
 * grants. Rejecting it at compile time makes that a property of the document
 * rather than a hope about how the document is used.
 */
function checkConditions(ctx: Ctx, statement: PolicyStatement): void {
  if (!statement.condition) {
    return;
  }
  checkConditionMap(ctx, statement, statement.condition, 0);
}

/** How deep a condition may nest before it stops being readable by a person. */
const MAX_CONDITION_DEPTH = 5;

/**
 * One condition map, and any groups inside it.
 *
 * This recurses because the invariants have to hold everywhere, not just at the
 * top. A signal buried two levels inside an `anyOf` on an allow is the same
 * hole as one written plainly, and the only thing that would have made it
 * different is that nobody looked.
 */
function checkConditionMap(
  ctx: Ctx,
  statement: PolicyStatement,
  condition: PolicyConditionMap,
  depth: number
): void {
  if (depth > MAX_CONDITION_DEPTH) {
    fail(
      ctx,
      `Statement "${statement.sid}" nests conditions more than ${MAX_CONDITION_DEPTH} deep. A rule nobody can read is a rule nobody can check.`,
      statement.sid
    );
    return;
  }

  for (const [key, value] of Object.entries(condition)) {
    if (key === CONDITION_GROUP.ANY_OF || key === CONDITION_GROUP.ALL_OF) {
      checkConditionGroup(ctx, statement, key, value, depth);
      continue;
    }

    if (isSignalConditionKey(key)) {
      if (statement.effect === PolicyEffect.ALLOW) {
        fail(
          ctx,
          `Statement "${statement.sid}" uses the signal "${key}" in an allow. A probabilistic signal may only tighten a decision, never grant one, so it is permitted in a deny only.`,
          statement.sid
        );
      }
    } else if (!CONDITION_KEYS.has(key)) {
      fail(
        ctx,
        `Statement "${statement.sid}" uses the unknown condition "${key}". An unrecognised key would evaluate to nothing and silently fail to protect.`,
        statement.sid
      );
    }

    if (!value || typeof value !== "object") {
      fail(ctx, `Condition "${key}" has no operator.`, statement.sid);
      continue;
    }
    for (const op of Object.keys(value)) {
      if (!OPERATORS.has(op)) {
        fail(
          ctx,
          `Condition "${key}" uses the unknown operator "${op}".`,
          statement.sid
        );
      }
    }
  }
}

function checkConditionGroup(
  ctx: Ctx,
  statement: PolicyStatement,
  key: string,
  value: unknown,
  depth: number
): void {
  if (!Array.isArray(value)) {
    fail(
      ctx,
      `Statement "${statement.sid}" gives "${key}" something that is not a list of conditions.`,
      statement.sid
    );
    return;
  }
  if (value.length === 0) {
    // An empty either-or names no alternative, so nothing satisfies it and the
    // statement can never match. That is always a mistake rather than a choice.
    fail(
      ctx,
      `Statement "${statement.sid}" has an empty "${key}", so it can never match.`,
      statement.sid
    );
    return;
  }
  for (const branch of value) {
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
      fail(
        ctx,
        `Statement "${statement.sid}" has a branch in "${key}" that is not a set of conditions.`,
        statement.sid
      );
      continue;
    }
    checkConditionMap(ctx, statement, branch as PolicyConditionMap, depth + 1);
  }
}

function checkLimits(ctx: Ctx, statement: PolicyStatement): void {
  for (const limit of statement.limit ?? []) {
    if (!LIMIT_METRICS.has(limit.metric)) {
      fail(ctx, `Unknown limit metric "${limit.metric}".`, statement.sid);
    }
    if (!LIMIT_WINDOWS.has(limit.window)) {
      fail(ctx, `Unknown limit window "${limit.window}".`, statement.sid);
    }
    if (!LIMIT_SCOPES.has(limit.scope)) {
      fail(ctx, `Unknown limit scope "${limit.scope}".`, statement.sid);
    }
    // A token limit counts one asset's own units, so it is meaningless without
    // naming that asset, and naming one on a dollar or count limit would read
    // as a restriction the engine does not apply.
    if (limit.metric === PolicyLimitMetric.TOKEN && !limit.asset) {
      fail(
        ctx,
        `Statement "${statement.sid}" has a token limit with no asset. A limit counted in token units must name the token it counts.`,
        statement.sid
      );
    }
    if (limit.metric !== PolicyLimitMetric.TOKEN && limit.asset) {
      fail(
        ctx,
        `Statement "${statement.sid}" names an asset on a ${limit.metric} limit. Only a token limit counts a single asset.`,
        statement.sid
      );
    }
    // A limit only bounds an allow. Attaching one to a deny reads as a budget
    // for how much may be denied, which means nothing.
    if (statement.effect !== PolicyEffect.ALLOW) {
      fail(
        ctx,
        `Statement "${statement.sid}" attaches a limit to a ${statement.effect}. Limits bound what an allow permits and have no meaning on any other effect.`,
        statement.sid
      );
    }
  }
}

function checkResources(
  ctx: Ctx,
  patterns: readonly string[],
  sid: string
): void {
  for (const pattern of patterns) {
    const parsed = parseArn(pattern);
    if (!parsed.ok) {
      fail(ctx, `Resource "${pattern}": ${parsed.error}`, sid);
    }
  }
}

function compileStatement(
  ctx: Ctx,
  statement: PolicyStatement,
  acknowledgeSelfReferential: boolean
): CompiledStatement | null {
  if (!statement.sid) {
    fail(
      ctx,
      "A statement has no sid. Decisions reference it, so it is required."
    );
    return null;
  }
  if (!EFFECTS.has(statement.effect)) {
    fail(ctx, `Unknown effect "${statement.effect}".`, statement.sid);
    return null;
  }

  const capabilities = expandCapabilities(
    ctx,
    statement.capability ?? [],
    statement.sid
  );
  if (capabilities.length === 0) {
    fail(
      ctx,
      `Statement "${statement.sid}" names no capability, so it can never match.`,
      statement.sid
    );
  }

  if (statement.effect === PolicyEffect.ALLOW && !acknowledgeSelfReferential) {
    const escalating = capabilities.filter(isSelfReferential);
    if (escalating.length > 0) {
      fail(
        ctx,
        `Statement "${statement.sid}" grants authority over the policy system itself (${escalating.join(", ")}). Set "acknowledgeSelfReferential": true on the document to confirm this is intended.`,
        statement.sid
      );
    }
  }

  checkConditions(ctx, statement);
  checkLimits(ctx, statement);
  checkResources(ctx, statement.resource ?? [], statement.sid);
  checkResources(ctx, statement.counterparty ?? [], statement.sid);

  return {
    sid: statement.sid,
    policyId: ctx.policyId,
    effect: statement.effect,
    capabilities,
    resourcePatterns: statement.resource ?? [],
    counterpartyPatterns: statement.counterparty ?? [],
    condition: statement.condition ?? {},
    limits: statement.limit ?? [],
    postcondition: statement.postcondition ?? {},
  };
}

/**
 * The managed scope: what this policy claims authority over.
 *
 * A capability inside the scope with no allow covering it is denied, which is
 * the allowlist behaviour. That is correct and it is also the single most
 * likely authoring mistake, so it is reported as a warning the editor can show
 * rather than left to be discovered when a workflow breaks.
 */
function compileManagedScope(
  ctx: Ctx,
  document: PolicyDocument
): { capabilities: Capability[]; resourcePatterns: string[] } {
  const capabilities = new Set<Capability>();
  const resourcePatterns: string[] = [];

  for (const entry of document.manages) {
    const asResource = parseArn(entry);
    if (asResource.ok) {
      resourcePatterns.push(asResource.arn.value);
      continue;
    }
    const expanded = expandCapabilityPattern(entry);
    if (expanded.length === 0) {
      fail(
        ctx,
        `Managed scope "${entry}" matches no capability and is not a valid resource identifier.`
      );
      continue;
    }
    for (const c of expanded) {
      capabilities.add(c);
    }
  }

  return { capabilities: [...capabilities], resourcePatterns };
}

export type CompileInput = Pick<
  OrganizationPolicy,
  "id" | "enabled" | "document"
> & { enforcement?: PolicyDocument["enforcement"] };

export type CompileOutcome =
  | { ok: true; compiled: CompiledPolicy; warnings: readonly string[] }
  | { ok: false; errors: readonly PolicyCompileError[] };

export function compilePolicy(input: CompileInput): CompileOutcome {
  const ctx: Ctx = { policyId: input.id, errors: [] };
  const document = input.document;

  if (document.schemaVersion !== POLICY_SCHEMA_VERSION) {
    fail(
      ctx,
      `Unsupported schema version "${document.schemaVersion}". This build understands "${POLICY_SCHEMA_VERSION}".`
    );
  }
  if (!document.manages || document.manages.length === 0) {
    fail(
      ctx,
      "A policy with an empty managed scope governs nothing. Name what it claims authority over."
    );
  }

  const acknowledge = document.acknowledgeSelfReferential === true;

  const scope = compileManagedScope(ctx, document);
  const statements: CompiledStatement[] = [];
  const seen = new Set<string>();

  for (const statement of document.statements ?? []) {
    if (seen.has(statement.sid)) {
      fail(ctx, `Duplicate statement id "${statement.sid}".`, statement.sid);
      continue;
    }
    seen.add(statement.sid);
    const compiled = compileStatement(ctx, statement, acknowledge);
    if (compiled) {
      statements.push(compiled);
    }
  }

  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }

  return {
    ok: true,
    compiled: {
      policyId: input.id,
      name: document.name,
      enforcement: input.enforcement ?? document.enforcement,
      managedCapabilities: scope.capabilities,
      managedResourcePatterns: scope.resourcePatterns,
      statements,
    },
    warnings: findUncoveredCapabilities(scope.capabilities, statements),
  };
}

/**
 * Capabilities the policy claims but never allows.
 *
 * Inside a managed scope the default is deny, so a claimed capability with no
 * allow is permanently refused. That is legitimate ("claim borrowing, permit
 * none of it") and it is also exactly how a workflow gets bricked by accident,
 * so it is surfaced rather than left silent.
 */
function findUncoveredCapabilities(
  managed: readonly Capability[],
  statements: readonly CompiledStatement[]
): string[] {
  const allowed = new Set<Capability>();
  for (const statement of statements) {
    if (statement.effect === PolicyEffect.ALLOW) {
      for (const c of statement.capabilities) {
        allowed.add(c);
      }
    }
  }
  const uncovered = managed.filter((c) => !allowed.has(c));
  if (uncovered.length === 0) {
    return [];
  }
  return [
    `This policy claims ${uncovered.length} capability${uncovered.length === 1 ? "" : " values"} that no allow statement covers, so they are denied: ${uncovered.join(", ")}. That is intended for a prohibition, and is the usual cause of a workflow that stops unexpectedly.`,
  ];
}

/** True when a compiled policy claims authority over a capability. */
export function policyManages(
  policy: CompiledPolicy,
  capability: Capability
): boolean {
  return policy.managedCapabilities.includes(capability);
}
