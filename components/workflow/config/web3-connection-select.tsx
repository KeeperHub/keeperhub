"use client";

import { AlertTriangle } from "lucide-react";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Web3ConnectionApiOption =
  | { value: "default"; label: string; kind: "default" }
  | { value: "eoa"; label: string; kind: "eoa" }
  | {
      value: string;
      label: string;
      kind: "safe";
      safeAddress: string;
    };

type Web3ConnectionsResponse = {
  defaultKind: "eoa" | "safe";
  options: Web3ConnectionApiOption[];
};

type RenderOption = {
  value: string;
  title: string;
  subtitle?: string;
  kind: "default" | "eoa" | "safe" | "stale";
};

type Web3ConnectionSelectProps = {
  /**
   * The node's `config.network` value. Used to derive the chainId the picker
   * scopes its Safe list to. A numeric string ("1", "8453") or chain name
   * ("base") narrows the picker; a template like `{{trigger.chainId}}` or
   * an empty value falls back to "default + EOA only".
   */
  network: string | undefined;
  /**
   * Current persisted value of `config.web3Connection`. Undefined / empty
   * is treated as `"default"` so existing nodes pick up the org-policy path.
   */
  value: string | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
};

/**
 * Heuristic: is the node's network field something we can resolve to a
 * concrete chainId right now? Numeric and well-known names yes; templates
 * (`{{trigger.chainId}}`) and empty values no.
 *
 * We deliberately don't try to mirror the server's `getChainIdFromNetwork`
 * here. The picker only needs to know whether to send a chainId query;
 * the server is still the source of truth for resolution and validation.
 */
function parseChainHint(network: string | undefined): number | null {
  if (!network) {
    return null;
  }
  if (network.includes("{{") || network.includes("}}")) {
    return null;
  }
  const parsed = Number.parseInt(network, 10);
  if (!Number.isNaN(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

/**
 * Decide which options to show and how to label them.
 *
 * Rules:
 *   - If the org-policy default is EOA and no Safe is configured on this
 *     chain, "Default" and "EOA" both resolve to the same wallet right now.
 *     Showing both is confusing, so we collapse to a single "EOA" entry.
 *     Its stored value is still "default" so the node auto-picks up a
 *     future Safe; losing that intent without surfacing it to the user
 *     would be worse than the duplicate label.
 *
 *   - If a Safe exists (whether or not it's the org default), the choice is
 *     real: Default follows org policy, EOA pins to the user's EOA, each
 *     Safe pins to that specific Safe. We show subtitles so the difference
 *     is explicit.
 *
 *   - A persisted Safe id that isn't in the API's current option set (Safe
 *     deleted, signing toggled off, different chain) renders as "Unavailable"
 *     so the user can see the mismatch and pick a valid value. The server
 *     rejects this at execution time with a clear error.
 */
function buildRenderOptions(
  data: Web3ConnectionsResponse,
  effectiveValue: string
): RenderOption[] {
  const safes = data.options.filter((opt) => opt.kind === "safe");
  const eoaOption = data.options.find((opt) => opt.kind === "eoa");

  // No Safe configured AND org policy is EOA -> collapse Default + EOA
  // into one "EOA" entry whose value is "default" (preserves auto-upgrade
  // behaviour if the user later turns on a Safe).
  if (safes.length === 0 && data.defaultKind === "eoa") {
    const collapsed: RenderOption[] = [
      { value: "default", title: "EOA", kind: "eoa" },
    ];
    return appendStaleIfNeeded(collapsed, effectiveValue);
  }

  // Otherwise we have a real choice. Spell out what each option does so the
  // tooltip / warning aren't doing all the explaining.
  const out: RenderOption[] = [
    {
      value: "default",
      title:
        data.defaultKind === "safe"
          ? "Default Sender (Safe)"
          : "Default Sender (EOA)",
      subtitle:
        data.defaultKind === "safe"
          ? "Tracks the wallet marked SENDER in your Wallet settings."
          : "No SENDER is set, so this falls back to your EOA. Will switch automatically if you mark a Safe as SENDER later.",
      kind: "default",
    },
  ];
  if (eoaOption) {
    out.push({
      value: "eoa",
      title: "EOA",
      subtitle:
        "Always your EOA, even if a Safe is marked SENDER. Skips any Safe policy gating.",
      kind: "eoa",
    });
  }
  for (const safe of safes) {
    out.push({
      value: safe.value,
      title: safe.label,
      subtitle:
        "kind" in safe && safe.kind === "safe" && safe.safeAddress
          ? safe.safeAddress
          : undefined,
      kind: "safe",
    });
  }
  return appendStaleIfNeeded(out, effectiveValue);
}

function appendStaleIfNeeded(
  rendered: RenderOption[],
  effectiveValue: string
): RenderOption[] {
  if (effectiveValue === "default" || effectiveValue === "eoa") {
    return rendered;
  }
  if (rendered.some((opt) => opt.value === effectiveValue)) {
    return rendered;
  }
  return [
    ...rendered,
    {
      value: effectiveValue,
      title: `Unavailable (${effectiveValue})`,
      subtitle: "This Safe is no longer available on this chain.",
      kind: "stale",
    },
  ];
}

export function Web3ConnectionSelect({
  network,
  value,
  onChange,
  disabled,
}: Web3ConnectionSelectProps): ReactElement {
  const chainHint = useMemo(() => parseChainHint(network), [network]);
  const [data, setData] = useState<Web3ConnectionsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const effectiveValue = value && value.length > 0 ? value : "default";

  const fetchOptions = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const url =
        chainHint === null
          ? "/api/user/web3-connections"
          : `/api/user/web3-connections?chainId=${chainHint}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        setData(null);
        return;
      }
      const body = (await res.json()) as Web3ConnectionsResponse;
      setData(body);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [chainHint]);

  useEffect(() => {
    fetchOptions();
  }, [fetchOptions]);

  const renderOptions = useMemo<RenderOption[]>(
    () => (data ? buildRenderOptions(data, effectiveValue) : []),
    [data, effectiveValue]
  );

  const selectedOption = renderOptions.find(
    (opt) => opt.value === effectiveValue
  );

  const showBypassWarning =
    data?.defaultKind === "safe" && effectiveValue === "eoa";

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled || loading}
        onOpenChange={(open) => {
          if (open) {
            fetchOptions();
          }
        }}
        onValueChange={onChange}
        value={effectiveValue}
      >
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={loading ? "Loading..." : "Select connection"}
          >
            {selectedOption?.title ?? null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {renderOptions.map((opt) => (
            <SelectItem
              key={opt.value}
              textValue={opt.title}
              value={opt.value}
            >
              <div className="flex flex-col items-start">
                <span>{opt.title}</span>
                {opt.subtitle && (
                  <span className="text-muted-foreground text-xs">
                    {opt.subtitle}
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showBypassWarning && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Selecting EOA bypasses the org Safe Wallet including any policy
            gating.
          </span>
        </div>
      )}
    </div>
  );
}
