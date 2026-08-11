"use client";

import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import { getChainName } from "@/lib/chain-utils";
import {
  integrationsAtom,
  integrationsLoadedAtom,
} from "@/lib/integrations-store";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TRAILING_SLASH_RE = /\/+$/;

type Chain = { name: string; explorerUrl: string | null };
type Token = { symbol: string; address: string };

export type ResolvedValue = {
  label: string;
  // The referenced entity (integration / token / plugin action) no longer
  // exists.
  deleted: boolean;
  // Render as a raw token (mono) vs a human name.
  mono: boolean;
  // The value was unset (empty/placeholder).
  empty: boolean;
  // Present when the value is an EVM address: the full checksummed address and
  // a network-aware block-explorer link (when the chain is known).
  address?: { full: string; href: string | null };
};

export type ConfigValueResolver = (
  actionType: string | undefined,
  key: string,
  value: string,
  chainId?: string
) => ResolvedValue;

function configFieldType(
  actionType: string | undefined,
  key: string
): string | undefined {
  if (!actionType) {
    return;
  }
  const action = findActionById(actionType);
  if (!action) {
    return;
  }
  return flattenConfigFields(action.configFields).find((f) => f.key === key)
    ?.type;
}

function parseTokenValue(raw: string): {
  custom: boolean;
  symbol?: string;
  address?: string;
  supportedTokenId?: string;
} {
  try {
    const parsed = JSON.parse(raw) as {
      mode?: string;
      supportedTokenId?: string;
      customToken?: { symbol?: string; address?: string };
    };
    return {
      custom: parsed.mode === "custom",
      symbol: parsed.customToken?.symbol,
      address: parsed.customToken?.address,
      supportedTokenId: parsed.supportedTokenId,
    };
  } catch {
    return { custom: false };
  }
}

/**
 * Resolves raw workflow config values to human names for the version-history
 * diff (chain id -> name, integrationId -> integration name, actionType ->
 * action label, supportedTokenId -> symbol, EVM address -> checksummed +
 * explorer link), and flags references whose target no longer exists as
 * `deleted`. Resolution runs against current data, so it works for every stored
 * version and detects deletions. Chain/token lookups are fetched once while
 * `enabled`.
 */
export function useConfigValueDisplay(enabled: boolean): ConfigValueResolver {
  const integrations = useAtomValue(integrationsAtom);
  const integrationsLoaded = useAtomValue(integrationsLoadedAtom);
  const [chains, setChains] = useState<Map<string, Chain>>(new Map());
  const [tokens, setTokens] = useState<Map<string, Token>>(new Map());
  const [tokensLoaded, setTokensLoaded] = useState(false);

  useEffect(() => {
    if (!enabled || chains.size > 0) {
      return;
    }
    let active = true;
    fetch("/api/chains")
      .then((r) => r.json())
      .then(
        (
          rows: Array<{
            chainId: number | string;
            name: string;
            explorerUrl?: string | null;
          }>
        ) => {
          if (active) {
            setChains(
              new Map(
                rows.map((c) => [
                  String(c.chainId),
                  { name: c.name, explorerUrl: c.explorerUrl ?? null },
                ])
              )
            );
          }
        }
      )
      .catch(() => {
        // best-effort; values fall back to getChainName / raw id
      });
    return () => {
      active = false;
    };
  }, [enabled, chains.size]);

  useEffect(() => {
    if (!enabled || tokensLoaded) {
      return;
    }
    let active = true;
    // network=1 returns the master token list (all ids resolve by id).
    fetch("/api/supported-tokens?network=1")
      .then((r) => r.json())
      .then(
        (rows: Array<{ id: string; symbol: string; tokenAddress: string }>) => {
          if (active) {
            setTokens(
              new Map(
                rows.map((t) => [
                  t.id,
                  { symbol: t.symbol, address: t.tokenAddress },
                ])
              )
            );
            setTokensLoaded(true);
          }
        }
      )
      .catch(() => {
        if (active) {
          setTokensLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [enabled, tokensLoaded]);

  return useMemo<ConfigValueResolver>(() => {
    const integrationById = new Map(integrations.map((i) => [i.id, i]));

    const explorerHref = (
      chainId: string | undefined,
      address: string
    ): string | null => {
      const explorer = chainId ? chains.get(chainId)?.explorerUrl : null;
      return explorer
        ? `${explorer.replace(TRAILING_SLASH_RE, "")}/address/${address}`
        : null;
    };

    return (actionType, key, value, chainId) => {
      const base = { deleted: false, mono: false, empty: false };
      const addressInfo = (addr: string) => {
        const full = toChecksumAddress(addr);
        return { full, href: explorerHref(chainId, full) };
      };
      if (!value || value === "empty") {
        return { ...base, label: "empty", empty: true };
      }

      if (key === "actionType") {
        const label = findActionById(value)?.label;
        if (label) {
          return { ...base, label };
        }
        // System actions ("Condition", "HTTP Request") have no "/" and are
        // their own label; a "<plugin>/<slug>" with no label was removed.
        return value.includes("/")
          ? { ...base, label: value, deleted: true, mono: true }
          : { ...base, label: value };
      }

      if (key === "integrationId") {
        const integration = integrationById.get(value);
        if (integration) {
          // Web3 wallet integrations resolve to their on-chain address
          // (checksummed + copyable + linkable); others to their name.
          if (integration.address) {
            const info = addressInfo(integration.address);
            return {
              ...base,
              label: truncateAddress(info.full),
              address: info,
            };
          }
          return { ...base, label: integration.name };
        }
        return integrationsLoaded
          ? { ...base, label: value, deleted: true, mono: true }
          : { ...base, label: value, mono: true };
      }

      const fieldType = configFieldType(actionType, key);
      if (fieldType === "chain-select") {
        return {
          ...base,
          label: chains.get(value)?.name ?? getChainName(value),
        };
      }
      if (fieldType === "token-select") {
        const token = parseTokenValue(value);
        if (token.custom) {
          return {
            ...base,
            label: token.symbol || "Custom token",
            address: token.address ? addressInfo(token.address) : undefined,
          };
        }
        if (token.supportedTokenId) {
          const meta = tokens.get(token.supportedTokenId);
          if (meta) {
            return {
              ...base,
              label: meta.symbol,
              address: addressInfo(meta.address),
            };
          }
          return tokensLoaded
            ? { ...base, label: "token", deleted: true }
            : { ...base, label: token.supportedTokenId, mono: true };
        }
      }

      if (ADDRESS_RE.test(value)) {
        const info = addressInfo(value);
        return {
          ...base,
          label: truncateAddress(info.full),
          mono: true,
          address: info,
        };
      }

      return { ...base, label: value, mono: true };
    };
  }, [integrations, integrationsLoaded, chains, tokens, tokensLoaded]);
}
