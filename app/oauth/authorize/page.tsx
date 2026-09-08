import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  isAnonymousUserShape,
  logAnonymousExecutionBlock,
} from "@/lib/auth-anonymous-guard";
import {
  clampScope,
  normalizeScope,
  parseScopes,
  SUPPORTED_SCOPES,
  scopeExceeds,
} from "@/lib/mcp/oauth-scopes";
import {
  AUTH_CODE_TTL_MS,
  getOAuthClient,
  storeAuthCode,
} from "@/lib/mcp/oauth-store";
import { isAllowedRedirectUri } from "@/lib/mcp/redirect-uri";
import { getScopePolicyForMint, policyCeiling } from "@/lib/mcp/scope-policy";
import { getOrgContext } from "@/lib/middleware/org-context";
import { ConsentForm } from "./_components/consent-form";
import { isConsentOrgMismatch } from "./_lib/consent-binding";

type AuthorizeSearchParams = {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
};

type PageProps = {
  searchParams: Promise<AuthorizeSearchParams>;
};

function errorRedirect(
  redirectUri: string,
  error: string,
  state: string | undefined
): never {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) {
    url.searchParams.set("state", state);
  }
  redirect(url.toString());
}

async function handleApprove(formData: FormData): Promise<void> {
  "use server";
  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  // The permissions section renders one checkbox per scope, so the granted
  // scope is whatever the user left checked -- not a fixed value bound into a
  // hidden field. normalizeScope drops anything unknown and falls back to
  // mcp:read if every box was unchecked, so a token can never carry a bogus or
  // empty scope.
  const scope = normalizeScope(
    formData
      .getAll("scope")
      .map((value) => value.toString())
      .join(" ")
  );
  const state = formData.get("state") as string | null;
  const codeChallenge = formData.get("code_challenge") as string;
  const codeChallengeMethod = formData.get("code_challenge_method") as string;

  const client = await getOAuthClient(clientId);
  if (
    !(
      client?.redirectUris.includes(redirectUri) &&
      isAllowedRedirectUri(redirectUri)
    )
  ) {
    redirect("/oauth/authorize?error=invalid_request");
  }

  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    redirect(`/?returnTo=${encodeURIComponent("/oauth/authorize")}`);
  }

  // Anonymous accounts must never be issued an mcp token.
  if (isAnonymousUserShape(session.user)) {
    logAnonymousExecutionBlock("oauth_consent", session.user.id);
    errorRedirect(redirectUri, "access_denied", state ?? undefined);
  }

  const orgContext = await getOrgContext();
  const organizationId = orgContext.organization?.id ?? session.user.id;

  // F-022 / KEEP-747: the consent page rendered (and showed the user) a
  // specific org and bound its id into the form. If the active org changed
  // between viewing the page and approving (e.g. switched in another tab), the
  // org resolved here no longer matches what the user consented to -- refuse
  // rather than silently scope the token to a different org.
  const consentedOrgId = formData.get("organization_id") as string | null;
  if (isConsentOrgMismatch(consentedOrgId, organizationId)) {
    errorRedirect(redirectUri, "access_denied", state ?? undefined);
  }

  // The organization's ceiling applies at consent, not only afterwards.
  // Without this a member could tick every box and connect above the limit,
  // leaving the setting to be enforced only on connections that already exist.
  const grantedScope = clampScope(
    scope,
    policyCeiling(await getScopePolicyForMint(session.user.id, organizationId))
  );

  const code = crypto.randomUUID().replace(/-/g, "");
  await storeAuthCode({
    code,
    clientId,
    redirectUri,
    scope: grantedScope,
    userId: session.user.id,
    organizationId,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) {
    callbackUrl.searchParams.set("state", state);
  }
  redirect(callbackUrl.toString());
}

async function handleDeny(formData: FormData): Promise<void> {
  "use server";
  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const state = formData.get("state") as string | null;

  const client = await getOAuthClient(clientId);
  if (
    !(
      client?.redirectUris.includes(redirectUri) &&
      isAllowedRedirectUri(redirectUri)
    )
  ) {
    redirect("/oauth/authorize?error=invalid_request");
  }

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("error", "access_denied");
  if (state) {
    callbackUrl.searchParams.set("state", state);
  }
  redirect(callbackUrl.toString());
}

export default async function AuthorizePage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: responseType,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  } = params;

  // Validate required parameters before doing anything else
  if (!(clientId && redirectUri)) {
    return (
      <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-xl border bg-background px-4 shadow-2xl ring-1 ring-black/5">
          <div className="flex flex-col gap-1.5 p-6 pb-0">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Invalid Request
            </h2>
            <p className="text-muted-foreground text-sm">
              Missing required OAuth parameters: client_id and redirect_uri are
              required.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const client = await getOAuthClient(clientId);
  if (!client) {
    return (
      <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-xl border bg-background px-4 shadow-2xl ring-1 ring-black/5">
          <div className="flex flex-col gap-1.5 p-6 pb-0">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Unknown Client
            </h2>
            <p className="text-muted-foreground text-sm">
              The application requesting access is not registered.
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (
    !(
      client.redirectUris.includes(redirectUri) &&
      isAllowedRedirectUri(redirectUri)
    )
  ) {
    return (
      <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-xl border bg-background px-4 shadow-2xl ring-1 ring-black/5">
          <div className="flex flex-col gap-1.5 p-6 pb-0">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Invalid Redirect URI
            </h2>
            <p className="text-muted-foreground text-sm">
              The redirect URI does not match the registered client.
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (responseType !== "code") {
    errorRedirect(redirectUri, "unsupported_response_type", state);
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    errorRedirect(redirectUri, "invalid_request", state);
  }

  // Check if user is authenticated
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user) {
    const loginUrl = new URL(
      "/",
      requestHeaders.get("x-forwarded-proto")
        ? `${requestHeaders.get("x-forwarded-proto")}://${requestHeaders.get("host")}`
        : "http://localhost:3000"
    );
    const returnTo = new URL(
      `/oauth/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`,
      loginUrl
    );
    redirect(
      `/?returnTo=${encodeURIComponent(returnTo.pathname + returnTo.search)}`
    );
  }

  // Anonymous demo accounts cannot grant API access. Show a sign-up prompt
  // rather than the consent form.
  if (isAnonymousUserShape(session.user)) {
    return (
      <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-full max-w-sm rounded-xl border bg-background px-4 shadow-2xl ring-1 ring-black/5">
          <div className="flex flex-col gap-1.5 p-6 pb-0">
            <h2 className="font-semibold text-lg leading-none tracking-tight">
              Create an account to continue
            </h2>
            <p className="text-muted-foreground text-sm">
              Authorizing API access requires a full KeeperHub account. Sign up
              to connect this application.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // F-022 / KEEP-747: resolve the org the token will be scoped to and show it,
  // then bind its id into the approve form so the user explicitly consents to
  // this specific org and handleApprove can reject a mid-flow org switch.
  const consentOrgContext = await getOrgContext();
  const consentOrgId = consentOrgContext.organization?.id ?? session.user.id;
  const consentOrgName =
    consentOrgContext.organization?.name ?? "your personal account";

  // The scopes the client asked for become the checkboxes that are ticked by
  // default. The user can untick any of them to narrow the grant (e.g. leave
  // only "Read" for a read-only connection) before approving.
  const requestedScopes = parseScopes(scope ?? "mcp:read mcp:write");

  const scopeDescriptions: Record<string, string> = {
    "mcp:read": "Read your workflows, executions, and plugin schemas",
    "mcp:write": "Write your workflows, executions, and integrations",
    "mcp:admin": "Full access to all existing and future actions",
  };

  // An organization can cap what its agents may do. Offering a box that the
  // grant would strip on approval would be a promise the connection cannot
  // keep, so the capped levels are not shown at all.
  const consentCeiling = consentOrgContext.organization?.id
    ? policyCeiling(
        await getScopePolicyForMint(
          session.user.id,
          consentOrgContext.organization.id
        )
      )
    : null;

  const scopeOptions = SUPPORTED_SCOPES.filter(
    (s) => !scopeExceeds(s, consentCeiling)
  ).map((s) => ({
    id: s,
    label: scopeDescriptions[s] ?? s,
  }));

  return (
    <main className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex w-full max-w-lg flex-col rounded-xl border bg-background shadow-2xl ring-1 ring-black/5">
        {/* Header */}
        <div className="relative flex flex-col gap-2 p-8 pb-0">
          <h2 className="font-semibold text-lg leading-none tracking-tight">
            Authorize Access
          </h2>
          <p className="text-muted-foreground text-sm">
            <span className="font-medium text-foreground">
              {client.clientName}
            </span>{" "}
            is requesting access to your account.
          </p>
        </div>

        <ConsentForm
          approveAction={handleApprove}
          clientId={clientId}
          codeChallenge={codeChallenge}
          codeChallengeMethod={codeChallengeMethod}
          consentOrgId={consentOrgId}
          consentOrgName={consentOrgName}
          denyAction={handleDeny}
          redirectUri={redirectUri}
          requestedScopes={requestedScopes}
          scopeOptions={scopeOptions}
          state={state}
          userEmail={session.user.email}
        />
      </div>
    </main>
  );
}
