import {
  FactProvenance,
  FactState,
  PrincipalKind,
} from "@/lib/policy/constants";
import type { Fact, Principal } from "@/lib/policy/types";

const ABSENT = { state: FactState.ABSENT } as const;

function known(value: string): Fact<string> {
  return {
    state: FactState.KNOWN,
    value,
    provenance: FactProvenance.AUTHORITATIVE,
  };
}

/** The acting principal's own identifier, whatever kind it is. */
export function principalId(principal: Principal): string | null {
  switch (principal.kind) {
    case PrincipalKind.MEMBER:
    case PrincipalKind.OAUTH:
      return principal.userId;
    case PrincipalKind.API_KEY:
      return principal.apiKeyId;
    case PrincipalKind.SERVICE:
      return principal.service;
    case PrincipalKind.PLATFORM:
      return principal.operator;
    default:
      return null;
  }
}

function principalRole(principal: Principal): string | null {
  return "role" in principal ? principal.role : null;
}

function principalScope(principal: Principal): string | null {
  return "scope" in principal ? (principal.scope ?? null) : null;
}

/**
 * Facts about who is acting, derived from the principal.
 *
 * Derived here rather than carried on `PolicyFacts` so no caller can forget to
 * populate them and no caller can claim to be someone else: the engine reads
 * the principal it was handed. Without these, "who may create an API key" is
 * not expressible, which is the whole of what a control-plane rule says.
 */
export function principalFacts(
  principal: Principal | undefined
): Record<string, Fact<string>> {
  if (!principal) {
    return {
      actor: { state: FactState.UNKNOWN },
      actorRole: { state: FactState.UNKNOWN },
      actorId: { state: FactState.UNKNOWN },
      authMethod: { state: FactState.UNKNOWN },
    };
  }

  const role = principalRole(principal);
  const id = principalId(principal);
  const scope = principalScope(principal);

  return {
    actor: known(principal.kind),
    actorRole: role ? known(role) : ABSENT,
    actorId: id ? known(id) : ABSENT,
    // A key or token authenticates differently from a signed-in person, which
    // is what "API keys may not touch production" is written against.
    authMethod: known(principal.kind),
    ...(scope ? { scope: known(scope) } : {}),
  };
}
