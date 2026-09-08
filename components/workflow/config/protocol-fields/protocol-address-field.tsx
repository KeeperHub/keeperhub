"use client";

import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { SaveAddressBookmark } from "@/components/address-book/save-address-bookmark";
import { parseAddressBookSelection } from "@/lib/address-book-selection";
import { toChecksumAddress } from "@/lib/address-utils";
import { validateAddress } from "@/lib/solidity-type-fields";
import { useMemo } from "react";

type ProtocolAddressFieldProps = {
  fieldKey: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  config?: Record<string, unknown>;
  nodeId?: string;
};

export function ProtocolAddressField({
  fieldKey,
  value,
  onChange,
  disabled,
  placeholder,
  config,
  nodeId,
}: ProtocolAddressFieldProps): React.ReactNode {
  const displayValue = toChecksumAddress(value ?? "");

  const validation = useMemo(() => {
    if (!value || value === "") return null;
    const result = validateAddress(value);
    return result.valid ? null : result.message;
  }, [value]);

  const selectionMap = config ? parseAddressBookSelection(config) : {};
  const selectedBookmarkId = selectionMap[fieldKey];

  // The input must be the DIRECT child of SaveAddressBookmark: it clones the
  // child to intercept value/onChange and, on picking a saved address, calls
  // `child.props.onChange`. Wrapping the input in a <div> sent the selection to
  // the div (no onChange), so picking from the address book never filled the
  // field. Validation renders as a sibling instead of inside the wrapper.
  return (
    <div className="relative">
      <SaveAddressBookmark
        fieldKey={fieldKey}
        nodeId={nodeId}
        selectedBookmarkId={selectedBookmarkId}
      >
        <TemplateBadgeInput
          disabled={disabled}
          id={fieldKey}
          onChange={onChange}
          placeholder={placeholder ?? "0x..."}
          value={displayValue}
        />
      </SaveAddressBookmark>
      {validation && (
        <p className="mt-1 text-xs text-destructive">{validation}</p>
      )}
    </div>
  );
}
