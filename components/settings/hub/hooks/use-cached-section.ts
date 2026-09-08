"use client";

import { useCachedResource } from "@/lib/hooks/use-cached-resource";
import { useSettingsContext } from "../settings-context";

type CachedSection<T> = {
  data: T | undefined;
  /** True only the first time, when there is nothing to show yet. */
  loading: boolean;
  refetch: () => Promise<void>;
};

/**
 * Section data that survives leaving the section.
 *
 * A section already visited paints from what it last saw and refreshes behind
 * that, so moving between sections costs a repaint rather than a skeleton.
 * Keys carry the organization, so another organization's data can never be
 * what gets painted, and the settings revision forces a reload when something
 * has changed underneath.
 */
export function useCachedSection<T>(
  key: string | null,
  fetcher: () => Promise<T>
): CachedSection<T> {
  const { revision } = useSettingsContext();
  return useCachedResource(key, fetcher, revision);
}
