"use client";

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { findActionById } from "@/plugins/registry";

type DiscordWebhookDisplayProps = {
  actionType: string | undefined;
  integrationId: string | undefined;
};

export function DiscordWebhookDisplay({
  actionType,
  integrationId,
}: DiscordWebhookDisplayProps) {
  const [discordIntegrationConfig, setDiscordIntegrationConfig] =
    useState<Record<string, unknown> | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Fetch Discord integration config when integration ID changes
  useEffect(() => {
    const action = actionType ? findActionById(actionType) : undefined;

    if (action?.integration === "discord" && integrationId) {
      api.integration
        .get(integrationId)
        .then((integration) => {
          setDiscordIntegrationConfig(integration.config);
        })
        .catch((error) => {
          console.error("Failed to fetch Discord integration config:", error);
        });
    } else {
      setDiscordIntegrationConfig(null);
    }
  }, [actionType, integrationId]);

  // Only show for Discord actions
  const action = actionType ? findActionById(actionType) : undefined;
  if (action?.integration !== "discord") {
    return null;
  }

  const webhookUrl = discordIntegrationConfig?.webhookUrl as string | undefined;
  const hasWebhookUrl = !!webhookUrl;
  const maskedUrl = hasWebhookUrl
    ? "•".repeat(Math.min(webhookUrl.length, 50))
    : "";

  return (
    <div className="space-y-1.5 pt-2">
      <Label className="text-muted-foreground text-xs">
        Webhook URL (from integration)
      </Label>
      <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
        {hasWebhookUrl ? (
          <>
            <p
              className={`flex-1 overflow-hidden font-mono text-muted-foreground text-xs ${
                isVisible ? "text-ellipsis whitespace-nowrap" : ""
              }`}
            >
              {isVisible ? webhookUrl : maskedUrl}
            </p>
            <Button
              className="h-6 w-6 shrink-0"
              onClick={() => setIsVisible(!isVisible)}
              size="icon"
              variant="ghost"
            >
              {isVisible ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </Button>
          </>
        ) : (
          <p className="flex-1 text-muted-foreground text-xs italic">
            Webhook needs to be set up in the integration config
          </p>
        )}
      </div>
    </div>
  );
}
