import { Environment, Para as ParaServer } from "@getpara/server-sdk";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  normalizeAddressForStorage,
  truncateAddress,
} from "@/lib/address-utils";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createIntegration } from "@/lib/db/integrations";
import { integrations, organizationWallets } from "@/lib/db/schema";
import { encryptUserShare } from "@/lib/encryption";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { createTurnkeyWallet } from "@/lib/turnkey/turnkey-client";
import type { WalletProvider } from "@/lib/wallet/types";

const PARA_API_KEY = process.env.PARA_API_KEY ?? "";
const PARA_ENV = process.env.PARA_ENVIRONMENT ?? "beta";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_PROVIDERS: WalletProvider[] = ["para", "turnkey"];
const EXPORTABLE_PROVIDERS: WalletProvider[] = ["para", "turnkey"];

// Helper: Validate user authentication, organization membership, and admin permissions
async function validateUserAndOrganization(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const user = session.user;

  if (!user.email) {
    return { error: "Email required to create wallet", status: 400 };
  }

  // Check if user is anonymous
  if (
    user.email.includes("@http://") ||
    user.email.includes("@https://") ||
    user.email.startsWith("temp-")
  ) {
    return {
      error:
        "Anonymous users cannot create wallets. Please sign in with a real account.",
      status: 400,
    };
  }

  // Get active organization from session
  const activeOrgId = getActiveOrgId(session);

  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  // Get user's member record in the active organization
  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });

  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  // Check if user has admin or owner role
  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can manage wallets",
      status: 403,
    };
  }

  return { user, organizationId: activeOrgId, member: activeMember };
}

// Helper: Check if a wallet already exists for this organization (one wallet per org)
async function checkExistingWallet(
  organizationId: string
): Promise<{ error: string; status: number } | { valid: true }> {
  const existing = await db
    .select({ id: organizationWallets.id })
    .from(organizationWallets)
    .where(eq(organizationWallets.organizationId, organizationId))
    .limit(1);

  if (existing.length > 0) {
    return {
      error: "A wallet already exists for this organization",
      status: 400,
    };
  }

  return { valid: true };
}

// Helper: Create wallet via Para SDK
async function createParaWallet(email: string) {
  if (!PARA_API_KEY) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[Para] PARA_API_KEY not configured",
      new Error("PARA_API_KEY not configured"),
      { endpoint: "/api/user/wallet", operation: "post" }
    );
    throw new Error("Para API key not configured");
  }

  const environment = PARA_ENV === "prod" ? Environment.PROD : Environment.BETA;
  console.log(
    `[Para] Initializing SDK with environment: ${PARA_ENV} (${environment})`
  );
  console.log(`[Para] API key: ${PARA_API_KEY.slice(0, 8)}...`);

  const paraClient = new ParaServer(environment, PARA_API_KEY);

  console.log(`[Para] Creating wallet for email: ${email}`);

  const wallet = await paraClient.createPregenWallet({
    type: "EVM",
    pregenId: { email },
  });

  const userShare = await paraClient.getUserShare();

  if (!userShare) {
    throw new Error("Failed to get user share from Para");
  }

  if (!(wallet.id && wallet.address)) {
    throw new Error("Invalid wallet data from Para");
  }

  return { wallet, userShare };
}

// Helper: Get user-friendly error response for wallet creation failures
function getErrorResponse(error: unknown): NextResponse {
  // Catch DB unique constraint violation (race condition: wallet already exists)
  if (error instanceof Error) {
    const cause = error.cause;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "23505"
    ) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Wallet] Race condition: external wallet created but DB insert hit unique constraint",
        error,
        { endpoint: "/api/user/wallet", operation: "post" }
      );
      return NextResponse.json(
        { error: "A wallet already exists for this organization" },
        { status: 409 }
      );
    }
  }

  logSystemError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[Wallet] Creation failed",
    error,
    { endpoint: "/api/user/wallet", operation: "post" }
  );

  let errorMessage = "Failed to create wallet";
  let statusCode = 500;

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes("already exists")) {
      errorMessage = "A wallet already exists for this email address";
      statusCode = 409;
    } else if (message.includes("invalid email")) {
      errorMessage = "Invalid email format";
      statusCode = 400;
    } else if (message.includes("forbidden") || message.includes("403")) {
      errorMessage = "API key authentication failed. Please contact support.";
      statusCode = 403;
    } else {
      errorMessage = error.message;
    }
  }

  return NextResponse.json({ error: errorMessage }, { status: statusCode });
}

// Helper: Store Para wallet in database and create integration
async function storeParaWalletAndIntegration(options: {
  userId: string;
  organizationId: string;
  email: string;
  paraWalletId: string;
  walletAddress: string;
  userShare: string;
}): Promise<{ walletAddress: string; walletId: string }> {
  const {
    userId,
    organizationId,
    email,
    paraWalletId,
    walletAddress,
    userShare,
  } = options;

  const normalizedWalletAddress = normalizeAddressForStorage(walletAddress);

  await db.insert(organizationWallets).values({
    userId,
    organizationId,
    provider: "para",
    email,
    walletAddress: normalizedWalletAddress,
    paraWalletId,
    userShare: encryptUserShare(userShare),
  });

  const truncatedAddress = truncateAddress(normalizedWalletAddress);
  await createIntegration({
    userId,
    organizationId,
    name: truncatedAddress,
    type: "web3",
    config: {},
  });

  return { walletAddress: normalizedWalletAddress, walletId: paraWalletId };
}

// Helper: Store Turnkey wallet in database and create integration
async function storeTurnkeyWalletAndIntegration(options: {
  userId: string;
  organizationId: string;
  email: string;
  walletAddress: string;
  turnkeySubOrgId: string;
  turnkeyWalletId: string;
  turnkeyPrivateKeyId: string;
}): Promise<{ walletAddress: string; walletId: string }> {
  const {
    userId,
    organizationId,
    email,
    walletAddress,
    turnkeySubOrgId,
    turnkeyWalletId,
    turnkeyPrivateKeyId,
  } = options;

  const normalizedWalletAddress = normalizeAddressForStorage(walletAddress);

  await db.insert(organizationWallets).values({
    userId,
    organizationId,
    provider: "turnkey",
    email,
    walletAddress: normalizedWalletAddress,
    turnkeySubOrgId,
    turnkeyWalletId,
    turnkeyPrivateKeyId,
  });

  const truncatedAddress = truncateAddress(normalizedWalletAddress);
  await createIntegration({
    userId,
    organizationId,
    name: truncatedAddress,
    type: "web3",
    config: {},
  });

  return { walletAddress: normalizedWalletAddress, walletId: turnkeyWalletId };
}

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

    const allWallets = await db
      .select()
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, activeOrgId));

    if (allWallets.length === 0) {
      return NextResponse.json({
        hasWallet: false,
        wallets: [],
        message: "No wallet found for this organization",
      });
    }

    const wallets = allWallets.map((w) => ({
      provider: w.provider,
      canExportKey: EXPORTABLE_PROVIDERS.includes(w.provider),
      walletAddress: w.walletAddress,
      walletId: w.paraWalletId ?? w.turnkeyWalletId,
      email: w.email,
      createdAt: w.createdAt,
      organizationId: w.organizationId,
    }));

    // Primary wallet (first one) for backward compatibility
    const primary = wallets[0];

    return NextResponse.json({
      hasWallet: true,
      ...primary,
      wallets,
    });
  } catch (error) {
    return apiError(error, "Failed to get wallet");
  }
}

export async function POST(request: Request) {
  try {
    // 1. Validate user, organization, and admin permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { user, organizationId } = validation;

    // 3. Parse request body
    const body: { email?: string; provider?: string } = await request.json();
    const walletEmail = body.email;
    const provider = (body.provider ?? "para") as WalletProvider;

    if (!walletEmail || typeof walletEmail !== "string") {
      return NextResponse.json(
        { error: "Email is required to create a wallet" },
        { status: 400 }
      );
    }

    if (!EMAIL_REGEX.test(walletEmail)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    if (!VALID_PROVIDERS.includes(provider)) {
      return NextResponse.json(
        {
          error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // 4. Check if a wallet already exists for this organization
    const existingCheck = await checkExistingWallet(organizationId);
    if ("error" in existingCheck) {
      return NextResponse.json(
        { error: existingCheck.error },
        { status: existingCheck.status }
      );
    }

    // 5. Create wallet via selected provider
    if (provider === "turnkey") {
      const orgName = `org-${organizationId.slice(0, 8)}`;
      const turnkeyResult = await createTurnkeyWallet(walletEmail, orgName);

      const { walletAddress: storedAddress, walletId } =
        await storeTurnkeyWalletAndIntegration({
          userId: user.id,
          organizationId,
          email: walletEmail,
          walletAddress: turnkeyResult.walletAddress,
          turnkeySubOrgId: turnkeyResult.subOrgId,
          turnkeyWalletId: turnkeyResult.walletId,
          turnkeyPrivateKeyId: turnkeyResult.privateKeyId,
        });

      return NextResponse.json({
        success: true,
        wallet: {
          address: storedAddress,
          walletId,
          email: walletEmail,
          organizationId,
          provider: "turnkey",
        },
      });
    }

    // Para wallet creation (default)
    const { wallet: paraWallet, userShare } =
      await createParaWallet(walletEmail);
    const paraWalletId = paraWallet.id as string;
    const paraAddress = paraWallet.address as string;

    const { walletAddress: paraStoredAddress } =
      await storeParaWalletAndIntegration({
        userId: user.id,
        organizationId,
        email: walletEmail,
        paraWalletId,
        walletAddress: paraAddress,
        userShare,
      });

    return NextResponse.json({
      success: true,
      wallet: {
        address: paraStoredAddress,
        walletId: paraWalletId,
        email: walletEmail,
        organizationId,
        provider: "para",
      },
    });
  } catch (error) {
    return getErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    // 1. Validate user, organization, and admin permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { organizationId } = validation;

    // 2. Get new email from request body
    const body = await request.json();
    const newEmail = body.email;

    if (!newEmail || typeof newEmail !== "string") {
      return NextResponse.json(
        { error: "Email is required to update wallet" },
        { status: 400 }
      );
    }

    // Basic email validation
    if (!EMAIL_REGEX.test(newEmail)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    // 3. Get existing wallet from database
    const existingWallet = await db
      .select()
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, organizationId))
      .limit(1);

    if (existingWallet.length === 0) {
      return NextResponse.json(
        { error: "No wallet found for this organization" },
        { status: 404 }
      );
    }

    const wallet = existingWallet[0];

    // 4. Check if email is actually different
    if (wallet.email === newEmail) {
      return NextResponse.json(
        { error: "New email is the same as the current email" },
        { status: 400 }
      );
    }

    // 5. Update wallet identifier in provider (Para only)
    if (wallet.provider === "para" && wallet.paraWalletId) {
      const environment =
        PARA_ENV === "prod" ? Environment.PROD : Environment.BETA;
      const paraClient = new ParaServer(environment, PARA_API_KEY);

      await paraClient.updatePregenWalletIdentifier({
        walletId: wallet.paraWalletId,
        newPregenId: { email: newEmail },
      });
    }

    // 6. Update email in local database
    await db
      .update(organizationWallets)
      .set({ email: newEmail })
      .where(eq(organizationWallets.organizationId, organizationId));

    return NextResponse.json({
      success: true,
      message: "Wallet email updated successfully",
      wallet: {
        address: wallet.walletAddress,
        walletId: wallet.paraWalletId ?? wallet.turnkeyWalletId,
        email: newEmail,
        organizationId,
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Para] Failed to update wallet email",
      error,
      { endpoint: "/api/user/wallet", operation: "patch" }
    );
    return apiError(error, "Failed to update wallet email");
  }
}

export async function DELETE(request: Request) {
  try {
    // 1. Validate user, organization, and admin permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { organizationId } = validation;

    // 2. Delete wallet data for this organization
    const deletedWallet = await db
      .delete(organizationWallets)
      .where(eq(organizationWallets.organizationId, organizationId))
      .returning();

    if (deletedWallet.length === 0) {
      return NextResponse.json(
        { error: "No wallet found to delete" },
        { status: 404 }
      );
    }

    // 3. Delete associated Web3 integration record
    await db
      .delete(integrations)
      .where(
        and(
          eq(integrations.organizationId, organizationId),
          eq(integrations.type, "web3")
        )
      );

    return NextResponse.json({
      success: true,
      message: "Wallet deleted successfully",
    });
  } catch (error) {
    return apiError(error, "Failed to delete wallet");
  }
}
