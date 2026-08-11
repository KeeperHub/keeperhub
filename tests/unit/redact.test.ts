import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "@/lib/utils/redact";

describe("redactSensitiveData", () => {
  it("redacts exact-match sensitive keys", () => {
    const input = {
      apiKey: "sk-12345678",
      password: "hunter2",
      token: "abc123",
    };
    const result = redactSensitiveData(input);
    expect(result.apiKey).not.toBe("sk-12345678");
    expect(result.password).not.toBe("hunter2");
    expect(result.token).not.toBe("abc123");
  });

  it("redacts pattern-match sensitive keys", () => {
    const input = {
      accessTokenValue: "secret-value",
      refreshTokenId: "refresh-123",
      bearerTokenHeader: "Bearer xyz",
      apiTokenKey: "tok-456",
      sessionTokenId: "sess-789",
      authorization: "Basic abc",
    };
    const result = redactSensitiveData(input);
    for (const key of Object.keys(input)) {
      expect(result[key], `${key} should be redacted`).not.toBe(
        input[key as keyof typeof input]
      );
    }
  });

  it("does NOT redact Web3 token balance fields", () => {
    const input = {
      currentATokenBalance: "1000000000000000000",
      currentStableDebtTokenBalance: "500000",
      currentVariableDebtTokenBalance: "250000",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      tokenAmount: "999",
      debtTokenBalance: "123456",
    };
    const result = redactSensitiveData(input);
    for (const [key, value] of Object.entries(input)) {
      expect(result[key], `${key} should NOT be redacted`).toBe(value);
    }
  });

  it("does NOT redact usageAsCollateralEnabled", () => {
    const input = { usageAsCollateralEnabled: true };
    const result = redactSensitiveData(input);
    expect(result.usageAsCollateralEnabled).toBe(true);
  });

  it("handles nested objects", () => {
    const input = {
      result: {
        currentATokenBalance: "1000",
        liquidityRate: "12345",
      },
      config: {
        apiKey: "secret-key",
      },
    };
    const result = redactSensitiveData(input);
    expect(result.result.currentATokenBalance).toBe("1000");
    expect(result.result.liquidityRate).toBe("12345");
    expect(result.config.apiKey).not.toBe("secret-key");
  });
});
