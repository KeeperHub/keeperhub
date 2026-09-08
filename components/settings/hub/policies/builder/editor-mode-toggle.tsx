"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type EditorMode = "builder" | "source";

/**
 * Switch between the form and the document it produces.
 *
 * Uses the same segmented control as the tabs elsewhere on this page, so the
 * selected side is legible in both themes and the page keeps one visual
 * language. It sits in the editor's own header so it is obvious what it
 * switches.
 *
 * A statement the form cannot draw disables the way back, because the form
 * would not show it and saving would drop it.
 */
export function EditorModeToggle({
  mode,
  builderDisabled,
  onChange,
}: {
  mode: EditorMode;
  /** True when a statement cannot be shown in the form. */
  builderDisabled: boolean;
  onChange: (next: EditorMode) => void;
}): React.ReactElement {
  return (
    <Tabs onValueChange={(next) => onChange(next as EditorMode)} value={mode}>
      <TabsList>
        <TabsTrigger disabled={builderDisabled} value="builder">
          Builder
        </TabsTrigger>
        <TabsTrigger value="source">Text</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
