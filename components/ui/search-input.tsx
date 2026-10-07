"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SearchInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "onChange" | "type" | "value"
> & {
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * A text field with a search icon and its own clear button, so it looks the
 * same in every browser. Escape clears a typed query and stops there; on an
 * empty field it passes through, so a surrounding panel can still close.
 */
export function SearchInput({
  value,
  onValueChange,
  className,
  onKeyDown,
  ...props
}: SearchInputProps): React.ReactNode {
  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
      />
      <Input
        className={cn("h-8 pr-8 pl-8 text-sm", className)}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            event.stopPropagation();
            onValueChange("");
          }
          onKeyDown?.(event);
        }}
        type="text"
        value={value}
        {...props}
      />
      {value !== "" && (
        <button
          aria-label="Clear search"
          className="-translate-y-1/2 absolute top-1/2 right-1 flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/60"
          onClick={() => onValueChange("")}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
