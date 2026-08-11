import sfMetadata from "@superfluid-finance/metadata";
import { describe, expect, it } from "vitest";
import { reshapeArgsForAbi } from "@/lib/abi/struct-args";
import superfluidProtocol, {
  CFA_FORWARDER_ADDRESS,
  GDA_FORWARDER_ADDRESS,
  SUPERFLUID_CHAIN_IDS,
} from "@/protocols/superfluid";

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CFA_MENTION_REGEX = /CFA/;
const GDA_MENTION_REGEX = /GDA/;
const EXPECTED_CHAINS: string[] = [...SUPERFLUID_CHAIN_IDS];

const CFA_FORWARDER = CFA_FORWARDER_ADDRESS;

type SuperfluidAction = (typeof superfluidProtocol.actions)[number];

const findAction = (slug: string): SuperfluidAction | undefined =>
  superfluidProtocol.actions.find((a) => a.slug === slug);

describe("Superfluid protocol", () => {
  describe("metadata", () => {
    it("declares the expected name, slug, and description", () => {
      expect(superfluidProtocol.name).toBe("Superfluid");
      expect(superfluidProtocol.slug).toBe("superfluid");
      expect(superfluidProtocol.description).toBeTruthy();
      expect(superfluidProtocol.website).toBe("https://superfluid.org");
    });
  });

  describe("cfaForwarder contract", () => {
    it("declares cfaForwarder with the same address on every chain in SUPERFLUID_CHAIN_IDS", () => {
      const contract = superfluidProtocol.contracts.cfaForwarder;
      expect(contract).toBeDefined();
      expect(Object.keys(contract.addresses).sort()).toEqual(
        [...EXPECTED_CHAINS].sort()
      );
      const unique = new Set(Object.values(contract.addresses));
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe(CFA_FORWARDER);
      for (const addr of Object.values(contract.addresses)) {
        expect(addr).toMatch(ADDRESS_REGEX);
      }
    });

    it("ships an inline ABI containing the 6 expected functions", () => {
      const contract = superfluidProtocol.contracts.cfaForwarder;
      expect(contract.abi).toBeTruthy();
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
      }>;
      const fnNames = abi
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .sort();
      expect(fnNames).toEqual(
        [
          "createFlow",
          "deleteFlow",
          "getAccountFlowrate",
          "getFlowInfo",
          "updateFlow",
          "updateFlowOperatorPermissions",
        ].sort()
      );
    });
  });

  describe("create-flow action", () => {
    it("is declared as a write action against cfaForwarder.createFlow", () => {
      const action = findAction("create-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("createFlow");
      expect(action?.slug).toMatch(KEBAB_CASE_REGEX);
    });

    it("has the five expected inputs in order", () => {
      const action = findAction("create-flow");
      const names = action?.inputs.map((i) => i.name);
      expect(names).toEqual([
        "token",
        "sender",
        "receiver",
        "flowRate",
        "userData",
      ]);
    });

    it("marks userData as advanced with default 0x", () => {
      const action = findAction("create-flow");
      const userData = action?.inputs.find((i) => i.name === "userData");
      expect(userData?.advanced).toBe(true);
      expect(userData?.default).toBe("0x");
    });

    it("includes the int96 helpTip on flowRate", () => {
      const action = findAction("create-flow");
      const flowRate = action?.inputs.find((i) => i.name === "flowRate");
      expect(flowRate?.helpTip).toContain("Wei per second");
      expect(flowRate?.helpTip).toContain("int96");
    });
  });

  describe("update-flow action", () => {
    it("is declared as a write action against cfaForwarder.updateFlow", () => {
      const action = findAction("update-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("updateFlow");
    });

    it("has the same input shape as create-flow", () => {
      const action = findAction("update-flow");
      const names = action?.inputs.map((i) => i.name);
      expect(names).toEqual([
        "token",
        "sender",
        "receiver",
        "flowRate",
        "userData",
      ]);
    });
  });

  describe("delete-flow action", () => {
    it("is declared as a write action against cfaForwarder.deleteFlow", () => {
      const action = findAction("delete-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("deleteFlow");
    });

    it("has token/sender/receiver/userData inputs", () => {
      const action = findAction("delete-flow");
      const names = action?.inputs.map((i) => i.name);
      expect(names).toEqual(["token", "sender", "receiver", "userData"]);
    });
  });

  describe("get-flow action", () => {
    it("is declared as a read action against cfaForwarder.getFlowInfo", () => {
      const action = findAction("get-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("read");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("getFlowInfo");
    });

    it("declares the four expected outputs, decimals only on token-amount fields", () => {
      const action = findAction("get-flow");
      const outputs = action?.outputs ?? [];
      expect(outputs.map((o) => o.name)).toEqual([
        "lastUpdated",
        "flowRate",
        "deposit",
        "owedDeposit",
      ]);
      expect(
        outputs.find((o) => o.name === "flowRate")?.decimals
      ).toBeUndefined();
      expect(outputs.find((o) => o.name === "deposit")?.decimals).toBe(18);
      expect(outputs.find((o) => o.name === "owedDeposit")?.decimals).toBe(18);
    });
  });

  describe("get-cfa-net-flow action", () => {
    it("is declared as a read action against cfaForwarder.getAccountFlowrate", () => {
      const action = findAction("get-cfa-net-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("read");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("getAccountFlowrate");
    });

    it("returns flowRate as int96 without decimals (rate, not token amount)", () => {
      const action = findAction("get-cfa-net-flow");
      const out = action?.outputs?.[0];
      expect(out?.name).toBe("flowRate");
      expect(out?.type).toBe("int96");
      expect(out?.decimals).toBeUndefined();
    });

    it("description points users to get-net-flow for combined readings", () => {
      const action = findAction("get-cfa-net-flow");
      expect(action?.description).toContain("get-net-flow");
    });
  });

  describe("get-net-flow action", () => {
    it("is declared as a read action against gdaForwarder.getNetFlow", () => {
      const action = findAction("get-net-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("read");
      expect(action?.contract).toBe("gdaForwarder");
      expect(action?.function).toBe("getNetFlow");
    });

    it("returns flowRate as int96 without decimals (rate, not token amount)", () => {
      const action = findAction("get-net-flow");
      const out = action?.outputs?.[0];
      expect(out?.name).toBe("flowRate");
      expect(out?.type).toBe("int96");
      expect(out?.decimals).toBeUndefined();
    });

    it("description signals it covers both CFA and GDA flows", () => {
      const action = findAction("get-net-flow");
      const desc = action?.description ?? "";
      expect(desc).toMatch(CFA_MENTION_REGEX);
      expect(desc).toMatch(GDA_MENTION_REGEX);
    });
  });

  describe("gdaForwarder contract", () => {
    const GDA_FORWARDER = GDA_FORWARDER_ADDRESS;

    it("declares gdaForwarder with the same address on every chain in SUPERFLUID_CHAIN_IDS", () => {
      const contract = superfluidProtocol.contracts.gdaForwarder;
      expect(contract).toBeDefined();
      expect(Object.keys(contract.addresses).sort()).toEqual(
        [...EXPECTED_CHAINS].sort()
      );
      const unique = new Set(Object.values(contract.addresses));
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe(GDA_FORWARDER);
    });

    it("ships an inline ABI with the 6 expected functions", () => {
      const contract = superfluidProtocol.contracts.gdaForwarder;
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
      }>;
      const fnNames = abi
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .sort();
      expect(fnNames).toEqual(
        [
          "connectPool",
          "createPool",
          "distribute",
          "distributeFlow",
          "getNetFlow",
          "updateMemberUnits",
        ].sort()
      );
    });

    it("createPool ABI declares the (bool,bool) PoolConfig tuple", () => {
      const contract = superfluidProtocol.contracts.gdaForwarder;
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
        inputs?: Array<{
          name: string;
          type: string;
          components?: Array<{ name: string; type: string }>;
        }>;
      }>;
      const createPool = abi.find(
        (f) => f.type === "function" && f.name === "createPool"
      );
      const config = createPool?.inputs?.find((i) => i.name === "config");
      expect(config?.type).toBe("tuple");
      expect(config?.components?.map((c) => c.name)).toEqual([
        "transferabilityForUnitsOwner",
        "distributionFromAnyAddress",
      ]);
    });
  });

  describe("GDA actions", () => {
    it("declares the six expected GDA action slugs", () => {
      const slugs = superfluidProtocol.actions
        .filter((a) => a.contract === "gdaForwarder")
        .map((a) => a.slug)
        .sort();
      expect(slugs).toEqual(
        [
          "connect-pool",
          "create-pool",
          "distribute",
          "distribute-flow",
          "get-net-flow",
          "update-member-units",
        ].sort()
      );
    });

    it("create-pool flattens the PoolConfig tuple into two top-level bool inputs", () => {
      const action = findAction("create-pool");
      const inputNames = action?.inputs.map((i) => i.name);
      expect(inputNames).toEqual([
        "token",
        "admin",
        "transferabilityForUnitsOwner",
        "distributionFromAnyAddress",
      ]);
      const transferability = action?.inputs.find(
        (i) => i.name === "transferabilityForUnitsOwner"
      );
      const distribution = action?.inputs.find(
        (i) => i.name === "distributionFromAnyAddress"
      );
      expect(transferability?.type).toBe("bool");
      expect(distribution?.type).toBe("bool");
    });

    it("create-pool flat args reshape into the (bool,bool) tuple expected by the ABI", () => {
      const contract = superfluidProtocol.contracts.gdaForwarder;
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
        inputs?: Array<{
          name: string;
          type: string;
          components?: Array<{ name: string; type: string }>;
        }>;
      }>;
      const createPoolAbi = abi.find(
        (f) => f.type === "function" && f.name === "createPool"
      );
      expect(createPoolAbi).toBeDefined();

      const flatArgs = [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        true,
        false,
      ];
      const reshaped = reshapeArgsForAbi(flatArgs, {
        inputs: createPoolAbi?.inputs,
      });
      expect(reshaped).toEqual([
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        {
          transferabilityForUnitsOwner: true,
          distributionFromAnyAddress: false,
        },
      ]);
    });

    it("distribute-flow uses int96 flowRate with the shared helpTip", () => {
      const action = findAction("distribute-flow");
      const flowRate = action?.inputs.find((i) => i.name === "flowRate");
      expect(flowRate?.type).toBe("int96");
      expect(flowRate?.helpTip).toContain("Wei per second");
    });

    it("connect-pool documents that members must call from their own wallet", () => {
      const action = findAction("connect-pool");
      expect(action?.description.toLowerCase()).toContain("own wallet");
    });
  });

  describe("superToken contract", () => {
    it("declares superToken with userSpecifiedAddress: true", () => {
      const contract = superfluidProtocol.contracts.superToken;
      expect(contract).toBeDefined();
      expect(contract.userSpecifiedAddress).toBe(true);
    });

    it("ships an inline ABI with the 4 expected functions", () => {
      const contract = superfluidProtocol.contracts.superToken;
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
      }>;
      const fnNames = abi
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .sort();
      expect(fnNames).toEqual(
        ["balanceOf", "downgrade", "getUnderlyingToken", "upgrade"].sort()
      );
    });
  });

  describe("SuperToken actions", () => {
    it("declares the four expected SuperToken action slugs", () => {
      const slugs = superfluidProtocol.actions
        .filter((a) => a.contract === "superToken")
        .map((a) => a.slug)
        .sort();
      expect(slugs).toEqual(
        [
          "get-super-token-balance",
          "get-underlying-token",
          "unwrap",
          "wrap",
        ].sort()
      );
    });

    it("wrap is a write action against superToken.upgrade", () => {
      const action = findAction("wrap");
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("superToken");
      expect(action?.function).toBe("upgrade");
    });

    it("unwrap is a write action against superToken.downgrade", () => {
      const action = findAction("unwrap");
      expect(action?.type).toBe("write");
      expect(action?.function).toBe("downgrade");
    });

    it("get-super-token-balance returns balance with decimals: 18", () => {
      const action = findAction("get-super-token-balance");
      expect(action?.type).toBe("read");
      expect(action?.outputs?.[0]?.decimals).toBe(18);
    });

    it("get-underlying-token returns an address output and takes no inputs", () => {
      const action = findAction("get-underlying-token");
      expect(action?.type).toBe("read");
      expect(action?.inputs).toEqual([]);
      expect(action?.outputs?.[0]?.type).toBe("address");
    });
  });

  describe("grant-flow-operator action", () => {
    // KEEP-456: routes through CFAv1Forwarder, not the SuperToken proxy.
    // Test pins the routing so the bug can't regress silently.
    it("is declared as a write action against cfaForwarder.updateFlowOperatorPermissions", () => {
      const action = findAction("grant-flow-operator");
      expect(action).toBeDefined();
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("updateFlowOperatorPermissions");
    });

    it("takes token, flowOperator, permissions, flowRateAllowance in that order", () => {
      const action = findAction("grant-flow-operator");
      expect(action?.inputs.map((i) => i.name)).toEqual([
        "token",
        "flowOperator",
        "permissions",
        "flowRateAllowance",
      ]);
    });

    it("includes the bitmap helpTip on permissions", () => {
      const action = findAction("grant-flow-operator");
      const perms = action?.inputs.find((i) => i.name === "permissions");
      expect(perms?.type).toBe("uint8");
      expect(perms?.helpTip).toContain("1");
      expect(perms?.helpTip).toContain("2");
      expect(perms?.helpTip).toContain("4");
      expect(perms?.helpTip).toContain("7");
    });
  });

  describe("overall integrity", () => {
    it("declares 16 actions in total", () => {
      expect(superfluidProtocol.actions).toHaveLength(16);
    });

    it("every action slug is unique kebab-case", () => {
      const slugs = superfluidProtocol.actions.map((a) => a.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const slug of slugs) {
        expect(slug).toMatch(KEBAB_CASE_REGEX);
      }
    });

    it("every action references a defined contract", () => {
      const contractKeys = new Set(Object.keys(superfluidProtocol.contracts));
      for (const action of superfluidProtocol.actions) {
        expect(contractKeys.has(action.contract)).toBe(true);
      }
    });

    it("every action's function exists in its contract's ABI", () => {
      for (const action of superfluidProtocol.actions) {
        const contract =
          superfluidProtocol.contracts[
            action.contract as keyof typeof superfluidProtocol.contracts
          ];
        const abi = contract.abi
          ? (JSON.parse(contract.abi) as Array<{
              type: string;
              name?: string;
            }>)
          : [];
        const fnNames = abi
          .filter((f) => f.type === "function")
          .map((f) => f.name);
        expect(fnNames).toContain(action.function);
      }
    });
  });

  // KEEP-463: guards against the Avalanche-Fuji-style trap where a chain
  // added to SUPERFLUID_CHAIN_IDS has a deviant CFAv1Forwarder address.
  // sameOnAllChains() would silently mis-route on such a chain. This block
  // cross-checks every pinned address against Superfluid's canonical
  // @superfluid-finance/metadata package and fails fast on any deviation.
  describe("canonical metadata cross-check", () => {
    it("pins constants that match metadata for Ethereum Mainnet", () => {
      const eth = sfMetadata.getNetworkByChainId(1);
      expect(eth?.contractsV1.cfaV1Forwarder).toBe(CFA_FORWARDER_ADDRESS);
      expect(eth?.contractsV1.gdaV1Forwarder).toBe(GDA_FORWARDER_ADDRESS);
    });

    for (const chainId of SUPERFLUID_CHAIN_IDS) {
      describe(`chain ${chainId}`, () => {
        const network = sfMetadata.getNetworkByChainId(Number(chainId));

        it("is present in @superfluid-finance/metadata", () => {
          expect(network).toBeDefined();
        });

        it("pinned cfaForwarder matches the canonical CFAv1Forwarder", () => {
          const pinned =
            superfluidProtocol.contracts.cfaForwarder.addresses[chainId];
          expect(pinned).toBe(network?.contractsV1.cfaV1Forwarder);
        });

        it("pinned gdaForwarder matches the canonical GDAv1Forwarder", () => {
          const pinned =
            superfluidProtocol.contracts.gdaForwarder.addresses[chainId];
          expect(pinned).toBe(network?.contractsV1.gdaV1Forwarder);
        });
      });
    }

    // Lock in the documented Fuji forwarder-address deviation that
    // motivates the cross-check above. If the "is not canonical" assertion
    // ever fails, Superfluid has redeployed Fuji's CFA at the canonical
    // address -- the trap is gone and Fuji can safely be added to
    // SUPERFLUID_CHAIN_IDS (and this describe block deleted).
    describe("Avalanche Fuji (43113) exception", () => {
      const fuji = sfMetadata.getNetworkByChainId(43_113);

      it("is intentionally excluded from SUPERFLUID_CHAIN_IDS", () => {
        const ids: readonly string[] = SUPERFLUID_CHAIN_IDS;
        expect(ids).not.toContain("43113");
      });

      it("has a non-canonical CFAv1Forwarder address upstream", () => {
        expect(fuji?.contractsV1.cfaV1Forwarder).not.toBe(
          CFA_FORWARDER_ADDRESS
        );
      });

      it("has the canonical GDAv1Forwarder address (asymmetric deviation)", () => {
        expect(fuji?.contractsV1.gdaV1Forwarder).toBe(GDA_FORWARDER_ADDRESS);
      });
    });
  });
});
