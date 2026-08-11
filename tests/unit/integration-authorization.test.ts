/**
 * Per-integration authorization.
 *
 * isIntegrationUsable is the pure security boundary that gates credential use
 * on the org principal's visibility grant. The org owns workflows, so every
 * execution authorizes as the org - personal credentials (private /
 * specific_members) never resolve for the org principal.
 * filterUnauthorizedIntegrationIds wires that rule to batched DB lookups; it
 * is tested with the db client mocked so the suite stays hermetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { fixtures } = vi.hoisted(() => ({
  fixtures: {
    integrations: [] as unknown[],
    users: [] as unknown[],
  },
}));

// Dispatch the db.select().from(table).where() chain by drizzle's table-name
// symbol so the two batched queries resolve to their own fixtures.
const DRIZZLE_NAME = Symbol.for("drizzle:Name");
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: Record<symbol, string>) => ({
        where: () => {
          const name = table[DRIZZLE_NAME];
          if (name === "integrations") {
            return Promise.resolve(fixtures.integrations);
          }
          if (name === "users") {
            return Promise.resolve(fixtures.users);
          }
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

import {
  filterUnauthorizedIntegrationIds,
  type IntegrationAuthRow,
  isIntegrationUsable,
} from "@/lib/integrations/authorization";

const NO_CTX = {
  isOwnerDeactivated: false,
};

function row(overrides: Partial<IntegrationAuthRow>): IntegrationAuthRow {
  return {
    id: "int_1",
    createdBy: "owner_1",
    organizationId: "org_1",
    visibility: "private",
    ...overrides,
  };
}

describe("isIntegrationUsable", () => {
  it("denies a private integration for the org principal (personal credentials never resolve)", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "private" }),
        { organizationId: "org_1" },
        NO_CTX
      )
    ).toBe(false);
  });

  it("allows the org principal on an org-visible integration in the same org", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        { organizationId: "org_1" },
        NO_CTX
      )
    ).toBe(true);
  });

  it("denies when the principal's org differs from the integration's org", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization", organizationId: "org_1" }),
        { organizationId: "org_2" },
        NO_CTX
      )
    ).toBe(false);
  });

  it("denies organization visibility when the integration has no org", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization", organizationId: null }),
        { organizationId: null },
        NO_CTX
      )
    ).toBe(false);
  });

  it("denies specific_members for the org principal (grants are per-user)", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "specific_members" }),
        { organizationId: "org_1" },
        NO_CTX
      )
    ).toBe(false);
  });

  it("freezes credentials when the owner is deactivated", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        { organizationId: "org_1" },
        { ...NO_CTX, isOwnerDeactivated: true }
      )
    ).toBe(false);
  });
});

describe("filterUnauthorizedIntegrationIds", () => {
  beforeEach(() => {
    fixtures.integrations = [];
    fixtures.users = [];
  });

  it("returns nothing for an empty id list without querying", async () => {
    expect(
      await filterUnauthorizedIntegrationIds([], { organizationId: "o" })
    ).toEqual([]);
  });

  it("treats non-existent ids as authorized (stale references stay savable)", async () => {
    fixtures.integrations = [];
    expect(
      await filterUnauthorizedIntegrationIds(["missing"], {
        organizationId: "org_1",
      })
    ).toEqual([]);
  });

  it("flags a private integration (personal credentials never resolve for the org principal)", async () => {
    fixtures.integrations = [
      {
        id: "int_1",
        createdBy: "owner_1",
        organizationId: "org_1",
        visibility: "private",
      },
    ];

    expect(
      await filterUnauthorizedIntegrationIds(["int_1"], {
        organizationId: "org_1",
      })
    ).toEqual(["int_1"]);
  });

  it("authorizes an org-visible integration but flags specific_members (no per-user grants for the org principal)", async () => {
    fixtures.integrations = [
      {
        id: "org_int",
        createdBy: "owner_1",
        organizationId: "org_1",
        visibility: "organization",
      },
      {
        id: "specific_int",
        createdBy: "owner_1",
        organizationId: "org_1",
        visibility: "specific_members",
      },
    ];

    expect(
      await filterUnauthorizedIntegrationIds(["org_int", "specific_int"], {
        organizationId: "org_1",
      })
    ).toEqual(["specific_int"]);
  });

  it("flags every integration whose owner is deactivated", async () => {
    fixtures.integrations = [
      {
        id: "org_int",
        createdBy: "owner_1",
        organizationId: "org_1",
        visibility: "organization",
      },
    ];
    fixtures.users = [{ id: "owner_1" }]; // owner_1 is deactivated

    expect(
      await filterUnauthorizedIntegrationIds(["org_int"], {
        organizationId: "org_1",
      })
    ).toEqual(["org_int"]);
  });
});

// The org owns workflows: every workflow gate and the runtime credential
// fetch authorize as the ORG principal (the workflow's owning org).
describe("org principal", () => {
  const ORG_PRINCIPAL = { organizationId: "org_1" };

  it("uses its own org-visible integration", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        ORG_PRINCIPAL,
        NO_CTX
      )
    ).toBe(true);
  });

  it("is denied on another org's organization-visible integration", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization", organizationId: "org_2" }),
        ORG_PRINCIPAL,
        NO_CTX
      )
    ).toBe(false);
  });

  it("is denied on a private integration (personal credentials never resolve)", () => {
    expect(
      isIntegrationUsable(row({ visibility: "private" }), ORG_PRINCIPAL, NO_CTX)
    ).toBe(false);
  });

  it("is denied on specific_members (grants are per-user)", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "specific_members" }),
        ORG_PRINCIPAL,
        NO_CTX
      )
    ).toBe(false);
  });

  it("is still frozen when the integration's creator is deactivated", () => {
    expect(
      isIntegrationUsable(row({ visibility: "organization" }), ORG_PRINCIPAL, {
        ...NO_CTX,
        isOwnerDeactivated: true,
      })
    ).toBe(false);
  });

  it("a null-org principal is denied everything", () => {
    expect(
      isIntegrationUsable(
        row({ visibility: "organization" }),
        { organizationId: null },
        NO_CTX
      )
    ).toBe(false);
  });

  it("filterUnauthorizedIntegrationIds authorizes org-visible, flags private and specific_members", async () => {
    fixtures.integrations = [
      {
        id: "org_int",
        createdBy: "owner_1",
        organizationId: "org_1",
        visibility: "organization",
      },
      {
        id: "private_int",
        createdBy: "owner_1",
        organizationId: "org_1",
        visibility: "private",
      },
      {
        id: "specific_int",
        createdBy: "owner_1",
        organizationId: "org_1",
        visibility: "specific_members",
      },
    ];
    fixtures.users = [];

    expect(
      await filterUnauthorizedIntegrationIds(
        ["org_int", "private_int", "specific_int"],
        ORG_PRINCIPAL
      )
    ).toEqual(["private_int", "specific_int"]);
  });
});
