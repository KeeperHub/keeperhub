"use client";

import { TemplateBadgeEditor } from "./template-badge-editor";

export { hasUsableSelection } from "./template-badge-editor";

export interface TemplateBadgeInputProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/**
 * An input component that renders template variables as styled badges
 * Converts {{@nodeId:DisplayName.field}} to badges showing "DisplayName.field"
 */
export function TemplateBadgeInput(props: TemplateBadgeInputProps) {
  return <TemplateBadgeEditor {...props} />;
}
