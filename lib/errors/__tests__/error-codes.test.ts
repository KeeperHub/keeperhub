import { describe, expect, it } from "vitest";
import { classifyExecutionError } from "@/lib/errors/classify";
import {
  DEFAULT_SYSTEM_ERROR_CODE,
  ERROR_CODES,
  ErrorCodePrefix,
  getCustomerMessageForCode,
  getErrorCodeEntry,
  isErrorCode,
} from "@/lib/errors/error-codes";

const CODE_FORMAT = /^(E|N|P|C|CS|BS|ES)-\d{4}$/;
const KNOWN_PREFIXES = new Set<string>(Object.values(ErrorCodePrefix));

describe("ERROR_CODES registry", () => {
  it("every entry's key matches its code and prefix", () => {
    for (const [key, entry] of Object.entries(ERROR_CODES)) {
      expect(entry.code).toBe(key);
      expect(key).toMatch(CODE_FORMAT);
      // Prefix is the segment before the dash.
      expect(entry.prefix).toBe(key.slice(0, key.indexOf("-")));
      expect(KNOWN_PREFIXES.has(entry.prefix)).toBe(true);
    }
  });

  it("every entry has a non-empty customer message that includes its code", () => {
    for (const entry of Object.values(ERROR_CODES)) {
      expect(entry.customerMessage.length).toBeGreaterThan(0);
      // The code must be visible to the user so support can act on it.
      expect(entry.customerMessage).toContain(entry.code);
    }
  });

  it("the default system code is registered", () => {
    expect(isErrorCode(DEFAULT_SYSTEM_ERROR_CODE)).toBe(true);
    expect(ERROR_CODES[DEFAULT_SYSTEM_ERROR_CODE]).toBeDefined();
  });
});

describe("registry helpers", () => {
  it("isErrorCode discriminates known vs unknown vs nullish", () => {
    expect(isErrorCode("C-0001")).toBe(true);
    expect(isErrorCode("Z-9999")).toBe(false);
    expect(isErrorCode("")).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });

  it("getErrorCodeEntry returns the entry or null", () => {
    expect(getErrorCodeEntry("P-0001")?.component).toBe("Pod");
    expect(getErrorCodeEntry("nope")).toBeNull();
    expect(getErrorCodeEntry(null)).toBeNull();
  });

  it("getCustomerMessageForCode returns the message or null", () => {
    expect(getCustomerMessageForCode("E-0001")).toBe(
      ERROR_CODES["E-0001"].customerMessage
    );
    expect(getCustomerMessageForCode("unknown")).toBeNull();
    expect(getCustomerMessageForCode(null)).toBeNull();
  });
});

describe("classifyExecutionError code contract", () => {
  it("null/empty/unmatched messages get the default system code", () => {
    for (const input of [null, undefined, "", "   ", "totally novel error"]) {
      const r = classifyExecutionError(input);
      expect(r.errorType).toBe("system");
      expect(r.code).toBe(DEFAULT_SYSTEM_ERROR_CODE);
    }
  });

  it("system failures always carry a registered code", () => {
    const systemMessages = [
      "RPC failed on both endpoints. Primary: timeout",
      "Failed to check balance: RPC failed on both endpoints",
      "Database query failed: connection refused",
      'Failed query: update "workflow_executions" set "status" = $1',
      "getaddrinfo EAI_AGAIN keeperhub-prod.x.us-east-2.rds.amazonaws.com",
      "Execution timed out: no progress for 30 minutes",
      'Step "x" exceeded max retries (1 retry)',
      "Unknown action type: condition",
      "Workflow terminated by SIGTERM signal",
      "Cannot find module './credential-map'",
      "TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY must be set",
      "Failed to initialize organization wallet: turnkey down",
    ];
    for (const msg of systemMessages) {
      const r = classifyExecutionError(msg);
      expect(r.errorType, msg).toBe("system");
      expect(isErrorCode(r.code), `${msg} -> ${r.code}`).toBe(true);
    }
  });

  it("external dependency failures never carry a code", () => {
    const externalMessages = [
      "Failed to send webhook: socket hang up",
      "HTTP request failed: fetch failed: read ECONNRESET",
    ];
    for (const msg of externalMessages) {
      const r = classifyExecutionError(msg);
      expect(r.errorType, msg).toBe("external");
      expect(r.code, msg).toBeNull();
    }
  });

  it("user failures never carry a code", () => {
    const userMessages = [
      "Unresolved template reference(s): {{@nodeId:Foo.bar}}",
      "Missing template variable(s) in URL: address",
      "Invalid contract address: 0x0",
      "Contract call failed: reverted",
      "Code execution failed: require is not defined",
      "HTTP 404: Not Found",
      "DATABASE_URL is not configured.",
      "Failed to initialize organization wallet: Para session expired.",
    ];
    for (const msg of userMessages) {
      const r = classifyExecutionError(msg);
      expect(r.errorType, msg).toBe("user");
      expect(r.code, msg).toBeNull();
    }
  });

  it("the nullness invariant holds: system <=> code present, user <=> code null", () => {
    const samples = [
      "RPC failed on both endpoints",
      "Unresolved template reference foo",
      "Database query failed",
      "Contract call failed: x",
      "Workflow terminated by SIGTERM",
      "novel unmatched error",
    ];
    for (const s of samples) {
      const r = classifyExecutionError(s);
      if (r.errorType === "system") {
        expect(isErrorCode(r.code)).toBe(true);
      } else {
        expect(r.code).toBeNull();
      }
    }
  });
});
