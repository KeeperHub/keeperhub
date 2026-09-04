"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AddressSelectPopover } from "@/components/address-book/address-select-popover";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "./field-label";

/** Long enough for a click inside the list to land before it closes. */
const BLUR_GRACE_MS = 200;

/**
 * An address field, with the address book on focus.
 *
 * The same control the rest of the app uses for an address: a plain input that
 * offers the book while it has focus. Typing is the primary action and picking
 * is the shortcut, which is the right way round for a field whose value is an
 * address that may well not be saved anywhere yet.
 */
export function AddressField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (blurTimer.current) {
        clearTimeout(blurTimer.current);
      }
    },
    []
  );

  const handleBlur = useCallback((): void => {
    // Deferred so a click inside the list still registers before the popover
    // unmounts. Mirrors DirectRuleRow and SaveAddressBookmark, so an address
    // field behaves the same way everywhere in the app.
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
    }
    blurTimer.current = setTimeout(() => {
      const active = document.activeElement;
      const insidePopover = Boolean(
        active?.closest('[data-slot="popover-content"]') ||
          active?.closest('[data-slot="command"]')
      );
      if (!insidePopover) {
        setFocused(false);
      }
    }, BLUR_GRACE_MS);
  }, []);

  const pick = useCallback(
    (address: string): void => {
      onChange(address);
      setFocused(false);
    },
    [onChange]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel hint={hint} htmlFor={id}>
        {label}
      </FieldLabel>
      <AddressSelectPopover
        isOpen={focused}
        onAddressSelect={pick}
        onClose={() => setFocused(false)}
      >
        <Input
          className="font-mono text-xs"
          id={id}
          onBlur={handleBlur}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder={placeholder ?? "0x..."}
          spellCheck={false}
          value={value}
        />
      </AddressSelectPopover>
    </div>
  );
}
