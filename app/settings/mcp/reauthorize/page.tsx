/**
 * KEEP-483: stub recovery page for the MCP `insufficient_scope` error
 * envelope emitted by `buildScopeDeniedResult` in `lib/mcp/tools.ts`.
 *
 * The envelope's `upgrade_url` resolves here so an agent can show the
 * user a real, contextual page when a tool denies for missing scope —
 * not a 404. The page reads the actual `granted` and `required` scope
 * strings out of the query params and points the user at the OAuth
 * consent screen with the full scope set pre-selected.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ReauthorizeSearchParams = {
  granted?: string;
  required?: string;
};

type PageProps = {
  searchParams: Promise<ReauthorizeSearchParams>;
};

// Re-consent target: full MCP scope set so a returning user gets both
// read and write in one click. `intent=upgrade` is a marker the auth
// flow can use later if it wants to render an "upgrading existing
// connection" variant of the consent screen.
const REAUTHORIZE_HREF =
  "/oauth/authorize?scope=mcp:read+mcp:write&intent=upgrade";

export default async function McpReauthorizePage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const granted = params.granted?.trim() ?? "";
  const required = params.required?.trim() ?? "";
  const grantedLabel = granted.length > 0 ? granted : "(none)";
  const requiredLabel = required.length > 0 ? required : "more access";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            <h1 className="text-base leading-none font-semibold">
              Reauthorize MCP access
            </h1>
          </CardTitle>
          <CardDescription>
            Your KeeperHub MCP connection has{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {grantedLabel}
            </code>{" "}
            but the action you tried needs{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {requiredLabel}
            </code>
            . Re-grant access to add the missing scope.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            <p className="mb-2 font-medium text-foreground">About MCP scopes</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <span className="font-mono text-xs">mcp:read</span> — list and
                inspect workflows, executions, integrations, and plugin schemas.
              </li>
              <li>
                <span className="font-mono text-xs">mcp:write</span> — create,
                update, execute, and delete workflows, plus call protocol
                actions and listed workflows.
              </li>
              <li>
                <span className="font-mono text-xs">mcp:admin</span> — full
                access to your KeeperHub organization.
              </li>
            </ul>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button asChild variant="outline">
            <Link href="/docs/ai-tools/mcp-server">Read the docs</Link>
          </Button>
          <Button asChild>
            <Link href={REAUTHORIZE_HREF}>Re-authorize</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
