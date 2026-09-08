"use client";

import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

type SendGridConnectionSectionProps = {
  config: Record<string, unknown>;
  updateConfig: (key: string, value: string) => void;
};

export function SendGridConnectionSection({
  config,
  updateConfig,
}: SendGridConnectionSectionProps) {
  const [loading, setLoading] = useState(true);
  const [isAnonymous, setIsAnonymous] = useState(false);

  // Check user type on mount
  useEffect(() => {
    async function checkUser() {
      try {
        const userResponse = await fetch("/api/user");
        const userData = await userResponse.json();

        // Detect anonymous user by email pattern or isAnonymous flag
        const isAnonUser =
          userData.isAnonymous ||
          userData.email?.includes("@http://") ||
          userData.email?.includes("@https://") ||
          userData.email?.startsWith("temp-");

        setIsAnonymous(isAnonUser);
      } catch (error) {
        console.error("Failed to check user:", error);
      } finally {
        setLoading(false);
      }
    }

    checkUser();
  }, []);

  // Initialize useKeeperHubApiKey to "true" if not set
  useEffect(() => {
    if (config.useKeeperHubApiKey === undefined) {
      updateConfig("useKeeperHubApiKey", "true");
    }
  }, [config.useKeeperHubApiKey, updateConfig]);

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  if (isAnonymous) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-medium text-sm">Email Connection</h3>
          <p className="text-muted-foreground text-sm">
            Send transactional emails via SendGrid.
          </p>
        </div>
        <div className="rounded-lg border bg-muted/50 p-3">
          <p className="text-muted-foreground text-sm">
            Please sign in with a real account to configure email.
          </p>
        </div>
      </div>
    );
  }

  const useKeeperHubApiKey = config.useKeeperHubApiKey !== "false";

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-2">
        <Checkbox
          checked={useKeeperHubApiKey}
          id="useKeeperHubApiKey"
          onCheckedChange={(checked) =>
            updateConfig("useKeeperHubApiKey", checked ? "true" : "false")
          }
        />
        <Label className="cursor-pointer text-sm" htmlFor="useKeeperHubApiKey">
          Use KeeperHub SendGrid API Key
        </Label>
      </div>
      <p className="text-muted-foreground text-xs">
        When checked, uses the KeeperHub SendGrid API key. Uncheck to use your
        own API key.
      </p>

      {!useKeeperHubApiKey && (
        <div className="space-y-2">
          <Label htmlFor="apiKey">API Key</Label>
          <Input
            id="apiKey"
            onChange={(e) => updateConfig("apiKey", e.target.value)}
            placeholder="SG...."
            type="password"
            value={(config.apiKey as string) || ""}
          />
          <p className="text-muted-foreground text-xs">
            Get your API key from{" "}
            <a
              className="underline hover:text-foreground"
              href="https://app.sendgrid.com/settings/api_keys"
              rel="noopener noreferrer"
              target="_blank"
            >
              sendgrid.com/api-keys
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
