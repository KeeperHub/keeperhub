import { describe, expect, it } from "vitest";
import {
  buildCreateBody,
  buildUpdateBody,
  chainGroupHealth,
  editDraftFor,
  filledSlots,
  filterChainGroups,
  formErrorsFrom,
  groupChainOptions,
  groupConfigsByChain,
  groupGapsByWorkflow,
  isCoverageRefusal,
  RpcChainFilter,
  slotsForChainType,
} from "@/components/settings/hub/rpc/model";
import {
  OrgRpcErrorCode,
  RpcUrlCheckFailure,
} from "@/lib/rpc/engine/org/codes";
import type { CoverageGap } from "@/lib/rpc/engine/org/coverage";
import type { OrgRpcConfigView } from "@/lib/rpc/engine/org/service";
import { RpcConfigUrlSlot } from "@/lib/rpc/engine/org/url-slots";
import { RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { RpcChainType, RpcPurpose } from "@/lib/rpc/engine/types";
import {
  OrgRpcApiError,
  orgRpcErrorFrom,
  type RpcChainOption,
  toRpcChainOptions,
} from "@/lib/rpc/org-rpc-client";

const CHECKED_AT = "2026-01-01T00:00:00.000Z";

const ethereum: RpcChainOption = {
  chainId: 1,
  name: "Ethereum",
  chainType: RpcChainType.EVM,
  isTestnet: false,
};
const base: RpcChainOption = {
  chainId: 8453,
  name: "Base",
  chainType: RpcChainType.EVM,
  isTestnet: false,
};
const solana: RpcChainOption = {
  chainId: 101,
  name: "Solana",
  chainType: RpcChainType.SOLANA,
  isTestnet: false,
};

function config(overrides: Partial<OrgRpcConfigView>): OrgRpcConfigView {
  return {
    id: "cfg-1",
    chainId: 1,
    name: "Main",
    isDefault: false,
    enabled: true,
    slots: [RpcConfigUrlSlot.HTTP_PRIMARY],
    verification: {},
    createdAt: CHECKED_AT,
    updatedAt: CHECKED_AT,
    ...overrides,
  };
}

function gap(overrides: Partial<CoverageGap>): CoverageGap {
  return {
    workflowId: "wf-1",
    workflowName: "Payouts",
    nodeId: "node-1",
    nodeLabel: "Send",
    chainId: 1,
    purpose: RpcPurpose.WRITE,
    code: RpcRouteErrorCode.NOT_COVERED,
    message: "No endpoint for this chain.",
    ...overrides,
  };
}

describe("slotsForChainType", () => {
  it("offers every slot on EVM and only HTTPS slots on Solana", () => {
    expect(slotsForChainType(RpcChainType.EVM)).toEqual([
      RpcConfigUrlSlot.HTTP_PRIMARY,
      RpcConfigUrlSlot.HTTP_FALLBACK,
      RpcConfigUrlSlot.WSS_PRIMARY,
      RpcConfigUrlSlot.WSS_FALLBACK,
      RpcConfigUrlSlot.PRIVATE_TX,
    ]);
    expect(slotsForChainType(RpcChainType.SOLANA)).toEqual([
      RpcConfigUrlSlot.HTTP_PRIMARY,
      RpcConfigUrlSlot.HTTP_FALLBACK,
    ]);
  });
});

describe("groupChainOptions", () => {
  it("puts mainnets before testnets, each by name", () => {
    const sepolia: RpcChainOption = {
      chainId: 11_155_111,
      name: "Ethereum Sepolia",
      chainType: RpcChainType.EVM,
      isTestnet: true,
    };
    const groups = groupChainOptions([sepolia, solana, ethereum, base]);
    expect(groups.mainnets.map((c) => c.name)).toEqual([
      "Base",
      "Ethereum",
      "Solana",
    ]);
    expect(groups.testnets.map((c) => c.name)).toEqual(["Ethereum Sepolia"]);
  });
});

describe("groupConfigsByChain", () => {
  it("groups by chain name, default first, unknown chains labelled", () => {
    const groups = groupConfigsByChain(
      [
        config({ id: "a", chainId: 1, name: "Zeta" }),
        config({ id: "b", chainId: 8453, name: "Base one" }),
        config({ id: "c", chainId: 1, name: "Alpha" }),
        config({ id: "d", chainId: 1, name: "Middle", isDefault: true }),
        config({ id: "e", chainId: 999, name: "Orphan" }),
      ],
      [ethereum, base, solana],
      { chains: [] }
    );

    expect(groups.map((g) => [g.name, g.chainType])).toEqual([
      ["Base", RpcChainType.EVM],
      ["Chain 999", null],
      ["Ethereum", RpcChainType.EVM],
    ]);
    expect(groups[2].configs.map((c) => c.id)).toEqual(["d", "c", "a"]);
  });

  it("carries each chain's policy and keeps enforced chains with no configs", () => {
    const blocking = gap({ chainId: 1 });
    const groups = groupConfigsByChain(
      [config({ id: "a", chainId: 1 })],
      [ethereum, base],
      {
        chains: [
          { chainId: 1, ownRpcOnly: false, gaps: [blocking] },
          { chainId: 8453, ownRpcOnly: true, gaps: [] },
        ],
      }
    );

    expect(
      groups.map((g) => [g.chainId, g.ownRpcOnly, g.gaps, g.configs.length])
    ).toEqual([
      [8453, true, [], 0],
      [1, false, [blocking], 1],
    ]);
  });
});

describe("filterChainGroups", () => {
  const failing = config({
    id: "f",
    chainId: 8453,
    name: "Flaky node",
    verification: {
      [RpcConfigUrlSlot.HTTP_PRIMARY]: {
        ok: false,
        checkedAt: CHECKED_AT,
        error: "The endpoint did not answer.",
      },
    },
  });
  const sepolia: RpcChainOption = {
    chainId: 11_155_111,
    name: "Ethereum Sepolia",
    chainType: RpcChainType.EVM,
    isTestnet: true,
  };
  const groups = groupConfigsByChain(
    [
      config({ id: "a", chainId: 1, name: "Main" }),
      failing,
      config({ id: "s", chainId: sepolia.chainId, name: "Test node" }),
    ],
    [ethereum, base, sepolia],
    { chains: [{ chainId: sepolia.chainId, ownRpcOnly: true, gaps: [] }] }
  );
  const ids = (found: { chainId: number }[]): number[] =>
    found.map((group) => group.chainId);

  it.each([
    [RpcChainFilter.ALL, [8453, 1, 11_155_111]],
    [RpcChainFilter.MAINNETS, [8453, 1]],
    [RpcChainFilter.TESTNETS, [11_155_111]],
    [RpcChainFilter.OWN_RPC_ONLY, [11_155_111]],
    [RpcChainFilter.NEEDS_ATTENTION, [8453]],
  ])("filters by %s", (filter, expected) => {
    expect(ids(filterChainGroups(groups, "", filter))).toEqual(expected);
  });

  it("searches chain names, chain IDs and endpoint names", () => {
    expect(ids(filterChainGroups(groups, "eth", RpcChainFilter.ALL))).toEqual([
      1, 11_155_111,
    ]);
    expect(ids(filterChainGroups(groups, "8453", RpcChainFilter.ALL))).toEqual([
      8453,
    ]);
    expect(
      ids(filterChainGroups(groups, " FLAKY ", RpcChainFilter.ALL))
    ).toEqual([8453]);
  });

  it("counts failed checks and gaps for the summary row", () => {
    expect(chainGroupHealth(groups[0])).toEqual({ failedChecks: 1, gaps: 0 });
  });
});

describe("filledSlots", () => {
  it("lists only set slots, in slot order", () => {
    const filled = filledSlots(
      config({
        slots: [RpcConfigUrlSlot.PRIVATE_TX, RpcConfigUrlSlot.HTTP_PRIMARY],
      })
    );
    expect(filled).toEqual([
      RpcConfigUrlSlot.HTTP_PRIMARY,
      RpcConfigUrlSlot.PRIVATE_TX,
    ]);
  });
});

describe("buildCreateBody", () => {
  it("is null until chain, name and primary URL are given", () => {
    expect(
      buildCreateBody({ chain: null, name: "x", urls: {}, isDefault: false })
    ).toBeNull();
    expect(
      buildCreateBody({
        chain: ethereum,
        name: "  ",
        urls: { [RpcConfigUrlSlot.HTTP_PRIMARY]: "https://a" },
        isDefault: false,
      })
    ).toBeNull();
  });

  it("trims, drops empty slots and slots the chain does not take", () => {
    const body = buildCreateBody({
      chain: solana,
      name: " Main ",
      urls: {
        [RpcConfigUrlSlot.HTTP_PRIMARY]: " https://a ",
        [RpcConfigUrlSlot.HTTP_FALLBACK]: "",
        [RpcConfigUrlSlot.WSS_PRIMARY]: "wss://ignored",
      },
      isDefault: false,
    });
    expect(body).toEqual({
      chainId: 101,
      name: "Main",
      urls: { [RpcConfigUrlSlot.HTTP_PRIMARY]: "https://a" },
    });
  });

  it("sends isDefault only when asked for", () => {
    const body = buildCreateBody({
      chain: ethereum,
      name: "Main",
      urls: { [RpcConfigUrlSlot.HTTP_PRIMARY]: "https://a" },
      isDefault: true,
    });
    expect(body?.isDefault).toBe(true);
  });
});

describe("buildUpdateBody", () => {
  const saved = config({
    slots: [RpcConfigUrlSlot.HTTP_PRIMARY, RpcConfigUrlSlot.WSS_PRIMARY],
  });

  it("is empty when nothing changed", () => {
    expect(buildUpdateBody(saved, editDraftFor(saved))).toEqual({});
  });

  it("sends a typed URL, null for a cleared one, and leaves the rest out", () => {
    const body = buildUpdateBody(saved, {
      ...editDraftFor(saved),
      name: "Renamed",
      enabled: false,
      urls: { [RpcConfigUrlSlot.HTTP_FALLBACK]: " https://f " },
      cleared: new Set([
        RpcConfigUrlSlot.WSS_PRIMARY,
        // Not saved, so there is nothing to remove.
        RpcConfigUrlSlot.PRIVATE_TX,
      ]),
    });
    expect(body).toEqual({
      name: "Renamed",
      enabled: false,
      urls: {
        [RpcConfigUrlSlot.HTTP_FALLBACK]: "https://f",
        [RpcConfigUrlSlot.WSS_PRIMARY]: null,
      },
    });
  });

  it("never clears the primary URL", () => {
    const body = buildUpdateBody(saved, {
      ...editDraftFor(saved),
      cleared: new Set([RpcConfigUrlSlot.HTTP_PRIMARY]),
    });
    expect(body).toEqual({});
  });
});

describe("formErrorsFrom", () => {
  it("puts each failed check on its slot", () => {
    const error = orgRpcErrorFrom(422, {
      error: "One or more URLs did not pass the check.",
      code: OrgRpcErrorCode.VERIFICATION_FAILED,
      verification: {
        [RpcConfigUrlSlot.HTTP_PRIMARY]: { ok: true, checkedAt: CHECKED_AT },
        [RpcConfigUrlSlot.WSS_PRIMARY]: {
          ok: false,
          checkedAt: CHECKED_AT,
          code: RpcUrlCheckFailure.WRONG_SCHEME,
          error: "Use a wss:// URL here.",
        },
      },
    });
    expect(formErrorsFrom(error, "fallback")).toEqual({
      slots: { [RpcConfigUrlSlot.WSS_PRIMARY]: "Use a wss:// URL here." },
      gaps: [],
    });
  });

  it("puts a taken name on the name field", () => {
    const error = orgRpcErrorFrom(409, {
      error: "A config with this name already exists for this chain.",
      code: OrgRpcErrorCode.NAME_TAKEN,
    });
    expect(formErrorsFrom(error, "fallback").name).toBe(
      "A config with this name already exists for this chain."
    );
  });

  it("keeps coverage gaps with the form message", () => {
    const gaps = [gap({})];
    const error = orgRpcErrorFrom(409, {
      error: "This change would leave workflows without an RPC endpoint.",
      code: OrgRpcErrorCode.COVERAGE_GAPS,
      gaps,
    });
    const errors = formErrorsFrom(error, "fallback");
    expect(errors.form).toBe(
      "This change would leave workflows without an RPC endpoint."
    );
    expect(errors.gaps).toEqual(gaps);
    expect(isCoverageRefusal(error)).toBe(true);
  });

  it("falls back for anything that is not a route refusal", () => {
    expect(formErrorsFrom(new Error("boom"), "Could not save").form).toBe(
      "Could not save"
    );
    expect(isCoverageRefusal(new Error("boom"))).toBe(false);
  });
});

describe("orgRpcErrorFrom", () => {
  it("ignores an unknown code and a body that is not an object", () => {
    const unknownCode = orgRpcErrorFrom(400, { error: "Bad", code: "NOPE" });
    expect(unknownCode).toBeInstanceOf(OrgRpcApiError);
    expect(unknownCode.code).toBeNull();
    expect(unknownCode.message).toBe("Bad");

    const empty = orgRpcErrorFrom(500, null);
    expect(empty.message).toBe("Request failed");
    expect(empty.gaps).toEqual([]);
    expect(empty.verification).toBeNull();
  });
});

describe("groupGapsByWorkflow", () => {
  it("keeps each workflow's nodes together in first-seen order", () => {
    const grouped = groupGapsByWorkflow([
      gap({ workflowId: "wf-1", nodeId: "a" }),
      gap({ workflowId: "wf-2", workflowName: "Alerts", nodeId: "b" }),
      gap({ workflowId: "wf-1", nodeId: "c" }),
    ]);
    expect(
      grouped.map((w) => [w.workflowId, w.gaps.map((g) => g.nodeId)])
    ).toEqual([
      ["wf-1", ["a", "c"]],
      ["wf-2", ["b"]],
    ]);
  });
});

describe("toRpcChainOptions", () => {
  it("keeps enabled chains of a known type, sorted by name", () => {
    const row = {
      id: "x",
      symbol: "X",
      explorerUrl: null,
      explorerAddressPath: null,
      explorerApiUrl: null,
      explorerApiType: null,
      isTestnet: false,
      usePrivateMempoolRpc: false,
    };
    const options = toRpcChainOptions([
      {
        ...row,
        chainId: 1,
        name: "Ethereum",
        chainType: "evm",
        isEnabled: true,
      },
      { ...row, chainId: 2, name: "Off", chainType: "evm", isEnabled: false },
      { ...row, chainId: 3, name: "Other", chainType: "move", isEnabled: true },
      {
        ...row,
        chainId: 101,
        name: "Solana",
        chainType: "solana",
        isEnabled: true,
      },
      {
        ...row,
        chainId: 8453,
        name: "Base",
        chainType: "evm",
        isEnabled: true,
      },
    ]);
    expect(options.map((o) => o.chainId)).toEqual([8453, 1, 101]);
  });
});
