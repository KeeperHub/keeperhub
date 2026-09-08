"use client";

import { TemplateBadgeEditor } from "./template-badge-editor";

export interface TemplateBadgeTextareaProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  rows?: number;
  /** When set, limits visible height to this many rows and makes content scrollable */
  maxRows?: number;
}

/**
 * A textarea component that renders template variables as styled badges
 * Converts {{@nodeId:DisplayName.field}} to badges showing "DisplayName.field"
 */
export function TemplateBadgeTextarea({
  rows = 3,
  maxRows,
  ...props
}: TemplateBadgeTextareaProps) {
  return <TemplateBadgeEditor {...props} multiline={{ rows, maxRows }} />;
}
