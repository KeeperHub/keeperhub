import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FactProvenance, FactState } from "@/lib/policy/constants";
import { summariseFactsForLog } from "@/lib/policy/guard";

/**
 * The decision log is read by anyone who can see policy, which is a wider
 * audience than the people who can see an execution. A step's URL routinely
 * carries a credential in its query string, so what reaches the log has to be
 * enough to explain the verdict and no more.
 */
const known = (value: unknown) => ({
  state: FactState.KNOWN,
  value,
  provenance: FactProvenance.AUTHORITATIVE,
});

describe("what a decision writes down", () => {
  it("drops the query string from a URL", () => {
    const out = summariseFactsForLog({
      httpUrl: known(
        "https://api.example.com/v1/pay?api_key=sk_live_abcdef123"
      ),
    } as never);

    expect(out.httpUrl).toBe("https://api.example.com/v1/pay");
    expect(JSON.stringify(out)).not.toContain("sk_live_abcdef123");
  });

  it("drops a fragment too", () => {
    const out = summariseFactsForLog({
      httpUrl: known("https://api.example.com/v1/pay#token=abc123"),
    } as never);

    expect(JSON.stringify(out)).not.toContain("abc123");
  });

  it("keeps a URL that carries nothing extra", () => {
    const out = summariseFactsForLog({
      httpUrl: known("https://api.example.com/v1/pay"),
    } as never);

    expect(out.httpUrl).toBe("https://api.example.com/v1/pay");
  });

  it("records nothing readable for a value that is not a URL", () => {
    // An unresolved template was never a URL, so there is no query to split off
    // and nothing safe to assume about what the rest of it contains.
    const out = summariseFactsForLog({
      httpUrl: known("{{@Fetch.url}}?key=secret123"),
    } as never);

    expect(JSON.stringify(out)).not.toContain("secret123");
  });

  it("leaves other string facts alone", () => {
    const out = summariseFactsForLog({
      httpHost: known("api.example.com"),
      selector: known("0x617ba037"),
    } as never);

    expect(out.httpHost).toBe("api.example.com");
    expect(out.selector).toBe("0x617ba037");
  });
});
