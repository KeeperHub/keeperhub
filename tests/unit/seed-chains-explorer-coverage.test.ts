import { describe, expect, it } from "vitest";

import { CHAIN_CONFIG } from "@/lib/rpc/rpc-config";
import {
  buildExplorerConfigs,
  CHAIN_TO_DEFAULT_ID,
  DEFAULT_CHAINS,
  EXPLORER_CONFIG_TEMPLATES,
} from "@/scripts/seed/seed-chains";

/**
 * Every chain the seed writes has to reach an explorer template, and the join
 * runs through CHAIN_TO_DEFAULT_ID keyed by display name. That map was the
 * step chain additions missed most: a name absent from it dropped the
 * explorer config with a console.warn and the seed exited zero, so the chain
 * shipped with no explorer links and no ABI lookups. This pins the join for
 * every entry, so a new chain fails here before it fails on staging.
 */
describe("seed-chains explorer coverage", () => {
  it("seeds at least one chain", () => {
    expect(DEFAULT_CHAINS.length).toBeGreaterThan(0);
  });

  it.each(DEFAULT_CHAINS.map((c) => [c.name, c.chainId] as const))(
    "%s (%s) has a CHAIN_TO_DEFAULT_ID entry",
    (name) => {
      expect(CHAIN_TO_DEFAULT_ID[name]).toBeTypeOf("number");
    }
  );

  it.each(Object.entries(CHAIN_TO_DEFAULT_ID))(
    "%s -> %s has an EXPLORER_CONFIG_TEMPLATES entry",
    (_name, defaultId) => {
      expect(EXPLORER_CONFIG_TEMPLATES[defaultId]).toBeDefined();
    }
  );

  it.each(Object.entries(CHAIN_TO_DEFAULT_ID))(
    "%s -> %s is a chain id with an RPC configuration",
    (_name, defaultId) => {
      expect(CHAIN_CONFIG[defaultId]).toBeDefined();
    }
  );

  it("maps every seeded chain to exactly one explorer config", () => {
    const configs = buildExplorerConfigs(
      DEFAULT_CHAINS,
      CHAIN_TO_DEFAULT_ID,
      EXPLORER_CONFIG_TEMPLATES
    );
    expect(configs.map((c) => c.chainId)).toEqual(
      DEFAULT_CHAINS.map((c) => c.chainId)
    );
    for (const config of configs) {
      expect(config.explorerUrl).toMatch(/^https:\/\//);
      expect(config.explorerApiUrl).toMatch(/^https:\/\//);
    }
  });

  it("has no CHAIN_TO_DEFAULT_ID entry that no seeded chain uses", () => {
    const seededNames = new Set(DEFAULT_CHAINS.map((c) => c.name));
    const orphans = Object.keys(CHAIN_TO_DEFAULT_ID).filter(
      (name) => !seededNames.has(name)
    );
    expect(orphans).toEqual([]);
  });

  it("throws, rather than skipping, when a chain name is missing from the map", () => {
    const [chain] = DEFAULT_CHAINS;
    expect(() =>
      buildExplorerConfigs([chain], {}, EXPLORER_CONFIG_TEMPLATES)
    ).toThrow(/No CHAIN_TO_DEFAULT_ID entry for chain/);
  });

  it("throws, rather than skipping, when the mapped id has no template", () => {
    const [chain] = DEFAULT_CHAINS;
    expect(() =>
      buildExplorerConfigs([chain], { [chain.name]: 999_999_999 }, {})
    ).toThrow(/No EXPLORER_CONFIG_TEMPLATES entry for chain/);
  });

  it("keys the explorer config by the chain's resolved id, not the default id", () => {
    const [chain] = DEFAULT_CHAINS;
    const overridden = { ...chain, chainId: 424_242 };
    const [config] = buildExplorerConfigs(
      [overridden],
      CHAIN_TO_DEFAULT_ID,
      EXPLORER_CONFIG_TEMPLATES
    );
    expect(config?.chainId).toBe(424_242);
    expect(config?.explorerUrl).toBe(
      EXPLORER_CONFIG_TEMPLATES[CHAIN_TO_DEFAULT_ID[chain.name] ?? 0]
        ?.explorerUrl
    );
  });
});
