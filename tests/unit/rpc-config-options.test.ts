import { describe, expect, it } from "vitest";

import { RpcConfigUrlSlot } from "@/lib/rpc/engine/org/url-slots";
import { RpcSelectionMode } from "@/lib/rpc/engine/types";
import {
  buildRpcConfigOptions,
  type OrgRpcEditorState,
  PLATFORM_LABEL,
  privateMempoolVariant,
  type RpcConfigSummary,
} from "@/lib/workflow/editor/rpc-config-options";

const MAINNET = 1;
const BASE = 8453;

function summary(overrides: Partial<RpcConfigSummary> = {}): RpcConfigSummary {
  return {
    id: "cfg_main",
    name: "Main",
    chainId: MAINNET,
    isDefault: true,
    enabled: true,
    slots: [RpcConfigUrlSlot.HTTP_PRIMARY],
    ...overrides,
  };
}

function state(
  configs: RpcConfigSummary[],
  ownRpcOnlyChains: number[] = []
): OrgRpcEditorState {
  return { configs, ownRpcOnlyChains };
}

const values = (options: { value: string }[]): string[] =>
  options.map((option) => option.value);

describe("buildRpcConfigOptions", () => {
  it("offers auto, KeeperHub and the network's enabled configs", () => {
    const built = buildRpcConfigOptions(
      undefined,
      String(MAINNET),
      state([
        summary({ id: "cfg_b", name: "Backup", isDefault: false }),
        summary(),
        summary({
          id: "cfg_off",
          name: "Off",
          enabled: false,
          isDefault: false,
        }),
        summary({ id: "cfg_base", name: "Base", chainId: BASE }),
      ])
    );
    expect(built.value).toBe(RpcSelectionMode.AUTO);
    expect(values(built.options)).toEqual([
      RpcSelectionMode.AUTO,
      RpcSelectionMode.PLATFORM,
      "cfg_b",
      "cfg_main",
    ]);
    expect(built.options[0].hint).toBe("Uses Main");
    expect(built.problem).toBeNull();
  });

  it("names KeeperHub when auto has no default config", () => {
    const built = buildRpcConfigOptions("", String(BASE), state([summary()]));
    expect(built.options[0].hint).toBe(`Uses ${PLATFORM_LABEL}`);
    expect(built.options[1]).toMatchObject({ disabled: false });
  });

  it("locks KeeperHub under own RPC only", () => {
    const built = buildRpcConfigOptions(
      RpcSelectionMode.PLATFORM,
      String(MAINNET),
      state([summary()], [MAINNET])
    );
    expect(built.options[1]).toMatchObject({
      value: RpcSelectionMode.PLATFORM,
      disabled: true,
    });
    expect(built.problem).not.toBeNull();
  });

  it("keeps KeeperHub on networks that are not set to own RPC only", () => {
    const built = buildRpcConfigOptions(
      RpcSelectionMode.PLATFORM,
      String(BASE),
      state([summary()], [MAINNET])
    );
    expect(built.options[1]).toMatchObject({ disabled: false });
    expect(built.problem).toBeNull();
  });

  it("flags auto under own RPC only when the network has no config", () => {
    const built = buildRpcConfigOptions(
      RpcSelectionMode.AUTO,
      String(BASE),
      state([summary()], [BASE])
    );
    expect(built.problem).toMatch(/No RPC config covers this network/);
  });

  it.each([
    ["a deleted config", "cfg_gone", [summary()], /no longer exists/],
    [
      "a disabled config",
      "cfg_main",
      [summary({ enabled: false })],
      /is disabled/,
    ],
    [
      "a config for another network",
      "cfg_base",
      [summary({ id: "cfg_base", chainId: BASE })],
      /another network/,
    ],
  ])(
    "keeps %s as a locked, invalid choice",
    (_name, value, configs, message) => {
      const built = buildRpcConfigOptions(
        value,
        String(MAINNET),
        state(configs)
      );
      expect(built.value).toBe(value);
      expect(built.problem).toMatch(message);
      const stored = built.options.find((option) => option.value === value);
      expect(stored).toMatchObject({ disabled: true });
    }
  );

  it("accepts a pinned config for the node's network", () => {
    const built = buildRpcConfigOptions(
      "cfg_main",
      String(MAINNET),
      state([summary()])
    );
    expect(built.problem).toBeNull();
    expect(values(built.options).filter((v) => v === "cfg_main")).toHaveLength(
      1
    );
  });

  it("lists no configs while the network is a template", () => {
    const built = buildRpcConfigOptions(
      undefined,
      "{{@n1:Step.network}}",
      state([summary()])
    );
    expect(values(built.options)).toEqual([
      RpcSelectionMode.AUTO,
      RpcSelectionMode.PLATFORM,
    ]);
  });
});

describe("privateMempoolVariant", () => {
  const mainnet = {
    chainId: MAINNET,
    name: "Ethereum",
    hasPlatformRelay: true,
  };
  const base = { chainId: BASE, name: "Base", hasPlatformRelay: false };
  const privateConfig = summary({
    chainId: BASE,
    slots: [RpcConfigUrlSlot.HTTP_PRIMARY, RpcConfigUrlSlot.PRIVATE_TX],
  });

  it("offers KeeperHub's relay where the chain has one", () => {
    expect(privateMempoolVariant(mainnet, undefined, state([]))).toEqual({
      offered: true,
      label: "Ethereum (Flashbots)",
      disabledReason: null,
    });
    expect(privateMempoolVariant(base, undefined, state([]))).toEqual({
      offered: false,
    });
  });

  it("offers the node's config when it has a private URL", () => {
    expect(
      privateMempoolVariant(base, undefined, state([privateConfig]))
    ).toMatchObject({ offered: true, disabledReason: null });
  });

  it("follows the node's KeeperHub choice over a private config", () => {
    expect(
      privateMempoolVariant(
        base,
        RpcSelectionMode.PLATFORM,
        state([privateConfig])
      )
    ).toEqual({ offered: false });
  });

  it("locks the entry under own RPC only without a private URL", () => {
    const variant = privateMempoolVariant(
      mainnet,
      undefined,
      state([summary()], [MAINNET])
    );
    expect(variant).toMatchObject({ offered: true });
    expect(variant.offered && variant.disabledReason).toMatch(
      /private transaction URL/
    );
  });

  it("offers the entry under own RPC only with a private URL", () => {
    expect(
      privateMempoolVariant(base, undefined, state([privateConfig], [BASE]))
    ).toMatchObject({ offered: true, disabledReason: null });
  });
});
