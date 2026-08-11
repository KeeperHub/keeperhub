"use client";

import { useState } from "react";

type ScopeOption = {
  id: string;
  label: string;
};

type ConsentFormProps = {
  scopeOptions: ScopeOption[];
  requestedScopes: string[];
  clientId: string;
  redirectUri: string;
  consentOrgId: string;
  consentOrgName: string;
  userEmail: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  approveAction: (formData: FormData) => Promise<void>;
  denyAction: (formData: FormData) => Promise<void>;
};

const APPROVE_FORM_ID = "approve-form";

export function ConsentForm({
  scopeOptions,
  requestedScopes,
  clientId,
  redirectUri,
  consentOrgId,
  consentOrgName,
  userEmail,
  state,
  codeChallenge,
  codeChallengeMethod,
  approveAction,
  denyAction,
}: ConsentFormProps): React.ReactElement {
  const [checkedScopes, setCheckedScopes] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        scopeOptions.map((option) => [
          option.id,
          requestedScopes.includes(option.id),
        ])
      )
  );

  const hasScopeSelected = Object.values(checkedScopes).some(Boolean);

  const isAdminSelected = checkedScopes["mcp:admin"] ?? false;

  const toggleScope = (id: string, checked: boolean): void => {
    if (id === "mcp:admin" && checked) {
      setCheckedScopes((previous) =>
        Object.fromEntries(Object.keys(previous).map((k) => [k, true]))
      );
    } else {
      setCheckedScopes((previous) => ({ ...previous, [id]: checked }));
    }
  };

  return (
    <>
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="rounded-lg border bg-muted/30 p-5">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Permissions
          </p>
          <ul className="space-y-3">
            {scopeOptions.map((option) => {
              const lockedByAdmin =
                option.id !== "mcp:admin" && isAdminSelected;
              return (
                <li key={option.id}>
                  <label
                    className={`flex items-center gap-3 text-sm text-foreground ${lockedByAdmin ? "cursor-default opacity-50" : "cursor-pointer"}`}
                  >
                    <input
                      checked={checkedScopes[option.id] ?? false}
                      className="h-4 w-4 shrink-0 rounded border-input accent-[var(--ds-green-accent)]"
                      disabled={lockedByAdmin}
                      form={APPROVE_FORM_ID}
                      name="scope"
                      onChange={(event) =>
                        toggleScope(option.id, event.target.checked)
                      }
                      type="checkbox"
                      value={option.id}
                    />
                    {option.label}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        <p className="mt-5 text-sm text-muted-foreground">
          Authorizing access to{" "}
          <span className="font-medium text-foreground">{consentOrgName}</span>
        </p>

        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as{" "}
          <span className="font-medium text-foreground">{userEmail}</span>
        </p>
      </div>

      {/* Footer */}
      <div className="flex gap-3 p-8 pt-4 sm:justify-end">
        <form action={denyAction}>
          <input name="client_id" type="hidden" value={clientId} />
          <input name="redirect_uri" type="hidden" value={redirectUri} />
          {state && <input name="state" type="hidden" value={state} />}
          <button
            className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-5 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            type="submit"
          >
            Deny
          </button>
        </form>

        <form action={approveAction} id={APPROVE_FORM_ID}>
          <input name="client_id" type="hidden" value={clientId} />
          <input name="redirect_uri" type="hidden" value={redirectUri} />
          <input name="organization_id" type="hidden" value={consentOrgId} />
          {state && <input name="state" type="hidden" value={state} />}
          <input name="code_challenge" type="hidden" value={codeChallenge} />
          <input
            name="code_challenge_method"
            type="hidden"
            value={codeChallengeMethod}
          />
          <button
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary"
            disabled={!hasScopeSelected}
            type="submit"
          >
            Approve
          </button>
        </form>
      </div>
    </>
  );
}
