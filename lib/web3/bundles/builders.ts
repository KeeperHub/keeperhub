import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import { bundleCapableBuilders } from "@/lib/rpc/rpc-config";

/** A builder a bundle goes to; the URL never leaves the server. */
export type BuilderEndpoint = { name: string; url: string };

/** The network's bundle-capable builders (chains.builder_rpc_urls), in order. */
export async function loadChainBuilders(
  chainId: number
): Promise<BuilderEndpoint[]> {
  const [row] = await db
    .select({ builderRpcUrls: chains.builderRpcUrls })
    .from(chains)
    .where(eq(chains.chainId, chainId))
    .limit(1);
  return bundleCapableBuilders(row?.builderRpcUrls).map(({ label, url }) => ({
    name: label,
    url,
  }));
}

/** The builders a step picked (all when none), and the picked names the network lacks. */
export function selectBuilders(
  available: readonly BuilderEndpoint[],
  picked: readonly string[] | undefined
): { endpoints: BuilderEndpoint[]; unknown: string[] } {
  if (picked === undefined) {
    return { endpoints: [...available], unknown: [] };
  }
  const byName = new Map(available.map((builder) => [builder.name, builder]));
  const endpoints: BuilderEndpoint[] = [];
  const unknown: string[] = [];
  for (const name of picked) {
    const builder = byName.get(name);
    if (builder) {
      endpoints.push(builder);
    } else {
      unknown.push(name);
    }
  }
  return { endpoints, unknown };
}
