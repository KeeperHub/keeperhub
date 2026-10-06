"use client";

import { createContext } from "react";

/**
 * Where an editor inside a modal puts the popups it would otherwise attach to
 * <body>. A modal traps focus and blocks the pointer outside itself, and hides
 * the rest of the page from assistive technology, so a popup on <body> - the
 * variable picker, Monaco's suggestions or its right-click menu - opens but
 * cannot be used. With no provider, editors keep using <body>.
 */
export type EditorPopupContainers = {
  /** Holds the variable picker. Null until the modal has mounted. */
  popups: HTMLElement | null;
  /** Monaco's overflow-widget root, created before any editor inside mounts. */
  monacoWidgets: HTMLElement;
};

export const EditorPopupContainerContext =
  createContext<EditorPopupContainers | null>(null);
