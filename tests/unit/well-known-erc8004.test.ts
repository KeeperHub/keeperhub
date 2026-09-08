import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as agentJsonGET } from "@/app/.well-known/agent.json/route";
import { GET as erc8004GET } from "@/app/.well-known/erc8004.json/route";
import { GET as agentGET } from "@/app/agent/route";

const REQ_URL = "https://app.keeperhub.com/.well-known/test";
const EIP55_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

// Canonical ERC-8004 Ethereum mainnet deployments, pinned as literals rather
// than imported from lib/agentic-wallet/constants.ts on purpose: importing the
// same source the route uses would make these assertions tautological and let a
// wrong address pass. Source: github.com/erc-8004/erc-8004-contracts.
const MAINNET_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const MAINNET_REPUTATION_REGISTRY =
  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ORIGINAL_AUTH_URL = process.env.BETTER_AUTH_URL;

beforeAll(() => {
  // Force baseUrl derivation to fall back to the request URL so the test
  // is independent of .env settings (BETTER_AUTH_URL=http://localhost:3000
  // in dev).
  process.env.NEXT_PUBLIC_APP_URL = "https://app.keeperhub.com";
  process.env.BETTER_AUTH_URL = "https://app.keeperhub.com";
});

afterAll(() => {
  if (ORIGINAL_APP_URL === undefined) {
    process.env.NEXT_PUBLIC_APP_URL = undefined;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  }
  if (ORIGINAL_AUTH_URL === undefined) {
    process.env.BETTER_AUTH_URL = undefined;
  } else {
    process.env.BETTER_AUTH_URL = ORIGINAL_AUTH_URL;
  }
});

describe("/.well-known/erc8004.json (KEEP-475)", () => {
  it("returns a JSON card with agent identity and registry metadata", async () => {
    const response = erc8004GET(new Request(REQ_URL));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.agent_id).toBe(31_875);
    expect(body.chain).toBe("ethereum");
    expect(body.chain_id).toBe(1);
    expect(body.registry).toMatch(EIP55_ADDRESS);
    expect(body.registry).toBe(MAINNET_IDENTITY_REGISTRY);
    expect(body.reputation.registry).toMatch(EIP55_ADDRESS);
    expect(body.reputation.registry).toBe(MAINNET_REPUTATION_REGISTRY);
    // Identity and reputation are separate contracts. Publishing the identity
    // address under `reputation` sends every reputation reader to a contract
    // that holds no feedback -- the KEEP-475 regression this pins shut.
    expect(body.reputation.registry).not.toBe(body.registry);
    expect(body.reputation.chain_id).toBe(1);
    expect(body.reputation.type).toBe("erc-8004");
    expect(body.cards.mcp).toBe(
      "https://app.keeperhub.com/.well-known/mcp.json"
    );
    expect(body.cards.a2a).toBe(
      "https://app.keeperhub.com/.well-known/agent-card.json"
    );
  });

  it("sets a cache header so 8004scan indexers can poll without hammering origin", () => {
    const response = erc8004GET(new Request(REQ_URL));
    expect(response.headers.get("cache-control")).toContain("max-age=300");
  });
});

describe("/.well-known/agent.json (KEEP-475)", () => {
  it("301-redirects to the canonical /.well-known/agent-card.json", () => {
    const response = agentJsonGET(new Request(REQ_URL));

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://app.keeperhub.com/.well-known/agent-card.json"
    );
  });
});

describe("/agent (KEEP-475)", () => {
  it("301-redirects the bare /agent path to the canonical agent card", () => {
    const response = agentGET(new Request("https://app.keeperhub.com/agent"));

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://app.keeperhub.com/.well-known/agent-card.json"
    );
  });
});
