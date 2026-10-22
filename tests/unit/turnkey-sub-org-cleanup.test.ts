import { describe, expect, it } from "vitest";
import type { RpcConfig } from "../../lib/rpc/rpc-config";
import type { TokenConfig } from "../../scripts/seed/supported-token-configs";
import {
  buildBalanceTargets,
  type CreationActivity,
  collectCreationsByKey,
  createRateLimiter,
  createTurnkeyReader,
  describeError,
  encodeBalanceOfCall,
  groupAddresses,
  hasNonZeroTokenAccount,
  isOwnedSolelyByKey,
  isSubOrgNotFound,
  isTransientError,
  mapWithConcurrency,
  parseHexQuantity,
  parseOptions,
  selectCandidates,
  shouldRetryTurnkeyRead,
  withRetry,
} from "../../scripts/turnkey/sub-org-cleanup";

const KEY =
  "03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_KEY =
  "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SUB_A = "11111111-1111-4111-8111-111111111111";
const SUB_B = "22222222-2222-4222-8222-222222222222";
const SUB_C = "33333333-3333-4333-8333-333333333333";
const HOUR_MS = 60 * 60 * 1000;

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_ACTIONS: "true",
    MODE: "dry-run",
    EXPECTED_KEY_PREFIX: KEY.slice(0, 16),
    TURNKEY_API_PUBLIC_KEY: KEY,
    TURNKEY_API_PRIVATE_KEY: "private",
    TURNKEY_ORGANIZATION_ID: "parent-org",
    CHAIN_RPC_CONFIG: "{}",
    ...overrides,
  };
}

function creation(
  subOrgId: string,
  signer: string,
  seconds: number,
  overrides: Partial<CreationActivity> = {}
): CreationActivity {
  return {
    status: "ACTIVITY_STATUS_COMPLETED",
    type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7",
    createdAt: { seconds: String(seconds) },
    votes: [{ publicKey: signer }],
    result: { createSubOrganizationResultV7: { subOrganizationId: subOrgId } },
    ...overrides,
  };
}

describe("parseOptions", () => {
  it("accepts a complete dry-run configuration with defaults", () => {
    const options = parseOptions(env());
    expect(options.mode).toBe("dry-run");
    expect(options.maxSubOrgs).toBe(1);
    expect(options.minAgeHours).toBe(6);
    expect(options.requestsPerSecond).toBe(10);
    expect(options.excludedSubOrgIds.size).toBe(0);
  });

  it("refuses to run outside GitHub Actions", () => {
    expect(() => parseOptions(env({ GITHUB_ACTIONS: undefined }))).toThrow(
      "only runs inside GitHub Actions"
    );
  });

  it("rejects an unknown mode", () => {
    expect(() => parseOptions(env({ MODE: "purge" }))).toThrow("MODE");
  });

  it("rejects a key prefix that does not match the key in use", () => {
    expect(() =>
      parseOptions(env({ EXPECTED_KEY_PREFIX: OTHER_KEY.slice(0, 16) }))
    ).toThrow("does not match");
  });

  it("rejects a key prefix shorter than 16 hex characters", () => {
    expect(() =>
      parseOptions(env({ EXPECTED_KEY_PREFIX: KEY.slice(0, 8) }))
    ).toThrow("at least 16");
  });

  it("matches the key prefix case-insensitively", () => {
    const options = parseOptions(
      env({ EXPECTED_KEY_PREFIX: KEY.slice(0, 16).toUpperCase() })
    );
    expect(options.apiPublicKey).toBe(KEY);
  });

  it.each([
    "TURNKEY_API_PUBLIC_KEY",
    "TURNKEY_API_PRIVATE_KEY",
    "TURNKEY_ORGANIZATION_ID",
    "CHAIN_RPC_CONFIG",
  ])("fails closed when %s is empty", (name) => {
    expect(() => parseOptions(env({ [name]: " " }))).toThrow(name);
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects MAX_SUB_ORGS=%s", (value) => {
    expect(() => parseOptions(env({ MAX_SUB_ORGS: value }))).toThrow(
      "MAX_SUB_ORGS"
    );
  });

  it.each(["0", "31"])("rejects REQUESTS_PER_SECOND=%s", (value) => {
    expect(() => parseOptions(env({ REQUESTS_PER_SECOND: value }))).toThrow(
      "REQUESTS_PER_SECOND"
    );
  });

  it("rejects MIN_AGE_HOURS below one hour", () => {
    expect(() => parseOptions(env({ MIN_AGE_HOURS: "0" }))).toThrow(
      "MIN_AGE_HOURS"
    );
  });

  it("parses comma and whitespace separated exclusions in lower case", () => {
    const options = parseOptions(
      env({ EXCLUDE_SUB_ORG_IDS: ` ${SUB_A.toUpperCase()},\n${SUB_B} ` })
    );
    expect([...options.excludedSubOrgIds]).toEqual([SUB_A, SUB_B]);
  });

  it("rejects an exclusion that is not a sub-org id", () => {
    expect(() =>
      parseOptions(env({ EXCLUDE_SUB_ORG_IDS: `${SUB_A},not-an-id` }))
    ).toThrow("not-an-id");
  });
});

describe("collectCreationsByKey", () => {
  it("keeps completed creations signed by the key, keyed in lower case", () => {
    const created = collectCreationsByKey(
      [creation(SUB_A.toUpperCase(), KEY.toUpperCase(), 100)],
      KEY
    );
    expect([...created]).toEqual([[SUB_A, 100_000]]);
  });

  it("drops creations signed by another key", () => {
    expect(
      collectCreationsByKey([creation(SUB_A, OTHER_KEY, 100)], KEY).size
    ).toBe(0);
  });

  it("drops creations with an extra signer", () => {
    const activity = creation(SUB_A, KEY, 100, {
      votes: [{ publicKey: KEY }, { publicKey: OTHER_KEY }],
    });
    expect(collectCreationsByKey([activity], KEY).size).toBe(0);
  });

  it("drops creations without any signer", () => {
    const activity = creation(SUB_A, KEY, 100, { votes: [] });
    expect(collectCreationsByKey([activity], KEY).size).toBe(0);
  });

  it("drops failed creations and other activity types", () => {
    const failed = creation(SUB_A, KEY, 100, {
      status: "ACTIVITY_STATUS_FAILED",
    });
    const other = creation(SUB_B, KEY, 100, {
      type: "ACTIVITY_TYPE_CREATE_WALLET",
    });
    expect(collectCreationsByKey([failed, other], KEY).size).toBe(0);
  });

  it("drops creations without a sub-org id or timestamp", () => {
    const noResult = creation(SUB_A, KEY, 100, { result: {} });
    const noTime = creation(SUB_B, KEY, 100, { createdAt: {} });
    expect(collectCreationsByKey([noResult, noTime], KEY).size).toBe(0);
  });
});

describe("selectCandidates", () => {
  const nowMs = 1000 * HOUR_MS;

  it("selects old sub-orgs created by the key and counts the rest", () => {
    const selection = selectCandidates({
      listedSubOrgIds: [SUB_A, SUB_B.toUpperCase(), SUB_C, "unknown-id"],
      createdByKey: new Map([
        [SUB_A, nowMs - 7 * HOUR_MS],
        [SUB_B, nowMs - 7 * HOUR_MS],
        [SUB_C, nowMs - HOUR_MS],
      ]),
      excludedSubOrgIds: new Set([SUB_B]),
      nowMs,
      minAgeHours: 6,
    });
    expect(selection).toEqual({
      candidates: [SUB_A],
      excluded: 1,
      tooYoung: 1,
      notCreatedByKey: 1,
    });
  });

  it("never selects a sub-org that is created by the key but no longer listed", () => {
    const selection = selectCandidates({
      listedSubOrgIds: [],
      createdByKey: new Map([[SUB_A, 0]]),
      excludedSubOrgIds: new Set(),
      nowMs,
      minAgeHours: 6,
    });
    expect(selection.candidates).toEqual([]);
  });
});

describe("isOwnedSolelyByKey", () => {
  const apiKey = (publicKey: string) => ({ credential: { publicKey } });

  it("accepts a single user whose only credential is the key", () => {
    expect(isOwnedSolelyByKey([{ apiKeys: [apiKey(KEY)] }], KEY)).toBe(true);
  });

  it("accepts several users that all hold only the key", () => {
    const users = [{ apiKeys: [apiKey(KEY)] }, { apiKeys: [apiKey(KEY)] }];
    expect(isOwnedSolelyByKey(users, KEY)).toBe(true);
  });

  it("rejects a sub-org with any other API key", () => {
    const users = [{ apiKeys: [apiKey(KEY), apiKey(OTHER_KEY)] }];
    expect(isOwnedSolelyByKey(users, KEY)).toBe(false);
  });

  it("rejects a sub-org with a passkey or an OAuth login", () => {
    expect(
      isOwnedSolelyByKey(
        [{ apiKeys: [apiKey(KEY)], authenticators: [{}] }],
        KEY
      )
    ).toBe(false);
    expect(
      isOwnedSolelyByKey(
        [{ apiKeys: [apiKey(KEY)], oauthProviders: [{}] }],
        KEY
      )
    ).toBe(false);
  });

  it("rejects a sub-org with no users or no keys", () => {
    expect(isOwnedSolelyByKey([], KEY)).toBe(false);
    expect(isOwnedSolelyByKey([{ apiKeys: [] }], KEY)).toBe(false);
  });
});

describe("groupAddresses", () => {
  it("splits EVM and Solana accounts and flags anything else", () => {
    expect(
      groupAddresses([
        { address: "0xABC", addressFormat: "ADDRESS_FORMAT_ETHEREUM" },
        { address: "So1ana", addressFormat: "ADDRESS_FORMAT_SOLANA" },
        {
          address: "bc1q",
          addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH",
        },
        { addressFormat: "ADDRESS_FORMAT_ETHEREUM" },
      ])
    ).toEqual({
      evm: ["0xabc"],
      solana: ["So1ana"],
      unsupported: [
        "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH",
        "ADDRESS_FORMAT_ETHEREUM",
      ],
    });
  });
});

describe("buildBalanceTargets", () => {
  const tokens: TokenConfig[] = [
    {
      chainId: 1,
      tokenAddress: "0xA0B8",
      logoUrl: null,
      isStablecoin: true,
      sortOrder: 1,
    },
    {
      chainId: 4217,
      tokenAddress: "0x20C0",
      logoUrl: null,
      isStablecoin: true,
      sortOrder: 1,
    },
    {
      chainId: 11_155_111,
      tokenAddress: "0x1C7D",
      logoUrl: null,
      isStablecoin: true,
      sortOrder: 1,
    },
  ];
  const config: RpcConfig = {
    "eth-mainnet": {
      chainId: 1,
      primaryRpcUrl: "https://eth.example",
      fallbackRpcUrl: "https://eth-fallback.example",
      isEnabled: true,
      isTestnet: false,
    },
    "tempo-mainnet": {
      chainId: 4217,
      primaryRpcUrl: "https://tempo.example",
      isTestnet: false,
    },
    "solana-mainnet": {
      chainId: 101,
      primaryRpcUrl: "https://sol.example",
      isTestnet: false,
    },
    "eth-sepolia": {
      chainId: 11_155_111,
      primaryRpcUrl: "https://sepolia.example",
      isTestnet: true,
    },
    "bsc-mainnet": {
      chainId: 56,
      primaryRpcUrl: "https://bsc.example",
      isEnabled: false,
      isTestnet: false,
    },
  };

  it("builds one target per enabled mainnet with its tokens", () => {
    expect(buildBalanceTargets(config, tokens)).toEqual([
      {
        name: "eth-mainnet",
        chainId: 1,
        kind: "evm",
        urls: ["https://eth.example", "https://eth-fallback.example"],
        checkNative: true,
        tokenAddresses: ["0xa0b8"],
      },
      {
        name: "tempo-mainnet",
        chainId: 4217,
        kind: "evm",
        urls: ["https://tempo.example"],
        checkNative: false,
        tokenAddresses: ["0x20c0"],
      },
      {
        name: "solana-mainnet",
        chainId: 101,
        kind: "solana",
        urls: ["https://sol.example"],
        checkNative: true,
        tokenAddresses: [],
      },
    ]);
  });

  it("checks an entry that has no isTestnet flag", () => {
    const targets = buildBalanceTargets(
      {
        ...config,
        "base-mainnet": {
          chainId: 8453,
          primaryRpcUrl: "https://base.example",
        },
      },
      tokens
    );
    expect(targets.map((target) => target.name)).toContain("base-mainnet");
  });

  it("fails closed without a Solana mainnet entry", () => {
    const { "solana-mainnet": _solana, ...withoutSolana } = config;
    expect(() => buildBalanceTargets(withoutSolana, tokens)).toThrow("Solana");
  });

  it("fails closed without any EVM mainnet entry", () => {
    expect(() =>
      buildBalanceTargets(
        { "solana-mainnet": config["solana-mainnet"] },
        tokens
      )
    ).toThrow("EVM");
  });

  it("fails closed on an enabled mainnet without an RPC URL", () => {
    expect(() =>
      buildBalanceTargets(
        { ...config, "base-mainnet": { chainId: 8453, isTestnet: false } },
        tokens
      )
    ).toThrow("base-mainnet");
  });

  it("fails closed on an empty config", () => {
    expect(() => buildBalanceTargets({}, tokens)).toThrow();
  });
});

describe("balance parsing", () => {
  it("parses hex quantities and treats an empty return as zero", () => {
    expect(parseHexQuantity("0x0")).toBe(BigInt(0));
    expect(parseHexQuantity("0x")).toBe(BigInt(0));
    expect(parseHexQuantity("0x0de0b6b3a7640000")).toBe(
      BigInt("1000000000000000000")
    );
  });

  it("returns undefined for anything that is not a hex quantity", () => {
    expect(parseHexQuantity(undefined)).toBeUndefined();
    expect(parseHexQuantity(null)).toBeUndefined();
    expect(parseHexQuantity(12)).toBeUndefined();
    expect(parseHexQuantity("12")).toBeUndefined();
    expect(parseHexQuantity("0xzz")).toBeUndefined();
  });

  it("encodes an ERC-20 balanceOf call", () => {
    expect(
      encodeBalanceOfCall("0x00000000000000000000000000000000000000AB")
    ).toBe(`0x70a08231${"0".repeat(62)}ab`);
  });

  it("detects a non-zero SPL token account", () => {
    const account = (amount: string) => ({
      account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
    });
    expect(hasNonZeroTokenAccount([])).toBe(false);
    expect(hasNonZeroTokenAccount([account("0")])).toBe(false);
    expect(hasNonZeroTokenAccount([account("0"), account("5")])).toBe(true);
  });
});

describe("createRateLimiter", () => {
  it("spaces calls evenly at the requested rate", async () => {
    let clock = 0;
    const waits: number[] = [];
    const limit = createRateLimiter(
      4,
      () => clock,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      }
    );
    await limit();
    await limit();
    await limit();
    expect(waits).toEqual([250, 500]);
    clock = 2000;
    await limit();
    expect(waits).toEqual([250, 500]);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps result order and never exceeds the concurrency", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      [5, 1, 4, 2, 3],
      2,
      async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, value));
        active -= 1;
        return value * 10;
      }
    );
    expect(results).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("returns an empty list for no items", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

// Shapes the Turnkey SDK and Node's fetch actually throw.
function networkError(...code: unknown[]): Error {
  const cause = new Error("socket hang up");
  if (code.length > 0) {
    Object.assign(cause, { code: code[0] });
  } else {
    Object.assign(cause, { code: "ECONNRESET" });
  }
  return new TypeError("fetch failed", { cause });
}

function turnkeyError(code: number, message: string): Error {
  return Object.assign(new Error(`Turnkey error ${code}: ${message}`), {
    name: "TurnkeyRequestError",
    code,
  });
}

const NOT_FOUND = turnkeyError(
  5,
  `${"x".repeat(400)} no organization found with given ID`
);

describe("describeError", () => {
  it("appends the network cause code that fetch hides", () => {
    expect(describeError(networkError())).toBe("fetch failed (ECONNRESET)");
  });

  it("falls back to the cause message when the code is empty", () => {
    expect(describeError(networkError(undefined))).toBe(
      "fetch failed (socket hang up)"
    );
    expect(describeError(networkError(null))).toBe(
      "fetch failed (socket hang up)"
    );
    expect(describeError(networkError(""))).toBe(
      "fetch failed (socket hang up)"
    );
  });

  it("keeps a numeric cause code", () => {
    expect(describeError(networkError(504))).toBe("fetch failed (504)");
  });

  it("returns the plain message when there is no cause", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("text")).toBe("text");
  });
});

describe("isSubOrgNotFound", () => {
  it("finds the phrase past the first 300 characters", () => {
    expect(isSubOrgNotFound(NOT_FOUND)).toBe(true);
  });

  it("is false for other errors", () => {
    expect(isSubOrgNotFound(turnkeyError(7, "permission denied"))).toBe(false);
  });
});

describe("isTransientError", () => {
  it.each([
    ["a network failure", networkError()],
    ["a Turnkey rate limit", turnkeyError(8, "rate limit exceeded")],
    ["a Turnkey internal error", turnkeyError(13, "internal")],
    ["Turnkey unavailable", turnkeyError(14, "unavailable")],
    ["a Turnkey deadline", turnkeyError(4, "deadline exceeded")],
    ["an HTTP 429 without a JSON body", new Error("429 Too Many Requests")],
    ["an HTTP 502 without a JSON body", new Error("502 Bad Gateway")],
  ])("retries %s", (_name, error) => {
    expect(isTransientError(error)).toBe(true);
  });

  it.each([
    ["an auth failure", turnkeyError(16, "unauthenticated")],
    ["a permission failure", turnkeyError(7, "permission denied")],
    ["a validation failure", turnkeyError(3, "invalid argument")],
    ["an HTTP 400 without a JSON body", new Error("400 Bad Request")],
    ["a plain error", new Error("boom")],
    ["a non-error value", "boom"],
  ])("does not retry %s", (_name, error) => {
    expect(isTransientError(error)).toBe(false);
  });
});

describe("shouldRetryTurnkeyRead", () => {
  it("never retries a missing sub-org", () => {
    expect(shouldRetryTurnkeyRead(NOT_FOUND)).toBe(false);
  });

  it("retries a dropped connection", () => {
    expect(shouldRetryTurnkeyRead(networkError())).toBe(true);
  });
});

describe("createTurnkeyReader", () => {
  const noSleep = () => Promise.resolve();

  function failing(errors: unknown[]) {
    let calls = 0;
    const call = () => {
      const error = errors[calls];
      calls += 1;
      return error === undefined
        ? Promise.resolve("ok")
        : Promise.reject(error);
    };
    return { call, calls: () => calls };
  }

  it("takes a rate-limit slot before every attempt, retries included", async () => {
    let slots = 0;
    const read = createTurnkeyReader(
      () => {
        slots += 1;
        return Promise.resolve();
      },
      { attempts: 5, baseDelayMs: 10, sleep: noSleep }
    );
    const target = failing([networkError(), networkError()]);
    expect(await read(target.call)).toBe("ok");
    expect(target.calls()).toBe(3);
    expect(slots).toBe(3);
  });

  it("does not retry a missing sub-org", async () => {
    const read = createTurnkeyReader(() => Promise.resolve(), {
      attempts: 5,
      baseDelayMs: 10,
      sleep: noSleep,
    });
    const target = failing([NOT_FOUND]);
    await expect(read(target.call)).rejects.toBe(NOT_FOUND);
    expect(target.calls()).toBe(1);
  });

  it("does not retry a permission failure", async () => {
    const read = createTurnkeyReader(() => Promise.resolve(), {
      attempts: 5,
      baseDelayMs: 10,
      sleep: noSleep,
    });
    const denied = turnkeyError(7, "permission denied");
    const target = failing([denied]);
    await expect(read(target.call)).rejects.toBe(denied);
    expect(target.calls()).toBe(1);
  });

  it("gives up after the last attempt without a final pause", async () => {
    const waits: number[] = [];
    const read = createTurnkeyReader(() => Promise.resolve(), {
      attempts: 3,
      baseDelayMs: 100,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const target = failing([networkError(), networkError(), networkError()]);
    await expect(read(target.call)).rejects.toThrow("fetch failed");
    expect(target.calls()).toBe(3);
    expect(waits).toEqual([100, 200]);
  });
});

describe("withRetry", () => {
  it("retries every error when no predicate is given", async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(new Error("HTTP 503"))
          : Promise.resolve("ok");
      },
      { attempts: 5, baseDelayMs: 10, sleep: () => Promise.resolve() }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });
});
