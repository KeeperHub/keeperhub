import { desc, eq, inArray } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { curateDbError } from "@/lib/db/errors";
import { addressBookEntry, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  resolveCreatorContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

// GET - List all address book entries for the current organization

export async function GET(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const { organizationId: activeOrgId } = authCtx;

    // List all address book entries for the organization
    const entries = await db
      .select({
        id: addressBookEntry.id,
        label: addressBookEntry.label,
        address: addressBookEntry.address,
        createdAt: addressBookEntry.createdAt,
        updatedAt: addressBookEntry.updatedAt,
        createdBy: addressBookEntry.createdBy,
      })
      .from(addressBookEntry)
      .where(eq(addressBookEntry.organizationId, activeOrgId))
      .orderBy(desc(addressBookEntry.createdAt));

    // Get unique creator IDs and fetch their names
    const creatorIds = [
      ...new Set(entries.map((e) => e.createdBy).filter(Boolean)),
    ] as string[];
    const creators =
      creatorIds.length > 0
        ? await db.query.users.findMany({
            where: inArray(users.id, creatorIds),
            columns: { id: true, name: true },
          })
        : [];
    const creatorMap = new Map(creators.map((u) => [u.id, u.name]));

    // Add createdByName to response
    const response = entries.map((entry) => ({
      ...entry,
      createdByName: entry.createdBy
        ? creatorMap.get(entry.createdBy) || null
        : null,
      createdBy: undefined,
    }));

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Address Book] Failed to list entries",
      error,
      { endpoint: "/api/address-book", operation: "list" }
    );
    const curated = curateDbError(error, {
      fallback: "Failed to list address book entries",
    });
    return NextResponse.json(
      { error: curated.message },
      { status: curated.status }
    );
  }
}

// POST - Create a new address book entry for the current organization
export async function POST(request: Request) {
  try {
    const authCtx = await resolveCreatorContext(request);
    if ("error" in authCtx) {
      return NextResponse.json(
        { error: authCtx.error },
        { status: authCtx.status }
      );
    }
    const scopeError = requireScope(authCtx.scope, SCOPE_MCP_WRITE, {
      credentialType: authCtx.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }
    const { organizationId: activeOrgId, userId } = authCtx;

    // Parse request body
    const body = await request.json().catch(() => ({}));
    const label = body.label?.trim();
    const address = body.address?.trim();

    if (!(label && address)) {
      return NextResponse.json(
        { error: "Label and address are required" },
        { status: 400 }
      );
    }

    // Validate address format
    if (!ethers.isAddress(address)) {
      return NextResponse.json(
        { error: "Invalid Ethereum address format" },
        { status: 400 }
      );
    }

    // Create new entry (store lowercase for consistency)
    const [newEntry] = await db
      .insert(addressBookEntry)
      .values({
        organizationId: activeOrgId,
        label,
        address: normalizeAddressForStorage(address),
        createdBy: userId,
      })
      .returning({
        id: addressBookEntry.id,
        label: addressBookEntry.label,
        address: addressBookEntry.address,
        createdAt: addressBookEntry.createdAt,
        updatedAt: addressBookEntry.updatedAt,
        createdBy: addressBookEntry.createdBy,
      });

    console.log(
      `[Address Book] Created new entry for organization ${activeOrgId}: ${newEntry.id}`
    );

    return NextResponse.json(newEntry, { status: 201 });
  } catch (error) {
    const curated = curateDbError(error, {
      messages: { "23505": "This address is already in your address book." },
      fallback: "Failed to create address book entry",
    });
    if (curated.status >= 500) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[Address Book] Failed to create entry",
        error,
        { endpoint: "/api/address-book", operation: "create" }
      );
    }
    return NextResponse.json(
      { error: curated.message },
      { status: curated.status }
    );
  }
}
