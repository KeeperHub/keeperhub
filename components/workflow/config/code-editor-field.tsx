"use client";

import { useCallback } from "react";
import { TemplateCodeEditor } from "@/components/workflow/config/template-code-editor";

type CodeEditorFieldProps = {
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  language?: string;
  height?: string;
  /** Names the field in the full-screen dialog. */
  label?: string;
};

export function CodeEditorField({
  value,
  onChange,
  disabled,
  placeholder,
  language = "javascript",
  height = "320px",
  label,
}: CodeEditorFieldProps): React.ReactElement {
  const handleChange = useCallback(
    (newValue: string): void => {
      onChange(newValue);
    },
    [onChange]
  );

  return (
    <TemplateCodeEditor
      disabled={disabled}
      height={height}
      label={label}
      language={language}
      onChange={handleChange}
      placeholder={placeholder}
      value={value}
    />
  );
}
