import { getExplorerAddressUrl } from "@/components/safe/chain-prefixes";
import { ArnSegment, parseArn } from "@/lib/policy/arn";

/**
 * Where an identifier in a policy points, when it points somewhere.
 *
 * A rule names things by identifier because that is what the engine matches on,
 * which leaves a reader holding an opaque string and no way to find out what it
 * refers to. Where the platform has a page for the thing, this returns it, so
 * reading a rule and looking at what it governs are one step rather than two.
 *
 * A wildcard resolves to nothing on purpose: `kh:workflow/*` names every
 * workflow, and sending someone to a page for a workflow called `*` is worse
 * than leaving the text alone.
 */

export type ResourceLink = {
  href: string;
  /** What to show instead of the raw identifier, when there is something better. */
  label: string;
  /** True when the page belongs to somebody else, so it opens in a new tab. */
  external?: boolean;
};

const WILDCARD = /[*]/;

/** The settings page each control-plane type is managed on. */
const SETTINGS_SEGMENT: Partial<Record<string, string>> = {
  [ArnSegment.APIKEY]: "api-keys",
  [ArnSegment.MEMBER]: "users",
  [ArnSegment.WALLET]: "wallets",
  [ArnSegment.INTEGRATION]: "connections",
  [ArnSegment.POLICY]: "policies",
  [ArnSegment.ADDRESSBOOK]: "address-book",
};

export function resourceLink(
  identifier: string,
  organizationId: string | null
): ResourceLink | null {
  if (WILDCARD.test(identifier)) {
    return null;
  }

  const parsed = parseArn(identifier);
  if (!parsed.ok) {
    return null;
  }
  const [first] = parsed.arn.parts;
  if (!first) {
    return null;
  }

  if (first.type === ArnSegment.WORKFLOW) {
    return { href: `/workflows/${first.id}`, label: first.id };
  }

  // An onchain target has no page here, but it has one on a block explorer,
  // which is where somebody checking what an address actually is would go.
  if (first.type === ArnSegment.CHAIN) {
    const contract = parsed.arn.parts.find(
      (part) =>
        part.type === ArnSegment.CONTRACT || part.type === ArnSegment.ASSET
    );
    const chainId = Number(first.id);
    if (contract && Number.isInteger(chainId)) {
      const href = getExplorerAddressUrl(chainId, contract.id);
      if (href) {
        return { href, label: contract.id, external: true };
      }
    }
    return null;
  }

  const segment = SETTINGS_SEGMENT[first.type];
  if (segment && organizationId) {
    // The settings pages already answer `?highlight=`, scrolling the card into
    // view and ringing it, so the link lands on the thing rather than the page.
    return {
      href: `/settings/${organizationId}/${segment}?highlight=${encodeURIComponent(first.id)}`,
      label: first.id,
    };
  }

  return null;
}
