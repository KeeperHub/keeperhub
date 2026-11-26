import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoveryData,
  NetworkConfig,
  RawWorkflow,
} from "../../lib/types";
import { resetFakeWeb3 } from "./helpers/fake-web3";

const ORG_URL = "https://org-route.example/org-secret-key";
const ORG_ID = "org-hidden-1";

const fake = await vi.hoisted(async () => {
  const { createFakeWeb3State } = await import("./helpers/fake-web3");
  return createFakeWeb3State();
});
const hooks = vi.hoisted(() => ({ discovery: null as unknown }));

vi.mock("@solana/web3.js", async (importActual) => {
  const actual = await importActual<typeof import("@solana/web3.js")>();
  const { makeFakeConnection } = await import("./helpers/fake-web3");
  return { ...actual, Connection: makeFakeConnection(fake) };
});
vi.mock("../../src/discovery", () => ({
  fetchSolanaTriggers: () => Promise.resolve(hooks.discovery),
}));
vi.mock("../../src/dedup-redis", () => ({
  createRedisDedupStore: () => ({
    isProcessed: () => Promise.resolve(false),
    markProcessed: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
  }),
}));
vi.mock("../../lib/sqs-client", () => ({ sqs: {} }));

function solanaNetwork(chainId: number): NetworkConfig {
  return {
    id: `chain-${chainId}`,
    chainId,
    name: `Solana ${chainId}`,
    symbol: "SOL",
    chainType: "solana",
    defaultPrimaryRpc: `https://platform-${chainId}.example`,
    defaultFallbackRpc: "",
    defaultPrimaryWss: `wss://platform-${chainId}.example`,
    defaultFallbackWss: "",
    isTestnet: false,
    isEnabled: true,
  };
}

function blockWorkflow(
  id: string,
  chainId: number,
  rpcRoute?: unknown,
): RawWorkflow {
  return {
    id,
    userId: "user-1",
    name: id,
    nodes: [
      {
        data: {
          type: "trigger",
          config: {
            triggerType: "Block",
            network: String(chainId),
            blockInterval: "1",
          },
        },
      },
    ],
    ...(rpcRoute === undefined ? {} : { rpcRoute }),
  };
}

function orgRoute(chainId: number): Record<string, unknown> {
  return {
    key: `route-${chainId}`,
    organizationId: ORG_ID,
    chainId,
    transport: "http",
    primary: {
      url: ORG_URL,
      origin: "org",
      configId: "cfg-1",
      addresses: ["203.0.113.10"],
    },
  };
}

function discovery(): DiscoveryData {
  return {
    eventWorkflows: [],
    blockWorkflows: [
      blockWorkflow("wf-platform", 101),
      blockWorkflow("wf-org-same-chain", 101, orgRoute(101)),
      blockWorkflow("wf-org-only-chain", 202, orgRoute(202)),
    ],
    networks: { 101: solanaNetwork(101), 202: solanaNetwork(202) },
  };
}

let main: typeof import("../../src/main");
let metrics: typeof import("../../lib/metrics");
let output: string[];
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetFakeWeb3(fake);
  hooks.discovery = discovery();
  output = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  }
  exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.resetModules();
  main = await import("../../src/main");
  metrics = await import("../../lib/metrics");
});

afterEach(async () => {
  await main.shutdownAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("organization routes in the reconciler", () => {
  it("leaves platform chains as they were and keeps routes out of health, metrics and logs", async () => {
    await main.synchronizeData();

    const platform = fake.instances.filter((c) => c.rpcUrl !== ORG_URL);
    expect(platform).toHaveLength(1);
    expect(platform[0].rpcUrl).toBe("https://platform-101.example");
    expect(platform[0].wsEndpoint).toBe("wss://platform-101.example");
    expect(fake.instances.filter((c) => c.rpcUrl === ORG_URL)).toHaveLength(2);

    expect(main.getAllHealth().map((h) => h.chainId)).toEqual([101]);
    main.refreshMetrics();
    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('chain="101"');
    expect(exposition).not.toContain('chain="202"');

    const logs = output.join("\n");
    expect(logs).toContain("[ingestor] chain 101 started");
    expect(logs).not.toContain("chain 202");
    expect(logs).not.toContain("org-route.example");
    expect(logs).not.toContain("org-secret-key");
    expect(logs).not.toContain(ORG_ID);
  });

  it("keeps platform chains live and the process up while a route fails", async () => {
    fake.subscribeThrows.add(ORG_URL);
    fake.rpcRejects.add(ORG_URL);

    for (let pass = 0; pass < 3; pass++) {
      await main.synchronizeData();
      for (const conn of fake.instances) {
        if (conn.rpcUrl !== ORG_URL) {
          conn.fireSlot(500 + pass);
        }
      }
    }

    expect(exit).not.toHaveBeenCalled();
    const health = main.getAllHealth();
    expect(health.map((h) => h.chainId)).toEqual([101]);
    expect(health[0].state).toBe("live");
    expect(output.join("\n")).not.toContain("org-route.example");
  });
});
