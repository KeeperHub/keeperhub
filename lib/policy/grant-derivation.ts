import { ARN_WILDCARD_DEEP, ArnSegment, buildArn } from "./arn";
import type { Capability } from "./capabilities";
import { capabilityForAction } from "./facts";

/**
 * What a workflow needs to reach, derived from what it is built out of.
 *
 * A grant says what can be reached at all, and a policy says what may be done
 * with it. The pair only works if something issues grants, and nothing did, so
 * every workflow reached everything its organization's integrations could and
 * the grant layer sat inert.
 *
 * This derives the set from the nodes themselves. It is deliberately not
 * clever: a node whose target is a literal address yields a grant naming that
 * address, and a node whose target is a template yields nothing, because the
 * value is not known until the run and pinning a guess would either block real
 * work or grant more than the workflow needs.
 *
 * Those unpinnable nodes are returned separately rather than dropped. A
 * workflow that has them cannot be constrained by derivation alone, and saying
 * so is the difference between a backfill that is reviewable and one that
 * quietly under-grants.
 */

export type DerivedGrant = {
  resource: string;
  capabilities: Capability[];
};

export type UnpinnableNode = {
  nodeId: string;
  actionType: string;
  /** The field that carried a template rather than a value. */
  field: string;
};

export type WorkflowGrantDerivation = {
  grants: DerivedGrant[];
  unpinnable: UnpinnableNode[];
};

type WorkflowNode = {
  id?: string;
  data?: {
    type?: string;
    config?: Record<string, unknown>;
  };
};

/** A value the author wrote as a reference to another node's output. */
function isTemplate(value: string): boolean {
  return value.includes("{{");
}

function readString(
  config: Record<string, unknown>,
  key: string
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function chainIdOf(config: Record<string, unknown>): number | undefined {
  const network = readString(config, "network");
  if (!network) {
    return undefined;
  }
  const parsed = Number(network);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function deriveWorkflowGrants(
  nodes: readonly WorkflowNode[]
): WorkflowGrantDerivation {
  const byResource = new Map<string, Set<Capability>>();
  const unpinnable: UnpinnableNode[] = [];

  for (const [index, node] of nodes.entries()) {
    if (node.data?.type !== "action") {
      continue;
    }
    const config = node.data.config ?? {};
    const actionType = readString(config, "actionType");
    if (!actionType) {
      continue;
    }
    const capability = capabilityForAction(actionType);
    if (!capability) {
      continue;
    }

    const nodeId = node.id ?? `node-${index}`;
    const target =
      readString(config, "contractAddress") ??
      readString(config, "programId") ??
      readString(config, "tokenAddress") ??
      readString(config, "mint");

    if (target && isTemplate(target)) {
      unpinnable.push({ nodeId, actionType, field: "contractAddress" });
      continue;
    }

    const chainId = chainIdOf(config);
    if (!(target && chainId !== undefined)) {
      // An action with no onchain target, or no chain to place it on, is not
      // something the identifier grammar can name.
      continue;
    }

    const isAsset =
      readString(config, "contractAddress") === undefined &&
      readString(config, "programId") === undefined;
    // A grant covers the whole target, not one function of it, so it ends in a
    // deep wildcard. Building it through buildArn is what lowercases an EVM
    // address and leaves a base58 one exactly as it is, since base58 carries no
    // case to normalise and lowercasing it names a different account.
    const resource = `${buildArn([
      { type: ArnSegment.CHAIN, id: String(chainId) },
      {
        type: isAsset ? ArnSegment.ASSET : ArnSegment.CONTRACT,
        id: target,
      },
    ])}/${ARN_WILDCARD_DEEP}`;

    const existing = byResource.get(resource) ?? new Set<Capability>();
    existing.add(capability);
    byResource.set(resource, existing);
  }

  return {
    grants: [...byResource.entries()].map(([resource, capabilities]) => ({
      resource,
      capabilities: [...capabilities].sort(),
    })),
    unpinnable,
  };
}
