import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The one thing this suite refuses to fake. Every other test in the policy
// suites proves a function behaves; this one proves the functions are actually
// called, by the code that ships, against a policy that really exists.
vi.mock("@/lib/db", async () => {
  const { drizzle: realDrizzle } = await import("drizzle-orm/postgres-js");
  const pg = (await import("postgres")).default;
  const connection =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/keeperhub_test";
  return { db: realDrizzle(pg(connection, { max: 2, idle_timeout: 1 })) };
});

// Reached only if policy fails to refuse. Each throws, so a test that expects a
// refusal fails loudly rather than quietly signing.
vi.mock("@/lib/turnkey/turnkey-client", () => ({
  getTurnkeySignerConfig: () => {
    throw new Error("REACHED THE SIGNER");
  },
}));
vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: () => {
    throw new Error("REACHED THE NETWORK");
  },
}));

import {
  agenticWallets,
  organization,
  organizationPolicies,
  users,
} from "@/lib/db/schema";
import { policyRefusalFor } from "@/lib/middleware/policy-gate";
import {
  Capability,
  FactProvenance,
  FactState,
  POLICY_SCHEMA_VERSION,
  PolicyCheckpoint,
  PolicyOutcome,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { enforceAgenticWalletPolicy } from "@/lib/policy/agentic-wallet";
import { enforceDirectNodePolicy } from "@/lib/policy/direct-execution";
import { enforcePolicy } from "@/lib/policy/guard";
import { invalidateAllPolicies } from "@/lib/policy/store";
import { triggerTypeOf } from "@/lib/workflow/trigger-type";
import { signTempoTx } from "@/plugins/tempo/steps/tempo-tx-core";

const shouldSkip = process.env.SKIP_INFRA_TESTS === "true";

const id = () => crypto.randomBytes(11).toString("base64url");

const BLOCKED = "0x1111111111111111111111111111111111111111";
const PERMITTED = "0x2222222222222222222222222222222222222222";
// Its own target, so the trigger rule below governs only these reads and does
// not silently claim every read the other cases make.
const TRIGGER_TARGET = "0x3333333333333333333333333333333333333333";
const TEMPO_CHAIN = 4217;

describe.skipIf(shouldSkip)("policy, wired", () => {
  let client: ReturnType<typeof postgres>;
  let testDb: ReturnType<typeof drizzle>;
  let orgId: string;
  let userId: string;
  let subOrgId: string;

  beforeAll(async () => {
    client = postgres(
      process.env.DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5433/keeperhub_test",
      { max: 5 }
    );
    testDb = drizzle(client);

    userId = id();
    orgId = id();
    subOrgId = id();
    const now = new Date();

    await testDb.insert(users).values({
      id: userId,
      name: "Policy wiring",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insert(organization).values({
      id: orgId,
      name: "Policy wiring org",
      slug: `wiring-${userId.toLowerCase()}`,
      createdAt: now,
    });
    await testDb.insert(agenticWallets).values({
      subOrgId,
      walletAddressBase: PERMITTED,
      walletAddressTempo: PERMITTED,
      linkedUserId: userId,
      organizationId: orgId,
    });

    // One address refused everywhere, and an either-or that permits two chains.
    await testDb.insert(organizationPolicies).values([
      {
        id: id(),
        organizationId: orgId,
        name: "Never this address",
        enabled: true,
        enforcement: "enforce",
        createdBy: userId,
        document: {
          schemaVersion: POLICY_SCHEMA_VERSION,
          name: "Never this address",
          enforcement: "enforce",
          manages: [
            `kh:chain/*/contract/${BLOCKED}/**`,
            "asset.transfer.token",
          ],
          statements: [
            {
              sid: "never-this-contract",
              effect: "deny",
              capability: ["contract.write", "contract.read"],
            },
            {
              // Who gets paid is a counterparty rule, which is how the rest of
              // the platform expresses it.
              sid: "never-pay-this-address",
              effect: "deny",
              capability: ["asset.transfer.token"],
              condition: { counterparty: { in: [BLOCKED] } },
            },
          ],
        },
      },
      {
        id: id(),
        organizationId: orgId,
        name: "Reads only on manual runs",
        enabled: true,
        enforcement: "enforce",
        createdBy: userId,
        document: {
          schemaVersion: POLICY_SCHEMA_VERSION,
          name: "Reads only on manual runs",
          enforcement: "enforce",
          manages: [`kh:chain/*/contract/${TRIGGER_TARGET}/**`],
          statements: [
            {
              sid: "manual-runs-only",
              effect: "allow",
              capability: ["contract.read"],
              resource: [`kh:chain/*/contract/${TRIGGER_TARGET}/fn/*`],
              condition: { triggerType: { eq: "manual" } },
            },
          ],
        },
      },
      {
        id: id(),
        organizationId: orgId,
        name: "Payments on either chain only",
        enabled: true,
        enforcement: "enforce",
        createdBy: userId,
        document: {
          schemaVersion: POLICY_SCHEMA_VERSION,
          name: "Payments on either chain only",
          enforcement: "enforce",
          manages: ["asset.transfer.token"],
          statements: [
            {
              sid: "either-chain",
              effect: "allow",
              capability: ["asset.transfer.token"],
              condition: {
                anyOf: [{ chainId: { eq: 8453 } }, { chainId: { eq: 4217 } }],
              },
            },
          ],
        },
      },
    ]);

    invalidateAllPolicies();
  });

  afterAll(async () => {
    await testDb
      .delete(organizationPolicies)
      .where(eq(organizationPolicies.organizationId, orgId));
    await testDb
      .delete(agenticWallets)
      .where(eq(agenticWallets.subOrgId, subOrgId));
    await testDb.delete(organization).where(eq(organization.id, orgId));
    await testDb.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  describe("a Tempo payment", () => {
    const call = (to: string) => ({
      to: to as `0x${string}`,
      data: "0xa9059cbb" as `0x${string}`,
    });

    it("is refused before it reaches a signer or the network", async () => {
      await expect(
        signTempoTx({
          organizationId: orgId,
          chainId: TEMPO_CHAIN,
          calls: [call(BLOCKED)],
          feeToken: PERMITTED as `0x${string}`,
        } as never)
      ).rejects.toThrow(/policy|Blocked/i);
    });

    it("is refused when any call in the envelope names the address", async () => {
      // The second call is the refused one. An envelope judged only by its
      // first call would sign this.
      await expect(
        signTempoTx({
          organizationId: orgId,
          chainId: TEMPO_CHAIN,
          calls: [call(PERMITTED), call(BLOCKED)],
          feeToken: PERMITTED as `0x${string}`,
        } as never)
      ).rejects.toThrow(/policy|Blocked/i);
    });

    it("gets past policy when nothing refuses it", async () => {
      // Reaching the network mock is the proof: policy let it through and the
      // next thing it tried to do was talk to a chain.
      await expect(
        signTempoTx({
          organizationId: orgId,
          chainId: TEMPO_CHAIN,
          calls: [call(PERMITTED)],
          feeToken: PERMITTED as `0x${string}`,
        } as never)
        // Getting as far as the wallet lookup is the proof: policy let it
        // through and the next thing it did was try to do the work.
      ).rejects.toThrow(/No wallet found|REACHED THE NETWORK/);
    });
  });

  describe("an agentic wallet payment", () => {
    it("is refused when it pays the address the organization refused", async () => {
      const refusal = await enforceAgenticWalletPolicy({
        organizationId: orgId,
        subOrgId,
        chainId: 8453,
        recipient: BLOCKED,
        amountMicro: "1000000",
      });
      expect(refusal?.status).toBe(403);
    });

    it("is permitted on a chain the either-or names", async () => {
      const refusal = await enforceAgenticWalletPolicy({
        organizationId: orgId,
        subOrgId,
        chainId: 8453,
        recipient: PERMITTED,
        amountMicro: "1000000",
      });
      expect(refusal).toBeNull();
    });

    it("is refused on a chain neither branch names", async () => {
      // The stored policy really does group its alternatives, and a chain
      // outside both is governed and permitted by nothing.
      const refusal = await enforceAgenticWalletPolicy({
        organizationId: orgId,
        subOrgId,
        chainId: 137,
        recipient: PERMITTED,
        amountMicro: "1000000",
      });
      expect(refusal?.status).toBe(403);
    });
  });

  describe("a direct call that runs a node", () => {
    it("refuses a read of the address the organization refused", async () => {
      const refusal = await enforceDirectNodePolicy({
        organizationId: orgId,
        apiKeyId: "key_1",
        actionType: "web3/read-contract",
        config: { network: "8453", contractAddress: BLOCKED },
      });
      expect(refusal?.status).toBe(403);
    });

    it("permits a read of an address nothing claims", async () => {
      const refusal = await enforceDirectNodePolicy({
        organizationId: orgId,
        apiKeyId: "key_1",
        actionType: "web3/read-contract",
        config: { network: "8453", contractAddress: PERMITTED },
      });
      expect(refusal).toBeNull();
    });
  });

  describe("a rule scoped to how the run started", () => {
    const UNKNOWN = { state: FactState.UNKNOWN } as const;
    const known = (value: unknown) =>
      ({
        state: FactState.KNOWN,
        value,
        provenance: FactProvenance.AUTHORITATIVE,
      }) as const;

    /** The nodes a workflow would carry for a given trigger. */
    const nodesFor = (declared: string) => [
      { data: { type: "trigger", config: { triggerType: declared } } },
      {
        data: { type: "action", config: { actionType: "web3/read-contract" } },
      },
    ];

    async function outcomeFor(declared: string): Promise<PolicyOutcome> {
      // The real mapper, so this covers nodes to trigger fact to stored policy
      // to decision rather than asserting the fact by hand.
      const resolved = triggerTypeOf(nodesFor(declared));
      const verdict = await enforcePolicy({
        principal: {
          kind: PrincipalKind.MEMBER,
          userId,
          organizationId: orgId,
          role: PolicyRole.MEMBER,
        },
        organizationId: orgId,
        capability: Capability.CONTRACT_READ,
        checkpoint: PolicyCheckpoint.NODE,
        facts: {
          capability: Capability.CONTRACT_READ,
          resource: known(
            `kh:chain/1/contract/${TRIGGER_TARGET}/fn/0x18160ddd`
          ),
          chainId: known(1),
          contractAddress: UNKNOWN,
          selector: UNKNOWN,
          protocolSlug: UNKNOWN,
          assets: UNKNOWN,
          counterparties: UNKNOWN,
          nativeValueWei: UNKNOWN,
          usdValue: UNKNOWN,
          unbounded: UNKNOWN,
          gasPriceGwei: UNKNOWN,
          gasLimit: UNKNOWN,
          signerMode: UNKNOWN,
          triggerType: resolved ? known(resolved) : UNKNOWN,
          workflowId: UNKNOWN,
          workflowTags: UNKNOWN,
          projectId: UNKNOWN,
          sourceIp: UNKNOWN,
          httpHost: UNKNOWN,
          httpUrl: UNKNOWN,
          httpMethod: UNKNOWN,
          resourceId: UNKNOWN,
        },
      } as never);
      return verdict.decision.outcome;
    }

    it("permits the run a person started", async () => {
      expect(await outcomeFor("Manual")).toBe(PolicyOutcome.ALLOW);
    });

    it.each([
      "Schedule",
      "Webhook",
      "Event",
      "Block",
      "Transfer",
    ])("refuses a %s run", async (declared) => {
      // Block and Transfer are the two that used to report themselves as
      // manual, so a rule keeping automation out let them straight through.
      expect(await outcomeFor(declared)).toBe(PolicyOutcome.DENY);
    });

    it("refuses a trigger nothing recognises rather than assuming a person", async () => {
      expect(await outcomeFor("SomethingAddedLater")).toBe(PolicyOutcome.DENY);
    });
  });

  describe("the control plane", () => {
    it("refuses a mutating route the manifest does not classify", async () => {
      const refusal = await policyRefusalFor(
        new Request("http://localhost/api/not-a-real-route", {
          method: "POST",
        }),
        { organizationId: orgId, userId }
      );
      expect(refusal).toMatchObject({ code: "policy_denied", status: 403 });
    });

    it("leaves a route policy does not govern alone", async () => {
      const refusal = await policyRefusalFor(
        new Request("http://localhost/api/workflows/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" }),
        }),
        { organizationId: orgId, userId }
      );
      expect(refusal).toBeNull();
    });
  });
});
