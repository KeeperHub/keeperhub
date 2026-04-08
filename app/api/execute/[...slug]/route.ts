import "server-only";
import "@/protocols";

import { NextResponse } from "next/server";
import { resolveAbi } from "@/lib/abi-cache";
import { enterApiExecuteErrorContext } from "@/lib/db/org-helpers";
import { getProtocol } from "@/lib/protocol-registry";
import { PLUGIN_STEP_IMPORTERS } from "@/lib/step-registry";
import { resolveProtocolMeta } from "@/plugins/protocol/steps/resolve-protocol-meta";
import {
  type ReadContractCoreInput,
  readContractCore,
} from "@/plugins/web3/steps/read-contract-core";
import {
  type WriteContractCoreInput,
  writeContractCore,
} from "@/plugins/web3/steps/write-contract-core";
import { validateApiKey } from "../_lib/auth";
import { checkRateLimit } from "../_lib/rate-limit";

function buildFunctionArgs(
  input: Record<string, unknown>,
  protocolSlug: string,
  contractKey: string,
  functionName: string
): string | undefined {
  const protocol = getProtocol(protocolSlug);
  if (!protocol) {
    return undefined;
  }

  const protocolAction = protocol.actions.find(
    (a) => a.function === functionName && a.contract === contractKey
  );

  if (!protocolAction || protocolAction.inputs.length === 0) {
    return undefined;
  }

  const args = protocolAction.inputs.map((inp) => {
    const value = input[inp.name];
    return value === undefined ? "" : String(value);
  });

  return JSON.stringify(args);
}

async function executeProtocolAction(
  actionType: string,
  body: Record<string, unknown>,
  organizationId: string
): Promise<NextResponse> {
  const meta = resolveProtocolMeta({ _actionType: actionType });
  if (!meta) {
    return NextResponse.json(
      {
        success: false,
        error: `Could not resolve protocol metadata for: ${actionType}`,
      },
      { status: 400 }
    );
  }

  const protocol = getProtocol(meta.protocolSlug);
  if (!protocol) {
    return NextResponse.json(
      { success: false, error: `Unknown protocol: ${meta.protocolSlug}` },
      { status: 400 }
    );
  }

  const contract = protocol.contracts[meta.contractKey];
  if (!contract) {
    return NextResponse.json(
      {
        success: false,
        error: `Unknown contract key "${meta.contractKey}" in protocol "${meta.protocolSlug}"`,
      },
      { status: 400 }
    );
  }

  const network = String(body.network ?? "");
  if (!network) {
    return NextResponse.json(
      { success: false, error: "Missing required field: network" },
      { status: 400 }
    );
  }

  const contractAddress = contract.userSpecifiedAddress
    ? String(body.contractAddress ?? "")
    : contract.addresses[network];

  if (!contractAddress) {
    return NextResponse.json(
      {
        success: false,
        error: contract.userSpecifiedAddress
          ? `Missing contract address for "${meta.contractKey}"`
          : `Protocol "${meta.protocolSlug}" contract "${meta.contractKey}" is not deployed on network "${network}"`,
      },
      { status: 400 }
    );
  }

  let resolvedAbi: string;
  try {
    const abiResult = await resolveAbi({
      contractAddress,
      network,
      abi: contract.abi,
    });
    resolvedAbi = abiResult.abi;
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: `Failed to resolve ABI: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 400 }
    );
  }

  const functionArgs = buildFunctionArgs(
    body,
    meta.protocolSlug,
    meta.contractKey,
    meta.functionName
  );

  if (meta.actionType === "read") {
    const coreInput: ReadContractCoreInput = {
      contractAddress,
      network,
      abi: resolvedAbi,
      abiFunction: meta.functionName,
      functionArgs,
      _context: { organizationId },
    };
    const result = await readContractCore(coreInput);
    return NextResponse.json(result);
  }

  const ethValue = body.ethValue ? String(body.ethValue) : undefined;
  const coreInput: WriteContractCoreInput = {
    contractAddress,
    network,
    abi: resolvedAbi,
    abiFunction: meta.functionName,
    functionArgs,
    ethValue,
    _context: { organizationId },
  };
  const result = await writeContractCore(coreInput);
  return NextResponse.json(result);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string[] }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const actionType = slug.join("/");

  if (slug.length < 2) {
    return NextResponse.json(
      { error: `Invalid action type: ${actionType}` },
      { status: 400 }
    );
  }

  // Verify the action exists in the registry
  if (!PLUGIN_STEP_IMPORTERS[actionType]) {
    return NextResponse.json(
      { error: `Unknown action: ${actionType}` },
      { status: 404 }
    );
  }

  const apiKeyCtx = await validateApiKey(request);
  if (!apiKeyCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Enter ALS error context so plugin step errors carry org labels
  await enterApiExecuteErrorContext(apiKeyCtx.organizationId);

  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // Try protocol action first (covers all protocol read/write tools)
    const meta = resolveProtocolMeta({ _actionType: actionType });
    if (meta) {
      return await executeProtocolAction(
        actionType,
        body,
        apiKeyCtx.organizationId
      );
    }

    // Non-protocol actions are not yet supported via direct execution
    return NextResponse.json(
      {
        error: `Direct execution not supported for "${actionType}". Use workflow execution instead.`,
        hint: "Create a workflow with this action and execute it via workflow_execute.",
      },
      { status: 501 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
