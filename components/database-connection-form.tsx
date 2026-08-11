"use client";

import { Check, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";

export type DatabaseTab = "url" | "details";

type SecretFieldProps = {
  fieldId: string;
  label: string;
  configKey: string;
  placeholder?: string;
  helpText?: string;
  value: string;
  onChange: (key: string, value: string) => void;
  isEditMode?: boolean;
};

function SecretField({
  fieldId,
  label,
  configKey,
  placeholder,
  helpText,
  value,
  onChange,
  isEditMode,
}: SecretFieldProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const isMobile = useIsMobile();
  const hasNewValue = value.length > 0;

  if (isEditMode && !isEditing && !hasNewValue) {
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{label}</Label>
        <div className="flex items-center gap-2">
          <div className="flex h-9 flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3">
            <Check className="size-4 text-green-600" />
            <span className="text-muted-foreground text-sm">Configured</span>
          </div>
          <Button
            onClick={() => setIsEditing(true)}
            type="button"
            variant="outline"
          >
            <Pencil className="mr-1.5 size-3" />
            Change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          autoFocus={isEditMode && isEditing && !isMobile}
          className="flex-1"
          id={fieldId}
          onChange={(e) => onChange(configKey, e.target.value)}
          placeholder={placeholder}
          type="password"
          value={value}
        />
        {isEditMode && (isEditing || hasNewValue) && (
          <Button
            onClick={() => {
              onChange(configKey, "");
              setIsEditing(false);
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      {helpText && <p className="text-muted-foreground text-xs">{helpText}</p>}
    </div>
  );
}

type DatabaseConnectionFormProps = {
  config: Record<string, string>;
  updateConfig: (key: string, value: string) => void;
  isEditMode?: boolean;
  onTabChange?: (tab: DatabaseTab) => void;
  defaultTab?: DatabaseTab;
};

export function DatabaseConnectionForm({
  config,
  updateConfig,
  isEditMode = false,
  onTabChange,
  defaultTab = "url",
}: DatabaseConnectionFormProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<DatabaseTab>(defaultTab);

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab]);

  const handleTabChange = (value: string): void => {
    const tab = value as DatabaseTab;
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  return (
    <Tabs onValueChange={handleTabChange} value={activeTab}>
      <TabsList className="w-full">
        <TabsTrigger value="url">Connection String</TabsTrigger>
        <TabsTrigger value="details">Connection Details</TabsTrigger>
      </TabsList>

      <TabsContent value="url">
        <div className="space-y-4 pt-2">
          <SecretField
            configKey="url"
            fieldId="db-url"
            helpText="Format: postgresql://user:password@host:port/database"
            isEditMode={isEditMode}
            label="Connection string"
            onChange={updateConfig}
            placeholder="postgresql://user:password@host:port/database"
            value={config.url || ""}
          />
        </div>
      </TabsContent>

      <TabsContent value="details">
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="db-host">Host</Label>
              <Input
                id="db-host"
                onChange={(e) => updateConfig("host", e.target.value)}
                placeholder="e.g. db.example.com"
                value={config.host || ""}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="db-port">Port</Label>
              <Input
                id="db-port"
                onChange={(e) => updateConfig("port", e.target.value)}
                placeholder="5432"
                value={config.port || ""}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="db-username">Username</Label>
              <Input
                id="db-username"
                onChange={(e) => updateConfig("username", e.target.value)}
                placeholder="postgres"
                value={config.username || ""}
              />
            </div>
            <div className="space-y-2">
              <SecretField
                configKey="password"
                fieldId="db-password"
                isEditMode={isEditMode}
                label="Password"
                onChange={updateConfig}
                placeholder=""
                value={config.password || ""}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="db-database">Database name</Label>
            <Input
              id="db-database"
              onChange={(e) => updateConfig("database", e.target.value)}
              placeholder="postgres"
              value={config.database || ""}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="database-ssl-mode">SSL mode</Label>
            <Select
              onValueChange={(value: string) => updateConfig("sslMode", value)}
              value={(config.sslMode as string) || "auto"}
            >
              <SelectTrigger id="database-ssl-mode">
                <SelectValue placeholder="SSL mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  Auto (use SSL for remote hosts)
                </SelectItem>
                <SelectItem value="require">Require</SelectItem>
                <SelectItem value="prefer">Prefer</SelectItem>
                <SelectItem value="disable">Disable</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Use Require for cloud providers (e.g. Supabase). Auto enables SSL
              for remote hosts. For Supabase, use the connection pooler host if
              your environment cannot resolve IPv6; the pooler uses IPv4.
            </p>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}

/**
 * Validates database config based on the active tab.
 * Returns an error message string, or null if valid.
 */
export function validateDatabaseConfig(
  config: Record<string, string>,
  activeTab: DatabaseTab
): string | null {
  if (activeTab === "url") {
    const hasUrl = typeof config.url === "string" && config.url.trim() !== "";
    if (!hasUrl) {
      return "Please enter a connection string.";
    }
    return null;
  }

  const hasHost = typeof config.host === "string" && config.host.trim() !== "";
  const hasUsername =
    typeof config.username === "string" && config.username.trim() !== "";
  const hasDatabase =
    typeof config.database === "string" && config.database.trim() !== "";

  if (!(hasHost && hasUsername && hasDatabase)) {
    return "Please fill in at least the host, username, and database fields.";
  }
  return null;
}

/**
 * Detects which tab to default to based on existing config values.
 * For edit mode: if URL was configured, use "url" tab; if host fields exist, use "details".
 */
export function detectDefaultTab(config: Record<string, string>): DatabaseTab {
  const hasDetailFields =
    (config.host !== undefined && config.host !== "") ||
    (config.username !== undefined && config.username !== "") ||
    (config.database !== undefined && config.database !== "");

  if (hasDetailFields) {
    return "details";
  }
  return "url";
}
