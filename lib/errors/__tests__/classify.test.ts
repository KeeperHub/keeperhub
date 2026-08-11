import { describe, expect, it } from "vitest";
import {
  applyErrorClassHint,
  classifyExecutionError,
  isDefaultClassification,
} from "@/lib/errors/classify";
import { DEFAULT_SYSTEM_ERROR_CODE } from "@/lib/errors/error-codes";
import { ErrorCategory } from "@/lib/logging";

describe("isDefaultClassification", () => {
  it("is true for null, empty, or unmatched messages (the catch-all default)", () => {
    expect(isDefaultClassification(classifyExecutionError(null))).toBe(true);
    expect(isDefaultClassification(classifyExecutionError(""))).toBe(true);
    expect(
      isDefaultClassification(
        classifyExecutionError("something no rule matches")
      )
    ).toBe(true);
  });

  it("is false for a matched user rule", () => {
    expect(
      isDefaultClassification(
        classifyExecutionError("Unresolved template reference {{x}}")
      )
    ).toBe(false);
  });

  it("is false for a matched system rule", () => {
    expect(
      isDefaultClassification(classifyExecutionError("Execution timed out"))
    ).toBe(false);
  });
});

describe("classifyExecutionError", () => {
  describe("empty / null / unknown inputs default to system workflow_engine", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace only", "   \n\t  "],
      [
        "totally unmatched message",
        "something completely novel that no rule matches",
      ],
    ])("returns workflow_engine + system for %s", (_label, input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("user-config: template and variable failures", () => {
    it.each([
      "Unresolved template reference(s): {{@nodeId:Foo.bar}} (Reference left in render)",
      "Missing template variable(s) in URL: address",
      "HTTP request failed: Missing template variable(s) in URL: address",
      'Action node "abc123" has no action type configured',
    ])("classifies %s as configuration + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });
  });

  describe("user-config: safe-fetch validation", () => {
    it.each([
      "safe-fetch: invalid URL",
      "safe-fetch: scheme file: not allowed",
      "blocked by SSRF policy",
      "URL is required",
    ])("classifies %s as validation + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });
  });

  describe("user-config: workflow authoring mistakes", () => {
    it("Code execution failed: validation + user", () => {
      const r = classifyExecutionError(
        "Code execution failed: require is not defined"
      );
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it("Invalid contract address: validation + user", () => {
      const r = classifyExecutionError("Invalid contract address: ");
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it("Invalid function arguments: validation + user", () => {
      const r = classifyExecutionError(
        "Invalid function arguments: _fee.nativeFee: uint256 cannot be empty"
      );
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it("For Each: arraySource is required: configuration + user", () => {
      const r = classifyExecutionError(
        "For Each: arraySource is required. Configure a template reference to an array"
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("Condition references field: configuration + user", () => {
      const r = classifyExecutionError(
        'Condition references field "logs" but "logs" does not exist on the data'
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("No token selected: configuration + user", () => {
      const r = classifyExecutionError("No token selected to check");
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("Contract call failed: transaction + user", () => {
      const r = classifyExecutionError(
        "Contract call failed: Error(This spell has already been scheduled)"
      );
      expect(r.errorCategory).toBe(ErrorCategory.TRANSACTION);
      expect(r.errorType).toBe("user");
    });

    it.each([
      "Token approval failed: execution reverted (unknown custom error)",
      "Token transfer failed: execution reverted",
      'Transaction failed: missing revert data (action="call", data=null)',
    ])("classifies %s as transaction + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.TRANSACTION);
      expect(r.errorType).toBe("user");
    });

    it("Invalid Ethereum address: validation + user", () => {
      const r = classifyExecutionError(
        "Invalid Ethereum address: 0x0B3d7DE83b842A78F6d4be3Ad0C66f8b86b79e06"
      );
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it.each([
      "Function 'name' not found in ABI",
      "Call at index 0: Function 'totalSupply' not found in ABI",
    ])("classifies %s as validation + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it("DATABASE_URL is not configured: configuration + user", () => {
      const r = classifyExecutionError(
        "DATABASE_URL is not configured. Please add it in Project Integrations."
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("Para session expired: configuration + user (more specific than generic wallet-init system rule)", () => {
      const r = classifyExecutionError(
        "Failed to initialize organization wallet: Para session expired. User must re-export from wallet settings."
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });
  });

  // Message shapes below are taken verbatim from production execution rows.
  // Before these rules existed they all fell through to the catch-all and
  // paged the System Error alert as if KeeperHub had failed.
  describe("user-config: wallet funding and on-chain outcomes", () => {
    it.each([
      "Insufficient USDC balance. Have: 0.5, Need: 1",
      "Insufficient ETH balance. Have: 0.05, Need: 0.051",
      "Insufficient USDT balance. Have: 0, Need: 25",
      "Insufficient SOL balance. Have: 0 lamports, Need: 5000 lamports (5000 fee)",
      "Transaction reverted: Execution reverted on chain (tx 0xbadab698fa3d746b7ba3ff6c87b6baf40271f4650be01f1118eb16)",
    ])("classifies %s as transaction + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.TRANSACTION);
      expect(r.errorType).toBe("user");
      expect(r.code).toBeNull();
    });

    it("Wallet has no token account for mint: configuration + user", () => {
      const r = classifyExecutionError(
        "Wallet has no token account for mint 4zMMC9srt5Ri5X14GAgXhaHii5GnPAEERYPJgZJDncDU"
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("typedData.domain.chainId on an unsupported chain: validation + user", () => {
      const r = classifyExecutionError(
        "typedData.domain.chainId 137 is not a supported chain"
      );
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    // The funding rules are start-anchored on purpose. An RPC exhaustion
    // message can quote a provider body that contains the same phrase, and
    // that must stay a KeeperHub-managed RPC fault rather than being
    // reattributed to the workflow author.
    it("keeps an RPC exhaustion message system even when it quotes a balance error", () => {
      const r = classifyExecutionError(
        "RPC failed on both endpoints. Primary: Insufficient ETH balance. Have: 0.05, Need: 0.051. Fallback: timeout"
      );
      expect(r.errorCategory).toBe(ErrorCategory.NETWORK_RPC);
      expect(r.errorType).toBe("system");
    });

    it("still defaults a genuinely unknown engine failure to system", () => {
      const r = classifyExecutionError(
        "Insufficient. balance without the expected shape"
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("user-config: bad request/auth to an external endpoint (4xx)", () => {
    it.each([
      'HTTP 401: {"error":"unauthorized"}',
      "HTTP 404: Not Found",
      "HTTP 400: Bad Request",
      "HTTP request failed with status 403: Forbidden",
    ])("classifies %s as external_service + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.EXTERNAL_SERVICE);
      expect(r.errorType).toBe("user");
    });

    it.each(["URL is required", "HTTP request failed: URL is required"])(
      "keeps %s as validation + user (config fault, not transport)",
      (input) => {
        const r = classifyExecutionError(input);
        expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
        expect(r.errorType).toBe("user");
      }
    );

    it.each([
      "Failed to send webhook: fetch failed: getaddrinfo EAI_AGAIN events.pagerduty.com",
      "HTTP request failed: fetch failed: getaddrinfo ENOTFOUND api.example.com",
    ])(
      "keeps DNS-resolution failure %s as user (configured host does not resolve)",
      (input) => {
        const r = classifyExecutionError(input);
        expect(r.errorCategory).toBe(ErrorCategory.EXTERNAL_SERVICE);
        expect(r.errorType).toBe("user");
      }
    );
  });

  describe("external: third-party dependency failures", () => {
    it.each([
      "HTTP request failed: fetch failed: read ECONNRESET",
      "HTTP request failed: The operation was aborted",
      "Failed to send webhook: fetch failed: read ECONNRESET",
      "Failed to send webhook: socket hang up",
    ])("classifies transport failure %s as external", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.EXTERNAL_SERVICE);
      expect(r.errorType).toBe("external");
      expect(r.code).toBeNull();
    });

    it.each([
      "HTTP 500: Internal Server Error",
      "HTTP 502: Failed to send Discord message",
      "HTTP 503: Service Unavailable",
      "HTTP request failed with status 503: Service Unavailable",
    ])("classifies 5xx endpoint response %s as external", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.EXTERNAL_SERVICE);
      expect(r.errorType).toBe("external");
      expect(r.code).toBeNull();
    });
  });

  describe("system: KeeperHub-managed RPC failures", () => {
    it("RPC failed on both endpoints: network_rpc + system", () => {
      const r = classifyExecutionError(
        "RPC failed on both endpoints. Primary: request timeout. Fallback: request timeout"
      );
      expect(r.errorCategory).toBe(ErrorCategory.NETWORK_RPC);
      expect(r.errorType).toBe("system");
      expect(r.code).toBe("N-0001");
    });

    it("Failed to check balance: RPC failed: network_rpc + system", () => {
      const r = classifyExecutionError(
        "Failed to check balance: RPC failed on both endpoints. Primary: request timeout"
      );
      expect(r.errorCategory).toBe(ErrorCategory.NETWORK_RPC);
      expect(r.errorType).toBe("system");
    });
  });

  describe("system: database / persistence", () => {
    it.each([
      "Database query failed: Database connection failed. Please verify your connection settings.",
      'Failed query: update "workflow_executions" set "status" = $1 where "workflow_executions"."id" = $2',
      "getaddrinfo EAI_AGAIN keeperhub-prod.cwmewmwvrqii.us-east-2.rds.amazonaws.com",
    ])("classifies %s as database + system", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.DATABASE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("system: workflow engine internals", () => {
    it("Execution timed out: workflow_engine + system", () => {
      const r = classifyExecutionError(
        "Execution timed out: no progress for 30 minutes"
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });

    it("Step exceeded max retries: workflow_engine + system", () => {
      const r = classifyExecutionError(
        'Step "step//./plugins/web3/steps/read-contract//readContractStep" exceeded max retries (1 retry)'
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });

    it("Unknown action type: workflow_engine + system", () => {
      const r = classifyExecutionError(
        'Unknown action type: "condition". This action is not registered in the plugin system.'
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });

    it("wallet saturated: configuration + user, no code", () => {
      const r = classifyExecutionError(
        "Wallet is saturated: could not acquire the nonce lock for 0xae36bc35098e24bbaed3dee86ec4653eb88a71a9:1 after 120s. Transactions from one wallet are sent one at a time, so reduce this workflow's trigger rate or spread writes across additional wallets."
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
      expect(r.code).toBeNull();
    });
  });

  describe("system: infra / deploy / secrets", () => {
    it("Workflow terminated by SIGTERM: infrastructure + system", () => {
      const r = classifyExecutionError("Workflow terminated by SIGTERM signal");
      expect(r.errorCategory).toBe(ErrorCategory.INFRASTRUCTURE);
      expect(r.errorType).toBe("system");
    });

    it("Cannot find module: infrastructure + system", () => {
      const r = classifyExecutionError(
        "Cannot find module './credential-map'\nRequire stack:\n- /app/lib/credential-fetcher.ts"
      );
      expect(r.errorCategory).toBe(ErrorCategory.INFRASTRUCTURE);
      expect(r.errorType).toBe("system");
    });

    it("Failed to initialize organization wallet (missing Turnkey key): infrastructure + system", () => {
      const r = classifyExecutionError(
        "Failed to initialize organization wallet: TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY must be set"
      );
      expect(r.errorCategory).toBe(ErrorCategory.INFRASTRUCTURE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("ErrorCategory enum exhaustiveness", () => {
    it("returns values that all belong to the ErrorCategory enum", () => {
      const allCategoryValues = new Set(Object.values(ErrorCategory));
      const samples = [
        "Unresolved template reference foo",
        "Database query failed: x",
        "Execution timed out",
        "Contract call failed: x",
        "Code execution failed: x",
        "Cannot find module foo",
        "RPC failed on both endpoints: x",
        "Failed to send webhook: x",
        "Workflow terminated by SIGTERM",
        "novel unmatched error",
      ];
      for (const s of samples) {
        const r = classifyExecutionError(s);
        expect(allCategoryValues.has(r.errorCategory)).toBe(true);
        expect(
          r.errorType === "user" ||
            r.errorType === "system" ||
            r.errorType === "external"
        ).toBe(true);
      }
    });
  });
});

describe("applyErrorClassHint", () => {
  it("returns the classification unchanged when the hint is null/undefined", () => {
    const base = classifyExecutionError("Execution timed out");
    expect(applyErrorClassHint(base, null)).toEqual(base);
    expect(applyErrorClassHint(base, undefined)).toEqual(base);
  });

  it("returns unchanged when the hint already agrees with the classifier", () => {
    const base = classifyExecutionError("Unresolved template reference {{x}}");
    expect(applyErrorClassHint(base, "user")).toEqual(base);
  });

  it("overrides an unmatched (default-system) failure to external with no code", () => {
    // A third-party integration message the string classifier does not know.
    const base = classifyExecutionError("Failed to send Slack message: 503");
    expect(base.errorType).toBe("system");
    const hinted = applyErrorClassHint(base, "external");
    expect(hinted).toEqual({
      errorCategory: ErrorCategory.EXTERNAL_SERVICE,
      errorType: "external",
      code: null,
    });
  });

  it("overrides to user with no code, keeping the classifier category", () => {
    const base = classifyExecutionError("some novel provider message");
    const hinted = applyErrorClassHint(base, "user");
    expect(hinted.errorType).toBe("user");
    expect(hinted.code).toBeNull();
    expect(hinted.errorCategory).toBe(base.errorCategory);
  });

  it("keeps a system hint coded (classifier code, or the default)", () => {
    const coded = classifyExecutionError("Execution timed out");
    expect(applyErrorClassHint(coded, "system")).toEqual(coded);

    const uncoded = applyErrorClassHint(
      classifyExecutionError(
        "HTTP request failed: fetch failed: read ECONNRESET"
      ),
      "system"
    );
    expect(uncoded.errorType).toBe("system");
    expect(uncoded.code).toBe(DEFAULT_SYSTEM_ERROR_CODE);
  });
});
