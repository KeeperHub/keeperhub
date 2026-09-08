"use client";

/**
 * Shown instead of an argument list when the ABI cannot describe the selected
 * function's parameters. Rendering a partial list would let the user submit an
 * incomplete contract call, so no fields are offered until the ABI is fixed.
 */
export function MalformedAbiArgsNotice(): React.ReactNode {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
      The parameters for this function could not be read from the ABI. Check
      that the ABI above is valid JSON and that every parameter has a type.
    </div>
  );
}
