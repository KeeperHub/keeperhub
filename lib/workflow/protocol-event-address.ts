import "@/protocols";
import { getProtocol } from "@/lib/protocol-registry";

/**
 * The contract address a protocol event points at on a chain, or null when it
 * does not resolve.
 *
 * An Event trigger built from a protocol event carries `_eventProtocolSlug`
 * and `_eventSlug` instead of a `contractAddress`. The events route fills the
 * address in from this before the event tracker sees the node, and the
 * validator asks the same question to decide whether the tracker will get an
 * address at all, so both read it from here.
 */
export function resolveProtocolEventAddress(
  protocolSlug: string | undefined,
  eventSlug: string | undefined,
  network: string | undefined
): string | null {
  if (!(protocolSlug && eventSlug && network)) {
    return null;
  }
  const protocol = getProtocol(protocolSlug);
  const event = protocol?.events?.find((e) => e.slug === eventSlug);
  if (!(protocol && event)) {
    return null;
  }
  const contract = protocol.contracts[event.contract];
  return contract?.addresses[network] || null;
}
