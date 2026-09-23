import type {
  ProtocolAction,
  ProtocolDefinition,
} from "@/lib/protocol-registry";

/**
 * Action slugs that moved to a new contract key on specific chains, keyed by
 * the old `<protocol>/<slug>` action type.
 *
 * The bridged wstETH and sUSDS tokens implement the ERC-20 surface only, so
 * the full-ABI `wsteth`/`sUsds` contract keys stopped carrying an L2 address
 * and every action bound to them stopped resolving there. The two ERC-20
 * reads that did work on each L2 survive under the read-only `wstethL2` /
 * `sUsdsL2` keys with `-l2` slugs: same address, same selector, same 18
 * decimals. Without an alias a workflow saved against an old slug fails its
 * next run with `contract "sUsds" is not deployed on network "8453"`, which
 * is a break in the identifier rather than in the capability.
 *
 * Scoped per chain deliberately. The old slugs still exist and still work on
 * the chains where the full ABI is implemented (mainnet for both, plus
 * Sepolia for wstETH), so the alias must not shadow them there.
 *
 * The table lives here, not beside the step that first needed it, because
 * three layers have to agree on it: the runtime resolution in
 * plugins/protocol/steps/resolve-protocol-meta.ts, the Network field's chain
 * list in lib/protocol-registry.ts (a saved Base workflow that executes must
 * still validate and still render its chain), and the codegen context in
 * lib/workflow/codegen. A second copy of the redirect rule is a second
 * chance for them to disagree.
 *
 * Nothing in here may acquire a VALUE import. lib/protocol-registry.ts is in
 * the client graph (components/hub/protocol-detail.tsx), so a runtime import
 * of, say, @/lib/logging from here would drag Sentry and the metrics client
 * into the browser bundle. The `import type` above is erased at compile time
 * and does not close a runtime cycle.
 */
export const L2_RENAMED_ACTIONS: Record<
  string,
  { slug: string; chainIds: readonly string[] }
> = {
  "sky/vault-balance": {
    slug: "get-susds-balance-l2",
    chainIds: ["8453", "42161"],
  },
  "sky/vault-total-supply": {
    slug: "get-susds-total-supply-l2",
    chainIds: ["8453", "42161"],
  },
  "lido/get-wsteth-balance": {
    slug: "get-wsteth-balance-l2",
    chainIds: ["8453"],
  },
  "lido/get-wsteth-total-supply": {
    slug: "get-wsteth-total-supply-l2",
    chainIds: ["8453"],
  },
};

type RenameEntry = (typeof L2_RENAMED_ACTIONS)[string];

/**
 * Own-property lookup. `actionType` is request-derived, and a plain object
 * literal answers `"constructor"` or `"toString"` with an inherited function
 * that has no `chainIds` to read.
 */
function lookupRename(actionType: string): RenameEntry | undefined {
  return Object.hasOwn(L2_RENAMED_ACTIONS, actionType)
    ? L2_RENAMED_ACTIONS[actionType]
    : undefined;
}

/**
 * Redirect a renamed action to its `-l2` replacement, or return it unchanged.
 *
 * The redirect is conditional on the originally bound contract having no
 * address on this chain, so the alias only fires where the old slug would
 * have failed. If a full-ABI `wsteth`/`sUsds` is ever deployed on one of
 * these chains the old slug starts resolving on its own and the alias steps
 * aside without needing to be deleted.
 *
 * Returns the argument by identity when nothing is redirected, so a caller
 * can test `resolved !== action` to detect that an alias fired.
 *
 * A redirect may never change `type`. Step ROUTING is chosen from the
 * REQUESTED slug - lib/step-registry.ts registers a read step and a write step
 * per slug - while the contract and function come from the RESOLVED one, so a
 * type-changing entry would hand protocolWriteStep a view function to
 * broadcast, or have protocolReadStep eth_call a state-changer. Refusing such
 * an entry here leaves the pre-alias behaviour, which fails loudly with
 * `contract "..." is not deployed on network "..."`.
 */
export function resolveRenamedAction(
  protocol: ProtocolDefinition,
  actionType: string,
  action: ProtocolAction,
  network: string | undefined
): ProtocolAction {
  if (network === undefined) {
    return action;
  }
  const rename = lookupRename(actionType);
  if (!rename?.chainIds.includes(network)) {
    return action;
  }
  if (protocol.contracts[action.contract]?.addresses[network] !== undefined) {
    return action;
  }
  const replacement = protocol.actions.find((a) => a.slug === rename.slug);
  if (!replacement || replacement.type !== action.type) {
    return action;
  }
  return replacement;
}

/**
 * The chains on which `actionType` redirects to a contract that does have an
 * address, i.e. the chains the old slug still executes on through the alias.
 *
 * The Network field's `allowedChainIds` is built from the declared contract's
 * addresses alone, which after the split lists mainnet only. That list gates
 * both the save-time config validation and the builder's chain dropdown, so
 * without this union a Base workflow that still executes correctly cannot be
 * saved and renders no chain. Derived from resolveRenamedAction rather than
 * from the table directly, so the offered chains are exactly the chains the
 * runtime redirect fires on.
 */
export function aliasedChainIds(
  protocol: ProtocolDefinition,
  actionType: string,
  action: ProtocolAction
): string[] {
  const rename = lookupRename(actionType);
  if (!rename) {
    return [];
  }
  return rename.chainIds.filter((chainId) => {
    const resolved = resolveRenamedAction(
      protocol,
      actionType,
      action,
      chainId
    );
    return (
      resolved !== action &&
      protocol.contracts[resolved.contract]?.addresses[chainId] !== undefined
    );
  });
}
