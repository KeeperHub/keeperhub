"use client";

import { useCallback, useMemo, useState } from "react";
import {
  buildContractCallArn,
  CAPABILITIES,
  type Capability,
  isOnchainCapability,
} from "@/lib/policy";
import {
  buildControlResourceArn,
  isCreateCapability,
  targetForCapability,
} from "@/lib/policy/catalog";
import type { ResourceSelection } from "@/lib/policy/ui";
import {
  ACTION_OPTIONS,
  actorOptions,
  assetForDenomination,
  isRoleOption,
  isTokenDenomination,
  NATIVE_DENOMINATION,
  type PolicyOption,
  resourceOptions,
  roleFromOption,
  SelectorScope,
  USD_DENOMINATION,
} from "@/lib/policy/ui";
import { useSettingsContext } from "../../settings-context";
import { usePolicyCatalog } from "../policy-context";

export type SimulationResult = {
  nodeId: string;
  capability?: string;
  outcome?: string;
  reason?: string;
  wouldBlock?: boolean;
  observedOnly?: boolean;
  message?: string;
  matched?: { sid: string; policyId: string }[];
  error?: string;
};

export type PolicySimulationState = {
  capability: string;
  setCapability: (next: string) => void;
  actor: string;
  setActor: (next: string) => void;
  resourceId: string;
  setResourceId: (next: string) => void;
  selection: ResourceSelection;
  setSelection: (next: ResourceSelection) => void;
  amount: string;
  setAmount: (next: string) => void;
  denomination: string;
  setDenomination: (next: string) => void;
  /** Which questions this action needs answering. */
  isOnchain: boolean;
  movesValue: boolean;
  namesResource: boolean;
  isCreate: boolean;
  actionOptions: PolicyOption[];
  actorChoices: PolicyOption[];
  resourceChoices: PolicyOption[];
  running: boolean;
  stale: boolean;
  results: SimulationResult[] | null;
  unavailable: boolean;
  run: () => Promise<void>;
};

/**
 * Everything the simulator does, minus the rendering.
 *
 * Which fields an action needs is derived here rather than in the component,
 * because the same three predicates decide what to show and what to send. Read
 * once, they cannot disagree: a field that is hidden is also not sent.
 */
export function usePolicySimulation(): PolicySimulationState {
  const { organizationId } = useSettingsContext();
  const { catalog } = usePolicyCatalog();

  const [capability, setCapability] = useState<string>(
    ACTION_OPTIONS[0]?.value ?? ""
  );
  const [actor, setActor] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [selection, setSelection] = useState<ResourceSelection>({
    chainId: null,
    address: "",
    selectors: [],
    selectorScope: SelectorScope.THESE,
  });
  const [amount, setAmount] = useState("");
  const [denomination, setDenomination] = useState(NATIVE_DENOMINATION);
  const [running, setRunning] = useState(false);
  const [stale, setStale] = useState(false);
  const [results, setResults] = useState<SimulationResult[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const controlTarget = useMemo(
    () => targetForCapability(capability),
    [capability]
  );
  const isOnchain = useMemo(
    () => isOnchainCapability(capability as Capability),
    [capability]
  );
  const movesValue = useMemo(
    () => CAPABILITIES[capability as Capability]?.valueMoving ?? false,
    [capability]
  );
  const isCreate = useMemo(() => isCreateCapability(capability), [capability]);
  const namesResource = controlTarget !== null && !isCreate;

  const actorChoices = useMemo(
    () => actorOptions(catalog.members),
    [catalog.members]
  );
  const resourceChoices = useMemo(
    () => (controlTarget ? resourceOptions(controlTarget, catalog) : []),
    [controlTarget, catalog]
  );

  /** A role choice carries no identity; a person carries the role they hold. */
  const actorRole = useMemo(() => {
    if (isRoleOption(actor)) {
      return roleFromOption(actor);
    }
    return catalog.members.find((entry) => entry.id === actor)?.role;
  }, [catalog.members, actor]);

  const actorId = useMemo(
    () => (isRoleOption(actor) ? undefined : actor || undefined),
    [actor]
  );

  const resourceArn = useMemo(() => {
    if (controlTarget) {
      return buildControlResourceArn(controlTarget, resourceId);
    }
    if (!(selection.chainId && selection.address)) {
      return null;
    }
    return buildContractCallArn({
      chainId: selection.chainId,
      contractAddress: selection.address,
      selector: selection.selectors[0] ?? null,
    });
  }, [selection, controlTarget, resourceId]);

  const run = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    setRunning(true);
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/policies/simulate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actorId,
            actorRole,
            nodes: [
              {
                nodeId: "simulated",
                capability,
                resource: resourceArn ?? undefined,
                // Three different facts, so only the one the author chose is
                // sent: dollars, the chain's own currency, or a named token.
                usdValue:
                  movesValue && denomination === USD_DENOMINATION
                    ? amount || undefined
                    : undefined,
                nativeAmount:
                  movesValue && denomination === NATIVE_DENOMINATION
                    ? amount || undefined
                    : undefined,
                amount:
                  movesValue && isTokenDenomination(denomination)
                    ? amount || undefined
                    : undefined,
                asset: movesValue
                  ? assetForDenomination(denomination)
                  : undefined,
              },
            ],
          }),
        }
      );
      const body = (await res.json()) as {
        results?: SimulationResult[];
        policySetAvailable?: boolean;
      };
      setResults(body.results ?? []);
      setStale(false);
      setUnavailable(body.policySetAvailable === false);
    } finally {
      setRunning(false);
    }
  }, [
    organizationId,
    capability,
    resourceArn,
    amount,
    denomination,
    movesValue,
    actorId,
    actorRole,
  ]);

  /** Any edit invalidates a result that is already on screen. */
  const touch = useCallback(
    <T>(setter: (next: T) => void) =>
      (next: T): void => {
        setter(next);
        setStale(results !== null);
      },
    [results]
  );

  return {
    capability,
    setCapability: touch(setCapability),
    actor,
    setActor: touch(setActor),
    resourceId,
    setResourceId: touch(setResourceId),
    selection,
    setSelection: touch(setSelection),
    amount,
    setAmount: touch(setAmount),
    denomination,
    setDenomination: touch(setDenomination),
    isOnchain,
    movesValue,
    namesResource,
    isCreate,
    actionOptions: ACTION_OPTIONS,
    actorChoices,
    resourceChoices,
    running,
    stale,
    results,
    unavailable,
    run,
  };
}
