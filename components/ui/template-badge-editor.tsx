"use client";

import { useAtom } from "jotai";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { doesNodeExist, getDisplayTextForTemplate } from "@/lib/workflow/editor/template-utils";
import { cn } from "@/lib/utils";
import { nodesAtom, selectedNodeAtom } from "@/lib/workflow/store";
import {
  TemplateAutocomplete,
  type TemplateAutocompleteCloseReason,
} from "./template-autocomplete";
import {
  countTemplateTokens,
  TEMPLATE_TOKEN_PATTERN,
  toStringValue,
} from "./template-badge-utils";

// Guards `selection.getRangeAt(0)`, which throws IndexSizeError when
// rangeCount is 0 (e.g. focus moved off the editable before keydown fired).
export function hasUsableSelection(
  selection: Selection | null
): selection is Selection {
  return selection !== null && selection.rangeCount > 0;
}

// Length of the trailing "}}" so the caret can be parked just inside the token
// when a badge is opened for editing.
const CLOSING_BRACES_LENGTH = 2;

/**
 * Caret offset to use when a badge is opened for editing: just inside the
 * closing braces, so typing extends the field path rather than appending text
 * after the token. Falls back to the end for a token that is not brace-closed.
 */
export function caretOffsetForBadgeEdit(rawTemplate: string): number {
  return rawTemplate.endsWith("}}")
    ? rawTemplate.length - CLOSING_BRACES_LENGTH
    : rawTemplate.length;
}

const EDIT_BADGE_HINT = "Double-click to edit this reference";

/**
 * Tooltip text for a badge whose reference the field cuts off: the full
 * reference leads, and the edit hint keeps its own line below.
 */
export function badgeTooltip(displayText: string): string {
  return displayText ? `${displayText}\n${EDIT_BADGE_HINT}` : EDIT_BADGE_HINT;
}

/**
 * Geometry of one badge inside the field that holds it, measured in the
 * field's content box so a scrolled field gives the same answer as an
 * unscrolled one.
 */
export type BadgeExtent = {
  /** Right edge of the badge, from the start of the field's content. */
  right: number;
  /** Width the field actually shows. */
  visibleWidth: number;
};

/**
 * Whether the field cuts the badge off. A badge never truncates itself -- it
 * sits at full width inside a wrapper that scrolls -- so the test is its right
 * edge against the visible width, where `TruncatedTooltip` asks the same
 * question of text that truncates against its own box.
 *
 * A badge that fits keeps the edit hint alone, so hovering a reference you can
 * already read in full does not repeat it back.
 */
export function isBadgeClipped({ right, visibleWidth }: BadgeExtent): boolean {
  return visibleWidth > 0 && right > visibleWidth;
}

export type TemplateBadgeEditorMultilineOptions = {
  rows: number;
  /** When set, limits visible height to this many rows and makes content scrollable */
  maxRows?: number;
};

export type TemplateBadgeEditorProps = {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  /**
   * When set, the editor behaves as a textarea: line breaks are preserved
   * (rendered as <br>, stored as "\n"), Enter inserts a line break, and the
   * given rows/maxRows drive the min/max height. When unset, the editor
   * behaves as a single-line input with Backspace/Delete badge removal.
   */
  multiline?: TemplateBadgeEditorMultilineOptions;
};

// Helper to find all template pattern ranges in text
function findTemplateRanges(text: string): Array<{ start: number; end: number }> {
  const templatePattern = /\{\{@[^}]+\}\}/g;
  const ranges: Array<{ start: number; end: number }> = [];
  let match;

  while ((match = templatePattern.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  return ranges;
}

// Helper to check if a position is inside any template range
function isInsideTemplate(position: number, templateRanges: Array<{ start: number; end: number }>): boolean {
  return templateRanges.some(range => position >= range.start && position < range.end);
}

// Helper to collect all @ signs that are not inside templates
function collectActiveAtSigns(text: string, templateRanges: Array<{ start: number; end: number }>): number[] {
  const activeAtSigns: number[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '@' && !isInsideTemplate(i, templateRanges)) {
      activeAtSigns.push(i);
    }
  }

  return activeAtSigns;
}

// Helper to find the @ closest to cursor position
function findClosestAtSign(activeAtSigns: number[], cursorOffset: number): number {
  let closestAt = activeAtSigns[0];
  let minDistance = Math.abs(closestAt - cursorOffset);

  for (const atPos of activeAtSigns) {
    const distance = Math.abs(atPos - cursorOffset);
    const isBeforeCursor = atPos <= cursorOffset;
    const isCloseAfterCursor = atPos > cursorOffset && distance <= 5;

    if (isBeforeCursor || isCloseAfterCursor) {
      const shouldUpdate = distance < minDistance || (isBeforeCursor && closestAt > cursorOffset);
      if (shouldUpdate) {
        closestAt = atPos;
        minDistance = distance;
      }
    }
  }

  return closestAt;
}

// Helper to find the "@" closest to cursor that's not inside a completed template pattern
function findActiveAtSign(text: string, cursorOffset?: number): number {
  const templateRanges = findTemplateRanges(text);
  const activeAtSigns = collectActiveAtSigns(text, templateRanges);

  if (activeAtSigns.length === 0) {
    return -1;
  }

  if (cursorOffset !== undefined && cursorOffset !== null) {
    return findClosestAtSign(activeAtSigns, cursorOffset);
  }

  // No cursor info, return the last @
  return activeAtSigns[activeAtSigns.length - 1];
}

/**
 * A contentEditable component that renders template variables as styled badges
 * Converts {{@nodeId:DisplayName.field}} to badges showing "DisplayName.field"
 */
export function TemplateBadgeEditor({
  value = "",
  onChange,
  placeholder,
  disabled,
  className,
  id,
  multiline,
}: TemplateBadgeEditorProps) {
  const [isFocused, setIsFocused] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState<string>(() =>
    toStringValue(value)
  );
  const shouldUpdateDisplay = useRef(true);
  const [selectedNodeId] = useAtom(selectedNodeAtom);
  const [nodes] = useAtom(nodesAtom);

  // Autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompletePosition, setAutocompletePosition] = useState({ top: 0, left: 0 });
  const [atSignPosition, setAtSignPosition] = useState<number | null>(null);
  const pendingCursorPosition = useRef<number | null>(null);

  const openAutocompleteAtAt = (atPosition: number): void => {
    setAtSignPosition(atPosition);
    if (contentRef.current) {
      const editorRect = contentRef.current.getBoundingClientRect();
      setAutocompletePosition({
        top: editorRect.bottom + window.scrollY + 4,
        left: editorRect.left + window.scrollX,
      });
    }
    setShowAutocomplete(true);
  };

  const closeAutocomplete = (reason: TemplateAutocompleteCloseReason): void => {
    setShowAutocomplete(false);
    setAtSignPosition(null);
    if (reason === "escape") {
      // Return focus to the editor so the user can keep typing.
      contentRef.current?.focus();
      return;
    }
    // "outside": user clicked somewhere else. Don't refocus; also sync
    // isFocused so the "@" chip hides if focus no longer lives in the editor.
    setTimeout(() => {
      if (document.activeElement !== contentRef.current) {
        setIsFocused(false);
      }
    }, 0);
  };

  // Update internal value when prop changes from outside
  useEffect(() => {
    const safeValue = toStringValue(value);
    if (safeValue !== internalValue && !isFocused) {
      setInternalValue(safeValue);
      shouldUpdateDisplay.current = true;
    }
  }, [value, isFocused, internalValue]);

  // Update display when nodes change (to reflect label updates)
  useEffect(() => {
    if (!isFocused && internalValue) {
      shouldUpdateDisplay.current = true;
    }
  }, [nodes, isFocused, internalValue]);

  // Save cursor position
  const saveCursorPosition = (): { offset: number } | null => {
    if (!contentRef.current) {
      return null;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(contentRef.current);
    preCaretRange.setEnd(range.endContainer, range.endOffset);

    // Calculate offset considering badges as single characters
    let offset = 0;
    const walker = document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );

    let node: Node | null;
    let found = false;
    while (!found && (node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node === range.endContainer) {
          offset += range.endOffset;
          found = true;
        } else {
          offset += (node.textContent ?? "").length;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const template = element.getAttribute("data-template");
        if (template) {
          if (element.contains(range.endContainer) || element === range.endContainer) {
            offset += template.length;
            found = true;
          } else {
            offset += template.length;
          }
        } else if (multiline && element.tagName === "BR") {
          if (element === range.endContainer || element.contains(range.endContainer)) {
            found = true;
          } else {
            offset += 1; // Count line break as 1 character
          }
        }
      }
    }

    return { offset };
  };

  // Restore cursor position
  const restoreCursorPosition = (cursorPos: { offset: number } | null): void => {
    if (!contentRef.current || !cursorPos) {
      return;
    }

    let offset = 0;
    const walker = document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );

    let node;
    let targetNode: Node | null = null;
    let targetOffset = 0;

    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = (node.textContent || "").length;
        if (offset + textLength >= cursorPos.offset) {
          targetNode = node;
          targetOffset = cursorPos.offset - offset;
          break;
        }
        offset += textLength;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const template = element.getAttribute("data-template");
        if (template) {
          if (offset + template.length >= cursorPos.offset) {
            // Position cursor after the badge
            targetNode = element.nextSibling;
            targetOffset = 0;
            if (!targetNode && element.parentNode) {
              // If no next sibling, create a text node
              targetNode = document.createTextNode("");
              element.parentNode.appendChild(targetNode);
            }
            break;
          }
          offset += template.length;
        } else if (multiline && element.tagName === "BR") {
          if (offset + 1 >= cursorPos.offset) {
            // Position cursor after the BR
            targetNode = element.nextSibling;
            targetOffset = 0;
            if (!targetNode && element.parentNode) {
              targetNode = document.createTextNode("");
              element.parentNode.appendChild(targetNode);
            }
            break;
          }
          offset += 1;
        }
      }
    }

    if (targetNode) {
      const range = document.createRange();
      const selection = window.getSelection();
      try {
        const finalOffset = Math.min(targetOffset, targetNode.textContent?.length || 0);
        range.setStart(targetNode, finalOffset);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        contentRef.current.focus();
      } catch {
        // If positioning fails, just focus the element
        contentRef.current.focus();
      }
    }
  };

  // Helper to add text with line breaks preserved (multiline only)
  const addTextWithLineBreaks = (container: HTMLElement, text: string): void => {
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line) {
        container.appendChild(document.createTextNode(line));
      }
      if (index < lines.length - 1) {
        container.appendChild(document.createElement("br"));
      }
    }
  };

  // Append text to the container: as-is for single-line, preserving line
  // breaks for multiline.
  const appendText = (container: HTMLElement, text: string): void => {
    if (multiline) {
      addTextWithLineBreaks(container, text);
      return;
    }
    container.appendChild(document.createTextNode(text));
  };

  // Give the full reference only to the badges the field cuts off, measuring
  // each against the content box so the answer does not move when the field is
  // scrolled. Mirrors TruncatedTooltip: measure, gate, re-measure on resize.
  const syncBadgeTooltips = (): void => {
    const container = contentRef.current;
    if (!container) {
      return;
    }

    const visibleWidth = container.clientWidth;
    const containerLeft = container.getBoundingClientRect().left;

    for (const badge of container.querySelectorAll<HTMLElement>(
      "[data-template]"
    )) {
      const right =
        badge.getBoundingClientRect().right -
        containerLeft +
        container.scrollLeft;
      badge.title = isBadgeClipped({ right, visibleWidth })
        ? badgeTooltip(badge.textContent ?? "")
        : EDIT_BADGE_HINT;
    }
  };

  // Parse text and render with badges
  const updateDisplay = (): void => {
    if (!contentRef.current || !shouldUpdateDisplay.current) return;

    const container = contentRef.current;
    const text = internalValue || "";

    // Save cursor position before updating
    let cursorPos = isFocused ? saveCursorPosition() : null;

    // If we have a pending cursor position (from autocomplete), use that instead
    if (pendingCursorPosition.current !== null) {
      cursorPos = { offset: pendingCursorPosition.current };
      pendingCursorPosition.current = null;
    }

    // Clear current content
    container.innerHTML = "";

    if (!text && !isFocused) {
      // Show placeholder
      container.innerHTML = `<span class="text-muted-foreground pointer-events-none">${placeholder || ""}</span>`;
      return;
    }

    // Match template patterns: {{@nodeId:DisplayName.field}} or {{@nodeId:DisplayName}}.
    // Fresh instance per call: the shared constant is /g and exec() would leave
    // lastIndex state behind for other consumers.
    const pattern = new RegExp(TEMPLATE_TOKEN_PATTERN.source, "g");
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const [fullMatch] = match;
      const matchStart = match.index;

      // Add text before the template
      if (matchStart > lastIndex) {
        const textBefore = text.slice(lastIndex, matchStart);
        appendText(container, textBefore);
      }

      // Create badge for template
      const badge = document.createElement("span");
      const nodeExists = doesNodeExist(fullMatch, nodes);
      badge.className = nodeExists
        ? "inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400 font-mono text-xs border border-blue-500/20 mx-0.5"
        : "inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-red-600 dark:text-red-400 font-mono text-xs border border-red-500/20 mx-0.5";
      badge.contentEditable = "false";
      badge.setAttribute("data-template", fullMatch);
      // Use current node label for display
      badge.textContent = getDisplayTextForTemplate(fullMatch, nodes);
      // Upgraded to the full reference by syncBadgeTooltips once the badge has
      // been laid out and its width against the field is known.
      badge.title = EDIT_BADGE_HINT;
      container.appendChild(badge);

      lastIndex = pattern.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      const textAfter = text.slice(lastIndex);
      appendText(container, textAfter);
    }

    // If empty and focused, ensure we can type
    if (container.innerHTML === "" && isFocused) {
      container.innerHTML = "<br>";
    }

    shouldUpdateDisplay.current = false;

    syncBadgeTooltips();

    // Restore cursor position after updating
    if (cursorPos) {
      // Use requestAnimationFrame to ensure DOM is fully updated
      requestAnimationFrame(() => restoreCursorPosition(cursorPos));
    }
  };

  // Extract plain text from content
  const extractValue = (): string => {
    if (!contentRef.current) return "";

    let result = "";
    const walker = document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );

    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        // Check if this text node is inside a badge element
        let parent = node.parentElement;
        let isInsideBadge = false;
        while (parent && parent !== contentRef.current) {
          if (parent.getAttribute("data-template")) {
            isInsideBadge = true;
            break;
          }
          parent = parent.parentElement;
        }

        // Only add text if it's NOT inside a badge
        if (!isInsideBadge) {
          result += node.textContent;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const template = element.getAttribute("data-template");
        if (template) {
          result += template;
        } else if (multiline && element.tagName === "BR") {
          result += "\n";
        }
      }
    }

    return result;
  };

  const handleInput = (): void => {
    // Extract the value from DOM
    const newValue = extractValue();

    // Check if the value has changed
    if (newValue === internalValue) {
      // No change, ignore (this can happen with badge clicks, etc)
      return;
    }

    // Count templates in old and new values
    const oldTemplates = countTemplateTokens(internalValue);
    const newTemplates = countTemplateTokens(newValue);

    if (newTemplates > oldTemplates) {
      // A new template was added, update display to show badge
      setInternalValue(newValue);
      onChange?.(newValue);
      shouldUpdateDisplay.current = true;
      setShowAutocomplete(false);

      // Call updateDisplay immediately to render badges
      requestAnimationFrame(() => updateDisplay());
      return;
    }

    if (newTemplates === oldTemplates && newTemplates > 0) {
      // Same number of templates, just typing around existing badges
      // DON'T update display, just update the value (prevents cursor reset)
      setInternalValue(newValue);
      onChange?.(newValue);
      maybeOpenAutocomplete(newValue);
      return;
    }

    if (newTemplates < oldTemplates) {
      // A template was removed (e.g., user deleted a badge or part of template text)
      setInternalValue(newValue);
      onChange?.(newValue);
      shouldUpdateDisplay.current = true;
      requestAnimationFrame(() => updateDisplay());
      return;
    }

    // Normal typing (no badges present)
    setInternalValue(newValue);
    onChange?.(newValue);
    maybeOpenAutocomplete(newValue);
  };

  // Detect the closest "@" to the cursor and open/close the dropdown accordingly.
  // The search happens inside the dropdown itself, so we no longer care what the
  // user types after "@" -- we only need the "@" anchor position for replacement.
  const maybeOpenAutocomplete = (currentValue: string): void => {
    const cursorPos = saveCursorPosition();
    const cursorOffset = cursorPos?.offset ?? currentValue.length;
    const atPosition = findActiveAtSign(currentValue, cursorOffset);

    if (atPosition === -1 || atPosition > cursorOffset) {
      setShowAutocomplete(false);
      setAtSignPosition(null);
      return;
    }

    openAutocompleteAtAt(atPosition);
  };

  const handleAutocompleteSelect = (template: string): void => {
    if (!contentRef.current || atSignPosition === null) {
      return;
    }

    // Filter text is typed into the dropdown's own search input, not the
    // editor, so we only replace the single "@" character that triggered it.
    const currentText = extractValue();
    const beforeAt = currentText.slice(0, atSignPosition);
    const afterAt = currentText.slice(atSignPosition + 1);
    const newText = beforeAt + template + afterAt;
    const targetCursorPosition = beforeAt.length + template.length;

    setInternalValue(newText);
    onChange?.(newText);
    shouldUpdateDisplay.current = true;

    setShowAutocomplete(false);
    setAtSignPosition(null);

    pendingCursorPosition.current = targetCursorPosition;
    contentRef.current.focus();
  };

  // Open a badge for editing: swap it for its raw `{{@nodeId:Label.path}}` text
  // with the caret just inside the closing braces. The autocomplete can only
  // offer field paths it has seen in a previous run, so a path on a node that
  // has never executed is otherwise unreachable -- the badge is
  // contentEditable=false and there is no cursor position inside it.
  //
  // No re-render is needed here: extractValue() reads a badge as its
  // data-template and raw text as itself, so the serialized value is unchanged.
  // Typing inside the token keeps the token count stable, which handleInput
  // treats as "typing around existing badges" and leaves the DOM alone.
  // handleBlur re-renders the badge with the edited path.
  const handleDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (disabled || !contentRef.current) {
      return;
    }
    const target = e.target as HTMLElement | null;
    const badge = target?.closest?.("[data-template]") as HTMLElement | null;
    if (!badge || !contentRef.current.contains(badge)) {
      return;
    }
    const raw = badge.getAttribute("data-template");
    if (!raw) {
      return;
    }

    e.preventDefault();
    const textNode = document.createTextNode(raw);
    badge.replaceWith(textNode);

    const caret = caretOffsetForBadgeEdit(raw);
    const selection = window.getSelection();
    try {
      const range = document.createRange();
      range.setStart(textNode, caret);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch {
      // Caret placement is a convenience; the text is editable regardless.
    }
    contentRef.current.focus();
    shouldUpdateDisplay.current = false;
  };

  const handleFocus = (): void => {
    setIsFocused(true);
    shouldUpdateDisplay.current = true;
  };

  const handleBlur = (): void => {
    // Delay to allow autocomplete click / focus transfer to register
    setTimeout(() => {
      const active = document.activeElement;
      if (active === contentRef.current) {
        return;
      }
      // Focus moved into the autocomplete (search input or option button).
      // Keep the dropdown mounted and the editor in its "focused" state.
      if (active instanceof Element && active.closest("[data-template-autocomplete]")) {
        return;
      }
      setIsFocused(false);
      shouldUpdateDisplay.current = true;
      setShowAutocomplete(false);
      setAtSignPosition(null);
    }, 200);
  };

  const handlePaste = (e: React.ClipboardEvent): void => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (multiline) {
      // Handle Enter key to insert line breaks
      if (e.key === "Enter") {
        // prevent Enter key from inserting line breaks if autocomplete is open
        if (showAutocomplete) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        document.execCommand("insertLineBreak");
      }
      return;
    }

    if (e.key === "Enter" && showAutocomplete) {
      e.preventDefault();
      return;
    }

    // Handle Backspace/Delete for badge removal
    if (e.key === "Backspace" || e.key === "Delete") {
      const selection = window.getSelection();
      if (!hasUsableSelection(selection) || !contentRef.current) return;

      // Case 1: Range selection containing a badge
      if (!selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const hasBadge = fragment.querySelector?.("[data-template]");
        if (hasBadge) {
          e.preventDefault();
          range.deleteContents();
          handleInput();
          return;
        }
      }

      // Case 2: Collapsed cursor — find nearest badge
      const range = selection.getRangeAt(0);
      const { startContainer, startOffset } = range;
      let badgeToRemove: HTMLElement | null = null;

      // Walk up from cursor to check if we're inside a badge
      let ancestor: Node | null = startContainer;
      while (ancestor && ancestor !== contentRef.current) {
        if (
          ancestor instanceof HTMLElement &&
          ancestor.getAttribute("data-template")
        ) {
          badgeToRemove = ancestor;
          break;
        }
        ancestor = ancestor.parentNode;
      }

      if (!badgeToRemove && startContainer === contentRef.current) {
        // Cursor at container level — check child at offset-1 and offset
        const children = contentRef.current.childNodes;
        if (e.key === "Backspace" && startOffset > 0) {
          const prev = children[startOffset - 1] as HTMLElement | null;
          if (prev?.getAttribute?.("data-template")) {
            badgeToRemove = prev;
          }
        }
        if (!badgeToRemove && startOffset < children.length) {
          const next = children[startOffset] as HTMLElement | null;
          if (next?.getAttribute?.("data-template")) {
            badgeToRemove = next;
          }
        }
      } else if (!badgeToRemove && startContainer.nodeType === Node.TEXT_NODE) {
        // Cursor in a text node — check adjacent siblings
        if (e.key === "Backspace" && startOffset === 0) {
          const prev = startContainer.previousSibling as HTMLElement | null;
          if (prev?.getAttribute?.("data-template")) {
            badgeToRemove = prev;
          }
        }
        if (
          !badgeToRemove &&
          e.key === "Delete" &&
          startOffset === (startContainer.textContent?.length ?? 0)
        ) {
          const next = startContainer.nextSibling as HTMLElement | null;
          if (next?.getAttribute?.("data-template")) {
            badgeToRemove = next;
          }
        }
        // Empty text node — check both sides regardless of key
        if (
          !badgeToRemove &&
          (startContainer.textContent?.length ?? 0) === 0
        ) {
          const prev = startContainer.previousSibling as HTMLElement | null;
          const next = startContainer.nextSibling as HTMLElement | null;
          if (prev?.getAttribute?.("data-template")) {
            badgeToRemove = prev;
          } else if (next?.getAttribute?.("data-template")) {
            badgeToRemove = next;
          }
        }
      }

      if (badgeToRemove) {
        e.preventDefault();
        badgeToRemove.remove();
        handleInput();
      }
    }
  };

  // Update display only when needed (not while typing)
  useEffect(() => {
    if (shouldUpdateDisplay.current) {
      updateDisplay();
    }
  }, [internalValue, isFocused]);

  // A field that grows or shrinks changes which badges are cut off, and the
  // panel holding these fields is resizable.
  useEffect(() => {
    const container = contentRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => syncBadgeTooltips());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Hint 2: clicking the "@" chip focuses the editor, inserts an "@" at the
  // cursor (or at the end if none), and lets handleInput open the dropdown.
  const handleAtButtonClick = (): void => {
    if (!contentRef.current || disabled) {
      return;
    }
    contentRef.current.focus();
    const selection = window.getSelection();
    const hasCursorInEditor =
      selection !== null &&
      selection.rangeCount > 0 &&
      contentRef.current.contains(selection.anchorNode);
    if (!hasCursorInEditor) {
      const range = document.createRange();
      range.selectNodeContents(contentRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    document.execCommand("insertText", false, "@");
  };

  // Calculate min height based on rows; max height when maxRows is set
  // (truncates display, scrollable). Single-line editors get no inline style.
  let style: CSSProperties | undefined;
  if (multiline) {
    style = { minHeight: `${multiline.rows * 1.5}rem` };
    if (multiline.maxRows !== undefined) {
      style.maxHeight = `${multiline.maxRows * 1.5}rem`;
      style.overflowY = "auto";
    }
  }

  return (
    <>
      <div
        className={cn(
          multiline
            ? "flex w-full items-start gap-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-within:outline-none focus-within:ring-1 focus-within:ring-ring"
            : "flex min-h-9 w-full items-center gap-1 overflow-hidden rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        style={style}
      >
        <div
          className={
            multiline
              ? "min-w-0 flex-1 whitespace-pre-wrap break-words outline-none"
              : "min-w-0 flex-1 overflow-hidden whitespace-nowrap outline-none"
          }
          contentEditable={!disabled}
          id={id}
          onBlur={handleBlur}
          onDoubleClick={handleDoubleClick}
          onFocus={handleFocus}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          ref={contentRef}
          role="textbox"
          suppressContentEditableWarning
        />
        {(isFocused || showAutocomplete) && !disabled && (
          <button
            aria-label="Insert workflow variable"
            className={
              multiline
                ? "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                : "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
            }
            onClick={handleAtButtonClick}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            title="Insert a workflow variable"
            type="button"
          >
            @
          </button>
        )}
      </div>

      <TemplateAutocomplete
        currentNodeId={selectedNodeId ?? undefined}
        isOpen={showAutocomplete}
        onClose={closeAutocomplete}
        onSelect={handleAutocompleteSelect}
        position={autocompletePosition}
      />
    </>
  );
}
