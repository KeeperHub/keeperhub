/**
 * JSON-LD published on the app's public pages.
 *
 * The graph names three nodes: the Organization that operates the service, the
 * WebSite this origin is, and the SoftwareApplication the product is, with its
 * plans as schema.org Offers derived from lib/billing/plans.ts. Offers are
 * generated rather than restated so a plan or price change cannot leave a stale
 * number in structured data - the failure mode that makes an agent quote the
 * wrong price with total confidence.
 *
 * The Organization `@id` is the marketing origin's, not this one's. See
 * lib/site/identity.ts#organizationId for why.
 */

import { PLANS, type PlanName } from "@/lib/billing/plans";
import {
  appUrl,
  docsUrl,
  foundingDate,
  KNOWS_ABOUT,
  marketingUrl,
  organizationId,
  postalAddress,
  privacyEmail,
  sameAs,
  supportEmail,
} from "@/lib/site/identity";

type JsonLdNode = Record<string, unknown>;

const OFFER_PLANS: readonly PlanName[] = ["free", "pro", "business"];

const PRODUCT_DESCRIPTION =
  "Web3 workflow automation platform. Build, schedule, and run onchain workflows - smart contract monitoring, token transfers, DeFi operations, and notifications - from a visual builder, a REST API, a CLI, or a hosted Model Context Protocol server.";

function organizationNode(): JsonLdNode {
  const address = postalAddress();
  const profiles = sameAs();
  const node: JsonLdNode = {
    "@type": "Organization",
    "@id": organizationId(),
    name: "KeeperHub",
    url: marketingUrl(),
    foundingDate: foundingDate(),
    description:
      "Blockchain automation platform for DeFi operations and Web3 workflows, built so that both people and AI agents can run onchain automation safely.",
    logo: {
      "@type": "ImageObject",
      url: `${appUrl()}/keeperhub_logo.png`,
    },
    knowsAbout: [...KNOWS_ABOUT],
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: supportEmail(),
        // marketingUrl(), not appUrl(): /contact, /privacy and /pricing are
        // served by keeperhub.com. They were briefly on this host and were
        // removed as duplicates, so pointing structured data at them here
        // would ship 404s to the crawlers this graph exists for.
        url: `${marketingUrl()}/contact`,
        availableLanguage: ["en"],
      },
      {
        "@type": "ContactPoint",
        contactType: "privacy",
        email: privacyEmail(),
        url: `${marketingUrl()}/privacy`,
        availableLanguage: ["en"],
      },
    ],
  };
  // Omitted rather than guessed when the deployment has not declared one; a
  // fabricated address is a worse legitimacy signal than a missing one.
  if (address) {
    node.address = { "@type": "PostalAddress", ...address };
  }
  if (profiles.length > 0) {
    node.sameAs = [...profiles];
  }
  return node;
}

function offerNode(plan: PlanName): JsonLdNode {
  const definition = PLANS[plan];
  const [entryTier] = definition.tiers;
  const price = entryTier ? entryTier.monthlyPrice : 0;
  return {
    "@type": "Offer",
    "@id": `${marketingUrl()}/pricing#${plan}`,
    name: definition.name,
    description: definition.description,
    url: `${marketingUrl()}/pricing`,
    price: String(price),
    priceCurrency: "USD",
    category: plan === "free" ? "free" : "subscription",
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: String(price),
      priceCurrency: "USD",
      // schema.org expects an ISO 8601 duration for the billing period.
      billingDuration: 1,
      billingIncrement: 1,
      unitCode: "MON",
    },
    eligibleQuantity: {
      "@type": "QuantitativeValue",
      name: "Included executions per month",
      value: definition.features.maxExecutionsPerMonth,
      unitText: "executions/month",
    },
  };
}

function softwareApplicationNode(): JsonLdNode {
  const app = appUrl();
  return {
    "@type": "SoftwareApplication",
    "@id": `${app}/#software`,
    name: "KeeperHub",
    url: app,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Workflow automation",
    operatingSystem: "Web",
    description: PRODUCT_DESCRIPTION,
    softwareHelp: { "@type": "CreativeWork", url: docsUrl() },
    featureList: [
      "Visual workflow builder",
      "Scheduled, webhook, event, and block triggers",
      "Smart contract reads and writes across EVM chains and Solana",
      "DeFi protocol actions",
      "Managed wallets with hardware-enclave key custody",
      "Per-organization spending limits and gas sponsorship",
      "REST API with a typed error model",
      "Hosted Model Context Protocol server",
      "Official kh command-line tool",
      "Multi-channel notifications",
    ],
    provider: { "@id": organizationId() },
    offers: OFFER_PLANS.map(offerNode),
  };
}

function webSiteNode(): JsonLdNode {
  const app = appUrl();
  return {
    "@type": "WebSite",
    "@id": `${app}/#website`,
    url: app,
    name: "KeeperHub",
    inLanguage: "en",
    description: PRODUCT_DESCRIPTION,
    publisher: { "@id": organizationId() },
  };
}

/** The `@graph` embedded on every public page. */
export function siteJsonLd(): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@graph": [organizationNode(), webSiteNode(), softwareApplicationNode()],
  };
}

/**
 * Serialised for embedding in a `<script type="application/ld+json">`.
 *
 * `<` is escaped so no value in the graph can close the script element early -
 * the standard JSON-LD injection guard. Every value here is deployment
 * configuration rather than user input, but the guard costs nothing and the
 * next contributor to add a field should not have to know that.
 */
export function siteJsonLdScript(): string {
  return JSON.stringify(siteJsonLd()).replace(/</g, "\\u003c");
}
