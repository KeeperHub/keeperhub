import { ArnSegment } from "./arn";
import { Capability } from "./capabilities";

/**
 * What policy makes of each mutating API route.
 *
 * A per-route check is a hole generator: the check is easy to leave out, and a
 * route without one fails open silently. So the mapping lives here instead, and
 * every mutating route must appear. `middleware.ts` refuses a mutating request
 * whose route is absent, and a test fails the build when a route file has no
 * entry, which together mean a new route cannot quietly escape governance.
 *
 * Three classifications, and the difference between the last two is the point:
 *
 * - `governed`   the action maps to a capability, so policy decides it
 * - `unmapped`   a real control-plane change with no capability in the
 *                vocabulary yet. Visible and counted rather than forgotten
 * - `ungoverned` not a control-plane change. Each says why, because "policy
 *                does not apply here" is a claim that should be reviewable
 */

export const HttpMutation = {
  POST: "POST",
  PATCH: "PATCH",
  PUT: "PUT",
  DELETE: "DELETE",
} as const;

export type HttpMutation = (typeof HttpMutation)[keyof typeof HttpMutation];

/** Where a resource id is read from, matched out of the concrete path. */
export type ResourceRef = {
  type: ArnSegment;
  /** The dynamic path segment holding the id, e.g. `workflowId`. */
  param?: string;
  /** The request-body field holding the id, for a route whose path has none. */
  bodyField?: string;
};

export type RouteGovernance =
  | {
      kind: "governed";
      capability: Capability;
      resource?: ResourceRef;
      /**
       * The type of object this route brings into existence.
       *
       * A creation has no id to name, so without this the resource fact is
       * absent and a statement scoped to `kh:workflow/*` matches nothing. The
       * gate supplies the `new` sentinel instead, which that pattern does
       * match, so "who may create a workflow" is expressible at all.
       */
      creates?: ArnSegment;
    }
  | { kind: "unmapped"; reason: string }
  | { kind: "ungoverned"; reason: string }
  | { kind: "unroutable"; reason: string };

const governed = (
  capability: Capability,
  resource?: ResourceRef
): RouteGovernance => ({ kind: "governed", capability, resource });

/** A route that creates an object of `type`, which has no id until it exists. */
const creates = (
  capability: Capability,
  type: ArnSegment
): RouteGovernance => ({ kind: "governed", capability, creates: type });

const unmapped = (reason: string): RouteGovernance => ({
  kind: "unmapped",
  reason,
});

const ungoverned = (reason: string): RouteGovernance => ({
  kind: "ungoverned",
  reason,
});

/**
 * The 404 handler, which serves only paths no route file claims.
 *
 * It is classified so the coverage test stays exhaustive, and excluded from
 * matching so it can never stand in for a route nobody classified. Without
 * that exclusion every unlisted route would resolve here and read as
 * deliberately ungoverned, which is the exact failure this manifest exists to
 * make impossible.
 */
const unroutable = (reason: string): RouteGovernance => ({
  kind: "unroutable",
  reason,
});

/** Applies to every mutating method the route exports. */
const all = (
  g: RouteGovernance
): Partial<Record<HttpMutation, RouteGovernance>> => ({
  POST: g,
  PATCH: g,
  PUT: g,
  DELETE: g,
});

const workflowRef: ResourceRef = {
  type: ArnSegment.WORKFLOW,
  param: "workflowId",
};

/** Execution is governed per node, after each node's templates resolve. */
const AT_NODE = "runs the workflow engine, governed at the node check";
/** Signing is governed at the signer, which every path reaches. */
const AT_SIGNER = "moves value, governed at the signing check";
const PERSONAL = "a person's own account, not an organization resource";
const PLATFORM = "platform operator surface, above organization policy";
const READ_ONLY = "changes nothing an organization owns";
/**
 * The one place policy deliberately does not reach.
 *
 * A rule that could refuse a policy edit can be written so that no one can undo
 * it, and the organization is locked out of its own guardrails for good. Owner
 * plus an audit record is the bar here instead, which is the exception the
 * model names rather than an oversight.
 */
const POLICY_ESCAPE_HATCH =
  "editing policy stays reachable by the owner, or a bad rule locks an organization out of its own rules";
/**
 * Reached before there is an organization answerable for the wallet, which is
 * recorded at link time. Policy is written by an organization, so there is
 * nobody to ask yet.
 */
const NO_ORGANIZATION_YET =
  "runs before the wallet belongs to an organization, so no rule can reach it";

export const CONTROL_PLANE_ROUTES: Readonly<
  Record<string, Partial<Record<HttpMutation, RouteGovernance>>>
> = {
  "/api/[...slug]": all(unroutable("the 404 handler for unclaimed paths")),

  "/api/address-book": {
    // The address is the resource, so a rule can name which counterparties may
    // be added rather than only whether anyone may add one.
    POST: governed(Capability.ADDRESSBOOK_CREATE, {
      type: ArnSegment.ADDRESSBOOK,
      bodyField: "address",
    }),
  },
  "/api/address-book/[entryId]": {
    PATCH: governed(Capability.ADDRESSBOOK_UPDATE, {
      type: ArnSegment.ADDRESSBOOK,
      param: "entryId",
    }),
    DELETE: governed(Capability.ADDRESSBOOK_DELETE, {
      type: ArnSegment.ADDRESSBOOK,
      param: "entryId",
    }),
  },

  "/api/admin/orgs/[orgId]/activate": { POST: ungoverned(PLATFORM) },
  "/api/admin/orgs/[orgId]/deactivate": { POST: ungoverned(PLATFORM) },
  "/api/admin/users/[userId]/activate": { POST: ungoverned(PLATFORM) },
  "/api/admin/users/[userId]/deactivate": { POST: ungoverned(PLATFORM) },
  "/api/admin/workflows/[workflowId]/activate": { POST: ungoverned(PLATFORM) },
  "/api/admin/workflows/[workflowId]/deactivate": {
    POST: ungoverned(PLATFORM),
  },

  "/api/agentic-wallet/[id]/approve": {
    POST: unmapped("approving a wallet request has no capability yet"),
  },
  "/api/agentic-wallet/[id]/reject": {
    POST: unmapped("rejecting a wallet request has no capability yet"),
  },
  "/api/agentic-wallet/approval-request": {
    POST: unmapped("raising a wallet request has no capability yet"),
  },
  // Signs a transaction to the reputation registry, so it is governed where
  // it signs rather than here.
  "/api/agentic-wallet/feedback": { POST: ungoverned(AT_SIGNER) },
  "/api/agentic-wallet/link": { POST: ungoverned(NO_ORGANIZATION_YET) },
  "/api/agentic-wallet/provision": {
    POST: ungoverned(NO_ORGANIZATION_YET),
  },
  "/api/agentic-wallet/rotate-hmac": {
    POST: ungoverned(NO_ORGANIZATION_YET),
  },
  "/api/agentic-wallet/sign": { POST: ungoverned(AT_SIGNER) },

  "/api/ai/generate": { POST: ungoverned("drafts a document, saves nothing") },

  // A `wfb_` key belongs to a person and is used to fire their own webhook
  // triggers. The organization credential is /api/keys, which is governed.
  "/api/api-keys": { POST: ungoverned(PERSONAL) },
  "/api/api-keys/[keyId]": { DELETE: ungoverned(PERSONAL) },
  "/api/keys": { POST: creates(Capability.APIKEY_CREATE, ArnSegment.APIKEY) },
  "/api/keys/[keyId]": {
    DELETE: governed(Capability.APIKEY_DELETE, {
      type: ArnSegment.APIKEY,
      param: "keyId",
    }),
  },

  "/api/auth/[...all]": all(ungoverned("authentication itself")),
  "/api/auth/finish-credential-signup": {
    POST: ungoverned("authentication itself"),
  },
  "/api/auth/oauth-mfa-finalize": { POST: ungoverned("authentication itself") },
  "/api/auth/scan-intent": { POST: ungoverned("authentication itself") },
  "/api/auth/signup-conflict": { POST: ungoverned("authentication itself") },
  "/api/auth/strict-signin": { POST: ungoverned("authentication itself") },
  "/api/auth/strict-signin/start": {
    POST: ungoverned("authentication itself"),
  },
  "/api/auth/template-intent": { POST: ungoverned("authentication itself") },

  "/api/billing/cancel": { POST: ungoverned("billing, not an org resource") },
  "/api/billing/checkout": { POST: ungoverned("billing, not an org resource") },
  "/api/billing/debt-scan": {
    POST: ungoverned("billing, not an org resource"),
  },
  "/api/billing/overage": { POST: ungoverned("billing, not an org resource") },
  "/api/billing/payg": { POST: ungoverned("billing, not an org resource") },
  "/api/billing/portal": { POST: ungoverned("billing, not an org resource") },
  "/api/billing/preview-proration": { POST: ungoverned(READ_ONLY) },
  "/api/billing/webhooks/stripe": {
    POST: ungoverned("inbound provider webhook"),
  },

  "/api/execute/[...slug]": { POST: ungoverned(AT_SIGNER) },
  "/api/execute/check-and-execute": { POST: ungoverned(AT_SIGNER) },
  "/api/execute/contract-call": { POST: ungoverned(AT_SIGNER) },
  "/api/execute/node": { POST: ungoverned(AT_SIGNER) },
  "/api/execute/swap": { POST: ungoverned(AT_SIGNER) },
  "/api/execute/transfer": { POST: ungoverned(AT_SIGNER) },

  "/api/executions/[executionId]/cancel": {
    POST: ungoverned("stops work already authorized"),
  },
  "/api/feedback": { POST: ungoverned(READ_ONLY) },
  "/api/gas/estimate": { POST: ungoverned(READ_ONLY) },
  "/api/hub/featured": { POST: ungoverned(PLATFORM) },
  "/api/hub/view": { POST: ungoverned(READ_ONLY) },

  "/api/integrations": {
    POST: creates(Capability.INTEGRATION_CREATE, ArnSegment.INTEGRATION),
  },
  "/api/integrations/[integrationId]": {
    PUT: governed(Capability.INTEGRATION_UPDATE, {
      type: ArnSegment.INTEGRATION,
      param: "integrationId",
    }),
    DELETE: governed(Capability.INTEGRATION_DELETE, {
      type: ArnSegment.INTEGRATION,
      param: "integrationId",
    }),
  },
  "/api/integrations/[integrationId]/test": { POST: ungoverned(READ_ONLY) },
  "/api/integrations/test": { POST: ungoverned(READ_ONLY) },

  "/api/internal/executions": { POST: ungoverned("internal service call") },
  "/api/internal/executions/[executionId]": {
    PATCH: ungoverned("internal service call"),
  },
  "/api/internal/schedules/[scheduleId]": {
    PATCH: ungoverned("internal service call"),
  },
  "/api/internal/wallet-unlock": { POST: ungoverned("internal service call") },

  "/api/mcp/connections/[connectionId]": {
    DELETE: unmapped("revoking an agent connection has no capability yet"),
  },
  "/api/mcp/members/[userId]": {
    PATCH: governed(Capability.MEMBER_UPDATE, {
      type: ArnSegment.MEMBER,
      param: "userId",
    }),
  },
  "/api/mcp/policy": {
    PUT: unmapped("the agent scope ceiling is not the policy vocabulary"),
  },
  "/api/mcp/workflows/[slug]/call": { POST: ungoverned(AT_NODE) },
  "/api/mcp/workflows/[slug]/listing": {
    POST: governed(Capability.WORKFLOW_PUBLISH),
    PATCH: governed(Capability.WORKFLOW_PUBLISH),
    DELETE: governed(Capability.WORKFLOW_PUBLISH),
  },

  "/api/oauth/register": { POST: ungoverned("authentication itself") },
  "/api/oauth/token": { POST: ungoverned("authentication itself") },

  "/api/organizations/[organizationId]": {
    PATCH: unmapped("organization settings have no capability yet"),
  },
  "/api/organizations/[organizationId]/execution-digest": {
    PUT: unmapped("digest preferences have no capability yet"),
  },
  "/api/organizations/[organizationId]/leave": {
    POST: governed(Capability.MEMBER_REMOVE),
  },
  "/api/organizations/[organizationId]/mfa-enforcement": {
    PUT: unmapped("MFA enforcement has no capability yet"),
  },
  "/api/organizations/[organizationId]/policies": {
    POST: ungoverned(POLICY_ESCAPE_HATCH),
  },
  "/api/organizations/[organizationId]/policies/[policyId]": {
    PATCH: ungoverned(POLICY_ESCAPE_HATCH),
    DELETE: ungoverned(POLICY_ESCAPE_HATCH),
  },
  "/api/organizations/[organizationId]/policies/simulate": {
    POST: ungoverned(READ_ONLY),
  },
  "/api/organizations/invitations/[invitationId]/wallet-accept": {
    POST: unmapped("accepting an invitation has no capability yet"),
  },

  "/api/projects": { POST: unmapped("projects have no capability yet") },
  "/api/projects/[projectId]": {
    PATCH: unmapped("projects have no capability yet"),
    DELETE: unmapped("projects have no capability yet"),
  },
  "/api/public-tags": { POST: ungoverned(PLATFORM) },
  "/api/security/audit/export": { POST: ungoverned(READ_ONLY) },
  "/api/tags": { POST: unmapped("tags have no capability yet") },
  "/api/tags/[tagId]": {
    PATCH: unmapped("tags have no capability yet"),
    DELETE: unmapped("tags have no capability yet"),
  },

  "/api/tempo/held-payments": { POST: ungoverned(AT_SIGNER) },
  "/api/tempo/held-payments/[id]/broadcast": { POST: ungoverned(AT_SIGNER) },
  "/api/tempo/held-payments/[id]/cancel": { POST: ungoverned(AT_SIGNER) },

  "/api/user": { PATCH: ungoverned(PERSONAL) },
  "/api/user/delete": { POST: ungoverned(PERSONAL) },
  "/api/user/display-name": { POST: ungoverned(PERSONAL) },
  "/api/user/forgot-password": { POST: ungoverned(PERSONAL) },
  "/api/user/onboarding/complete": { POST: ungoverned(PERSONAL) },
  "/api/user/password": { POST: ungoverned(PERSONAL) },
  "/api/user/rpc-preferences/[chainId]": {
    PUT: ungoverned(PERSONAL),
    DELETE: ungoverned(PERSONAL),
  },
  "/api/user/sessions/[sessionId]/revoke": { POST: ungoverned(PERSONAL) },
  "/api/user/step-up/email": {
    POST: ungoverned(PERSONAL),
    DELETE: ungoverned(PERSONAL),
  },
  "/api/user/totp/backup-codes": { POST: ungoverned(PERSONAL) },
  "/api/user/totp/disable": { POST: ungoverned(PERSONAL) },
  "/api/user/totp/enroll": { POST: ungoverned(PERSONAL) },
  "/api/user/totp/setup": { POST: ungoverned(PERSONAL) },
  "/api/user/totp/verify-stepup": { POST: ungoverned(PERSONAL) },
  "/api/user/verify-ip": { POST: ungoverned(PERSONAL) },

  "/api/user/safe": {
    POST: creates(Capability.WALLET_CREATE, ArnSegment.WALLET),
  },
  "/api/user/safe/[safeId]": {
    PATCH: governed(Capability.WALLET_UPDATE, {
      type: ArnSegment.WALLET,
      param: "safeId",
    }),
  },
  "/api/user/safe/[safeId]/role": {
    POST: governed(Capability.WALLET_ROLE_UPDATE, {
      type: ArnSegment.WALLET,
      param: "safeId",
    }),
  },
  "/api/user/safe/[safeId]/role/allowances": {
    POST: governed(Capability.WALLET_ROLE_UPDATE, {
      type: ArnSegment.WALLET,
      param: "safeId",
    }),
  },
  "/api/user/safe/[safeId]/role/allowances/[tokenAddress]": {
    DELETE: governed(Capability.WALLET_ROLE_UPDATE, {
      type: ArnSegment.WALLET,
      param: "safeId",
    }),
  },
  "/api/user/safe/[safeId]/role/reconcile": {
    POST: governed(Capability.WALLET_ROLE_UPDATE, {
      type: ArnSegment.WALLET,
      param: "safeId",
    }),
  },
  "/api/user/safe/[safeId]/role/simulate": { POST: ungoverned(READ_ONLY) },
  "/api/user/safe/[safeId]/role/update": {
    POST: governed(Capability.WALLET_ROLE_UPDATE, {
      type: ArnSegment.WALLET,
      param: "safeId",
    }),
  },
  "/api/user/safe/reconcile-all": { POST: governed(Capability.WALLET_UPDATE) },
  "/api/user/safe/simulate-deploy": { POST: ungoverned(READ_ONLY) },

  "/api/user/wallet": {
    POST: creates(Capability.WALLET_CREATE, ArnSegment.WALLET),
    DELETE: governed(Capability.WALLET_DELETE),
  },
  "/api/user/wallet/active": { POST: ungoverned(PERSONAL) },
  "/api/user/wallet/estimate-gas": { POST: ungoverned(READ_ONLY) },
  "/api/user/wallet/export-key/verify": { POST: ungoverned(PERSONAL) },
  "/api/user/wallet/prices": { POST: ungoverned(READ_ONLY) },
  "/api/user/wallet/tokens": {
    POST: ungoverned(PERSONAL),
    DELETE: ungoverned(PERSONAL),
  },
  "/api/user/wallet/withdraw": { POST: ungoverned(AT_SIGNER) },

  "/api/web3/fetch-abi": { POST: ungoverned(READ_ONLY) },

  "/api/workflow/[workflowId]/execute": { POST: ungoverned(AT_NODE) },
  "/api/workflows/create": {
    POST: creates(Capability.WORKFLOW_CREATE, ArnSegment.WORKFLOW),
  },
  "/api/workflows/current": {
    POST: creates(Capability.WORKFLOW_CREATE, ArnSegment.WORKFLOW),
  },
  "/api/workflows/import": {
    POST: creates(Capability.WORKFLOW_CREATE, ArnSegment.WORKFLOW),
  },
  "/api/workflows/[workflowId]": {
    PATCH: governed(Capability.WORKFLOW_UPDATE, workflowRef),
    DELETE: governed(Capability.WORKFLOW_DELETE, workflowRef),
  },
  // Retired. The handler takes no request and answers 410, so there is nothing
  // to govern.
  "/api/workflows/[workflowId]/claim": {
    POST: ungoverned("claiming is retired and the route only answers 410"),
  },
  "/api/workflows/[workflowId]/duplicate": {
    POST: creates(Capability.WORKFLOW_CREATE, ArnSegment.WORKFLOW),
  },
  "/api/workflows/[workflowId]/executions": {
    DELETE: unmapped("clearing run history has no capability yet"),
  },
  "/api/workflows/[workflowId]/go-live": {
    PUT: governed(Capability.WORKFLOW_PUBLISH, workflowRef),
  },
  "/api/workflows/[workflowId]/rate": { POST: ungoverned(READ_ONLY) },
  "/api/workflows/[workflowId]/simulate": { POST: ungoverned(READ_ONLY) },
  "/api/workflows/[workflowId]/webhook": { POST: ungoverned(AT_NODE) },
};

/** A concrete path matched against a manifest pattern. */
export type RouteMatch = {
  pattern: string;
  governance: RouteGovernance;
  params: Readonly<Record<string, string>>;
};

export function isMutation(method: string): method is HttpMutation {
  return method in HttpMutation;
}

/**
 * Match one concrete path against one pattern, returning its dynamic segments.
 *
 * A `[...rest]` segment consumes the remainder, so a catch-all matches only
 * when no exact pattern does. Callers rank exact patterns first.
 */
function matchPattern(
  pattern: string,
  segments: readonly string[]
): Record<string, string> | null {
  const patternSegments = pattern.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const expected = patternSegments[i];
    if (expected.startsWith("[...") && expected.endsWith("]")) {
      params[expected.slice(4, -1)] = segments.slice(i).join("/");
      return params;
    }
    const actual = segments[i];
    if (actual === undefined) {
      return null;
    }
    if (expected.startsWith("[") && expected.endsWith("]")) {
      params[expected.slice(1, -1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) {
      return null;
    }
  }

  return patternSegments.length === segments.length ? params : null;
}

/**
 * What policy makes of this request, or null when the method mutates nothing.
 *
 * Returns undefined governance for a path no pattern covers. That is the case
 * `middleware.ts` refuses: an unlisted mutating route is a route nobody
 * classified, and guessing on its behalf is how a gap becomes permanent.
 */
export function matchControlPlaneRoute(
  method: string,
  pathname: string
): RouteMatch | null {
  if (!isMutation(method)) {
    return null;
  }

  const segments = pathname.split("?")[0].split("/").filter(Boolean);
  const patterns = Object.keys(CONTROL_PLANE_ROUTES);
  // Exact patterns win over catch-alls, so `/api/execute/transfer` never
  // resolves through `/api/execute/[...slug]`.
  const ranked = [...patterns].sort(
    (a, b) => Number(a.includes("[...")) - Number(b.includes("[..."))
  );

  for (const pattern of ranked) {
    const params = matchPattern(pattern, segments);
    if (params === null) {
      continue;
    }
    const governance = CONTROL_PLANE_ROUTES[pattern][method];
    if (governance === undefined || governance.kind === "unroutable") {
      continue;
    }
    return { pattern, governance, params };
  }

  return null;
}
