import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resolveAbi } from "@/lib/abi/cache";
import type { AbiEntry } from "@/lib/abi/types";
import { db } from "@/lib/db";
import { contractCatalog } from "@/lib/db/schema";
import { ErrorCategory, logSystemWarn, logWarn } from "@/lib/logging";
import { CATALOG_SCHEMA_VERSION } from "@/lib/policy/catalog/constants";
import { deriveContractCatalog } from "@/lib/policy/catalog/derive";
import {
  type DeclaredContract,
  declaredContract,
} from "@/lib/policy/catalog/protocol-abi";
import {
  CatalogEntrySource,
  type ContractCatalog,
} from "@/lib/policy/catalog/types";

/** How long a catalog row is served before the ABI is checked again. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Unverified contracts are retried less often, to spare explorer quota. */
const UNVERIFIED_RETRY_MS = 6 * 60 * 60 * 1000;

export type CatalogLookup = {
  chainId: number;
  address: string;
  /** Network slug the ABI resolver keys on. */
  network: string;
  protocolSlug?: string;
};

function hashAbi(abi: string): string {
  return createHash("sha256").update(abi).digest("hex");
}

function parseAbi(abi: string): readonly AbiEntry[] {
  const parsed: unknown = JSON.parse(abi);
  if (!Array.isArray(parsed)) {
    throw new Error("ABI is not an array");
  }
  return parsed as AbiEntry[];
}

/** An entry-less catalog, used when no ABI could be read. */
function unverifiedCatalog(lookup: CatalogLookup): ContractCatalog {
  return {
    chainId: lookup.chainId,
    address: lookup.address.toLowerCase(),
    implementationAddress: null,
    entries: [],
    collisions: [],
  };
}

function isFresh(fetchedAt: Date, source: string): boolean {
  const ttl =
    source === CatalogEntrySource.UNVERIFIED
      ? UNVERIFIED_RETRY_MS
      : CATALOG_TTL_MS;
  return Date.now() - fetchedAt.getTime() < ttl;
}

/**
 * A proxy that names this address as its implementation.
 *
 * Answers the question a rule author cannot: "is this the address calls are
 * actually sent to, or the one behind it". Only contracts already in the
 * catalog are known, so a null answer means "no proxy on record" rather than
 * "definitely not an implementation".
 */
async function findProxyFronting(
  chainId: number,
  address: string
): Promise<string | null> {
  const [row] = await db
    .select({ address: contractCatalog.address })
    .from(contractCatalog)
    .where(
      and(
        eq(contractCatalog.chainId, chainId),
        eq(contractCatalog.implementationAddress, address)
      )
    )
    .limit(1);
  return row?.address ?? null;
}

async function readRow(chainId: number, address: string) {
  const [row] = await db
    .select()
    .from(contractCatalog)
    .where(
      and(
        eq(contractCatalog.chainId, chainId),
        eq(contractCatalog.address, address)
      )
    )
    .limit(1);
  return row ?? null;
}

type UpsertInput = {
  lookup: CatalogLookup;
  catalog: ContractCatalog;
  abi: string | null;
  source: CatalogEntrySource;
};

async function upsert(input: UpsertInput): Promise<void> {
  const now = new Date();
  const values = {
    chainId: input.lookup.chainId,
    address: input.catalog.address,
    implementationAddress: input.catalog.implementationAddress,
    protocolSlug: input.lookup.protocolSlug ?? null,
    abi: input.abi,
    abiHash: input.abi ? hashAbi(input.abi) : null,
    entries: [...input.catalog.entries],
    collisions: [...input.catalog.collisions],
    source: input.source,
    catalogVersion: CATALOG_SCHEMA_VERSION,
    fetchedAt: now,
    updatedAt: now,
  };

  await db
    .insert(contractCatalog)
    .values(values)
    .onConflictDoUpdate({
      target: [contractCatalog.chainId, contractCatalog.address],
      set: values,
    });
}

/**
 * Re-derive from a stored ABI without touching the network.
 *
 * Used when only the derivation rules changed, which is the common case after
 * a deploy and must not cost an explorer round trip per contract.
 */
async function rederive(
  lookup: CatalogLookup,
  abi: string,
  implementationAddress: string | null
): Promise<ContractCatalog> {
  const catalog = deriveContractCatalog({
    chainId: lookup.chainId,
    address: lookup.address,
    abi: parseAbi(abi),
    implementationAddress,
    protocolSlug: lookup.protocolSlug,
  });
  await upsert({
    lookup,
    catalog,
    abi,
    source: CatalogEntrySource.DERIVED,
  });
  return catalog;
}

/**
 * Build from the ABI this platform ships, without asking an explorer.
 *
 * A registry contract is described here in full, so going to the network for
 * it would be slower, rate limited, and would fail for a contract that is
 * simply unverified rather than unknown.
 */
async function fromRegistry(
  lookup: CatalogLookup,
  declared: DeclaredContract
): Promise<ContractCatalog> {
  const catalog = deriveContractCatalog({
    chainId: lookup.chainId,
    address: lookup.address,
    abi: parseAbi(declared.abi),
    implementationAddress: null,
    protocolSlug: declared.protocolSlug,
  });
  await upsert({
    lookup: { ...lookup, protocolSlug: declared.protocolSlug },
    catalog,
    abi: declared.abi,
    source: CatalogEntrySource.DERIVED,
  });
  return catalog;
}

async function rebuild(lookup: CatalogLookup): Promise<ContractCatalog> {
  const declared = declaredContract(lookup.chainId, lookup.address);
  if (declared) {
    return await fromRegistry(lookup, declared);
  }

  const resolved = await resolveAbi({
    contractAddress: lookup.address,
    network: lookup.network,
  });
  const catalog = deriveContractCatalog({
    chainId: lookup.chainId,
    address: lookup.address,
    abi: parseAbi(resolved.abi),
    implementationAddress: resolved.implementationAddress ?? null,
    protocolSlug: lookup.protocolSlug,
  });
  await upsert({
    lookup,
    catalog,
    abi: resolved.abi,
    source: CatalogEntrySource.DERIVED,
  });
  return catalog;
}

async function recordUnverified(
  lookup: CatalogLookup
): Promise<ContractCatalog> {
  const catalog = unverifiedCatalog(lookup);
  await upsert({
    lookup,
    catalog,
    abi: null,
    source: CatalogEntrySource.UNVERIFIED,
  });
  return catalog;
}

/**
 * The catalog for one contract, rebuilt when stale.
 *
 * An unverified contract is a normal outcome, not an error: it yields an
 * entry-less catalog, which the builder renders as a plain selector field and
 * the engine reads as `signal.contractUnknown`. Nothing here throws, because a
 * contract we cannot describe must not stop a policy being authored.
 */
export async function getContractCatalog(
  lookup: CatalogLookup
): Promise<ContractCatalog> {
  const address = lookup.address.toLowerCase();
  const normalized = { ...lookup, address };

  const row = await readRow(normalized.chainId, address);

  // A contract the registry now describes must not keep serving a row that
  // recorded not knowing it. That row was written when nothing could answer,
  // and it would go on saying so for hours after a protocol is added, which
  // reads as a contract with no functions rather than a stale answer.
  const supersededByRegistry =
    row?.source === CatalogEntrySource.UNVERIFIED &&
    declaredContract(normalized.chainId, address) !== null;

  const current =
    !supersededByRegistry &&
    row?.catalogVersion === CATALOG_SCHEMA_VERSION &&
    isFresh(row.fetchedAt, row.source);

  if (row && current) {
    return {
      chainId: row.chainId,
      address: row.address,
      implementationAddress: row.implementationAddress,
      proxiedBy: await findProxyFronting(normalized.chainId, address),
      entries: row.entries,
      collisions: row.collisions,
    };
  }

  if (row?.abi && row.catalogVersion !== CATALOG_SCHEMA_VERSION) {
    try {
      return await rederive(normalized, row.abi, row.implementationAddress);
    } catch (error) {
      logSystemWarn(
        ErrorCategory.CONFIGURATION,
        "[PolicyCatalog] Stored ABI could not be re-derived",
        error,
        { chainId: String(normalized.chainId), address }
      );
    }
  }

  try {
    const built = await rebuild(normalized);
    return {
      ...built,
      proxiedBy: await findProxyFronting(normalized.chainId, address),
    };
  } catch (error) {
    logWarn("[PolicyCatalog] No ABI available for contract", {
      chainId: String(normalized.chainId),
      address,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return await recordUnverified(normalized);
  }
}

/** Drops a catalog row so the next read rebuilds it. */
export async function invalidateContractCatalog(
  chainId: number,
  address: string
): Promise<void> {
  await db
    .delete(contractCatalog)
    .where(
      and(
        eq(contractCatalog.chainId, chainId),
        eq(contractCatalog.address, address.toLowerCase())
      )
    );
}
