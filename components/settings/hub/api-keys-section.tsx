"use client";

import { KeysCard } from "./api-keys/keys-card";
import { SectionHeader } from "./section";
import { useSettingsContext } from "./settings-context";

const ORG_READ_ONLY =
  "Only organization admins or owners can create or revoke these keys.";

export function ApiKeysSection(): React.ReactElement {
  const { isAdmin } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description="Keys let scripts, agents and CI call the KeeperHub API on this organization's behalf."
        title="API keys"
      />

      <KeysCard
        activity={{
          resourceType: "org_api_key",
          title: "Organisation key activity",
        }}
        canManage={isAdmin}
        description="Call the API and the CLI on this organization's behalf, across everything the scopes allow. Admins and owners can mint and revoke them."
        keyType="organisation"
        listEndpoint="/api/keys"
        readOnlyReason={ORG_READ_ONLY}
        showCreator
        title="Organisation keys"
      />

      <KeysCard
        activity={
          isAdmin
            ? { resourceType: "api_key", title: "Webhook key activity" }
            : null
        }
        canManage
        description="Authenticate calls into this organization's webhook triggers, so a third-party service can run a webhook-triggered workflow. Scoped to webhooks only, and valid for this organization."
        keyType="webhook"
        listEndpoint="/api/api-keys"
        showCreator={false}
        title="Webhook keys"
      />
    </>
  );
}
