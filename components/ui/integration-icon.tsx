"use client";

import { Database, HelpCircle } from "lucide-react";
import type { IntegrationType } from "@/lib/types/integration";
import { cn } from "@/lib/utils";
import { getIntegration } from "@/plugins/registry";

interface IntegrationIconProps {
  integration: string;
  className?: string;
}

const SPECIAL_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  database: Database,
};

export function IntegrationIcon({
  integration,
  className = "h-3 w-3",
}: IntegrationIconProps) {
  const SpecialIcon = SPECIAL_ICONS[integration];
  if (SpecialIcon) {
    return <SpecialIcon className={cn("text-foreground", className)} />;
  }

  const plugin = getIntegration(integration as IntegrationType);

  if (plugin?.icon) {
    const PluginIcon = plugin.icon;
    return <PluginIcon className={cn("text-foreground", className)} />;
  }

  return <HelpCircle className={cn("text-foreground", className)} />;
}
