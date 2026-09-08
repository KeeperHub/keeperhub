"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const sizedInputVariants = cva(
  "w-full min-w-0 rounded-md border border-input bg-transparent shadow-xs outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        sm: "h-8 px-2.5 py-1 text-xs",
        default: "h-9 px-3 py-1 text-sm",
        lg: "h-11 px-4 py-2 text-base",
        xl: "h-14 px-5 py-3 text-lg",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
);

type SizedInputProps = ComponentProps<"input"> &
  VariantProps<typeof sizedInputVariants>;

function SizedInput({ className, type, size, ...props }: SizedInputProps) {
  return (
    <input
      className={cn(sizedInputVariants({ size, className }))}
      data-slot="input"
      type={type}
      {...props}
    />
  );
}

export { SizedInput, sizedInputVariants };
