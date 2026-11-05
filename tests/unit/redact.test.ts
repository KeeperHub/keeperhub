import { describe, expect, it } from "vitest";
import { redactErrorSecrets, redactSensitiveData } from "@/lib/utils/redact";

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

describe("redactErrorSecrets", () => {
  it("masks the sensitive names in error text, in both forms", () => {
    const out = redactErrorSecrets(
      "Authorization: Bearer abc.def; authorization=Basic dXNlcjpwYXNz; client_secret: s3cr; token=t0k; key=k3y; pwd=p4ss"
    );
    for (const leak of [
      "abc.def",
      "dXNlcjpwYXNz",
      "s3cr",
      "t0k",
      "k3y",
      "p4ss",
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("Authorization: Bearer [REDACTED]");
  });

  it("masks the token after any Authorization scheme, or a bare value", () => {
    expect(redactErrorSecrets("Authorization: Token abc123")).toBe(
      "Authorization: Token [REDACTED]"
    );
    expect(redactErrorSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic [REDACTED]"
    );
    expect(redactErrorSecrets('"authorization": "Bot s3cr3t"')).toBe(
      '"authorization": "Bot [REDACTED]"'
    );
    expect(redactErrorSecrets("authorization=abc123; next")).toBe(
      "authorization=[REDACTED]; next"
    );
  });

  it("masks a whole value with no known scheme, and Digest's parameters", () => {
    expect(redactErrorSecrets("Authorization: abcdefghXYZ is invalid")).toBe(
      "Authorization: [REDACTED]"
    );
    expect(redactErrorSecrets("Authorization: required for this call")).toBe(
      "Authorization: [REDACTED]"
    );
    const digest = redactErrorSecrets(
      'Authorization: Digest username="bob", realm="api", nonce="n0nce", response="6629fae49393a053"\nnext line'
    );
    expect(digest).toBe("Authorization: Digest [REDACTED]\nnext line");
    expect(redactErrorSecrets("authorization: apikey s3cr3t")).toBe(
      "authorization: apikey [REDACTED]"
    );
  });

  it("masks a key=value Authorization list (AWS SigV4) to the end of the line", () => {
    const sigv4 = redactErrorSecrets(
      "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261105/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024\nnext line"
    );
    expect(sigv4).toBe("Authorization: AWS4-HMAC-SHA256 [REDACTED]\nnext line");
    expect(
      redactErrorSecrets("Authorization: Credential=AKIA, Signature=abc")
    ).toBe("Authorization: [REDACTED]");
  });

  it("keeps prose that only names a token or key readable", () => {
    const text =
      "execution reverted: Unsupported token: 0xA0b8, key: missing, auth: failed";
    expect(redactErrorSecrets(text)).toBe(text);
  });
});
