import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ExecutionAccessDenied } from "@/components/executions/execution-access-denied";
import { ExecutionShareView } from "@/components/executions/execution-share-view";
import {
  getDualAuthContext,
  hasResolvedPrincipal,
} from "@/lib/middleware/auth-helpers";
import { resolveExecutionViewAccess } from "@/lib/workflow/execution-access";
import { checkExecutionStatusRateLimit } from "@/lib/workflow/execution-status-rate-limit";

type ExecutionPageProps = {
  params: Promise<{ executionId: string }>;
};

export default async function ExecutionPage({
  params,
}: ExecutionPageProps): Promise<React.ReactElement> {
  const { executionId } = await params;
  const headerList = await headers();
  const request = new Request(`http://localhost/executions/${executionId}`, {
    headers: headerList,
  });

  const authContext = await getDualAuthContext(request, { required: false });

  const rateLimit = checkExecutionStatusRateLimit(request, authContext);
  if (!rateLimit.allowed) {
    return (
      <main className="flex min-h-[40vh] flex-col items-center justify-center gap-2 p-8 text-center">
        <h1 className="font-semibold text-lg">Too many requests</h1>
        <p className="text-muted-foreground text-sm">
          Please wait a moment and try again.
        </p>
      </main>
    );
  }

  const access = await resolveExecutionViewAccess(
    request,
    executionId,
    authContext
  );

  if (access.mode === "notFound") {
    notFound();
  }

  if (access.mode === "accessDenied") {
    return <ExecutionAccessDenied />;
  }

  if (access.mode === "invalidAuth") {
    notFound();
  }

  // Derived from the context already resolved above rather than a third
  // getSession round-trip. Anonymous-account sessions are excluded here on
  // purpose: the "View workflow" / "Back to Hub" links they gate lead to
  // surfaces an anonymous explorer has no use for.
  const hasSession =
    hasResolvedPrincipal(authContext) &&
    !authContext.isAnonymous &&
    authContext.userId !== null;

  const { execution } = access;

  return (
    <ExecutionShareView
      executionId={executionId}
      hasSession={hasSession}
      initialStatus={execution.status}
      workflowId={execution.workflow.id}
      workflowName={execution.workflow.name}
    />
  );
}
