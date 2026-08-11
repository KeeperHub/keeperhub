"use client";

import * as React from "react";

import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * AlertDialog is implemented as a thin wrapper around Dialog rather
 * than via @radix-ui/react-alert-dialog. The Radix alert-dialog package
 * internally evaluates @radix-ui/react-dialog at module-eval time,
 * which Turbopack's SSR bundler cannot resolve reliably when the
 * file is in the eager root chunk (createDialogScope shows up as
 * undefined). Routing through our existing Dialog primitive (which
 * Turbopack handles fine) sidesteps the issue and preserves the same
 * public API every callsite already uses.
 *
 * The `role="alertdialog"` attribute on Content keeps the WAI-ARIA
 * semantics expected by assistive tech (forced acknowledgement).
 * Action / Cancel buttons here render as styled <button> elements;
 * Action requires the caller to wire up their click handler, Cancel
 * closes the dialog through DialogClose.
 */

const AlertDialog: typeof Dialog = Dialog;
const AlertDialogTrigger: typeof DialogTrigger = DialogTrigger;
const AlertDialogPortal: typeof DialogPortal = DialogPortal;
const AlertDialogOverlay: typeof DialogOverlay = DialogOverlay;
const AlertDialogHeader: typeof DialogHeader = DialogHeader;
const AlertDialogFooter: typeof DialogFooter = DialogFooter;
const AlertDialogTitle: typeof DialogTitle = DialogTitle;
const AlertDialogDescription: typeof DialogDescription = DialogDescription;

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof DialogContent>): React.ReactElement {
  return (
    <DialogContent
      data-slot="alert-dialog-content"
      role="alertdialog"
      {...props}
      className={cn(className)}
    />
  );
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<"button">): React.ReactElement {
  return (
    <button
      data-slot="alert-dialog-action"
      type="button"
      {...props}
      className={cn(buttonVariants(), className)}
    />
  );
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<"button">): React.ReactElement {
  return (
    <DialogClose asChild>
      <button
        data-slot="alert-dialog-cancel"
        type="button"
        {...props}
        className={cn(buttonVariants({ variant: "outline" }), className)}
      />
    </DialogClose>
  );
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
