"use client";

import { Copy, ExternalLink, Loader2, Plus } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { toChecksumAddress } from "@/lib/address-utils";
import type {
  CustomToken,
  SupportedToken,
  TokenFieldValue,
} from "@/lib/wallet/types";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type TokenSelectFieldProps = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
  networkField?: string;
};

/**
 * Token Select Field
 *
 * Provides a toggle between:
 * - Supported Tokens: Single-select dropdown of system-wide stablecoins
 * - Custom Token: Text input for a single ERC20 token address
 *
 * The field stores a JSON object with the mode and a single selected token.
 */
export function TokenSelectField({
  field,
  config,
  onUpdateConfig,
  disabled,
  networkField = "network",
}: TokenSelectFieldProps) {
  const [tokens, setTokens] = useState<SupportedToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevNetworkRef = useRef<string | undefined>(undefined);
  const [customInputValue, setCustomInputValue] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Parse current value
  const currentValue = parseTokenValue(
    config[field.key] as string | Record<string, unknown> | undefined
  );
  const networkValue = config[networkField] as string | undefined;

  // Reset token selection when network changes
  useEffect(() => {
    if (
      prevNetworkRef.current !== undefined &&
      prevNetworkRef.current !== networkValue
    ) {
      // Network changed - reset the selection
      const resetValue: TokenFieldValue = {
        mode: currentValue.mode,
      };
      onUpdateConfig(field.key, JSON.stringify(resetValue));
      setValidationError(null);
    }
    prevNetworkRef.current = networkValue;
  }, [networkValue, currentValue.mode, field.key, onUpdateConfig]);

  // Fetch supported tokens for the selected chain
  useEffect(() => {
    if (!networkValue) {
      setTokens([]);
      return;
    }

    const fetchTokens = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/supported-tokens?network=${encodeURIComponent(networkValue)}`
        );
        if (!response.ok) {
          throw new Error("Failed to fetch supported tokens");
        }
        const data = await response.json();
        setTokens(data.tokens || []);
      } catch (err) {
        console.error("[TokenSelectField] Error fetching tokens:", err);
        setError("Failed to load supported tokens");
        setTokens([]);
      } finally {
        setLoading(false);
      }
    };

    fetchTokens();
  }, [networkValue]);

  // Handle mode toggle
  const handleModeChange = (useCustom: boolean) => {
    const newValue: TokenFieldValue = {
      mode: useCustom ? "custom" : "supported",
      supportedTokenId: currentValue.supportedTokenId,
      customToken: currentValue.customToken,
    };
    onUpdateConfig(field.key, JSON.stringify(newValue));
    setValidationError(null);
  };

  // Handle supported token selection
  const handleTokenSelect = (tokenId: string) => {
    // Single-select: if already selected, clear; otherwise, set to this token
    const newValue: TokenFieldValue = {
      ...currentValue,
      supportedTokenId:
        currentValue.supportedTokenId === tokenId ? undefined : tokenId,
      customToken: undefined, // Clear custom token when selecting supported
    };
    onUpdateConfig(field.key, JSON.stringify(newValue));
  };

  // Add custom token - validate and fetch symbol
  const handleAddCustomToken = async () => {
    const trimmed = customInputValue.trim();
    if (!(trimmed && networkValue)) {
      return;
    }

    // If same token already selected, just clear input
    if (
      currentValue.customToken?.address.toLowerCase() === trimmed.toLowerCase()
    ) {
      setCustomInputValue("");
      setValidationError(null);
      return;
    }

    setValidating(true);
    setValidationError(null);

    try {
      const response = await fetch(
        `/api/validate-token?address=${encodeURIComponent(trimmed)}&network=${encodeURIComponent(networkValue)}`
      );
      const data = await response.json();

      if (!data.valid) {
        setValidationError(data.error || "Invalid token");
        setValidating(false);
        return;
      }

      // Replace the existing custom token with the new one
      const newValue: TokenFieldValue = {
        ...currentValue,
        customToken: {
          address: data.token.address,
          symbol: data.token.symbol,
        },
        supportedTokenId: undefined, // Clear supported token when selecting custom
      };
      onUpdateConfig(field.key, JSON.stringify(newValue));
      setCustomInputValue("");
      setValidationError(null);
    } catch (err) {
      console.error("[TokenSelectField] Error validating token:", err);
      setValidationError("Failed to validate token");
    } finally {
      setValidating(false);
    }
  };

  const isCustomMode = currentValue.mode === "custom";

  // Get the currently selected token for display
  const selectedSupportedToken = currentValue.supportedTokenId
    ? tokens.find((t) => t.id === currentValue.supportedTokenId)
    : null;

  // Copy token address to clipboard (checksummed for user safety)
  const copyTokenAddress = (address: string) => {
    navigator.clipboard.writeText(toChecksumAddress(address));
    toast.success("Token address copied");
  };

  // Render selected token info with copy + explorer icons
  const renderSelectedTokenInfo = () => {
    // For supported tokens mode
    if (!isCustomMode && selectedSupportedToken) {
      const displayAddress = toChecksumAddress(
        selectedSupportedToken.tokenAddress
      );
      return (
        <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          {selectedSupportedToken.logoUrl && (
            <Image
              alt={selectedSupportedToken.symbol}
              className="h-4 w-4 rounded-full"
              height={16}
              src={selectedSupportedToken.logoUrl}
              width={16}
            />
          )}
          <span className="font-medium">{selectedSupportedToken.symbol}</span>
          <span className="truncate font-mono text-muted-foreground text-xs">
            {displayAddress.slice(0, 10)}...{displayAddress.slice(-8)}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() =>
                copyTokenAddress(selectedSupportedToken.tokenAddress)
              }
              title="Copy token address"
              type="button"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            {selectedSupportedToken.explorerUrl && (
              <a
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                href={selectedSupportedToken.explorerUrl}
                rel="noopener noreferrer"
                target="_blank"
                title="View on explorer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      );
    }

    // For custom token mode
    if (isCustomMode && currentValue.customToken) {
      const customToken = currentValue.customToken;
      const displayAddress = toChecksumAddress(customToken.address);
      return (
        <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">{customToken.symbol}</span>
          <span className="truncate font-mono text-muted-foreground text-xs">
            {displayAddress.slice(0, 10)}...{displayAddress.slice(-8)}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => copyTokenAddress(customToken.address)}
              title="Copy token address"
              type="button"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      );
    }

    return null;
  };

  // Render supported tokens section based on state
  const renderSupportedTokensSection = () => {
    if (!networkValue) {
      return (
        <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
          Select a network first to see available tokens
        </div>
      );
    }
    if (loading) {
      return (
        <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
          Loading supported tokens...
        </div>
      );
    }
    if (error) {
      return (
        <div className="rounded-md border border-dashed p-3 text-center text-red-500 text-sm">
          {error}
        </div>
      );
    }
    if (tokens.length === 0) {
      return (
        <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-sm">
          No supported tokens for this network
        </div>
      );
    }
    // Separate available and unavailable tokens
    const availableTokens = tokens.filter((t) => t.available !== false);
    const unavailableTokens = tokens.filter((t) => t.available === false);

    return (
      <Select
        disabled={disabled}
        onValueChange={handleTokenSelect}
        value={currentValue.supportedTokenId || ""}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select a token..." />
        </SelectTrigger>
        <SelectContent>
          {availableTokens.map((token) => {
            const isSelected = currentValue.supportedTokenId === token.id;
            return (
              <SelectItem key={token.id} value={token.id}>
                <div className="flex items-center gap-2">
                  {token.logoUrl && (
                    <Image
                      alt={token.symbol}
                      className="h-4 w-4 rounded-full"
                      height={16}
                      src={token.logoUrl}
                      width={16}
                    />
                  )}
                  <span>{token.symbol}</span>
                  {isSelected && <span className="text-primary">✓</span>}
                </div>
              </SelectItem>
            );
          })}
          {unavailableTokens.length > 0 && (
            <>
              <div className="my-1 border-t" />
              <div className="px-2 py-1.5 text-muted-foreground text-xs">
                Not available on this chain
              </div>
              {unavailableTokens.map((token) => (
                <SelectItem
                  className="opacity-50"
                  disabled
                  key={token.id}
                  value={token.id}
                >
                  <div className="flex items-center gap-2">
                    {token.logoUrl && (
                      <Image
                        alt={token.symbol}
                        className="h-4 w-4 rounded-full grayscale"
                        height={16}
                        src={token.logoUrl}
                        width={16}
                      />
                    )}
                    <span className="text-muted-foreground">
                      {token.symbol}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>
    );
  };

  return (
    <div className="space-y-3">
      {/* Mode Toggle */}
      <div className="space-y-2">
        <Label className="text-muted-foreground text-xs">Token Mode</Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => handleModeChange(value === "custom")}
          value={currentValue.mode}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="supported">Stablecoins</SelectItem>
            <SelectItem value="custom">Import Token Address</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Supported Tokens Single-Select */}
      {!isCustomMode && (
        <div className="space-y-2">
          {renderSupportedTokensSection()}
          {renderSelectedTokenInfo()}
        </div>
      )}

      {/* Custom Token Address Input */}
      {isCustomMode && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              className={`flex-1 ${validationError ? "border-red-500" : ""}`}
              disabled={disabled || validating}
              id={`${field.key}-custom`}
              onChange={(e) => {
                setCustomInputValue(e.target.value);
                setValidationError(null);
              }}
              placeholder="0x... (ERC20 token contract address)"
              value={customInputValue}
            />
            <Button
              className="shrink-0"
              disabled={
                disabled ||
                !customInputValue.trim() ||
                validating ||
                !networkValue
              }
              onClick={handleAddCustomToken}
              size="sm"
              type="button"
              variant="outline"
            >
              {validating ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              {validating ? "Validating..." : "Add"}
            </Button>
          </div>
          {validationError && (
            <p className="text-red-500 text-xs">{validationError}</p>
          )}
          {!networkValue && isCustomMode && (
            <p className="text-muted-foreground text-xs">
              Select a network first to add custom tokens
            </p>
          )}
          {renderSelectedTokenInfo()}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Value Parsing Utilities
// ============================================================================

/**
 * Extract mode from parsed config, defaulting to "supported"
 */
function extractMode(parsed: unknown): "supported" | "custom" {
  if (typeof parsed !== "object" || parsed === null) {
    return "supported";
  }

  const config = parsed as Record<string, unknown>;
  return config.mode === "supported" || config.mode === "custom"
    ? (config.mode as "supported" | "custom")
    : "supported";
}

/**
 * Extract supported token ID from parsed config
 * Handles both new (single) and legacy (array) formats
 */
function extractSupportedTokenId(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const config = parsed as Record<string, unknown>;

  // New format: single token ID
  if (typeof config.supportedTokenId === "string") {
    return config.supportedTokenId;
  }

  // Legacy format: array - use first element
  if (
    Array.isArray(config.supportedTokenIds) &&
    config.supportedTokenIds.length > 0
  ) {
    const firstId = config.supportedTokenIds[0];
    return typeof firstId === "string" ? firstId : undefined;
  }

  return;
}

/**
 * Extract custom token from parsed config
 * Handles both new (single) and legacy (array/string) formats
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles multiple legacy formats for backwards compatibility
function extractCustomToken(parsed: unknown): CustomToken | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const config = parsed as Record<string, unknown>;

  // New format: single custom token object
  if (
    config.customToken &&
    typeof config.customToken === "object" &&
    config.customToken !== null
  ) {
    const token = config.customToken as Record<string, unknown>;
    if (typeof token.address === "string" && typeof token.symbol === "string") {
      return { address: token.address, symbol: token.symbol };
    }
  }

  // Legacy format: array of custom tokens - use first element
  if (Array.isArray(config.customTokens) && config.customTokens.length > 0) {
    const firstToken = config.customTokens[0];
    if (
      firstToken &&
      typeof firstToken === "object" &&
      typeof firstToken.address === "string" &&
      typeof firstToken.symbol === "string"
    ) {
      return {
        address: firstToken.address,
        symbol: firstToken.symbol,
      };
    }
  }

  // Legacy format: array of addresses - convert first address to token
  if (
    Array.isArray(config.customTokenAddresses) &&
    config.customTokenAddresses.length > 0
  ) {
    const address = config.customTokenAddresses.find(
      (a): a is string => typeof a === "string" && a.trim() !== ""
    );
    if (address) {
      return { address, symbol: "???" };
    }
  }

  // Legacy format: single address string
  if (typeof config.customTokenAddress === "string") {
    return { address: config.customTokenAddress, symbol: "???" };
  }

  return;
}

/**
 * Parse token value from JSON string or object
 * Supports: object (API/MCP), JSON string (UI), bare address string (legacy)
 */
function parseTokenValue(
  value: string | Record<string, unknown> | undefined
): TokenFieldValue {
  if (!value) {
    return {
      mode: "supported",
    };
  }

  // Object values from API/MCP-created workflows
  if (typeof value === "object") {
    return {
      mode: extractMode(value),
      supportedTokenId: extractSupportedTokenId(value),
      customToken: extractCustomToken(value),
    };
  }

  try {
    const parsed = JSON.parse(value);

    return {
      mode: extractMode(parsed),
      supportedTokenId: extractSupportedTokenId(parsed),
      customToken: extractCustomToken(parsed),
    };
  } catch {
    // Legacy support: if value is just a string (old format), treat as custom
    if (value.startsWith("0x")) {
      return {
        mode: "custom",
        customToken: { address: value, symbol: "???" },
      };
    }
    return {
      mode: "supported",
    };
  }
}

/**
 * Extract token address from the field value for step execution
 * Returns a single token address (either supported or custom)
 */
export function extractTokenAddresses(
  value: string | undefined,
  supportedTokens: SupportedToken[]
): string | null {
  const parsed = parseTokenValue(value);

  // Get supported token address
  if (parsed.supportedTokenId) {
    const token = supportedTokens.find((t) => t.id === parsed.supportedTokenId);
    if (token?.tokenAddress) {
      return token.tokenAddress;
    }
  }

  // Get custom token address
  if (parsed.customToken?.address) {
    return parsed.customToken.address;
  }

  return null;
}
