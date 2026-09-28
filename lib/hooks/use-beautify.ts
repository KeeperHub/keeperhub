"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { beautifySource } from "@/lib/utils/beautify";

export type UseBeautifyOptions = {
  /** Reads the text to format at the moment the action runs. */
  read: () => string;
  /** Receives the formatted text; only called when formatting changed it. */
  apply: (formatted: string) => void;
  language: string;
  disabled?: boolean;
};

export type UseBeautifyResult = {
  pending: boolean;
  beautify: () => void;
};

/**
 * Drives the Beautify action for a config field.
 *
 * The source is read through a callback rather than passed in, because the
 * Monaco fields hold the current text in their model while the textarea fields
 * hold it in the config - both are current only at the moment of the click.
 */
export function useBeautify({
  read,
  apply,
  language,
  disabled,
}: UseBeautifyOptions): UseBeautifyResult {
  const [pending, setPending] = useState(false);

  const beautify = useCallback((): void => {
    if (disabled || pending) {
      return;
    }
    const source = read();
    setPending(true);
    const run = async (): Promise<void> => {
      try {
        const outcome = await beautifySource(source, language);
        if (outcome.ok) {
          // The editor stays typable while this runs, and the first JavaScript
          // format waits on Prettier's chunks. Writing back unconditionally
          // would replace anything typed in that window with the formatted
          // pre-click text, so a field that moved is left alone.
          if (read() !== source) {
            return;
          }
          if (outcome.value !== source) {
            apply(outcome.value);
          }
          return;
        }
        toast.error("Could not beautify", { description: outcome.error });
      } catch {
        // Nothing reachable throws today, but run() is fire-and-forget: an
        // unhandled rejection would reach Sentry with whatever the formatter
        // put in the message, and tell the user nothing.
        toast.error("Could not beautify", {
          description: "Something went wrong while formatting this field.",
        });
      } finally {
        setPending(false);
      }
    };
    run();
  }, [apply, disabled, language, pending, read]);

  return { pending, beautify };
}
