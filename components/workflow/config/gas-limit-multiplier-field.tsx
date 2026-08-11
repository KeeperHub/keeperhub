"use client";

import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { parseGasLimitConfig } from "@/lib/web3/gas-defaults";
import type { ActionConfigFieldBase } from "@/plugins/registry";

type GasLimitMultiplierFieldProps = {
  field: ActionConfigFieldBase;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  config: Record<string, unknown>;
};

type GasEstimateState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; estimatedGas: string }
  | { status: "error"; message: string };

const DEBOUNCE_MS = 500;
const TEMPLATE_REF_PATTERN = /\{\{.*?\}\}/;

function hasTemplateRefs(config: Record<string, unknown>): boolean {
  return Object.values(config).some(
    (v) => typeof v === "string" && TEMPLATE_REF_PATTERN.test(v)
  );
}

function formatGasNumber(value: string): string {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return value;
  }
  return num.toLocaleString();
}

export function GasLimitMultiplierField({
  field,
  value,
  onChange,
  disabled,
  config,
}: GasLimitMultiplierFieldProps) {
  const networkField = field.networkField ?? "network";
  const chainIdRaw = config[networkField];
  const chainId = chainIdRaw ? Number(chainIdRaw) : undefined;
  const actionSlug = field.actionSlug;

  // Parse the current value — always treat as maxGasLimit mode
  const parsed = useMemo(() => parseGasLimitConfig(value), [value]);
  const inputValue = parsed?.value ?? "";

  // Memoize only the config fields relevant to gas estimation.
  // Excludes gasLimitMultiplier so typing in the gas limit input
  // doesn't re-trigger the estimate fetch.
  const estimationConfig = useMemo(
    () =>
      JSON.stringify({
        contractAddress: config.contractAddress,
        abi: config.abi,
        abiFunction: config.abiFunction,
        functionArgs: config.functionArgs,
        recipientAddress: config.recipientAddress,
        amount: config.amount,
        tokenConfig: config.tokenConfig,
      }),
    [
      config.contractAddress,
      config.abi,
      config.abiFunction,
      config.functionArgs,
      config.recipientAddress,
      config.amount,
      config.tokenConfig,
    ]
  );

  const [estimate, setEstimate] = useState<GasEstimateState>({
    status: "idle",
  });
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const configHasTemplateRefs = useMemo(
    () => hasTemplateRefs(config),
    [config]
  );

  // Determine if we have enough config to estimate
  const canEstimate = useMemo(() => {
    if (!(chainId && actionSlug)) {
      return false;
    }
    if (configHasTemplateRefs) {
      return false;
    }

    switch (actionSlug) {
      case "transfer-funds":
        return Boolean(config.recipientAddress);
      case "transfer-token":
        return Boolean(config.recipientAddress && config.tokenConfig);
      case "write-contract":
        return Boolean(
          config.contractAddress && config.abi && config.abiFunction
        );
      default:
        return false;
    }
  }, [
    chainId,
    actionSlug,
    configHasTemplateRefs,
    config.recipientAddress,
    config.tokenConfig,
    config.contractAddress,
    config.abi,
    config.abiFunction,
  ]);

  // Fetch gas estimate with debounce
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fetch with validation, error handling, and abort support
  const fetchEstimate = useCallback(async () => {
    if (!(canEstimate && chainId && actionSlug)) {
      setEstimate({ status: "idle" });
      return;
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setEstimate({ status: "loading" });

    try {
      const response = await fetch("/api/gas/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId,
          actionSlug,
          config: JSON.parse(estimationConfig),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setEstimate({
          status: "error",
          message: data.error ?? "Failed to estimate gas",
        });
        return;
      }

      const data = (await response.json()) as {
        estimatedGas: string;
        chainDefaults: { multiplier: number; conservative: number };
      };

      setEstimate({ status: "success", estimatedGas: data.estimatedGas });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setEstimate({
        status: "error",
        message:
          error instanceof Error ? error.message : "Failed to estimate gas",
      });
    }
  }, [canEstimate, chainId, actionSlug, estimationConfig]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      fetchEstimate().catch(() => {
        // Errors handled inside fetchEstimate via setEstimate
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [fetchEstimate]);

  useEffect(
    () => () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    },
    []
  );

  const handleValueChange = (newValue: string) => {
    if (!newValue && estimate.status === "error") {
      setEstimate({ status: "idle" });
    }
    onChange(
      newValue ? JSON.stringify({ mode: "maxGasLimit", value: newValue }) : ""
    );
  };

  // Warning when gas limit is below or close to estimate
  const gasWarning = useMemo(() => {
    if (estimate.status !== "success" || !inputValue) {
      return;
    }
    const estimated = Number(estimate.estimatedGas);
    const limit = Number(inputValue);
    if (Number.isNaN(estimated) || estimated === 0 || Number.isNaN(limit)) {
      return;
    }
    if (limit < estimated) {
      return {
        level: "error" as const,
        message:
          "Gas limit is below the estimate \u2014 transaction will likely fail",
      };
    }
    if (limit < estimated * 1.2) {
      return {
        level: "warning" as const,
        message:
          "Gas limit is close to the estimate \u2014 consider adding headroom",
      };
    }
    return;
  }, [estimate, inputValue]);

  return (
    <div className="space-y-2">
      <Input
        disabled={disabled}
        id={field.key}
        min={0}
        onChange={(e) => handleValueChange(e.target.value)}
        placeholder="e.g. 500000"
        step={1}
        type="number"
        value={inputValue}
      />

      <div className="min-w-0 space-y-1">
        {estimate.status === "loading" && (
          <div className="flex items-center gap-1.5 text-foreground text-sm">
            <Spinner className="size-3" />
            Estimating gas...
          </div>
        )}
        {estimate.status === "success" && (
          <p className="font-medium text-foreground text-sm">
            Gas Estimate: {formatGasNumber(estimate.estimatedGas)}
          </p>
        )}
        {estimate.status === "error" && (
          <div className="flex items-start gap-1.5 text-red-600 text-sm dark:text-red-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words font-medium">{estimate.message}</span>
          </div>
        )}
        {estimate.status === "idle" &&
          canEstimate === false &&
          chainId &&
          actionSlug && (
            <p className="text-muted-foreground text-xs">
              {configHasTemplateRefs
                ? "Cannot estimate with template references"
                : "Configure required fields to see gas estimate"}
            </p>
          )}

        {gasWarning && (
          <div
            className={`flex items-start gap-1.5 font-medium text-sm ${
              gasWarning.level === "error"
                ? "text-red-600 dark:text-red-400"
                : "text-yellow-600 dark:text-yellow-500"
            }`}
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{gasWarning.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
