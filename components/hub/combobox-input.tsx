"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type ComboboxInputProps = {
  value: string;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

export function ComboboxInput({
  value,
  options,
  placeholder = "Select or type...",
  disabled = false,
  onChange,
}: ComboboxInputProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filtered = useMemo(() => {
    if (!inputValue.trim()) {
      return options;
    }
    const query = inputValue.toLowerCase();
    return options.filter((opt) => opt.toLowerCase().includes(query));
  }, [options, inputValue]);

  const handleInputChange = (newValue: string): void => {
    setInputValue(newValue);
    setOpen(true);
    onChange(newValue);
  };

  const handleSelect = (option: string): void => {
    setInputValue(option);
    onChange(option);
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex items-center rounded-md border border-input bg-transparent shadow-xs">
        <input
          className="min-h-9 flex-1 rounded-md bg-transparent px-3 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          type="text"
          value={inputValue}
        />
        <button
          className="px-2 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled}
          onClick={() => setOpen(!open)}
          tabIndex={-1}
          type="button"
        >
          <ChevronsUpDown className="size-4" />
        </button>
      </div>

      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {filtered.map((option) => (
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                option === value && "font-medium"
              )}
              key={option}
              onClick={() => handleSelect(option)}
              type="button"
            >
              <Check
                className={cn(
                  "size-3.5 shrink-0",
                  option === value ? "opacity-100" : "opacity-0"
                )}
              />
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
