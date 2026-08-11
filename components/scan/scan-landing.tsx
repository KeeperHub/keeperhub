"use client";

import { Globe, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScanDisclaimer } from "@/components/scan/scan-disclaimer";
import { ScanInput } from "@/components/scan/scan-input";
import { ScanNetworkStrip } from "@/components/scan/scan-network-strip";
import { ScanResults } from "@/components/scan/scan-results";
import { SuggestionPreviewDrawer } from "@/components/scan/suggestion-preview-drawer";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { useStartBuilding } from "@/lib/hooks/use-start-building";
import { isAnonymousUser } from "@/lib/is-anonymous";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { ScanResponse } from "@/lib/scan/types";
import {
  getAppName,
  getCustomLogo,
} from "@/lib/workflow/editor/extension-registry";

type ScanState =
  | "idle"
  | "loading"
  | "populated"
  | "empty"
  | "rate-limited"
  | "error";

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
// Name-shaped query (mirrors ENS_NAME_REGEX on the server): at least one dot,
// no whitespace, not an 0x address. The server resolves it via ENS.
const ENS_QUERY_REGEX = /^(?!0x)[^\s.]+(?:\.[^\s.]+)+$/i;

/** A query is scannable if it is a raw EVM address or a name we can resolve. */
function isScannableQuery(query: string): boolean {
  return ADDRESS_REGEX.test(query) || ENS_QUERY_REGEX.test(query);
}

// Short display labels keep the chip row on a single line.
const EXAMPLE_WALLETS = [
  {
    display: "Stablecoin holder",
    query: "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d",
  },
  {
    display: "Aave borrower",
    query: "0xE33230364C7379DD0026f3ec714283d03535E77a",
  },
  {
    display: "vitalik.eth",
    query: "vitalik.eth",
  },
  {
    display: "Safe contract",
    query: "0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7",
  },
] as const;

/**
 * "Try an example" chips, shown under the search bar in both the hero and
 * the post-scan compact states so examples stay one click away.
 */
function ExampleChips({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (query: string) => void;
}): React.ReactElement {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
      <span className="text-muted-foreground text-xs">Try an example:</span>
      {EXAMPLE_WALLETS.map((example) => (
        <Button
          className="whitespace-nowrap rounded-full border-[var(--color-border-accent)]/30 font-normal text-foreground/80 text-xs transition-colors hover:border-[var(--color-border-accent)]/70 hover:bg-[var(--color-bg-accent)] hover:text-[var(--color-text-accent)]"
          disabled={disabled}
          key={example.query}
          onClick={() => onSelect(example.query)}
          size="sm"
          type="button"
          variant="outline"
        >
          {example.display}
        </Button>
      ))}
    </div>
  );
}

/**
 * The scan experience: hero (brand mark, scan input, examples, builder entry
 * points), results grid, and suggestion preview drawer. Rendered on "/" as
 * the default landing page and on /scan for deep links; both routes share
 * this component so the URL-param contract (?address=) works identically.
 */
export function ScanLanding(): React.ReactElement {
  const CustomLogo = getCustomLogo();
  const appName = getAppName();
  const [address, setAddress] = useState<string>("");
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | undefined>(undefined);
  const [selectedSuggestion, setSelectedSuggestion] =
    useState<SuggestionDescriptor | null>(null);
  const [selectedVariants, setSelectedVariants] = useState<
    SuggestionDescriptor[]
  >([]);
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Monotonic scan generation: bumped by every runScan call and by the
  // URL-param reset below, so a superseded in-flight response never lands.
  const scanSeq = useRef(0);
  // True once the current ?address= param has been consumed (either written
  // by runScan itself or auto-scanned from a deep link). Also guards Strict
  // Mode's double effect invocation from burning a second anonymous scan.
  const autoScanDone = useRef(false);

  const router = useRouter();
  const { startBuilding } = useStartBuilding();

  const { data: session } = useSession();
  const isAuthenticated =
    Boolean(session?.user) && !isAnonymousUser(session?.user);

  const handleAddressChange = (value: string): void => {
    setAddress(value);
    if (inputError) {
      setInputError(undefined);
    }
  };

  const runScan = useCallback(async (target: string): Promise<void> => {
    if (!isScannableQuery(target)) {
      setInputError("Enter a wallet address, contract address, or ENS name");
      return;
    }

    const seq = ++scanSeq.current;
    setInputError(undefined);
    setScanState("loading");

    // Reflect the scanned address in the URL so results are shareable.
    // history.replaceState (synced into useSearchParams by the App Router)
    // avoids a route re-render; autoScanDone marks the param as self-written
    // so the URL-sync effect below does not scan it a second time.
    autoScanDone.current = true;
    window.history.replaceState(null, "", `?address=${target}`);

    try {
      const res = await fetch(`/api/scan/${encodeURIComponent(target)}`);

      if (res.status === 429) {
        const body = (await res.json()) as { retryAfter?: number };
        if (scanSeq.current !== seq) {
          return;
        }
        // The API returns retryAfter in SECONDS; the banner renders minutes.
        // Convert to whole minutes (min 1) and fall back to 60 (hourly limit)
        // when the field is absent or non-positive.
        const retrySeconds = body.retryAfter;
        setRetryAfter(
          retrySeconds && retrySeconds > 0
            ? Math.max(1, Math.ceil(retrySeconds / 60))
            : 60
        );
        setScanState("rate-limited");
        return;
      }

      if (!res.ok) {
        if (scanSeq.current !== seq) {
          return;
        }
        setErrorMessage(
          "Our chain data providers are not responding right now. This usually clears within a few minutes, so try again shortly."
        );
        setScanState("error");
        return;
      }

      const data = (await res.json()) as ScanResponse;
      if (scanSeq.current !== seq) {
        return;
      }
      setScanData(data);
      setScanState(data.suggestions?.length ? "populated" : "empty");
    } catch {
      if (scanSeq.current !== seq) {
        return;
      }
      setErrorMessage(
        "Couldn't reach the scanner. Check your connection and try again."
      );
      setScanState("error");
    }
  }, []);

  const handleScanSubmit = (): void => {
    runScan(address).catch(() => {
      // Errors are handled inside runScan's try/catch block.
    });
  };

  const handleExampleSelect = (target: string): void => {
    setAddress(target);
    runScan(target).catch(() => {
      // Errors are handled inside runScan's try/catch block.
    });
  };

  // Sync scan state with the ?address= URL param. Deep links (?address=)
  // prefill and auto-run one scan; navigating back to the bare path (e.g. the
  // logo while results are showing) resets to the initial hero state.
  const searchParams = useSearchParams();
  const urlAddress = searchParams.get("address");
  useEffect(() => {
    if (urlAddress && isScannableQuery(urlAddress)) {
      if (autoScanDone.current) {
        return;
      }
      autoScanDone.current = true;
      setAddress(urlAddress);
      runScan(urlAddress).catch(() => {
        // Errors are handled inside runScan's try/catch block.
      });
      return;
    }
    // Param gone: invalidate any in-flight scan and return to the hero state.
    scanSeq.current += 1;
    autoScanDone.current = false;
    setAddress("");
    setScanState("idle");
    setScanData(null);
    setRetryAfter(null);
    setErrorMessage(null);
    setInputError(undefined);
    setPreviewOpen(false);
    setSelectedSuggestion(null);
    setSelectedVariants([]);
  }, [urlAddress, runScan]);

  const handleCardSelect = (
    suggestion: SuggestionDescriptor,
    variants: SuggestionDescriptor[]
  ): void => {
    // Capture the currently focused element so focus can return on drawer close.
    triggerRef.current = document.activeElement as HTMLElement | null;
    setSelectedSuggestion(suggestion);
    setSelectedVariants(variants);
    setPreviewOpen(true);
  };

  const handlePreviewOpenChange = (open: boolean): void => {
    setPreviewOpen(open);
    if (!open) {
      triggerRef.current?.focus();
    }
  };

  const isCompact = scanState !== "idle";
  const isLoading = scanState === "loading";

  return (
    <>
      <main className="pointer-events-auto fixed inset-0 overflow-y-auto bg-[var(--color-hub-overlay)] bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,color-mix(in_oklab,var(--keeperhub-green)_7%,transparent),transparent)] pt-[calc(5rem+var(--app-banner-height,0px))]">
        <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
          <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
            {isCompact ? (
              <div className="mx-auto max-w-2xl py-4">
                <div className="mx-auto max-w-lg">
                  <ScanInput
                    disabled={isLoading}
                    error={inputError}
                    onChange={handleAddressChange}
                    onSubmit={handleScanSubmit}
                    value={address}
                  />
                </div>
                <ExampleChips
                  disabled={isLoading}
                  onSelect={handleExampleSelect}
                />
              </div>
            ) : (
              <div className="mx-auto max-w-2xl py-12 text-center sm:py-16">
                {CustomLogo && <CustomLogo className="mx-auto mb-2 size-11" />}
                <h1 className="mb-1 font-bold text-3xl leading-tight tracking-tight text-foreground">
                  {appName}
                </h1>
                <p className="mb-7 text-muted-foreground">
                  Automate anything onchain
                </p>
                <p className="mb-4 text-foreground/80 text-sm">
                  Scan any wallet or contract to see live DeFi positions and
                  turn them into ready-to-run Keeper Workflows
                </p>
                <div className="mx-auto max-w-lg">
                  <ScanInput
                    disabled={isLoading}
                    error={inputError}
                    onChange={handleAddressChange}
                    onSubmit={handleScanSubmit}
                    value={address}
                  />
                </div>
                <ExampleChips
                  disabled={isLoading}
                  onSelect={handleExampleSelect}
                />
                <ScanNetworkStrip />
                <div className="mx-auto my-8 flex max-w-md items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-muted-foreground text-xs">OR</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button
                    className="gap-2 shadow-lg"
                    onClick={() => {
                      startBuilding().catch(() => {
                        // Errors are surfaced via toast inside startBuilding.
                      });
                    }}
                    size="default"
                    type="button"
                  >
                    <Plus className="size-4" />
                    Start building
                  </Button>
                  <Button
                    className="gap-2 shadow-lg"
                    onClick={() => router.push("/hub")}
                    size="default"
                    type="button"
                    variant="outline"
                  >
                    <Globe className="size-4" />
                    Browse the Hub
                  </Button>
                </div>
              </div>
            )}

            {scanState !== "idle" && (
              <ScanResults
                data={scanData}
                errorMessage={errorMessage}
                onCardSelect={handleCardSelect}
                retryAfter={retryAfter}
                scanState={scanState}
              />
            )}

            {scanState === "populated" && <ScanDisclaimer />}
          </div>
        </div>
      </main>

      <SuggestionPreviewDrawer
        address={address}
        addressKind={scanData?.addressKind}
        ensName={scanData?.ensName}
        isAuthenticated={isAuthenticated}
        onOpenChange={handlePreviewOpenChange}
        open={previewOpen}
        suggestion={selectedSuggestion}
        userEmail={session?.user?.email ?? undefined}
        variants={selectedVariants}
      />
    </>
  );
}
