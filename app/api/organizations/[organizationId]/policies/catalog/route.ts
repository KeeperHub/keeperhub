import { and, asc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  addressBookEntry,
  chains,
  member,
  organizationTokens,
  projects,
  safeWallets,
  supportedTokens,
  tags,
  users,
  workflows,
} from "@/lib/db/schema";
import {
  buildContractCallArn,
  CAPABILITIES,
  type Capability,
  getCapabilitiesByPlane,
  PolicyPlane,
} from "@/lib/policy";
// Registers the protocol definitions as a side effect. Without it the registry
// is empty here and the contract picker offers nothing, which reads as "this
// organization has no protocols" rather than "this module never loaded them".
import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { requireOrgPolicyAccess } from "../_lib/access";

/** A contract-level rule leaves the selector open rather than pinning one. */
const NO_SELECTOR_SUFFIX = /\/fn\/none$/;

/**
 * What a policy can be written against, for the builder.
 *
 * The point is that nobody should have to type an identifier by hand. Every
 * resource here is a real one: protocols come from the registry, chains from
 * the database, counterparties from the organization's own address book. A
 * builder that offered free text would mostly produce rules that match nothing.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }

  try {
    const [
      chainRows,
      counterparties,
      systemTokens,
      customTokens,
      projectRows,
      tagRows,
      memberRows,
      workflowRows,
      walletRows,
    ] = await Promise.all([
      db
        .select({
          chainId: chains.chainId,
          name: chains.name,
          isTestnet: chains.isTestnet,
          /** The chain's native currency, e.g. ETH, AVAX, BNB. */
          symbol: chains.symbol,
        })
        .from(chains)
        .where(eq(chains.isEnabled, true))
        .orderBy(asc(chains.name)),
      db
        .select({
          label: addressBookEntry.label,
          address: addressBookEntry.address,
        })
        .from(addressBookEntry)
        .where(eq(addressBookEntry.organizationId, organizationId))
        .orderBy(asc(addressBookEntry.label)),
      db
        .select({
          chainId: supportedTokens.chainId,
          address: supportedTokens.tokenAddress,
          symbol: supportedTokens.symbol,
          name: supportedTokens.name,
          decimals: supportedTokens.decimals,
          isStablecoin: supportedTokens.isStablecoin,
        })
        .from(supportedTokens)
        .orderBy(asc(supportedTokens.sortOrder), asc(supportedTokens.symbol)),
      db
        .select({
          chainId: organizationTokens.chainId,
          address: organizationTokens.tokenAddress,
          symbol: organizationTokens.symbol,
        })
        .from(organizationTokens)
        .where(eq(organizationTokens.organizationId, organizationId)),
      db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.organizationId, organizationId))
        .orderBy(asc(projects.name)),
      db
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(eq(tags.organizationId, organizationId))
        .orderBy(asc(tags.name)),
      db
        .select({
          id: member.userId,
          name: users.name,
          email: users.email,
          role: member.role,
        })
        .from(member)
        .innerJoin(users, eq(users.id, member.userId))
        .where(eq(member.organizationId, organizationId))
        .orderBy(asc(users.name)),
      db
        .select({ id: workflows.id, name: workflows.name })
        .from(workflows)
        .where(
          and(
            eq(workflows.organizationId, organizationId),
            isNull(workflows.deletedAt)
          )
        )
        .orderBy(asc(workflows.name)),
      db
        .select({
          id: safeWallets.id,
          address: safeWallets.safeAddress,
          chainId: safeWallets.chainId,
        })
        .from(safeWallets)
        .where(eq(safeWallets.organizationId, organizationId)),
    ]);

    // The org's own tokens come second and are marked, so a custom token is
    // distinguishable from one the platform tracks. A token the org added that
    // the platform also tracks is not duplicated.
    const seenTokens = new Set(
      systemTokens.map((token) => `${token.chainId}:${token.address}`)
    );
    const tokens = [
      ...systemTokens.map((token) => ({ ...token, custom: false })),
      ...customTokens
        .filter((token) => !seenTokens.has(`${token.chainId}:${token.address}`))
        .map((token) => ({
          ...token,
          name: token.symbol,
          decimals: null,
          isStablecoin: false,
          custom: true,
        })),
    ];

    const capabilities = (plane: PolicyPlane) =>
      getCapabilitiesByPlane(plane).map((id: Capability) => ({
        id,
        label: CAPABILITIES[id].label,
        valueMoving: CAPABILITIES[id].valueMoving,
        guardDimensions: CAPABILITIES[id].guardDimensions,
      }));

    // Each protocol contributes the concrete call identifiers it can be
    // addressed by, one per chain it is deployed on, so a rule about "Aave on
    // Base" is a selection rather than something to be typed correctly.
    const protocols = getRegisteredProtocols().map((protocol) => ({
      slug: protocol.slug,
      name: protocol.name,
      contracts: Object.entries(protocol.contracts).map(([key, contract]) => ({
        key,
        label: contract.label,
        deployments: Object.entries(contract.addresses).map(
          ([chainId, address]) => ({
            chainId: Number(chainId),
            address,
            resource: buildContractCallArn({
              chainId: Number(chainId),
              contractAddress: address,
              // A rule about a contract rather than one function leaves the
              // selector open.
              selector: null,
            }).replace(NO_SELECTOR_SUFFIX, "/fn/*"),
          })
        ),
      })),
      actions: protocol.actions.map((a) => ({
        slug: a.slug,
        label: a.label,
        type: a.type,
      })),
    }));

    return NextResponse.json({
      capabilities: {
        data: capabilities(PolicyPlane.DATA),
        control: capabilities(PolicyPlane.CONTROL),
      },
      chains: chainRows,
      protocols,
      counterparties,
      tokens,
      projects: projectRows,
      tags: tagRows,
      // Resources a control-plane rule can be narrowed to, so "which one" is a
      // selection rather than an id nobody has memorised.
      members: memberRows,
      workflows: workflowRows,
      wallets: walletRows,
    });
  } catch (error) {
    return apiError(error, "Failed to load the policy catalog");
  }
}
