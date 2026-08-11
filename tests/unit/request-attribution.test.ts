import { describe, expect, it } from "vitest";
import {
  buildAttribution,
  getRequestCountry,
  getRequestSourceIp,
  resolveTriggerLabels,
} from "@/lib/security/request-attribution";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/x", { headers });
}

describe("resolveTriggerLabels", () => {
  it("passes a recognised x-trigger-type header through to both labels", () => {
    for (const t of ["block", "event", "schedule"] as const) {
      expect(resolveTriggerLabels(t, false)).toEqual({
        triggerType: t,
        triggerSource: t,
      });
      // isInternal flag is irrelevant once a valid header is present
      expect(resolveTriggerLabels(t, true)).toEqual({
        triggerType: t,
        triggerSource: t,
      });
    }
  });

  it("internal call without a header → metric 'schedule', audit 'internal'", () => {
    // Regression guard: the metric label must stay 'schedule' (NOT
    // 'scheduled') so it never re-fragments the started_total series, while
    // trigger_source keeps the more precise 'internal'.
    expect(resolveTriggerLabels(null, true)).toEqual({
      triggerType: "schedule",
      triggerSource: "internal",
    });
  });

  it("external call without a header → 'manual' on both", () => {
    expect(resolveTriggerLabels(null, false)).toEqual({
      triggerType: "manual",
      triggerSource: "manual",
    });
  });

  it("normalises a legacy 'scheduled' header to canonical 'schedule'", () => {
    // An explicit x-trigger-type: scheduled must NOT pass through as
    // "scheduled" -- that would re-fragment the metric/audit series the
    // header-less path already converges on "schedule".
    expect(resolveTriggerLabels("scheduled", false)).toEqual({
      triggerType: "schedule",
      triggerSource: "schedule",
    });
    expect(resolveTriggerLabels("scheduled", true)).toEqual({
      triggerType: "schedule",
      triggerSource: "schedule",
    });
  });

  it("ignores an unrecognised header value and falls back", () => {
    expect(resolveTriggerLabels("garbage", false)).toEqual({
      triggerType: "manual",
      triggerSource: "manual",
    });
    expect(resolveTriggerLabels("garbage", true)).toEqual({
      triggerType: "schedule",
      triggerSource: "internal",
    });
  });
});

describe("getRequestSourceIp", () => {
  it("prefers cf-connecting-ip when present", () => {
    const req = makeRequest({
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "10.0.0.1",
      "x-forwarded-for": "10.0.0.2",
    });
    expect(getRequestSourceIp(req)).toBe("203.0.113.7");
  });

  it("trims whitespace around cf-connecting-ip", () => {
    const req = makeRequest({ "cf-connecting-ip": "  203.0.113.8  " });
    expect(getRequestSourceIp(req)).toBe("203.0.113.8");
  });

  it("returns null when cf-connecting-ip is empty string", () => {
    const req = makeRequest({ "cf-connecting-ip": "   " });
    expect(getRequestSourceIp(req)).toBeNull();
  });

  it("falls back to trusted-proxy XFF when peer is a CF IP", () => {
    // 162.158.0.0/15 is a CF CIDR per lib/security/trusted-proxies.ts
    const req = makeRequest({
      "x-real-ip": "162.158.0.5",
      "x-forwarded-for": "203.0.113.99, 162.158.0.5",
    });
    expect(getRequestSourceIp(req)).toBe("203.0.113.99");
  });

  it("returns the peer when not a trusted proxy and ignores XFF", () => {
    const req = makeRequest({
      "x-real-ip": "8.8.8.8",
      "x-forwarded-for": "10.0.0.1",
    });
    expect(getRequestSourceIp(req)).toBe("8.8.8.8");
  });

  it("returns null when no IP source is present", () => {
    const req = makeRequest();
    expect(getRequestSourceIp(req)).toBeNull();
  });
});

describe("getRequestCountry", () => {
  it("returns the cf-ipcountry value when present", () => {
    expect(getRequestCountry(makeRequest({ "cf-ipcountry": "US" }))).toBe("US");
  });

  it("returns null when header is missing", () => {
    expect(getRequestCountry(makeRequest())).toBeNull();
  });

  it("returns null for CF unknown / Tor sentinels", () => {
    expect(getRequestCountry(makeRequest({ "cf-ipcountry": "XX" }))).toBeNull();
    expect(getRequestCountry(makeRequest({ "cf-ipcountry": "T1" }))).toBeNull();
  });

  it("trims whitespace", () => {
    expect(getRequestCountry(makeRequest({ "cf-ipcountry": " GB " }))).toBe(
      "GB"
    );
  });
});

describe("buildAttribution", () => {
  it("captures source, IP, and country from request", () => {
    const req = makeRequest({
      "cf-connecting-ip": "203.0.113.10",
      "cf-ipcountry": "CA",
    });
    const attribution = buildAttribution({ request: req, source: "webhook" });
    expect(attribution).toEqual({
      triggeredByUserApiKeyId: null,
      triggeredByOrgApiKeyId: null,
      triggeredByIp: "203.0.113.10",
      triggeredByCountry: "CA",
      triggerSource: "webhook",
      triggeredByCredentialType: null,
      triggeredByCredentialLabel: null,
    });
  });

  it("captures the durable credential type and label", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.12" });
    const attribution = buildAttribution({
      request: req,
      source: "webhook",
      userApiKeyId: "key_1",
      credentialType: "webhook_key",
      credentialLabel: "wfb_abc1234",
    });
    expect(attribution.triggeredByCredentialType).toBe("webhook_key");
    expect(attribution.triggeredByCredentialLabel).toBe("wfb_abc1234");
  });

  it("normalises undefined credential fields to null", () => {
    const attribution = buildAttribution({ source: "manual" });
    expect(attribution.triggeredByCredentialType).toBeNull();
    expect(attribution.triggeredByCredentialLabel).toBeNull();
  });

  it("leaves country null when cf-ipcountry header is absent", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.10" });
    const attribution = buildAttribution({ request: req, source: "webhook" });
    expect(attribution.triggeredByCountry).toBeNull();
  });

  it("passes through user and org API key IDs", () => {
    const req = makeRequest({ "cf-connecting-ip": "203.0.113.11" });
    const attribution = buildAttribution({
      request: req,
      source: "mcp",
      userApiKeyId: "user_key_1",
      orgApiKeyId: "org_key_2",
    });
    expect(attribution.triggeredByUserApiKeyId).toBe("user_key_1");
    expect(attribution.triggeredByOrgApiKeyId).toBe("org_key_2");
    expect(attribution.triggerSource).toBe("mcp");
  });

  it("returns null IP when request is omitted (internal callers)", () => {
    const attribution = buildAttribution({ source: "internal" });
    expect(attribution.triggeredByIp).toBeNull();
    expect(attribution.triggerSource).toBe("internal");
  });

  it("normalises undefined key IDs to null", () => {
    const attribution = buildAttribution({ source: "manual" });
    expect(attribution.triggeredByUserApiKeyId).toBeNull();
    expect(attribution.triggeredByOrgApiKeyId).toBeNull();
  });
});
