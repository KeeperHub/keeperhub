"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parsePythTriggerConfig } from "@/lib/pyth/price-trigger";

export function PythTriggerConfig({
  config,
  disabled,
  onUpdateConfig,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  onUpdateConfig: (key: string, value: string) => void;
}) {
  let error: string | null = null;
  try {
    parsePythTriggerConfig(config);
  } catch (failure) {
    error =
      failure instanceof Error
        ? failure.message
        : "Complete the Pyth trigger settings.";
  }
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        React to a Pyth price signal before it is necessarily recorded onchain.
        This is a speculative signal: it does not guarantee transaction ordering
        or the future onchain price. Runs use your normal execution allowance.
      </p>
      <div className="space-y-2">
        <Label htmlFor="pyth-feed-id">Pyth feed ID</Label>
        <Input
          id="pyth-feed-id"
          disabled={disabled}
          value={String(config.feedId ?? "")}
          onChange={(event) => onUpdateConfig("feedId", event.target.value)}
          placeholder="64 hexadecimal characters"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pyth-direction">Fire when price reaches</Label>
        <Select
          disabled={disabled}
          value={typeof config.direction === "string" ? config.direction : ""}
          onValueChange={(value) => onUpdateConfig("direction", value)}
        >
          <SelectTrigger id="pyth-direction">
            <SelectValue placeholder="Choose a direction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="above">At or above threshold</SelectItem>
            <SelectItem value="below">At or below threshold</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="pyth-threshold">Price threshold</Label>
        <Input
          id="pyth-threshold"
          inputMode="decimal"
          disabled={disabled}
          value={String(config.threshold ?? "")}
          onChange={(event) => onUpdateConfig("threshold", event.target.value)}
          placeholder="Price in the feed's quote currency"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pyth-rearm">Rearm price</Label>
        <Input
          id="pyth-rearm"
          inputMode="decimal"
          disabled={disabled}
          value={String(config.rearmThreshold ?? "")}
          onChange={(event) =>
            onUpdateConfig("rearmThreshold", event.target.value)
          }
        />
        <p className="text-muted-foreground text-xs">
          The price must return here before another run can fire. Use a value
          below an above trigger, or above a below trigger.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="pyth-max-age">Maximum signal age (seconds)</Label>
        <Input
          id="pyth-max-age"
          type="number"
          min={5}
          max={300}
          disabled={disabled}
          value={String(config.maxAgeSeconds ?? 30)}
          onChange={(event) =>
            onUpdateConfig("maxAgeSeconds", event.target.value)
          }
        />
        <p className="text-muted-foreground text-xs">
          Old updates and queued signals expire after this time. Starting or
          reconnecting establishes a fresh baseline; crossings missed during an
          outage are not replayed. Failover may take up to 45 seconds.
        </p>
      </div>
      {error && (
        <p role="status" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
