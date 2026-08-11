"use client";

import { useCallback } from "react";
import { TemplateCodeEditor } from "@/components/ui/template-code-editor";

type CodeEditorFieldProps = {
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  language?: string;
  height?: string;
};

export function CodeEditorField({
  value,
  onChange,
  disabled,
  placeholder,
  language = "javascript",
  height = "320px",
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
      language={language}
      onChange={handleChange}
      placeholder={placeholder}
      value={value}
    />
  );
}
