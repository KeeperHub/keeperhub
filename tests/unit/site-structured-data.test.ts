import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLANS } from "@/lib/billing/plans";

type JsonLdNode = Record<string, unknown>;

const SITE_ENV_KEYS = [
  "SITE_MARKETING_URL",
  "SITE_SUPPORT_EMAIL",
  "SITE_PRIVACY_EMAIL",
  "SITE_FOUNDING_DATE",
  "SITE_SAME_AS",
  "SITE_ADDRESS_COUNTRY",
  "SITE_ADDRESS_STREET",
  "SITE_ADDRESS_LOCALITY",
  "SITE_ADDRESS_REGION",
  "SITE_ADDRESS_POSTAL_CODE",
] as const;

describe("homepage JSON-LD", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadWith(
    overrides: Record<string, string>
  ): Promise<typeof import("@/lib/site/structured-data")> {
    const next: Record<string, string> = {
      ...(originalEnv as Record<string, string>),
      NEXT_PUBLIC_APP_URL: "https://app.keeperhub.com",
    };
    for (const key of SITE_ENV_KEYS) {
      delete next[key];
    }
    Object.assign(next, overrides);
    process.env = next as NodeJS.ProcessEnv;
    return await import("@/lib/site/structured-data");
  }

  function nodeOfType(graph: JsonLdNode, type: string): JsonLdNode {
    const nodes = graph["@graph"] as JsonLdNode[];
    const found = nodes.find((node) => node["@type"] === type);
    expect(found, `no ${type} node in the graph`).toBeDefined();
    return found as JsonLdNode;
  }

  it("emits a schema.org graph with the three identity nodes", async () => {
    const { siteJsonLd } = await loadWith({});
    const graph = siteJsonLd();
    expect(graph["@context"]).toBe("https://schema.org");
    const types = (graph["@graph"] as JsonLdNode[]).map(
      (node) => node["@type"]
    );
    expect(types).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
  });

  describe("Organization", () => {
    it("carries a contactPoint with an email and a contactType", async () => {
      const { siteJsonLd } = await loadWith({});
      const org = nodeOfType(siteJsonLd(), "Organization");
      const contactPoints = org.contactPoint as JsonLdNode[];
      expect(contactPoints.length).toBeGreaterThan(0);
      for (const point of contactPoints) {
        expect(point["@type"]).toBe("ContactPoint");
        expect(point.email).toMatch(/@/);
        expect(typeof point.contactType).toBe("string");
      }
      expect(contactPoints.map((point) => point.contactType)).toContain(
        "customer support"
      );
    });

    it("resolves to the marketing site's entity id, not a second company record", async () => {
      const { siteJsonLd } = await loadWith({});
      const graph = siteJsonLd();
      const org = nodeOfType(graph, "Organization");
      expect(org["@id"]).toBe("https://keeperhub.com/#organization");
      // The other nodes must point at that same id, or the graph describes two
      // unrelated publishers.
      expect(nodeOfType(graph, "WebSite").publisher).toEqual({
        "@id": org["@id"],
      });
      expect(nodeOfType(graph, "SoftwareApplication").provider).toEqual({
        "@id": org["@id"],
      });
    });

    it("points contact and pricing at the marketing site, not this host", async () => {
      // /contact, /privacy and /pricing are served by keeperhub.com. They were
      // briefly on this host; pointing structured data at them here shipped
      // four 404s to exactly the crawlers this graph exists for.
      const graph = JSON.stringify((await loadWith({})).siteJsonLd());
      for (const path of ["/contact", "/privacy", "/pricing"]) {
        expect(graph).toContain(`https://keeperhub.com${path}`);
        expect(graph).not.toContain(`https://app.keeperhub.com${path}`);
      }
    });

    it("publishes KeeperHub's registered address by default", async () => {
      const { siteJsonLd } = await loadWith({});
      expect(nodeOfType(siteJsonLd(), "Organization").address).toEqual({
        "@type": "PostalAddress",
        streetAddress: "Ahtri 12",
        addressLocality: "Tallinn",
        addressRegion: "Harju maakond",
        addressCountry: "EE",
        postalCode: "10151",
      });
    });

    it("withholds the default address from a deployment that is not KeeperHub", async () => {
      // Coherence guard, mirroring onChainIdentity() in lib/agent-identity.ts:
      // overriding the marketing URL renames the entity the address belongs to,
      // and serving KeeperHub's address under it would be a plausible lie in the
      // one field a reader consults to check the company is real.
      const { siteJsonLd } = await loadWith({
        SITE_MARKETING_URL: "https://example.test",
      });
      expect(nodeOfType(siteJsonLd(), "Organization")).not.toHaveProperty(
        "address"
      );
    });

    it("lets a renamed deployment publish its own address", async () => {
      const { siteJsonLd } = await loadWith({
        SITE_MARKETING_URL: "https://example.test",
        SITE_ADDRESS_COUNTRY: "DE",
        SITE_ADDRESS_LOCALITY: "Berlin",
      });
      expect(nodeOfType(siteJsonLd(), "Organization").address).toEqual({
        "@type": "PostalAddress",
        addressCountry: "DE",
        addressLocality: "Berlin",
      });
    });

    it("publishes a PostalAddress once a country is configured", async () => {
      const { siteJsonLd } = await loadWith({
        SITE_ADDRESS_COUNTRY: "AU",
        SITE_ADDRESS_LOCALITY: "Melbourne",
        SITE_ADDRESS_REGION: "VIC",
        SITE_ADDRESS_STREET: "1 Example St",
        SITE_ADDRESS_POSTAL_CODE: "3000",
      });
      expect(nodeOfType(siteJsonLd(), "Organization").address).toEqual({
        "@type": "PostalAddress",
        streetAddress: "1 Example St",
        addressLocality: "Melbourne",
        addressRegion: "VIC",
        postalCode: "3000",
        addressCountry: "AU",
      });
    });

    it("publishes a partial address rather than nothing when only a country is set", async () => {
      // An explicit country replaces the default outright; it is not merged
      // with it, or a fork would inherit a street in Tallinn.
      const { siteJsonLd } = await loadWith({ SITE_ADDRESS_COUNTRY: "AU" });
      expect(nodeOfType(siteJsonLd(), "Organization").address).toEqual({
        "@type": "PostalAddress",
        addressCountry: "AU",
      });
    });

    it("mirrors the marketing site's split between the two mailboxes", async () => {
      // human@ is the contactType "customer support" on the marketing site's
      // Organization node; support@ is what its privacy policy names for data
      // rights. Publishing a different pairing here would give one company two
      // conflicting contact records.
      const { siteJsonLd } = await loadWith({});
      const points = nodeOfType(siteJsonLd(), "Organization")
        .contactPoint as JsonLdNode[];
      expect(points[0].contactType).toBe("customer support");
      expect(points[0].email).toBe("human@keeperhub.com");
      expect(points[1].contactType).toBe("privacy");
      expect(points[1].email).toBe("support@keeperhub.com");
    });

    it("honours per-mailbox overrides independently", async () => {
      const { siteJsonLd } = await loadWith({
        SITE_SUPPORT_EMAIL: "help@example.test",
      });
      const points = nodeOfType(siteJsonLd(), "Organization")
        .contactPoint as JsonLdNode[];
      expect(points[0].email).toBe("help@example.test");
      // The privacy mailbox has its own default and is not dragged along.
      expect(points[1].email).toBe("support@keeperhub.com");
    });

    it("publishes no sameAs when a deployment declares none", async () => {
      const { siteJsonLd } = await loadWith({ SITE_SAME_AS: "" });
      expect(nodeOfType(siteJsonLd(), "Organization")).not.toHaveProperty(
        "sameAs"
      );
    });
  });

  describe("SoftwareApplication offers", () => {
    it("derives one Offer per self-serve plan from lib/billing/plans.ts", async () => {
      const { siteJsonLd } = await loadWith({});
      const offers = nodeOfType(siteJsonLd(), "SoftwareApplication")
        .offers as JsonLdNode[];
      expect(offers.map((offer) => offer.name)).toEqual([
        PLANS.free.name,
        PLANS.pro.name,
        PLANS.business.name,
      ]);
    });

    it("quotes the price billing actually charges", async () => {
      const { siteJsonLd } = await loadWith({});
      const offers = nodeOfType(siteJsonLd(), "SoftwareApplication")
        .offers as JsonLdNode[];
      const pro = offers.find((offer) => offer.name === PLANS.pro.name);
      expect(pro?.price).toBe(String(PLANS.pro.tiers[0].monthlyPrice));
      expect(pro?.priceCurrency).toBe("USD");
    });

    it("prices the free plan at zero rather than omitting it", async () => {
      const { siteJsonLd } = await loadWith({});
      const offers = nodeOfType(siteJsonLd(), "SoftwareApplication")
        .offers as JsonLdNode[];
      expect(offers[0].price).toBe("0");
    });
  });

  describe("script serialisation", () => {
    it("produces parseable JSON", async () => {
      const { siteJsonLd, siteJsonLdScript } = await loadWith({});
      expect(JSON.parse(siteJsonLdScript().replace(/\\u003c/g, "<"))).toEqual(
        siteJsonLd()
      );
    });

    it("escapes < so no value can close the script element early", async () => {
      const { siteJsonLdScript } = await loadWith({
        SITE_SAME_AS: "https://example.test/</script><script>alert(1)</script>",
      });
      const serialised = siteJsonLdScript();
      expect(serialised).not.toContain("</script>");
      expect(serialised).toContain("\\u003c/script");
    });
  });
});
