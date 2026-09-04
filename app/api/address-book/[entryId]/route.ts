import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { curateDbError } from "@/lib/db/errors";
import { addressBookEntry } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";

// Helper: Get existing entry and validate it belongs to organization
async function getExistingEntry(entryId: string, activeOrgId: string) {
  const existingEntries = await db
    .select()
    .from(addressBookEntry)
    .where(
      and(
        eq(addressBookEntry.id, entryId),
        eq(addressBookEntry.organizationId, activeOrgId)
      )
    )
    .limit(1);

  return existingEntries[0] || null;
}

// Helper: Validate and build update object
function buildUpdateObject(body: { label?: string; address?: string }) {
  const updates: {
    label?: string;
    address?: string;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };

  const label = body.label?.trim();
  if (label !== undefined) {
    if (!label) {
      return {
        error: NextResponse.json(
          { error: "Label cannot be empty" },
          { status: 400 }
        ),
      };
    }
    updates.label = label;
  }

  const address = body.address?.trim();
  if (address !== undefined) {
    if (!address) {
      return {
        error: NextResponse.json(
          { error: "Address cannot be empty" },
          { status: 400 }
        ),
      };
    }

    if (!ethers.isAddress(address)) {
      return {
        error: NextResponse.json(
          { error: "Invalid Ethereum address format" },
          { status: 400 }
        ),
      };
    }

    updates.address = normalizeAddressForStorage(address);
  }

  return { updates };
}

// PATCH - Update an address book entry
export async function PATCH(
  request: Request,
  context: { params: Promise<{ entryId: string }> }
) {
  try {
    const { entryId } = await context.params;

    const authCtx = await resolveOrganizationId(request);
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
    const { organizationId: activeOrgId } = authCtx;

    // Get existing entry
    const existingEntry = await getExistingEntry(entryId, activeOrgId);
    if (!existingEntry) {
      return NextResponse.json(
        { error: "Address book entry not found" },
        { status: 404 }
      );
    }

    // Parse and validate request body
    const body = await request.json().catch(() => ({}));
    const updateResult = buildUpdateObject(body);
    if (updateResult.error) {
      return updateResult.error;
    }
    const { updates } = updateResult;

    // Update entry
    const [updatedEntry] = await db
      .update(addressBookEntry)
      .set(updates)
      .where(
        and(
          eq(addressBookEntry.id, entryId),
          eq(addressBookEntry.organizationId, activeOrgId)
        )
      )
      .returning({
        id: addressBookEntry.id,
        label: addressBookEntry.label,
        address: addressBookEntry.address,
        createdAt: addressBookEntry.createdAt,
        updatedAt: addressBookEntry.updatedAt,
        createdBy: addressBookEntry.createdBy,
      });

    console.log(
      `[Address Book] Updated entry ${entryId} for organization ${activeOrgId}`
    );

    return NextResponse.json(updatedEntry);
  } catch (error) {
    const curated = curateDbError(error, {
      messages: { "23505": "This address is already in your address book." },
      fallback: "Failed to update address book entry",
    });
    if (curated.status >= 500) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[Address Book] Failed to update entry",
        error,
        { endpoint: "/api/address-book/[entryId]", operation: "update" }
      );
    }
    return NextResponse.json(
      { error: curated.message },
      { status: curated.status }
    );
  }
}

// DELETE - Delete an address book entry
export async function DELETE(
  request: Request,
  context: { params: Promise<{ entryId: string }> }
) {
  try {
    const { entryId } = await context.params;
    const authCtx = await resolveOrganizationId(request);
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
    const { organizationId: activeOrgId } = authCtx;

    // Verify entry exists and belongs to active organization, then delete
    const result = await db
      .delete(addressBookEntry)
      .where(
        and(
          eq(addressBookEntry.id, entryId),
          eq(addressBookEntry.organizationId, activeOrgId)
        )
      )
      .returning({ id: addressBookEntry.id });

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Address book entry not found" },
        { status: 404 }
      );
    }

    console.log(
      `[Address Book] Deleted entry ${entryId} for organization ${activeOrgId}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Address Book] Failed to delete entry",
      error,
      { endpoint: "/api/address-book/[entryId]", operation: "delete" }
    );
    const curated = curateDbError(error, {
      fallback: "Failed to delete address book entry",
    });
    return NextResponse.json(
      { error: curated.message },
      { status: curated.status }
    );
  }
}
