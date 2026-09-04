import { describe, expect, it } from "vitest";
import { PolicyRole, PrincipalKind } from "@/lib/policy";
import { extractFacts } from "@/lib/policy/facts";
import {
  hostMatchesAnyDomain,
  INTERNAL_ADDRESS_TOKEN,
  ipInAnyCidr,
  isInternalAddress,
} from "@/lib/policy/network-match";
import { principalFacts } from "@/lib/policy/principal-facts";
import type { Fact, Principal } from "@/lib/policy/types";

function state(fact: Fact<string> | undefined): string {
  if (!fact) {
    return "missing";
  }
  return fact.state === "known" ? fact.value : fact.state;
}

describe("IP matching", () => {
  const denied = ["169.254.0.0/16", "127.0.0.0/8", "10.0.0.0/8"];

  it.each([
    ["169.254.169.254", "the metadata endpoint"],
    ["::ffff:169.254.169.254", "the same endpoint, IPv4-mapped"],
    ["::ffff:a9fe:a9fe", "the same endpoint, mapped in hex groups"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback, fully expanded and mapped"],
    ["::ffff:10.1.2.3", "a private address, mapped"],
  ])("catches %s (%s)", (ip) => {
    expect(ipInAnyCidr(ip, denied)).toBe(true);
  });

  it.each([["8.8.8.8"], ["::ffff:8.8.8.8"], ["2001:db8::1"]])(
    "leaves the public address %s alone",
    (ip) => {
      expect(ipInAnyCidr(ip, denied)).toBe(false);
    }
  );

  it("treats a bare address as a single host", () => {
    expect(ipInAnyCidr("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipInAnyCidr("203.0.113.8", ["203.0.113.7"])).toBe(false);
  });
});

describe("the internal token", () => {
  it.each([
    ["169.254.169.254"],
    ["127.0.0.1"],
    ["::1"],
    ["10.1.2.3"],
    ["172.16.5.5"],
    ["192.168.1.1"],
    ["100.64.0.1"],
    ["fd00::1"],
    ["fe80::1"],
    ["64:ff9b::a9fe:a9fe"],
    ["255.255.255.255"],
  ])("blocks %s", (ip) => {
    expect(isInternalAddress(ip)).toBe(true);
    expect(ipInAnyCidr(ip, [INTERNAL_ADDRESS_TOKEN])).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["2606:4700::1111"]])(
    "allows the public address %s",
    (ip) => {
      expect(isInternalAddress(ip)).toBe(false);
    }
  );

  it("treats an unreadable address as internal, so a deny still fires", () => {
    expect(isInternalAddress("garbage")).toBe(true);
    expect(isInternalAddress("999.1.1.1")).toBe(true);
  });
});

describe("domain matching", () => {
  const allowed = ["api.stripe.com", "*.internal.corp"];

  it.each([
    ["api.stripe.com", true],
    ["API.STRIPE.COM.", true],
    ["a.internal.corp", true],
    ["deep.a.internal.corp", true],
    ["internal.corp", false],
    ["xapi.stripe.com", false],
    ["evil.com", false],
  ])("matches %s as %s", (host, expected) => {
    expect(hostMatchesAnyDomain(host, allowed)).toBe(expected);
  });
});

describe("who is acting", () => {
  const cases: [string, Principal | undefined, string, string][] = [
    [
      "an owner",
      {
        kind: PrincipalKind.MEMBER,
        userId: "joel",
        organizationId: "o",
        role: PolicyRole.OWNER,
      },
      "owner",
      "joel",
    ],
    [
      "a member",
      {
        kind: PrincipalKind.MEMBER,
        userId: "cleo",
        organizationId: "o",
        role: PolicyRole.MEMBER,
      },
      "member",
      "cleo",
    ],
    [
      "a run whose creator left the org",
      { kind: PrincipalKind.SERVICE, service: "workflow-executor" },
      "absent",
      "workflow-executor",
    ],
    ["nothing at all", undefined, "unknown", "unknown"],
  ];

  it.each(cases)("reads %s", (_name, principal, role, id) => {
    const facts = principalFacts(principal);
    expect(state(facts.actorRole)).toBe(role);
    expect(state(facts.actorId)).toBe(id);
  });

  it("never invents a role, so a rule keyed on one cannot be satisfied by a guess", () => {
    const facts = principalFacts({
      kind: PrincipalKind.SERVICE,
      service: "workflow-executor",
    });
    expect(state(facts.actorRole)).not.toBe(PolicyRole.MEMBER);
  });
});

describe("HTTP facts", () => {
  it.each([
    ["https://api.stripe.com/v1/charges", "api.stripe.com"],
    ["http://a.internal.corp/admin", "a.internal.corp"],
    ["http://169.254.169.254/latest/meta-data", "169.254.169.254"],
  ])("reads the host out of %s", (url, host) => {
    const facts = extractFacts({ actionType: "HTTP Request", config: { url } });
    expect(state(facts.httpHost as Fact<string>)).toBe(host);
  });

  it("leaves the host unknown when the URL has not resolved", () => {
    // A rule about hosts then refuses rather than reading the wrong one.
    const facts = extractFacts({
      actionType: "HTTP Request",
      config: { url: "{{@n1.url}}" },
    });
    expect(state(facts.httpHost as Fact<string>)).not.toBe("{{@n1.url}}");
  });
});
