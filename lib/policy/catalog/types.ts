import type { AbiFunctionEntry } from "@/lib/abi/types";
import type {
  PolicyRiskClass,
  SelectorParameterRole,
} from "@/lib/policy/catalog/constants";
import type { PolicyConditionKey } from "@/lib/policy/constants";

/** Where a catalog entry's classification came from. */
export const CatalogEntrySource = {
  /** Derived from the ABI by the rules in this module. */
  DERIVED: "derived",
  /** Derived, then corrected by an editorial override. */
  OVERRIDE: "override",
  /** No ABI available. The entry claims nothing. */
  UNVERIFIED: "unverified",
} as const;

export type CatalogEntrySource =
  (typeof CatalogEntrySource)[keyof typeof CatalogEntrySource];

export type SelectorCatalogEntry = {
  /** Lowercase 4-byte selector, e.g. "0x617ba037". */
  selector: string;
  name: string;
  /** Canonical signature, e.g. "supply(address,uint256,address,uint16)". */
  signature: string;
  stateMutability: AbiFunctionEntry["stateMutability"];
  riskClass: PolicyRiskClass;
  /**
   * The capability this function exercises, read from its ABI name.
   *
   * Authoritative, unlike the capability guessed from an action-type slug: the
   * function name comes from the contract, not from what a workflow author
   * chose to call the node.
   */
  capability: string;
  /**
   * Condition keys that can bind on this selector, excluding the ambient keys
   * that are meaningful for every request.
   */
  conditionKeys: readonly PolicyConditionKey[];
  /** Whether a spend or count limit can bind here. */
  supportsLimits: boolean;
  parameterRoles: readonly SelectorParameterRole[];
  /**
   * True when the function forwards arbitrary calls, which makes permitting it
   * equivalent to permitting everything the contract can reach.
   */
  isDispatcher: boolean;
  source: CatalogEntrySource;
};

export type ContractCatalog = {
  chainId: number;
  /** Lowercase address that appears as `to` on the wire. */
  address: string;
  /**
   * Lowercase implementation address when `address` is a proxy. The function
   * list comes from here; the identifier still pins `address`.
   */
  implementationAddress: string | null;
  /**
   * A proxy known to front this address, when this address is an
   * implementation. Set by looking for a contract that names this one, which is
   * what lets a rule pinned to the wrong half be caught rather than silently
   * matching nothing.
   */
  proxiedBy?: string | null;
  entries: readonly SelectorCatalogEntry[];
  /** Selectors exposed by more than one function on this contract. */
  collisions: readonly string[];
};
