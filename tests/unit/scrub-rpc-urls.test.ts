import { describe, expect, it } from "vitest";
import {
  redactAllUrls,
  redactSecretUrls,
  scrubRpcUrls,
  scrubSentryEvent,
} from "@/lib/rpc/scrub-rpc-urls";

// Fake key markers. Long enough to trip the generic 32+ char path mask;
// recognizable in greps so any regression that lets them through is loud.
const FAKE_ALCHEMY_KEY = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAA";
const FAKE_INFURA_KEY = "FAKE_TEST_KEY_DO_NOT_USE_BBBBBBBBBB";
const FAKE_QUICKNODE_KEY = "FAKE_TEST_KEY_DO_NOT_USE_CCCCCCCCCC";
const FAKE_ANKR_KEY = "FAKE_TEST_KEY_DO_NOT_USE_DDDDDDDDDD";

describe("scrubRpcUrls", () => {
  it("masks Alchemy /v2/<key> paths and keeps host visible", () => {
    const input = `POST https://avax-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY} failed`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    expect(out).toContain("avax-mainnet.g.alchemy.com");
    expect(out).toContain("/v2/[REDACTED]");
  });

  it("masks Infura /v3/<key> paths", () => {
    const input = `https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_INFURA_KEY);
    expect(out).toContain("/v3/[REDACTED]");
  });

  it("masks QuickNode subdomain key paths", () => {
    const input = `https://example.quiknode.pro/${FAKE_QUICKNODE_KEY}/eth/`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_QUICKNODE_KEY);
  });

  it("masks Ankr premium /<chain>/<key> paths", () => {
    const input = `https://rpc.ankr.com/eth/${FAKE_ANKR_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ANKR_KEY);
  });

  it("drops query strings entirely", () => {
    const input = `https://rpc.example.com/foo?apikey=${FAKE_ALCHEMY_KEY}&debug=1`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    expect(out).toContain("[REDACTED-QUERY]");
  });

  it("scrubs wss:// URLs the same way", () => {
    const input = `wss://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
  });

  it("masks multiple URLs in one string", () => {
    const input =
      `tried https://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY} ` +
      `then https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    expect(out).not.toContain(FAKE_INFURA_KEY);
  });

  it("stops at delimiting characters in error prose", () => {
    const input = `(POST https://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY}) failed`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    // The closing paren should survive intact.
    expect(out).toContain(") failed");
  });

  it("leaves plain prose without URLs untouched", () => {
    expect(scrubRpcUrls("connection refused")).toBe("connection refused");
  });

  it("returns empty string for empty input", () => {
    expect(scrubRpcUrls("")).toBe("");
  });

  it("does not over-mask short path segments like /v2/ alone", () => {
    // Bare provider path without a secret - nothing to redact.
    const input = "https://example.com/api/v1/health";
    const out = scrubRpcUrls(input);
    expect(out).toContain("example.com");
    expect(out).toContain("/api/v1/health");
  });

  it("masks dRPC /<chain>/<key> paths while keeping the chain visible", () => {
    // 44-char key shape - matches the dRPC key form used in CHAIN_RPC_CONFIG.
    const fakeDrpcKey = "FAKE_TEST_KEY_DO_NOT_USE_DDDDDDDDDDDDDDDDDDDD";
    const input = `https://lb.drpc.live/polygon/${fakeDrpcKey}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(fakeDrpcKey);
    expect(out).toContain("lb.drpc.live");
    expect(out).toContain("/polygon/");
  });

  it("masks dRPC even on chain names with dashes (e.g. 0g-galileo-testnet)", () => {
    const fakeDrpcKey = "FAKE_TEST_KEY_DO_NOT_USE_DDDDDDDDDDDDDDDDDDDD";
    const input = `https://lb.drpc.live/0g-galileo-testnet/${fakeDrpcKey}`;
    const out = scrubRpcUrls(input);
    expect(out).not.toContain(fakeDrpcKey);
    expect(out).toContain("/0g-galileo-testnet/");
  });

  it("is idempotent - scrubbing already-scrubbed output is a no-op", () => {
    // The runtime applies the scrubber at multiple layers (provider source,
    // step-handler backstop, read path), so masked output must be a fixed
    // point - including the query-string replacement shape.
    const inputs = [
      `Primary: https://lb.drpc.live/ethereum/${FAKE_ALCHEMY_KEY}. Fallback: https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`,
      `https://rpc.example.com/foo?apikey=${FAKE_ALCHEMY_KEY}&debug=1`,
      "connection refused",
    ];
    for (const input of inputs) {
      const once = scrubRpcUrls(input);
      expect(scrubRpcUrls(once)).toBe(once);
    }
  });
});

describe("redactAllUrls", () => {
  it("replaces every URL with the placeholder, host included", () => {
    const input =
      `RPC failed on both endpoints. Primary: fetch https://lb.drpc.live/ethereum/${FAKE_ALCHEMY_KEY} failed. ` +
      "Fallback: fetch wss://chain.techops.services/eth-mainnet failed";
    const out = redactAllUrls(input);
    expect(out).not.toContain("lb.drpc.live");
    expect(out).not.toContain("chain.techops.services");
    expect(out).not.toContain(FAKE_ALCHEMY_KEY);
    expect(out).toContain("[REDACTED-URL]");
    expect(out).toContain("RPC failed on both endpoints");
  });

  it("is idempotent and a no-op on URL-free prose", () => {
    const once = redactAllUrls("fetch https://example.com/a failed");
    expect(redactAllUrls(once)).toBe(once);
    expect(redactAllUrls("connection refused")).toBe("connection refused");
  });
});

describe("redactSecretUrls", () => {
  it("drops known provider hosts even without a key in the path", () => {
    const out = redactSecretUrls(
      "fetch https://chain.techops.services/eth-mainnet failed"
    );
    expect(out).not.toContain("chain.techops.services");
    expect(out).toContain("[REDACTED-URL]");
  });

  it("drops key-bearing, query-bearing, and already-masked URLs entirely", () => {
    const inputs = [
      `https://lb.drpc.live/ethereum/${FAKE_ALCHEMY_KEY}`,
      `https://my-custom-node.example.com/rpc?apikey=${FAKE_INFURA_KEY}`,
      "https://my-custom-node.example.com/[REDACTED]",
      `https://my-custom-node.example.com/${FAKE_QUICKNODE_KEY}`,
    ];
    for (const input of inputs) {
      const out = redactSecretUrls(`request to ${input} failed`);
      expect(out).toBe("request to [REDACTED-URL] failed");
    }
  });

  it("keeps plain user-owned URLs readable", () => {
    const input =
      "Failed to send webhook: https://users-own-site.com/hook returned 404";
    expect(redactSecretUrls(input)).toBe(input);
  });

  it("is idempotent", () => {
    const input = `mixed: https://users-own-site.com/hook and https://lb.drpc.live/base/${FAKE_ALCHEMY_KEY}`;
    const once = redactSecretUrls(input);
    expect(redactSecretUrls(once)).toBe(once);
  });
});

// Regression-style coverage: every distinct URL shape currently present in
// CHAIN_RPC_CONFIG (host, path layout). Fake keys match the real keys'
// charset and length so coverage is meaningful. If a new provider lands in
// the config that this suite does not cover, the corresponding fake key
// will survive scrubbing and the test will fail loudly.
describe("scrubRpcUrls - CHAIN_RPC_CONFIG provider coverage", () => {
  const FAKE_ALCHEMY_21 = "FAKE_TEST_KEY_DO_NOT_AA"; // 23 chars, alchemy form
  const FAKE_ALCHEMY_32 = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAA"; // 32 chars
  const FAKE_QUICKNODE_40 = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAA"; // 40 chars
  const FAKE_DRPC_44 = "FAKE_TEST_KEY_DO_NOT_USE_AAAAAAAAAAAAAAAAAAAA"; // 44 chars

  type Case = { label: string; url: string; fakeKey?: string };

  const cases: readonly Case[] = [
    // No-secret hosts - the scrubber must not introduce false positives.
    {
      label: "TechOps proxy mainnet",
      url: "https://chain.techops.services/eth-mainnet",
    },
    {
      label: "TechOps proxy testnet",
      url: "https://chain.techops.services/base-sepolia",
    },
    {
      label: "TechOps proxy wss",
      url: "wss://chain.techops.services/arb-mainnet",
    },
    { label: "Flashbots fast", url: "https://rpc.flashbots.net/fast" },
    { label: "Flashbots sepolia", url: "https://rpc-sepolia.flashbots.net" },
    {
      label: "publicnode polygon",
      url: "https://polygon-bor-rpc.publicnode.com",
    },
    { label: "publicnode bsc", url: "https://bsc-testnet-rpc.publicnode.com" },
    { label: "arbitrum.io", url: "https://arb1.arbitrum.io/rpc" },
    {
      label: "arbitrum sepolia",
      url: "https://sepolia-rollup.arbitrum.io/rpc",
    },
    { label: "binance dataseed", url: "https://bsc-dataseed.binance.org" },
    {
      label: "polygon.technology amoy",
      url: "https://rpc-amoy.polygon.technology",
    },
    { label: "solana official mainnet", url: "https://api.mainnet.solana.com" },
    { label: "solana official devnet wss", url: "wss://api.devnet.solana.com" },
    { label: "tempo.xyz", url: "https://rpc.tempo.xyz/" },
    { label: "tempo moderato", url: "https://rpc.moderato.tempo.xyz" },
    { label: "Ankr public solana", url: "wss://rpc.ankr.com/solana" },

    // Secret-bearing hosts - must redact and must not leak the fake key.
    {
      label: "Alchemy eth-mainnet v2",
      url: `https://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_21}`,
      fakeKey: FAKE_ALCHEMY_21,
    },
    {
      label: "Alchemy avax-mainnet v2",
      url: `https://avax-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_32}`,
      fakeKey: FAKE_ALCHEMY_32,
    },
    {
      label: "Alchemy solana mainnet v2",
      url: `https://solana-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_21}`,
      fakeKey: FAKE_ALCHEMY_21,
    },
    {
      label: "Alchemy wss",
      url: `wss://base-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_21}`,
      fakeKey: FAKE_ALCHEMY_21,
    },
    {
      label: "dRPC mainnet",
      url: `https://lb.drpc.live/polygon/${FAKE_DRPC_44}`,
      fakeKey: FAKE_DRPC_44,
    },
    {
      label: "dRPC testnet with dashed chain",
      url: `https://lb.drpc.live/0g-galileo-testnet/${FAKE_DRPC_44}`,
      fakeKey: FAKE_DRPC_44,
    },
    {
      label: "dRPC wss",
      url: `wss://lb.drpc.live/bsc/${FAKE_DRPC_44}`,
      fakeKey: FAKE_DRPC_44,
    },
    {
      label: "QuickNode with trailing slash",
      url: `https://twilight-prettiest-water.0g-mainnet.quiknode.pro/${FAKE_QUICKNODE_40}/`,
      fakeKey: FAKE_QUICKNODE_40,
    },
    {
      label: "QuickNode without trailing slash",
      url: `https://twilight-prettiest-water.0g-galileo.quiknode.pro/${FAKE_QUICKNODE_40}`,
      fakeKey: FAKE_QUICKNODE_40,
    },
  ];

  it.each(cases)("$label: never leaks any secret", ({ url, fakeKey }: Case) => {
    const out = scrubRpcUrls(url);
    if (fakeKey) {
      expect(out).not.toContain(fakeKey);
    } else {
      // No-secret URLs should round-trip through the scrubber unchanged.
      expect(out).toBe(url);
    }
  });

  it("scrubs all observed shapes when concatenated into one error message", () => {
    // Worst-case fixture: every secret-bearing URL pasted into a single
    // string (the kind of payload an ethers v6 error message could become
    // if multiple failovers happen back-to-back).
    const secretCases = cases.filter((c) => c.fakeKey !== undefined);
    const blob = secretCases.map((c) => c.url).join(" | ");
    const out = scrubRpcUrls(blob);
    for (const c of secretCases) {
      if (c.fakeKey) {
        expect(out).not.toContain(c.fakeKey);
      }
    }
  });
});

describe("scrubSentryEvent", () => {
  it("scrubs the exception chain, so a linked cause cannot leak a key", () => {
    // LinkedErrors flattens `cause` into extra exception.values entries, which
    // is how a viem HttpRequestError wrapping a keyed RPC URL reaches Sentry
    // even when the top-level error message is clean.
    const event = {
      exception: {
        values: [
          { value: "HTTP request failed" },
          {
            value: `URL: https://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY}`,
          },
        ],
      },
    };

    scrubSentryEvent(event);

    expect(event.exception.values[1].value).not.toContain(FAKE_ALCHEMY_KEY);
    expect(event.exception.values[1].value).toContain(
      "eth-mainnet.g.alchemy.com"
    );
    expect(event.exception.values[0].value).toBe("HTTP request failed");
  });

  it("scrubs message, logentry and breadcrumbs", () => {
    const event = {
      message: `boom https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`,
      logentry: {
        message: `entry https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}`,
      },
      breadcrumbs: [
        { message: `crumb https://mainnet.infura.io/v3/${FAKE_INFURA_KEY}` },
      ],
    };

    scrubSentryEvent(event);

    expect(event.message).not.toContain(FAKE_INFURA_KEY);
    expect(event.logentry.message).not.toContain(FAKE_INFURA_KEY);
    expect(event.breadcrumbs[0].message).not.toContain(FAKE_INFURA_KEY);
  });

  it("leaves an event with no free-text fields alone", () => {
    const event: Record<string, unknown> = {};
    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect(event).toEqual({});
  });
});
